import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { storyEntries, syncOps } from '$lib/server/db/schema';
import { turnRequestSchema, type RetrievedMemoryPacket, type TurnRequest, type TurnResponse } from '$lib/contracts/memory';
import { bumpStoryVersion, getSyncChanges } from '$lib/server/memory/canonical';
import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { worldStateUpdateSchema } from '$lib/services/ai/tools/schemas';
import { contextWiki } from '$lib/server/wiki/wikiCore';
import { loadGmTimelineBrief, promoteDueTimelineEvents } from '$lib/server/events/timeline';
import { loadTurnContext } from './context';
import { buildServerTurnPrompt, buildStateExtractionPrompt } from './promptPacket';
import {
	ServerGenerationError,
	generateServerTextWithMetrics,
	parseJsonFromGeneratedText,
	type ServerGenerationResult,
} from './provider';
import { applyValidatedTurnUpdate, parseTurnUpdate } from './patchValidator';
import { requireResolvedServiceProfile, resolveServiceGeneration } from '$lib/server/engine/llmSettings';
import { recordApiCallLog } from '$lib/server/engine/apiCallLogs';
import { appendTurnEvidence } from '$lib/server/engine/campaignVault';
import { getCampaignProjection } from '$lib/server/engine/projections';
import { enqueueContinuityAuditJob, enqueueTurnStateExtractionJob } from '$lib/server/jobs/outbox';
import {
	buildEngineCacheKey,
	engineCacheDependencyHash,
	readEngineCacheSegment,
	recordEngineCacheSegment,
	recordPromptCacheSegments,
	type EngineCacheRepository,
	type RecordEngineCacheSegmentResult,
} from '$lib/server/engine/cache';
import { buildEngineCacheDebug, buildTurnDebugSnapshot, type EngineCacheDebug } from './debugSnapshot';
import { createTimingRecorder, type TimingEntry, type TimingRecorder } from '$lib/server/performance/timing';
import type { TurnContext } from './context';
import { ensureFreshStoryVault, resolveWikiTarget } from '$lib/server/wiki/storyVault';
import { getMtheriosAppConfig } from '$lib/server/app/config';

function nowIso(): string {
	return new Date().toISOString();
}

function monotonicNow(): number {
	return globalThis.performance?.now?.() ?? Date.now();
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function hashText(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function preparedTurnCacheKey(storyId: string, clientTurnId: string): string {
	return `${storyId}:${clientTurnId}`;
}

function preparedTurnFingerprint(request: TurnRequest): string {
	return hashText(stableJson({
		storyId: request.storyId,
		clientTurnId: request.clientTurnId,
		playerText: request.playerText,
		clientContext: request.clientContext ?? null,
	}));
}

function trimPreparedTurnCache(now = Date.now()): void {
	for (const [key, entry] of preparedTurnCache) {
		if (entry.expiresAt <= now) preparedTurnCache.delete(key);
	}
	while (preparedTurnCache.size > PREPARED_TURN_CACHE_MAX) {
		const oldest = preparedTurnCache.keys().next().value;
		if (!oldest) break;
		preparedTurnCache.delete(oldest);
	}
}

function readPreparedTurn(request: TurnRequest, consume: boolean): PreparedServerTurnContext | null {
	trimPreparedTurnCache();
	const key = preparedTurnCacheKey(request.storyId, request.clientTurnId);
	const entry = preparedTurnCache.get(key);
	if (!entry || entry.fingerprint !== preparedTurnFingerprint(request)) return null;
	if (consume) preparedTurnCache.delete(key);
	return entry.prepared;
}

function writePreparedTurn(prepared: PreparedServerTurnContext): void {
	trimPreparedTurnCache();
	preparedTurnCache.set(preparedTurnCacheKey(prepared.request.storyId, prepared.request.clientTurnId), {
		fingerprint: preparedTurnFingerprint(prepared.request),
		expiresAt: Date.now() + PREPARED_TURN_TTL_MS,
		prepared,
	});
	trimPreparedTurnCache();
}

type ProviderProfile = NonNullable<TurnRequest['providerProfile']>;
type GenerationTiming = NonNullable<TurnResponse['generationTimings']>[number];
type ResolvedGenerationService = Awaited<ReturnType<typeof resolveServiceGeneration>>;
type ServerTurnPrompt = ReturnType<typeof buildServerTurnPrompt>;
type MemorySettings = {
	chapterThreshold: number;
	postChapterBuffer: number;
	chaptersPerArc: number;
};

interface ServerWikiContext {
	markdown: string;
	citations: string[];
	pageCount: number;
	seedCount: number;
	semanticError?: string | null;
	sourcePaths: string[];
	cacheHit?: boolean;
}

type WikiContextLoader = () => Promise<unknown>;
type WikiContextSourceHasher = (sourcePaths: string[]) => Promise<string[]>;

interface LoadServerWikiContextCacheOptions {
	repository?: EngineCacheRepository;
	loadContext?: WikiContextLoader;
	sourceHash?: WikiContextSourceHasher;
}

const DEFAULT_MEMORY_TOKEN_BUDGET = 800;
const MAX_CLASSIFIER_TOKENS = 2048;
const WIKI_CONTEXT_LIMIT = 4;
const WIKI_CONTEXT_PAGE_LIMIT = 6;
const WIKI_CONTEXT_PAGE_CHARS = 700;
const WIKI_CONTEXT_MAX_CHARS = 4000;
const WIKI_CONTEXT_BUDGET_MS = 700;
const GM_TIMELINE_BRIEF_BUDGET_MS = 300;
const PREPARED_TURN_TTL_MS = 120_000;
const PREPARED_TURN_CACHE_MAX = 48;

export interface PreparedTurnPromptSummary {
	systemChars: number;
	systemDynamicChars: number;
	playerPromptChars: number;
	messageCount: number;
	messageChars: number;
	totalChars: number;
	tokenEstimate: number;
}

export interface PreparedServerTurnSummary {
	storyId: string;
	clientTurnId: string;
	playerEntryId: string;
	preparedAt: string;
	contextCounts: Record<string, number>;
	prompt: PreparedTurnPromptSummary;
	retrievedMemory: {
		nodeCount: number;
		tokenEstimate: number;
		nodeIds: string[];
	};
	wikiContext: {
		pageCount: number;
		seedCount: number;
		charCount: number;
		citations: string[];
		semanticError?: string | null;
	} | null;
	timeline: {
		currentTurn: number;
		currentWorldTime: string | null;
		dueEventCount: number;
		recentEventCount: number;
		scheduledEventCount: number;
		npcEventCount: number;
	};
	cache: EngineCacheDebug | null;
	warnings: string[];
	timings: TimingEntry[];
}

export interface TurnPerformanceSummary {
	preparedCacheHit: boolean;
	prompt: {
		tokenEstimate: number;
		totalChars: number;
		messageCount: number;
	};
	cache: {
		hitCount: number;
		missCount: number;
		tokenEstimate: number;
		segmentCount: number;
	} | null;
	generation: {
		operationCount: number;
		durationMs: number;
		requestTokens: number | null;
		responseTokens: number | null;
		totalTokens: number | null;
	};
	waterfall: {
		turnId: string | null;
		storyId: string | null;
		model: string | null;
		profile: string | null;
		totalMs: number;
		frontendOutboxFlushMs: number | null;
		commandRouterMs: number | null;
		resolveNarrativeMs: number;
		retrieveMemoryPacketMs: number;
		loadDbContextMs: number;
		loadTimelineBriefMs: number;
		loadWikiContextMs: number;
		buildPromptMs: number;
		inputTokens: number | null;
		outputTokens: number | null;
		promptBytes: number;
		recentMessageCount: number;
		wikiChunkCount: number;
		memoryItemCount: number;
		providerTimeToFirstTokenMs: number | null;
		providerTotalMs: number;
		providerRetries: number;
		providerTimeoutHit: boolean;
		persistMs: number;
		stateExtractionMode: 'deferred' | 'sync' | 'none';
		stateExtractionMs: number;
		vaultAppendMs: number;
		projectionBuildMs: number;
		cacheHit: boolean;
		stablePromptHash: string | null;
		dynamicContextHash: string | null;
	};
	topSpans: Array<{
		operation: string;
		durationMs: number;
	}>;
	slowTimings: Array<{
		operation: string;
		durationMs: number;
	}>;
}

export interface TurnContextReceipt {
	turnId: string;
	storyId: string;
	truncated: boolean;
	included: {
		recentEntries: number;
		memoryNodes: number;
		wikiChunks: number;
		timelineEvents: number;
		factionSheets: string[];
	};
	skipped: Array<{
		source: string;
		reason: string;
	}>;
	budgets: {
		memoryTokensUsed: number;
		memoryTokensMax: number;
		wikiCharsUsed: number;
		wikiCharsMax: number;
	};
}

interface PreparedServerTurnContext {
	request: TurnRequest;
	playerEntryId: string;
	preparedAt: string;
	preparedCacheHit: boolean;
	warnings: string[];
	memoryTokenBudget: number;
	memorySettings: MemorySettings;
	retrieved: RetrievedMemoryPacket;
	ctxWithTimeline: TurnContext & { gmBrief: NonNullable<TurnContext['gmBrief']> };
	gmBrief: NonNullable<TurnContext['gmBrief']>;
	wikiContext: ServerWikiContext | null;
	prompt: ServerTurnPrompt;
	narrativeService: ResolvedGenerationService;
	narrativeProfile: ProviderProfile;
	narrativeGeneration: ResolvedGenerationService['generation'];
	narrativeSystem: string;
	narrativeSystemDynamic: string;
	narrativePrompt: string;
	narrativeDebugPrompt: string;
	contextCounts: Record<string, number>;
	engineCacheDebug: EngineCacheDebug | null;
	contextReceipt: TurnContextReceipt;
}

type PreparedCacheEntry = {
	fingerprint: string;
	expiresAt: number;
	prepared: PreparedServerTurnContext;
};

const preparedTurnCache = new Map<string, PreparedCacheEntry>();

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sumNullable(values: Array<number | null | undefined>): number | null {
	let total = 0;
	let found = false;
	for (const value of values) {
		if (typeof value !== 'number' || !Number.isFinite(value)) continue;
		total += value;
		found = true;
	}
	return found ? total : null;
}

function clampInt(value: number | null | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function applyPromptContextBudget(
	value: string,
	maxChars: number | null | undefined,
): { value: string; truncated: boolean } {
	if (!maxChars || maxChars <= 0 || value.length <= maxChars) return { value, truncated: false };
	const finalInstruction = 'Return only the narration prose for the player action. Do not include JSON in this response.';
	const marker = '\n\n[Backend context budget truncated older dynamic context.]\n\n';
	if (maxChars <= marker.length + finalInstruction.length + 120 || !value.endsWith(finalInstruction)) {
		return {
			value: value.slice(0, Math.max(0, maxChars)),
			truncated: true,
		};
	}
	const headBudget = Math.max(0, maxChars - marker.length - finalInstruction.length);
	return {
		value: `${value.slice(0, headBudget).trimEnd()}${marker}${finalInstruction}`,
		truncated: true,
	};
}

export async function withBudget<T>(
	fn: () => Promise<T>,
	budgetMs: number,
	fallback: T,
): Promise<T> {
	if (!Number.isFinite(budgetMs) || budgetMs <= 0) return fn();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const guarded = fn().catch((error) => {
		if (timedOut) return fallback;
		throw error;
	});
	const timeoutPromise = new Promise<T>((resolve) => {
		timeout = setTimeout(() => {
			timedOut = true;
			resolve(fallback);
		}, budgetMs);
	});
	try {
		return await Promise.race([guarded, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function withBudgetStatus<T>(
	fn: () => Promise<T>,
	budgetMs: number,
	fallback: T,
): Promise<{ value: T; budgetExceeded: boolean }> {
	type BudgetStatus = { value: T; budgetExceeded: boolean };
	return withBudget<BudgetStatus>(
		async () => ({ value: await fn(), budgetExceeded: false }),
		budgetMs,
		{ value: fallback, budgetExceeded: true },
	);
}

function timingMs(timings: TimingEntry[], phase: string): number {
	return Math.max(0, Math.trunc(timings.find((timing) => timing.phase === phase)?.durationMs ?? 0));
}

function sumTimingMs(timings: TimingEntry[], phases: string[]): number {
	return phases.reduce((sum, phase) => sum + timingMs(timings, phase), 0);
}

function sortedTimingSpans(timings: TimingEntry[], thresholdMs = 0, limit = Number.POSITIVE_INFINITY): Array<{ operation: string; durationMs: number }> {
	return timings
		.filter((timing) => timing.durationMs >= thresholdMs)
		.map((timing) => ({
			operation: timing.phase,
			durationMs: Math.max(0, Math.trunc(timing.durationMs)),
		}))
		.sort((a, b) => b.durationMs - a.durationMs || a.operation.localeCompare(b.operation))
		.slice(0, limit);
}

function generationDuration(generationTimings: GenerationTiming[], operation: string): number {
	const timing = generationTimings.find((item) => item.operation === operation);
	return Math.max(0, Math.trunc(timing?.durationMs ?? 0));
}

function emptyServerWikiContext(): ServerWikiContext {
	return {
		markdown: '',
		citations: [],
		pageCount: 0,
		seedCount: 0,
		sourcePaths: [],
		cacheHit: false,
	};
}

function emptyGmTimelineBrief(storyId: string): NonNullable<TurnContext['gmBrief']> {
	return {
		storyId,
		currentTurn: 0,
		currentWorldTime: null,
		dueEvents: [],
		recentEvents: [],
		scheduledEvents: [],
		npcEvents: [],
	};
}

export function buildTurnContextReceipt(input: {
	turnId: string;
	storyId: string;
	truncated?: boolean;
	recentEntryCount?: number | null;
	memoryNodeCount?: number | null;
	wikiChunkCount?: number | null;
	timelineEventCount?: number | null;
	factionIds?: string[];
	skipped?: Array<{ source: string; reason: string }>;
	budgets?: Partial<TurnContextReceipt['budgets']>;
}): TurnContextReceipt {
	const clampCount = (value: number | null | undefined) => Math.max(0, Math.trunc(Number.isFinite(value) ? Number(value) : 0));
	const factionSheets = [...new Set((input.factionIds ?? []).map((id) => id.trim()).filter(Boolean))];
	const skipped = (input.skipped ?? [])
		.map((item) => ({ source: item.source.trim(), reason: item.reason.trim() }))
		.filter((item) => item.source && item.reason);
	const budgets = input.budgets ?? {};
	return {
		turnId: input.turnId,
		storyId: input.storyId,
		truncated: input.truncated === true || skipped.some((item) => item.reason.includes('truncated')),
		included: {
			recentEntries: clampCount(input.recentEntryCount),
			memoryNodes: clampCount(input.memoryNodeCount),
			wikiChunks: clampCount(input.wikiChunkCount),
			timelineEvents: clampCount(input.timelineEventCount),
			factionSheets,
		},
		skipped,
		budgets: {
			memoryTokensUsed: clampCount(budgets.memoryTokensUsed),
			memoryTokensMax: clampCount(budgets.memoryTokensMax),
			wikiCharsUsed: clampCount(budgets.wikiCharsUsed),
			wikiCharsMax: clampCount(budgets.wikiCharsMax),
		},
	};
}

export function buildTurnPerformanceSummary(input: {
	turnId?: string | null;
	storyId?: string | null;
	totalMs?: number | null;
	model?: string | null;
	profile?: string | null;
	stateExtractionMode?: 'deferred' | 'sync' | 'none';
	stablePromptHash?: string | null;
	dynamicContextHash?: string | null;
	recentMessageCount?: number | null;
	wikiChunkCount?: number | null;
	memoryItemCount?: number | null;
	preparedCacheHit: boolean;
	prompt: {
		tokenEstimate: number;
		totalChars: number;
		messageCount: number;
	};
	cache: EngineCacheDebug | null;
	generationTimings: GenerationTiming[];
	timings: TimingEntry[];
	slowTimingThresholdMs?: number;
}): TurnPerformanceSummary {
	const slowTimingThresholdMs = Math.max(0, Math.trunc(input.slowTimingThresholdMs ?? 500));
	const generation = {
		operationCount: input.generationTimings.length,
		durationMs: input.generationTimings.reduce((sum, timing) => sum + Math.max(0, Math.trunc(timing.durationMs)), 0),
		requestTokens: sumNullable(input.generationTimings.map((timing) => timing.requestTokens)),
		responseTokens: sumNullable(input.generationTimings.map((timing) => timing.responseTokens)),
		totalTokens: sumNullable(input.generationTimings.map((timing) => timing.totalTokens)),
	};
	const cacheHit = input.preparedCacheHit || (input.cache?.hitCount ?? 0) > 0;
	const waterfall = {
		turnId: input.turnId ?? null,
		storyId: input.storyId ?? null,
		model: input.model ?? null,
		profile: input.profile ?? null,
		totalMs: Math.max(0, Math.trunc(input.totalMs ?? 0)),
		frontendOutboxFlushMs: null,
		commandRouterMs: null,
		resolveNarrativeMs: timingMs(input.timings, 'turn.service_config.narrative'),
		retrieveMemoryPacketMs: timingMs(input.timings, 'turn.memory_retrieval'),
		loadDbContextMs: timingMs(input.timings, 'turn.context_load'),
		loadTimelineBriefMs: timingMs(input.timings, 'turn.gm_timeline_brief'),
		loadWikiContextMs: timingMs(input.timings, 'turn.wiki_context'),
		buildPromptMs: timingMs(input.timings, 'turn.prompt_assembly'),
		inputTokens: generation.requestTokens,
		outputTokens: generation.responseTokens,
		promptBytes: Math.max(0, Math.trunc(input.prompt.totalChars)),
		recentMessageCount: Math.max(0, Math.trunc(input.recentMessageCount ?? input.prompt.messageCount)),
		wikiChunkCount: Math.max(0, Math.trunc(input.wikiChunkCount ?? 0)),
		memoryItemCount: Math.max(0, Math.trunc(input.memoryItemCount ?? 0)),
		providerTimeToFirstTokenMs: null,
		providerTotalMs: generationDuration(input.generationTimings, 'turn.narration'),
		providerRetries: 0,
		providerTimeoutHit: false,
		persistMs: sumTimingMs(input.timings, [
			'turn.persistence.allocate_position_version',
			'turn.persistence.entries',
		]),
		stateExtractionMode: input.stateExtractionMode ?? 'none',
		stateExtractionMs: sumTimingMs(input.timings, [
			'turn.llm.state_extraction',
			'turn.state_extraction.enqueue',
		]),
		vaultAppendMs: timingMs(input.timings, 'turn.campaign_vault.append_evidence'),
		projectionBuildMs: timingMs(input.timings, 'turn.final_response.readback'),
		cacheHit,
		stablePromptHash: input.stablePromptHash ?? null,
		dynamicContextHash: input.dynamicContextHash ?? null,
	} satisfies TurnPerformanceSummary['waterfall'];
	return {
		preparedCacheHit: input.preparedCacheHit,
		prompt: {
			tokenEstimate: Math.max(0, Math.trunc(input.prompt.tokenEstimate)),
			totalChars: Math.max(0, Math.trunc(input.prompt.totalChars)),
			messageCount: Math.max(0, Math.trunc(input.prompt.messageCount)),
		},
		cache: input.cache ? {
			hitCount: Math.max(0, Math.trunc(input.cache.hitCount)),
			missCount: Math.max(0, Math.trunc(input.cache.missCount)),
			tokenEstimate: Math.max(0, Math.trunc(input.cache.tokenEstimate ?? 0)),
			segmentCount: input.cache.segments.length,
		} : null,
		generation,
		waterfall,
		topSpans: sortedTimingSpans(input.timings, 0, 8),
		slowTimings: sortedTimingSpans(input.timings, slowTimingThresholdMs),
	};
}

function slowTurnThresholdMs(): number {
	const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.MTHERIOS_SLOW_TURN_MS;
	const parsed = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8_000;
}

export function logSlowTurn(
	performance: TurnPerformanceSummary,
	thresholdMs = slowTurnThresholdMs(),
	warn: (message: string, payload: Record<string, unknown>) => void = console.warn,
): void {
	if (performance.waterfall.totalMs < thresholdMs) return;
	warn('[slow-turn]', {
		turnId: performance.waterfall.turnId,
		storyId: performance.waterfall.storyId,
		totalMs: performance.waterfall.totalMs,
		model: performance.waterfall.model,
		topSpans: performance.topSpans.slice(0, 8),
	});
}

function generationErrorResult(error: unknown): ServerGenerationError['result'] | null {
	return error instanceof ServerGenerationError ? error.result : null;
}

function timingFromResult(
	operation: string,
	serviceId: string,
	result: ServerGenerationResult | ServerGenerationError['result'],
	status: 'success' | 'error',
): GenerationTiming {
	const usage = 'usage' in result ? result.usage : undefined;
	return {
		operation,
		serviceId,
		model: result.model ?? null,
		status,
		durationMs: Math.max(0, Math.trunc(result.durationMs)),
		requestTokens: usage?.requestTokens ?? null,
		responseTokens: usage?.responseTokens ?? null,
		totalTokens: usage?.totalTokens ?? null,
	};
}

async function logGenerationCall(options: {
	storyId: string;
	clientTurnId: string;
	serviceId: string;
	operation: string;
	profile: ProviderProfile;
	result: ServerGenerationResult | ServerGenerationError['result'];
	status: 'success' | 'error';
	error?: unknown;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	const usage = 'usage' in options.result ? options.result.usage : undefined;
	await recordApiCallLog({
		storyId: options.storyId,
		serviceId: options.serviceId,
		operation: options.operation,
		providerType: options.profile.providerType,
		providerName: options.profile.name ?? null,
		profileId: options.profile.id ?? null,
		model: options.result.model,
		endpoint: options.result.endpoint,
		status: options.status,
		durationMs: options.result.durationMs,
		requestTokens: usage?.requestTokens ?? null,
		responseTokens: usage?.responseTokens ?? null,
		totalTokens: usage?.totalTokens ?? null,
		promptChars: options.result.promptChars,
		responseChars: 'responseChars' in options.result ? options.result.responseChars ?? null : null,
		error: options.error ? (options.error instanceof Error ? options.error.message : String(options.error)) : null,
		metadata: {
			clientTurnId: options.clientTurnId,
			...options.metadata,
		},
	});
}

function extractServerWikiContext(result: unknown): ServerWikiContext {
	const record = asRecord(result);
	const pages = Array.isArray(record.pages)
		? record.pages
			.map((page) => asRecord(page))
			.map((page) => typeof page.path === 'string' ? page.path : '')
			.filter(Boolean)
		: [];
	return {
		markdown: typeof record.contextMarkdown === 'string' ? record.contextMarkdown : '',
		citations: asStringArray(record.citations),
		pageCount: asNumber(record.pageCount),
		seedCount: asNumber(record.seedCount),
		semanticError: typeof record.semanticError === 'string' ? record.semanticError : null,
		sourcePaths: [...new Set(pages)],
		cacheHit: false,
	};
}

function wikiContextCachePayload(context: ServerWikiContext): string {
	return JSON.stringify({
		markdown: context.markdown,
		citations: context.citations,
		pageCount: context.pageCount,
		seedCount: context.seedCount,
		semanticError: context.semanticError ?? null,
		sourcePaths: context.sourcePaths,
	});
}

function parseWikiContextCachePayload(value: string): ServerWikiContext | null {
	try {
		const record = asRecord(JSON.parse(value));
		const markdown = typeof record.markdown === 'string' ? record.markdown : '';
		if (!markdown.trim()) return null;
		return {
			markdown,
			citations: asStringArray(record.citations),
			pageCount: asNumber(record.pageCount),
			seedCount: asNumber(record.seedCount),
			semanticError: typeof record.semanticError === 'string' ? record.semanticError : null,
			sourcePaths: asStringArray(record.sourcePaths),
			cacheHit: true,
		};
	} catch {
		return null;
	}
}

function wikiContextCacheKey(storyId: string, query: string): string {
	return buildEngineCacheKey({
		storyId,
		kind: 'wiki_context_pack',
		parts: [
			'turn-prepare',
			query,
			WIKI_CONTEXT_LIMIT,
			1,
			WIKI_CONTEXT_PAGE_LIMIT,
			WIKI_CONTEXT_PAGE_CHARS,
			WIKI_CONTEXT_MAX_CHARS,
		],
	});
}

function isPathInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function hashWikiContextSourceFiles(storyId: string, sourcePaths: string[]): Promise<string[]> {
	if (sourcePaths.length === 0) return [];
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget({ storyId }, config);
	const root = path.resolve(target.vaultPath);
	const hashes: string[] = [];
	for (const sourcePath of sourcePaths) {
		const absolutePath = path.resolve(root, sourcePath);
		if (!isPathInside(root, absolutePath)) {
			hashes.push(engineCacheDependencyHash({ path: sourcePath, invalid: true }));
			continue;
		}
		try {
			const content = await fs.readFile(absolutePath, 'utf8');
			hashes.push(engineCacheDependencyHash({
				path: sourcePath,
				contentHash: hashText(content),
			}));
		} catch (error) {
			hashes.push(engineCacheDependencyHash({
				path: sourcePath,
				missing: true,
				error: error instanceof Error ? error.message : String(error),
			}));
		}
	}
	return hashes;
}

function turnContextCounts(ctx: Awaited<ReturnType<typeof loadTurnContext>>): Record<string, number> {
	const gmDueEvents = ctx.gmBrief?.dueEvents.length ?? 0;
	const gmRecentEvents = ctx.gmBrief?.recentEvents.length ?? 0;
	const gmScheduledEvents = ctx.gmBrief?.scheduledEvents.length ?? 0;
	const gmNpcEvents = ctx.gmBrief?.npcEvents.length ?? 0;
	return {
		recentEntries: ctx.recentEntries.length,
		entities: ctx.entities.length,
		factions: ctx.factions.length,
		factionMemberships: ctx.factionMemberships.length,
		factionResources: ctx.factionResources.length,
		factionGoals: ctx.factionGoals.length,
		factionProjects: ctx.factionProjects.length,
		agreements: ctx.agreements.length,
		threads: ctx.threads.length,
		events: ctx.events.length,
		beliefs: ctx.beliefs.length,
		chapters: ctx.chapters.length,
		arcs: ctx.arcs.length,
		sagas: ctx.sagas.length,
		gmDueEvents,
		gmRecentEvents,
		gmScheduledEvents,
		gmNpcEvents,
		gmTimelineEvents: gmDueEvents + gmRecentEvents + gmScheduledEvents,
	};
}

export async function loadServerWikiContextWithCache(
	storyId: string,
	query: string,
	options: LoadServerWikiContextCacheOptions = {},
): Promise<ServerWikiContext> {
	const cacheKey = wikiContextCacheKey(storyId, query);
	const repository = options.repository;
	const loadContext = options.loadContext ?? (() => contextWiki({
		storyId,
		query,
		limit: WIKI_CONTEXT_LIMIT,
		followDepth: 1,
		pageLimit: WIKI_CONTEXT_PAGE_LIMIT,
		pageChars: WIKI_CONTEXT_PAGE_CHARS,
		maxChars: WIKI_CONTEXT_MAX_CHARS,
	}));
	const sourceHash = options.sourceHash ?? ((sourcePaths: string[]) => hashWikiContextSourceFiles(storyId, sourcePaths));
	if (!options.sourceHash) {
		await ensureFreshStoryVault(storyId);
	}

	const candidate = await readEngineCacheSegment({
		storyId,
		kind: 'wiki_context_pack',
		cacheKey,
		touch: false,
	}, repository);
	const cachedContext = candidate ? parseWikiContextCachePayload(candidate.value) : null;
	if (cachedContext && cachedContext.sourcePaths.length > 0) {
		const dependencyHashes = await sourceHash(cachedContext.sourcePaths);
		const hit = await readEngineCacheSegment({
			storyId,
			kind: 'wiki_context_pack',
			cacheKey,
			dependencyHashes,
		}, repository);
		if (hit) return cachedContext;
	}

	const context = extractServerWikiContext(await loadContext());
	const dependencyHashes = context.sourcePaths.length > 0
		? await sourceHash(context.sourcePaths)
		: [engineCacheDependencyHash({
			queryHash: hashText(query),
			markdown: context.markdown,
			pageCount: context.pageCount,
			seedCount: context.seedCount,
		})];
	await recordEngineCacheSegment({
		storyId,
		kind: 'wiki_context_pack',
		cacheKey,
		value: wikiContextCachePayload(context),
		tokenEstimate: Math.max(1, Math.ceil(context.markdown.length / 4)),
		dependencyHashes,
		metadata: {
			queryHash: hashText(query),
			pageCount: context.pageCount,
			seedCount: context.seedCount,
			sourcePathCount: context.sourcePaths.length,
			sourcePaths: context.sourcePaths.slice(0, 20),
			hasSemanticError: Boolean(context.semanticError),
		},
	}, repository);
	return context;
}

async function loadServerWikiContext(storyId: string, query: string): Promise<ServerWikiContext> {
	return loadServerWikiContextWithCache(storyId, query);
}

async function nextEntryPosition(storyId: string): Promise<number> {
	const db = getDb();
	const [last] = await db
		.select({ position: storyEntries.position })
		.from(storyEntries)
		.where(eq(storyEntries.storyId, storyId))
		.orderBy(desc(storyEntries.position))
		.limit(1);
	return (last?.position ?? -1) + 1;
}

async function existingTurn(storyId: string, clientTurnId: string): Promise<TurnResponse | null> {
	const db = getDb();
	const playerEntryId = `entry_${clientTurnId}`;
	const assistantEntryId = `narration_${clientTurnId}`;
	const rows = await db
		.select()
		.from(storyEntries)
		.where(eq(storyEntries.storyId, storyId))
		.limit(200);
	const player = rows.find((entry) => entry.id === playerEntryId);
	const assistant = rows.find((entry) => entry.id === assistantEntryId);
	if (!player && !assistant) return null;
	const serverVersion = Math.max(player?.serverVersion ?? 0, assistant?.serverVersion ?? 0);
	return {
		narration: assistant?.content ?? '',
		entries: [player, assistant].filter(Boolean) as Array<Record<string, unknown>>,
		playerEntryId: player?.id ?? null,
		assistantEntryId: assistant?.id ?? null,
		statePatchIds: [],
		eventIds: [],
		retrievedMemoryIds: [],
		memoryNodeIds: [],
		serverVersion,
		syncChanges: await getSyncChanges(storyId, 0),
		warnings: ['Turn was already processed; returning existing backend entries.'],
		generationTimings: [],
		performance: null,
		contextReceipt: null,
	};
}

function summarizePreparedTurnContext(
	prepared: PreparedServerTurnContext,
	timings: TimingEntry[] = [],
): PreparedServerTurnSummary {
	const messageChars = prepared.prompt.messages.reduce((sum, message) => sum + message.content.length, 0);
	const totalChars = prepared.narrativeSystem.length
		+ prepared.narrativeSystemDynamic.length
		+ prepared.narrativePrompt.length
		+ messageChars;
	return {
		storyId: prepared.request.storyId,
		clientTurnId: prepared.request.clientTurnId,
		playerEntryId: prepared.playerEntryId,
		preparedAt: prepared.preparedAt,
		contextCounts: { ...prepared.contextCounts },
		prompt: {
			systemChars: prepared.narrativeSystem.length,
			systemDynamicChars: prepared.narrativeSystemDynamic.length,
			playerPromptChars: prepared.narrativePrompt.length,
			messageCount: prepared.prompt.messages.length,
			messageChars,
			totalChars,
			tokenEstimate: Math.max(1, Math.ceil(totalChars / 4)),
		},
		retrievedMemory: {
			nodeCount: prepared.retrieved.nodes.length,
			tokenEstimate: prepared.retrieved.tokenEstimate,
			nodeIds: prepared.retrieved.nodes.map((node) => node.id),
		},
		wikiContext: prepared.wikiContext ? {
			pageCount: prepared.wikiContext.pageCount,
			seedCount: prepared.wikiContext.seedCount,
			charCount: prepared.wikiContext.markdown.length,
			citations: [...prepared.wikiContext.citations],
			semanticError: prepared.wikiContext.semanticError ?? null,
		} : null,
		timeline: {
			currentTurn: prepared.gmBrief.currentTurn,
			currentWorldTime: prepared.gmBrief.currentWorldTime,
			dueEventCount: prepared.gmBrief.dueEvents.length,
			recentEventCount: prepared.gmBrief.recentEvents.length,
			scheduledEventCount: prepared.gmBrief.scheduledEvents.length,
			npcEventCount: prepared.gmBrief.npcEvents.length,
		},
		cache: prepared.engineCacheDebug,
		warnings: [...prepared.warnings],
		timings,
	};
}

export async function prepareServerTurnContext(
	input: unknown,
	options: {
		recorder?: TimingRecorder;
		cachePrepared?: boolean;
		consumePrepared?: boolean;
	} = {},
): Promise<PreparedServerTurnContext> {
	const request = turnRequestSchema.parse(input);
	const recorder = options.recorder ?? createTimingRecorder({
		pipeline: 'backend.turn.prepare',
		metadata: {
			storyId: request.storyId,
			clientTurnId: request.clientTurnId,
		},
	});
	const cached = options.consumePrepared ? readPreparedTurn(request, true) : null;
	if (cached) {
		recorder.record('turn.prepare.cache_hit', 0, {
			preparedAt: cached.preparedAt,
			contextCounts: cached.contextCounts,
		});
		return { ...cached, preparedCacheHit: true };
	}

	const playerEntryId = `entry_${request.clientTurnId}`;
	const warnings: string[] = [];
	const contextSkipped: TurnContextReceipt['skipped'] = [];
	const narrativeService = await recorder.time('turn.service_config.narrative', {}, () => resolveServiceGeneration('narrative'));
	const narrativeProfile = requireResolvedServiceProfile('narrative', narrativeService);
	const narrativeGeneration = narrativeService.generation;
	const memoryTokenBudget = clampInt(request.clientContext?.memoryTokenBudget, 160, 2400, DEFAULT_MEMORY_TOKEN_BUDGET);
	const memorySettings = {
		chapterThreshold: clampInt(request.clientContext?.chapterThreshold, 5, 200, 20),
		postChapterBuffer: clampInt(request.clientContext?.postChapterBuffer, 0, 100, 10),
		chaptersPerArc: clampInt(request.clientContext?.chaptersPerArc, 2, 50, 5),
	};

	const retrievalRequest = {
		storyId: request.storyId,
		query: request.playerText,
		sceneEntityIds: request.clientContext?.sceneEntityIds ?? [],
		presentNpcIds: request.clientContext?.presentNpcIds ?? [],
		locationId: request.clientContext?.locationId ?? null,
		threadIds: request.clientContext?.threadIds ?? [],
		currentFactionId: request.clientContext?.currentFactionId ?? null,
		tokenBudget: memoryTokenBudget,
	};
	const wikiContextTask = recorder.time('turn.wiki_context', {
		limit: WIKI_CONTEXT_LIMIT,
		pageLimit: WIKI_CONTEXT_PAGE_LIMIT,
		maxChars: WIKI_CONTEXT_MAX_CHARS,
		budgetMs: WIKI_CONTEXT_BUDGET_MS,
	}, async () => {
		try {
			const context = await withBudgetStatus(
				() => loadServerWikiContext(request.storyId, request.playerText),
				WIKI_CONTEXT_BUDGET_MS,
				emptyServerWikiContext(),
			);
			return { ok: true as const, ...context };
		} catch (error) {
			return { ok: false as const, error };
		}
	});
	const [retrieved, ctx, gmBriefResult, wikiResult] = await recorder.time('turn.context_assembly', {
		parallel: true,
		memoryTokenBudget,
	}, () => Promise.all([
		recorder.time('turn.memory_retrieval', {
			tokenBudget: memoryTokenBudget,
			sceneEntityIds: retrievalRequest.sceneEntityIds.length,
			presentNpcIds: retrievalRequest.presentNpcIds.length,
			threadIds: retrievalRequest.threadIds.length,
		}, () => retrieveMemoryPacket(retrievalRequest)),
		recorder.time('turn.context_load', {
			presentNpcIds: request.clientContext?.presentNpcIds?.length ?? 0,
			sceneEntityIds: retrievalRequest.sceneEntityIds.length,
		}, () => loadTurnContext(request.storyId, request.clientContext?.presentNpcIds ?? [], retrievalRequest.sceneEntityIds)),
		recorder.time('turn.gm_timeline_brief', {
			sceneEntityIds: retrievalRequest.sceneEntityIds.length,
			presentNpcIds: retrievalRequest.presentNpcIds.length,
			budgetMs: GM_TIMELINE_BRIEF_BUDGET_MS,
		}, async () => {
			try {
				const brief = await withBudgetStatus(
					() => loadGmTimelineBrief({
						storyId: request.storyId,
						sceneEntityIds: retrievalRequest.sceneEntityIds,
						presentNpcIds: retrievalRequest.presentNpcIds,
						includeSecret: true,
					}),
					GM_TIMELINE_BRIEF_BUDGET_MS,
					emptyGmTimelineBrief(request.storyId),
				);
				return { ok: true as const, ...brief };
			} catch (error) {
				return { ok: false as const, error, value: emptyGmTimelineBrief(request.storyId), budgetExceeded: false };
			}
		}),
		wikiContextTask,
	]));
	const gmBrief = gmBriefResult.value;
	if (gmBriefResult.ok) {
		if (gmBriefResult.budgetExceeded) {
			contextSkipped.push({ source: 'timeline', reason: 'budget_exceeded' });
			warnings.push(`GM timeline brief skipped after ${GM_TIMELINE_BRIEF_BUDGET_MS}ms budget.`);
		}
	} else {
		const error = gmBriefResult.error;
		contextSkipped.push({ source: 'timeline', reason: 'unavailable' });
		warnings.push(`GM timeline brief unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const ctxWithTimeline: TurnContext & { gmBrief: NonNullable<TurnContext['gmBrief']> } = { ...ctx, gmBrief };
	let wikiContext: ServerWikiContext | null = null;
	if (wikiResult.ok) {
		wikiContext = wikiResult.value;
		if (wikiResult.budgetExceeded) {
			contextSkipped.push({ source: 'wiki', reason: 'budget_exceeded' });
			warnings.push(`Terminal wiki context skipped after ${WIKI_CONTEXT_BUDGET_MS}ms budget.`);
		}
		if (wikiContext.semanticError) warnings.push(`Terminal wiki semantic search warning: ${wikiContext.semanticError}`);
	} else {
		const error = wikiResult.error;
		contextSkipped.push({ source: 'wiki', reason: 'unavailable' });
		warnings.push(`Terminal wiki context unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const contextCounts = turnContextCounts(ctxWithTimeline);
	const prompt = recorder.timeSync('turn.prompt_assembly', {
		retrievedMemoryNodes: retrieved.nodes.length,
		wikiContextChars: wikiContext?.markdown.length ?? 0,
		...contextCounts,
	}, () => buildServerTurnPrompt(ctxWithTimeline, retrieved, playerEntryId, {
		currentFactionId: request.clientContext?.currentFactionId ?? null,
		sceneEntityIds: request.clientContext?.sceneEntityIds ?? [],
		wikiContextMarkdown: wikiContext?.markdown ?? null,
	}));
	const narrativeSystem = narrativeService.systemPromptOverride?.trim() || prompt.system;
	const promptBudget = applyPromptContextBudget(prompt.prompt, request.clientContext?.contextBudget ?? 0);
	if (promptBudget.truncated) {
		contextSkipped.push({ source: 'dynamic_context', reason: 'truncated_by_context_budget' });
		warnings.push(`Dynamic prompt context budget applied: ${prompt.prompt.length} -> ${promptBudget.value.length} chars.`);
	}
	const narrativeSystemDynamic = promptBudget.value;
	const narrativePrompt = `Player action:\n${request.playerText}`;
	const narrativeDebugPrompt = `${narrativeSystemDynamic}\n\n${narrativePrompt}`;
	recorder.record('turn.prompt_payload', 0, {
		systemChars: narrativeSystem.length,
		systemDynamicChars: narrativeSystemDynamic.length,
		promptChars: narrativePrompt.length,
		messageCount: prompt.messages.length,
		messageChars: prompt.messages.reduce((sum, message) => sum + message.content.length, 0),
	});
	let promptCacheStats: { hitCount: number; missCount: number; segments: RecordEngineCacheSegmentResult[] } | null = null;
	try {
		promptCacheStats = await recorder.time('turn.engine_cache.prompt_segments', {
			retrievedMemoryNodes: retrieved.nodes.length,
			wikiContextChars: wikiContext?.markdown.length ?? 0,
		}, () => recordPromptCacheSegments({
			storyId: request.storyId,
			segments: [
				{
					kind: 'prompt_system',
					cacheKey: buildEngineCacheKey({
						storyId: request.storyId,
						kind: 'prompt_system',
						parts: ['narrative', narrativeProfile.providerType, narrativeGeneration.model ?? 'default'],
					}),
					value: narrativeSystem,
					dependencyHashes: [engineCacheDependencyHash({
						service: 'narrative',
						providerType: narrativeProfile.providerType,
						model: narrativeGeneration.model ?? null,
						systemPromptOverride: narrativeService.systemPromptOverride ?? null,
					})],
				},
				{
					kind: 'retrieved_memory',
					cacheKey: buildEngineCacheKey({
						storyId: request.storyId,
						kind: 'retrieved_memory',
						parts: ['selected-memory-packet'],
					}),
					value: retrieved.packet,
					tokenEstimate: retrieved.tokenEstimate,
					dependencyHashes: retrieved.nodes.map((node) => engineCacheDependencyHash({
						id: node.id,
						type: node.type,
						updatedAt: node.updatedAt,
						content: node.content,
						summary: node.summary,
					})),
					metadata: { nodeCount: retrieved.nodes.length },
				},
				{
					kind: 'wiki_context',
					cacheKey: buildEngineCacheKey({
						storyId: request.storyId,
						kind: 'wiki_context',
						parts: ['selected-markdown-chunks'],
					}),
					value: wikiContext?.markdown ?? '',
					dependencyHashes: [engineCacheDependencyHash({
						citations: wikiContext?.citations ?? [],
						pageCount: wikiContext?.pageCount ?? 0,
						markdown: wikiContext?.markdown ?? '',
					})],
					metadata: {
						citations: wikiContext?.citations ?? [],
						pageCount: wikiContext?.pageCount ?? 0,
					},
				},
				{
					kind: 'campaign_continuity',
					cacheKey: buildEngineCacheKey({
						storyId: request.storyId,
						kind: 'campaign_continuity',
						parts: ['chapters-arcs-sagas'],
					}),
					value: stableJson({
						chapters: ctxWithTimeline.chapters,
						arcs: ctxWithTimeline.arcs,
						sagas: ctxWithTimeline.sagas,
					}),
					dependencyHashes: [
						...ctxWithTimeline.chapters.map((chapter) => engineCacheDependencyHash({
							id: chapter.id,
							type: 'chapter',
							number: chapter.number,
							updatedAt: chapter.updatedAt,
							sceneOutcome: chapter.sceneOutcome,
							openThreads: chapter.openThreads,
						})),
						...ctxWithTimeline.arcs.map((arc) => engineCacheDependencyHash({
							id: arc.id,
							type: 'arc',
							number: arc.number,
							updatedAt: arc.updatedAt,
							summary: arc.summary,
							openThreadIds: arc.openThreadIds,
						})),
						...ctxWithTimeline.sagas.map((saga) => engineCacheDependencyHash({
							id: saga.id,
							type: 'saga',
							number: saga.number,
							updatedAt: saga.updatedAt,
							summary: saga.summary,
							lingeringThreads: saga.lingeringThreads,
						})),
					],
					metadata: {
						chapterCount: ctxWithTimeline.chapters.length,
						arcCount: ctxWithTimeline.arcs.length,
						sagaCount: ctxWithTimeline.sagas.length,
					},
				},
				{
					kind: 'tool_schema',
					cacheKey: buildEngineCacheKey({
						storyId: request.storyId,
						kind: 'tool_schema',
						parts: ['world-state-update', 'v1'],
					}),
					value: 'worldStateUpdateSchema:v1',
					dependencyHashes: [engineCacheDependencyHash('worldStateUpdateSchema:v1')],
				},
			],
		}));
	} catch (error) {
		warnings.push(`Engine prompt cache unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const contextReceipt = buildTurnContextReceipt({
		turnId: request.clientTurnId,
		storyId: request.storyId,
		truncated: promptBudget.truncated,
		recentEntryCount: ctxWithTimeline.recentEntries.length,
		memoryNodeCount: retrieved.nodes.length,
		wikiChunkCount: wikiContext?.pageCount ?? 0,
		timelineEventCount: gmBrief.dueEvents.length + gmBrief.recentEvents.length + gmBrief.scheduledEvents.length,
		factionIds: [
			request.clientContext?.currentFactionId ?? '',
			...ctxWithTimeline.factions.map((faction) => faction.id),
		].filter(Boolean).slice(0, 20),
		skipped: contextSkipped,
		budgets: {
			memoryTokensUsed: retrieved.tokenEstimate,
			memoryTokensMax: memoryTokenBudget,
			wikiCharsUsed: wikiContext?.markdown.length ?? 0,
			wikiCharsMax: WIKI_CONTEXT_MAX_CHARS,
		},
	});
	const prepared: PreparedServerTurnContext = {
		request,
		playerEntryId,
		preparedAt: nowIso(),
		preparedCacheHit: false,
		warnings,
		memoryTokenBudget,
		memorySettings,
		retrieved,
		ctxWithTimeline,
		gmBrief,
		wikiContext,
		prompt,
		narrativeService,
		narrativeProfile,
		narrativeGeneration,
		narrativeSystem,
		narrativeSystemDynamic,
		narrativePrompt,
		narrativeDebugPrompt,
		contextCounts,
		engineCacheDebug: buildEngineCacheDebug(promptCacheStats) ?? null,
		contextReceipt,
	};
	if (options.cachePrepared) writePreparedTurn(prepared);
	return prepared;
}

export async function prepareServerTurn(input: unknown): Promise<PreparedServerTurnSummary> {
	const request = turnRequestSchema.parse(input);
	const recorder = createTimingRecorder({
		pipeline: 'backend.turn.prepare',
		metadata: {
			storyId: request.storyId,
			clientTurnId: request.clientTurnId,
		},
	});
	const prepared = await prepareServerTurnContext(request, { recorder, cachePrepared: true });
	return summarizePreparedTurnContext(prepared, recorder.timings);
}

export async function processServerTurn(input: unknown): Promise<TurnResponse> {
	const turnStartedAt = monotonicNow();
	const request = turnRequestSchema.parse(input);
	const recorder = createTimingRecorder({
		pipeline: 'backend.turn.generation',
		metadata: {
			storyId: request.storyId,
			clientTurnId: request.clientTurnId,
		},
	});
	recorder.record('turn.request_start', 0, {
		localVersion: request.localVersion,
		hasClientContext: Boolean(request.clientContext),
	});
	const existing = await recorder.time('turn.idempotency_check', {}, () => existingTurn(request.storyId, request.clientTurnId));
	if (existing) {
		recorder.record('turn.response_cached', 0, { serverVersion: existing.serverVersion });
		return existing;
	}

	const db = getDb();
	const createdAt = nowIso();
	const assistantEntryId = `narration_${request.clientTurnId}`;
	const prepared = await prepareServerTurnContext(request, { recorder, consumePrepared: true });
	const {
		playerEntryId,
		retrieved,
		gmBrief,
		wikiContext,
		prompt,
		narrativeProfile,
		narrativeGeneration,
		narrativeSystem,
		narrativeSystemDynamic,
		narrativePrompt,
		narrativeDebugPrompt,
		contextCounts,
		engineCacheDebug,
		contextReceipt,
		memoryTokenBudget,
		memorySettings,
	} = prepared;
	const warnings: string[] = [...prepared.warnings];
	const classifierService = await recorder.time('turn.service_config.classifier', {}, () => resolveServiceGeneration('classifier'));
	const classifierProfile = classifierService.profile ?? narrativeProfile;
	const classifierGeneration = classifierService.profile
		? {
			...classifierService.generation,
			temperature: classifierService.generation.temperature ?? 0.2,
			maxTokens: Math.min(classifierService.generation.maxTokens ?? MAX_CLASSIFIER_TOKENS, MAX_CLASSIFIER_TOKENS),
		}
		: {
			model: narrativeGeneration.model,
			temperature: 0.2,
			maxTokens: Math.min(narrativeGeneration.maxTokens ?? MAX_CLASSIFIER_TOKENS, MAX_CLASSIFIER_TOKENS),
		};
	if (classifierService.missingReason) {
		warnings.push(`Classifier service fallback: ${classifierService.missingReason}`);
	}
	const deferStateExtraction = request.clientContext?.deferStateExtraction !== false;
	const generationTimings: GenerationTiming[] = [];
	const narrativeDebugBase = {
		kind: 'narration' as const,
		playerText: request.playerText,
		system: narrativeSystem,
		messages: prompt.messages,
		prompt: narrativeDebugPrompt,
		retrievedMemory: retrieved,
		wikiContext,
		contextCounts,
		engineCache: engineCacheDebug,
	};

	let narration = '';
	try {
		const result = await generateServerTextWithMetrics({
			profile: narrativeProfile,
			model: narrativeGeneration.model,
			temperature: narrativeGeneration.temperature,
			maxTokens: narrativeGeneration.maxTokens,
			system: narrativeSystem,
			systemDynamic: narrativeSystemDynamic,
			messages: prompt.messages,
			prompt: narrativePrompt,
		});
		narration = result.text;
		generationTimings.push(timingFromResult('turn.narration', 'narrative', result, 'success'));
		recorder.record('turn.llm.narration', result.durationMs, {
			serviceId: 'narrative',
			model: result.model,
			status: 'success',
			promptChars: result.promptChars,
			responseChars: result.responseChars,
			requestTokens: result.usage.requestTokens,
			responseTokens: result.usage.responseTokens,
			totalTokens: result.usage.totalTokens,
			maxOutputTokens: narrativeGeneration.maxTokens,
			retryCount: 0,
		});
		await logGenerationCall({
			storyId: request.storyId,
			clientTurnId: request.clientTurnId,
			serviceId: 'narrative',
			operation: 'turn.narration',
			profile: narrativeProfile,
			result,
			status: 'success',
			metadata: {
				wikiContextPageCount: wikiContext?.pageCount ?? 0,
				wikiContextSeedCount: wikiContext?.seedCount ?? 0,
				retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
				debugSnapshot: buildTurnDebugSnapshot({
					...narrativeDebugBase,
					output: narration,
				}),
			},
		});
	} catch (error) {
		const failedResult = generationErrorResult(error);
		if (failedResult) {
			generationTimings.push(timingFromResult('turn.narration', 'narrative', failedResult, 'error'));
			recorder.record('turn.llm.narration', failedResult.durationMs, {
				serviceId: 'narrative',
				model: failedResult.model,
				status: 'error',
				promptChars: failedResult.promptChars,
				responseChars: failedResult.responseChars ?? null,
				requestTokens: failedResult.usage?.requestTokens ?? null,
				responseTokens: failedResult.usage?.responseTokens ?? null,
				totalTokens: failedResult.usage?.totalTokens ?? null,
				maxOutputTokens: narrativeGeneration.maxTokens,
				retryCount: 0,
				statusCode: failedResult.statusCode ?? null,
			});
			await logGenerationCall({
				storyId: request.storyId,
				clientTurnId: request.clientTurnId,
				serviceId: 'narrative',
				operation: 'turn.narration',
				profile: narrativeProfile,
				result: failedResult,
				status: 'error',
				error,
				metadata: {
					statusCode: failedResult.statusCode ?? null,
					retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
					debugSnapshot: buildTurnDebugSnapshot(narrativeDebugBase),
				},
			});
		}
		throw error;
	}

	if (!narration.trim()) {
		throw new Error('Terminal narrative generation returned an empty response. No backend turn was persisted.');
	}

	const [position, turnVersion] = await recorder.time('turn.persistence.allocate_position_version', {}, () => Promise.all([
		nextEntryPosition(request.storyId),
		bumpStoryVersion(request.storyId),
	]));

	await recorder.time('turn.persistence.entries', {
		writes: 3,
		narrationChars: narration.length,
		playerTextChars: request.playerText.length,
	}, () => Promise.all([
		db.insert(syncOps).values({
			id: `turn_${request.clientTurnId}`,
			storyId: request.storyId,
			type: 'turn_command',
			payload: { playerText: request.playerText, clientContext: request.clientContext ?? null },
			clientVersion: request.localVersion,
			status: 'applied',
			createdAt,
		}).onConflictDoNothing(),
		db.insert(storyEntries).values({
			id: playerEntryId,
			storyId: request.storyId,
			type: 'user_action',
			content: request.playerText,
			position,
			parentId: null,
			branchId: null,
			metadata: { clientTurnId: request.clientTurnId, source: 'server_turn' },
			serverVersion: turnVersion,
			createdAt,
			updatedAt: createdAt,
		}).onConflictDoNothing(),
		db.insert(storyEntries).values({
			id: assistantEntryId,
			storyId: request.storyId,
			type: 'narration',
			content: narration,
			position: position + 1,
			parentId: playerEntryId,
			branchId: null,
			metadata: {
				clientTurnId: request.clientTurnId,
				source: 'server_turn',
				retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
				wikiContextCitations: wikiContext?.citations ?? [],
				wikiContextPageCount: wikiContext?.pageCount ?? 0,
				wikiContextSeedCount: wikiContext?.seedCount ?? 0,
				generationTimings,
				stateExtraction: {
					mode: deferStateExtraction ? 'deferred' : 'sync',
				},
				memoryTokenBudget,
				engineCache: engineCacheDebug ?? null,
			},
			serverVersion: turnVersion,
			createdAt,
			updatedAt: createdAt,
		}).onConflictDoNothing(),
	]));

	let rawUpdate: unknown = { update: worldStateUpdateSchema.parse({}) };
	if (classifierProfile && !deferStateExtraction) {
		const classifierSystem = classifierService.systemPromptOverride?.trim() || 'You extract canonical state changes for a text adventure. Return strict JSON only.';
		const extractionPrompt = buildStateExtractionPrompt(request.playerText, narration);
		try {
			const extractionResult = await generateServerTextWithMetrics({
				profile: classifierProfile,
				model: classifierGeneration.model,
				temperature: classifierGeneration.temperature,
				maxTokens: classifierGeneration.maxTokens,
				system: classifierSystem,
				prompt: extractionPrompt,
				responseFormat: 'json_object',
			});
			generationTimings.push(timingFromResult('turn.state_extraction', 'classifier', extractionResult, 'success'));
			recorder.record('turn.llm.state_extraction', extractionResult.durationMs, {
				serviceId: 'classifier',
				model: extractionResult.model,
				status: 'success',
				promptChars: extractionResult.promptChars,
				responseChars: extractionResult.responseChars,
				requestTokens: extractionResult.usage.requestTokens,
				responseTokens: extractionResult.usage.responseTokens,
				totalTokens: extractionResult.usage.totalTokens,
				maxOutputTokens: classifierGeneration.maxTokens,
				responseFormat: 'json_object',
				retryCount: 0,
			});
			await logGenerationCall({
				storyId: request.storyId,
				clientTurnId: request.clientTurnId,
				serviceId: 'classifier',
				operation: 'turn.state_extraction',
				profile: classifierProfile,
				result: extractionResult,
				status: 'success',
				metadata: {
					responseFormat: 'json_object',
					debugSnapshot: buildTurnDebugSnapshot({
						kind: 'state_extraction',
						playerText: request.playerText,
						system: classifierSystem,
						prompt: extractionPrompt,
						output: extractionResult.text,
					}),
				},
			});
			rawUpdate = parseJsonFromGeneratedText(extractionResult.text);
		} catch (error) {
			const failedResult = generationErrorResult(error);
			if (failedResult) {
				generationTimings.push(timingFromResult('turn.state_extraction', 'classifier', failedResult, 'error'));
				recorder.record('turn.llm.state_extraction', failedResult.durationMs, {
					serviceId: 'classifier',
					model: failedResult.model,
					status: 'error',
					promptChars: failedResult.promptChars,
					responseChars: failedResult.responseChars ?? null,
					requestTokens: failedResult.usage?.requestTokens ?? null,
					responseTokens: failedResult.usage?.responseTokens ?? null,
					totalTokens: failedResult.usage?.totalTokens ?? null,
					maxOutputTokens: classifierGeneration.maxTokens,
					responseFormat: 'json_object',
					retryCount: 0,
					statusCode: failedResult.statusCode ?? null,
				});
				await logGenerationCall({
					storyId: request.storyId,
					clientTurnId: request.clientTurnId,
					serviceId: 'classifier',
					operation: 'turn.state_extraction',
					profile: classifierProfile,
					result: failedResult,
					status: 'error',
					error,
					metadata: {
						responseFormat: 'json_object',
						statusCode: failedResult.statusCode ?? null,
						debugSnapshot: buildTurnDebugSnapshot({
							kind: 'state_extraction',
							playerText: request.playerText,
							system: classifierSystem,
							prompt: extractionPrompt,
						}),
					},
				});
			}
			warnings.push(`State extraction failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const parsedUpdate = recorder.timeSync('turn.validation.parse_update', {}, () => parseTurnUpdate(rawUpdate));
	warnings.push(...parsedUpdate.warnings);
	const applied = await recorder.time('turn.validation.apply_update', {
		parseWarnings: parsedUpdate.warnings.length,
	}, () => applyValidatedTurnUpdate({
		storyId: request.storyId,
		playerEntryId,
		assistantEntryId,
		narration,
		update: parsedUpdate.update,
		parseWarnings: parsedUpdate.warnings,
		retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
		serverVersion: turnVersion,
		memorySettings,
	}));
	warnings.push(...applied.warnings);
	if (deferStateExtraction) {
		try {
			const jobId = await recorder.time('turn.state_extraction.enqueue', {
				timelineTurn: gmBrief.currentTurn,
				retrievedMemoryIds: retrieved.nodes.length,
			}, () => enqueueTurnStateExtractionJob({
				storyId: request.storyId,
				playerEntryId,
				assistantEntryId,
				playerText: request.playerText,
				narration,
				clientTurnId: request.clientTurnId,
				timelineTurn: gmBrief.currentTurn,
				retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
				memorySettings,
			}));
			warnings.push(`State extraction queued as background job: ${jobId}`);
		} catch (error) {
			warnings.push(`State extraction enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const promotionMetadata: Record<string, unknown> = {
		currentTurn: gmBrief.currentTurn,
		serverVersion: turnVersion,
		status: 'pending',
		...contextCounts,
		promotedEvents: 0,
	};
	try {
		await recorder.time('turn.timeline.promote_due', promotionMetadata, async () => {
			try {
				const promotedEvents = await promoteDueTimelineEvents(request.storyId, gmBrief.currentTurn, { serverVersion: turnVersion });
				promotionMetadata.promotedEvents = promotedEvents.length;
				promotionMetadata.status = 'success';
				return promotedEvents;
			} catch (error) {
				promotionMetadata.status = 'error';
				promotionMetadata.error = error instanceof Error ? error.message : String(error);
				throw error;
			}
		});
	} catch (error) {
		warnings.push(`Timeline due-event promotion failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	let campaignVault: TurnResponse['campaignVault'] = null;
	try {
		campaignVault = await recorder.time('turn.campaign_vault.append_evidence', {
			position,
			serverVersion: turnVersion,
			eventIds: applied.eventIds.length,
			statePatchIds: applied.patchIds.length,
			retrievedMemoryIds: retrieved.nodes.length,
		}, () => appendTurnEvidence({
			story: {
				id: request.storyId,
				title: request.storyId,
				serverVersion: turnVersion,
			},
			clientTurnId: request.clientTurnId,
			position,
			playerText: request.playerText,
			narration,
			eventIds: applied.eventIds,
			statePatchIds: applied.patchIds,
			retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
			memoryNodeIds: applied.memoryNodeIds,
			warnings,
			generationTimings,
			metadata: {
				engineCache: engineCacheDebug ?? null,
				wikiContextCitations: wikiContext?.citations ?? [],
			},
		}));
	} catch (error) {
		warnings.push(`Campaign vault evidence append failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	const [entries, syncChanges, projection] = await recorder.time('turn.final_response.readback', {
		localVersion: request.localVersion,
	}, () => Promise.all([
		db
			.select()
			.from(storyEntries)
			.where(eq(storyEntries.storyId, request.storyId))
			.orderBy(desc(storyEntries.position))
			.limit(2),
		getSyncChanges(request.storyId, request.localVersion),
		getCampaignProjection(request.storyId, { entryLimit: 80 }).catch((error) => {
			warnings.push(`Campaign projection readback failed: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}),
	]));
	const maxVersion = syncChanges.reduce((max, change) => Math.max(max, change.version), turnVersion);
	recorder.record('turn.final_response.serialize', 0, {
		syncChanges: syncChanges.length,
		warnings: warnings.length,
		phaseCount: recorder.timings.length,
	});
	const preparedSummary = summarizePreparedTurnContext(prepared);
	const performance = buildTurnPerformanceSummary({
		turnId: request.clientTurnId,
		storyId: request.storyId,
		totalMs: monotonicNow() - turnStartedAt,
		model: narrativeGeneration.model ?? null,
		profile: narrativeProfile.providerType,
		stateExtractionMode: deferStateExtraction ? 'deferred' : 'sync',
		stablePromptHash: hashText(narrativeSystem),
		dynamicContextHash: hashText(narrativeSystemDynamic),
		recentMessageCount: prompt.messages.length,
		wikiChunkCount: wikiContext?.pageCount ?? 0,
		memoryItemCount: retrieved.nodes.length,
		preparedCacheHit: prepared.preparedCacheHit,
		prompt: {
			tokenEstimate: preparedSummary.prompt.tokenEstimate,
			totalChars: preparedSummary.prompt.totalChars,
			messageCount: preparedSummary.prompt.messageCount,
		},
		cache: engineCacheDebug,
		generationTimings,
		timings: recorder.timings,
	});
	logSlowTurn(performance);
	try {
		await recorder.time('turn.continuity_audit.enqueue', {
			serverVersion: turnVersion,
			truncated: contextReceipt.truncated,
		}, () => enqueueContinuityAuditJob({
			storyId: request.storyId,
			playerEntryId,
			assistantEntryId,
			clientTurnId: request.clientTurnId,
			serverVersion: turnVersion,
			contextReceipt: contextReceipt as unknown as Record<string, unknown>,
			performance: performance as unknown as Record<string, unknown>,
		}));
	} catch (error) {
		warnings.push(`Continuity audit enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	return {
		narration,
		entries: entries.reverse(),
		playerEntryId,
		assistantEntryId,
		statePatchIds: applied.patchIds,
		eventIds: applied.eventIds,
		retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
		memoryNodeIds: applied.memoryNodeIds,
		serverVersion: maxVersion,
		syncChanges,
		warnings,
		campaignVault,
		projection: projection ? {
			mode: projection.mode,
			entryLimit: 80,
			counts: projection.counts,
			cache: projection.cache ? {
				hitCount: projection.cache.hitCount,
				missCount: projection.cache.missCount,
				tokenEstimate: projection.cache.tokenEstimate,
			} : null,
		} : null,
		generationTimings,
		performance,
		contextReceipt,
	};
}
