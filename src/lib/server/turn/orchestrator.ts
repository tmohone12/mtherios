import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { storyEntries, syncOps } from '$lib/server/db/schema';
import { turnRequestSchema, type RetrievedMemoryPacket, type TurnRequest, type TurnResponse } from '$lib/contracts/memory';
import { bumpStoryVersion, getSyncChanges } from '$lib/server/memory/canonical';
import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { worldStateUpdateSchema } from '$lib/services/ai/tools/schemas';
import { DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET } from '$lib/services/memorySettings';
import { contextWiki } from '$lib/server/wiki/wikiCore';
import { loadGmTimelineBrief, promoteDueTimelineEvents } from '$lib/server/events/timeline';
import { loadTurnContext } from './context';
import { buildServerTurnPrompt, buildPromptSectionTrace, buildStateExtractionPrompt, chaptersForPromptContinuity, type PromptSectionTrace } from './promptPacket';
export { chaptersForPromptContinuity } from './promptPacket';
import {
	ServerGenerationError,
	generateServerTextWithMetrics,
	parseJsonFromGeneratedText,
	type ResponseSchemaOptions,
	type ServerGenerationResult,
} from './provider';
import { applyValidatedTurnUpdate, turnUpdateOperationCount } from './patchValidator';
import { requireResolvedServiceProfile, resolveServiceGeneration } from '$lib/server/engine/llmSettings';
import { recordApiCallLog } from '$lib/server/engine/apiCallLogs';
import { appendTurnEvidence } from '$lib/server/engine/campaignVault';
import { getCampaignProjection } from '$lib/server/engine/projections';
import { enqueueChapterSummaryJob, enqueueContinuityAuditJob, enqueueTurnStateExtractionJob } from '$lib/server/jobs/outbox';
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
import { countTokens, truncateToTokenBudget } from '$lib/utils/tokens';
import { encodeDiceMarker, parseRollMarker, rollCheck, type RollCheckResult } from '$lib/utils/dice';
import { sliceWellFormedText, toWellFormedText } from './wellFormedText';

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

export function resolveNarrationRoll(text: string): {
	preText: string;
	diceMarker: string;
	rollSummary: string;
	result: RollCheckResult;
} | null {
	const { preText, marker } = parseRollMarker(text);
	if (!marker) return null;
	try {
		const result = rollCheck(marker.notation, marker.dc, marker.ability, marker.description);
		const critical = result.critical === 'success'
			? ' (NATURAL 20 - CRITICAL SUCCESS!)'
			: result.critical === 'failure'
				? ' (NATURAL 1 - CRITICAL FAILURE!)'
				: '';
		return {
			preText,
			diceMarker: encodeDiceMarker(result),
			rollSummary: `[Roll Result: ${marker.ability} Check - ${result.notation} = ${result.total} (natural ${result.natural}) vs DC ${marker.dc} - ${result.success ? 'SUCCESS' : 'FAILURE'}${critical}]`,
			result,
		};
	} catch {
		return null;
	}
}

export function shouldQueueChapterSummaryWithoutState(
	mode: 'deferred' | 'sync' | 'none',
	counts: { eventIds: number; memoryNodeIds: number; patchIds: number },
): boolean {
	return mode !== 'deferred' && counts.eventIds === 0 && counts.memoryNodeIds === 0 && counts.patchIds === 0;
}

const CONTINUITY_CACHE_CHAPTER_OUTCOME_CHAR_LIMIT = 900;
const CONTINUITY_CACHE_ARC_SUMMARY_CHAR_LIMIT = 2400;
const CONTINUITY_CACHE_SAGA_SUMMARY_CHAR_LIMIT = 2400;
const CONTINUITY_CACHE_LIST_LIMIT = 12;
const CONTINUITY_CACHE_LIST_ITEM_CHAR_LIMIT = 180;

function compactContinuityCacheText(value: string | null | undefined, max: number): string {
	const text = toWellFormedText(value ?? '').trim();
	if (text.length <= max) return text;
	return `${sliceWellFormedText(text, max - 3).trimEnd()}...`;
}

function compactContinuityCacheList(values: string[], limit = CONTINUITY_CACHE_LIST_LIMIT): string[] {
	return values
		.slice(0, limit)
		.map((value) => compactContinuityCacheText(value, CONTINUITY_CACHE_LIST_ITEM_CHAR_LIMIT))
		.filter(Boolean);
}

export function buildCampaignContinuityCachePayload(ctx: Pick<TurnContext, 'chapters' | 'arcs' | 'sagas'>) {
	const chapters = chaptersForPromptContinuity(ctx.chapters, ctx.arcs);
	return {
		chapters: chapters.map((chapter) => ({
			id: chapter.id,
			number: chapter.number,
			title: chapter.title,
			sceneOutcome: compactContinuityCacheText(chapter.sceneOutcome, CONTINUITY_CACHE_CHAPTER_OUTCOME_CHAR_LIMIT),
			openThreads: compactContinuityCacheList(chapter.openThreads),
			updatedAt: chapter.updatedAt,
		})),
		arcs: ctx.arcs.map((arc) => ({
			id: arc.id,
			number: arc.number,
			title: arc.title,
			summary: compactContinuityCacheText(arc.summary, CONTINUITY_CACHE_ARC_SUMMARY_CHAR_LIMIT),
			chapterIds: arc.chapterIds,
			openThreadIds: compactContinuityCacheList(arc.openThreadIds),
			updatedAt: arc.updatedAt,
		})),
		sagas: ctx.sagas.map((saga) => ({
			id: saga.id,
			number: saga.number,
			title: saga.title,
			summary: compactContinuityCacheText(saga.summary, CONTINUITY_CACHE_SAGA_SUMMARY_CHAR_LIMIT),
			arcIds: saga.arcIds,
			keyFactionShifts: compactContinuityCacheList(saga.keyFactionShifts),
			majorPowerChanges: compactContinuityCacheList(saga.majorPowerChanges),
			lingeringThreads: compactContinuityCacheList(saga.lingeringThreads),
			overallTone: compactContinuityCacheText(saga.overallTone, CONTINUITY_CACHE_LIST_ITEM_CHAR_LIMIT),
			updatedAt: saga.updatedAt,
		})),
	};
}

function hashText(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

export function buildProviderPromptCacheKey(input: {
	providerType: string;
	model: string | null | undefined;
	storyId: string;
	stablePromptHash: string;
	storyStaticHash?: string | null;
}): string {
	return [
		'mtherios',
		'v3',
		input.providerType || 'unknown',
		input.model || 'default',
		input.storyId,
		input.stablePromptHash.slice(0, 16),
		input.storyStaticHash?.slice(0, 16) || null,
	].filter(Boolean).join(':');
}

function stripJsonSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
	const { $schema: _schema, ...rest } = schema;
	return rest;
}

export function buildStateExtractionResponseSchema(): ResponseSchemaOptions {
	return {
		name: 'mtherios_state_patch',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				update: stripJsonSchemaMeta(z.toJSONSchema(worldStateUpdateSchema) as Record<string, unknown>),
			},
			required: ['update'],
		},
	};
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

const strictWorldStateUpdateSchema = worldStateUpdateSchema.strict();
const strictExtractedUpdateSchema = z.object({ update: strictWorldStateUpdateSchema }).strict();

export const DEFAULT_STATE_EXTRACTION_SYSTEM = 'You extract canonical state changes for a text adventure. Return strict JSON only.';

export function shouldUseLegacyClassifierFallback(
	service: Pick<ResolvedGenerationService, 'profile' | 'setting'>,
): boolean {
	return service.profile === null && service.setting === null;
}

export function classifierGenerationMaxTokens(
	generation: Pick<ResolvedGenerationService['generation'], 'maxTokens'>,
	fallback = 2048,
): number {
	return generation.maxTokens ?? fallback;
}

export function parseStateExtractionResult(text: string): {
	update: z.infer<typeof worldStateUpdateSchema>;
	warnings: string[];
	operationCount: number;
} {
	if (!text.trim()) throw new Error('Classifier returned an empty state extraction response.');
	const raw = parseJsonFromGeneratedText(text);
	const wrapped = strictExtractedUpdateSchema.safeParse(raw);
	if (wrapped.success) {
		return {
			update: wrapped.data.update,
			warnings: [],
			operationCount: turnUpdateOperationCount(wrapped.data.update),
		};
	}
	const direct = strictWorldStateUpdateSchema.safeParse(raw);
	if (!direct.success) {
		const issues = [...wrapped.error.issues, ...direct.error.issues]
			.slice(0, 4)
			.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
			.join('; ');
		throw new Error(`Classifier returned an invalid state extraction response: ${issues}`);
	}
	return { update: direct.data, warnings: [], operationCount: turnUpdateOperationCount(direct.data) };
}

export interface ProcessServerTurnOptions {
	onNarrationChunk?: (chunk: string) => void | Promise<void>;
}
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

const MEMORY_RETRIEVAL_BUDGET_MS = 3_000;
const WIKI_CONTEXT_LIMIT = 4;
const WIKI_CONTEXT_PAGE_LIMIT = 6;
const WIKI_CONTEXT_PAGE_CHARS = 700;
const WIKI_CONTEXT_MAX_CHARS = 4000;
const WIKI_CONTEXT_BUDGET_MS = 3_000;
const GM_TIMELINE_BRIEF_BUDGET_MS = 300;
const PREPARED_TURN_TTL_MS = 120_000;
const PREPARED_TURN_CACHE_MAX = 48;

function emptyRetrievedMemoryPacket(storyId: string, query: string): RetrievedMemoryPacket {
	return {
		storyId,
		query,
		packet: '',
		nodes: [],
		tokenEstimate: 0,
		retrievalDebug: ['normal_turn_retrieval=off'],
		retrievalTrace: [],
	};
}

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
		chapters: number;
		arcs: number;
		chaptersSuppressedByArcs: number;
		chaptersSent: number;
		arcsSent: number;
		chaptersSuppressedByArc: number;
		memoryNodesSent: number;
		totalChars: number;
		totalTokens: number | null;
		facts: number;
		patchProposals: number;
		unresolvedCharacterReferences: number;
		continuityWarnings: number;
		factionSheets: string[];
	};
	skipped: Array<{
		source: string;
		reason: string;
	}>;
	unresolvedCharacterReferences: Array<{
		proposalId: string;
		name: string;
		contextLabel: string;
		reason: string;
		sourceEntryIds: string[];
	}>;
	continuityLedger: {
		facts: Array<{
			id: string;
			statement: string;
			sourceEntryIds: string[];
			sourcePatchIds: string[];
		}>;
		patchProposals: Array<{
			id: string;
			status: string;
			proposalType: string;
			targetTable: string;
			targetRecordId: string;
			reason: string;
			sourceEntryIds: string[];
			sourcePatchIds: string[];
		}>;
		warnings: Array<{
			id: string;
			level: string;
			status: string;
			title: string;
			sourceEntryIds: string[];
			sourcePatchIds: string[];
		}>;
	};
	cacheSegments: Array<{
		kind: string;
		cacheKey: string;
		contentHash: string;
		hit: boolean;
		invalidated: boolean;
		tokenEstimate: number;
		dependencyCount: number;
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
	promptSectionTrace: PromptSectionTrace[];
	narrativeService: ResolvedGenerationService;
	narrativeProfile: ProviderProfile;
	narrativeGeneration: ResolvedGenerationService['generation'];
	narrativeSystem: string;
	narrativeSystemDynamic: string;
	narrativePrompt: string;
	narrativePromptCacheKey: string;
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

function sourceIds(...values: Array<string | null | undefined>): string[] {
	return [...new Set(values.map((value) => value?.trim() ?? '').filter(Boolean))];
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
	maxTokens: number | null | undefined,
): { value: string; truncated: boolean } {
	const cleanValue = toWellFormedText(value);
	if (!maxTokens || maxTokens <= 0 || countTokens(cleanValue) <= maxTokens) return { value: cleanValue, truncated: cleanValue !== value };
	const finalInstruction = 'Return only GM narration prose for the player action. Do not include JSON, ending choices, numbered options, menus, or OOC notes in this response.';
	const marker = cleanValue.includes('<context_data>')
		? '\n\n</context_data>\n\n[Backend context budget truncated lower-priority context.]\n\n'
		: '\n\n[Backend context budget truncated lower-priority context.]\n\n';
	const reservedTokens = countTokens(marker) + countTokens(finalInstruction);
	if (maxTokens <= reservedTokens + 32 || !cleanValue.endsWith(finalInstruction)) {
		return {
			value: truncateToTokenBudget(cleanValue, Math.max(1, maxTokens)),
			truncated: true,
		};
	}
	const headBudget = Math.max(1, maxTokens - reservedTokens - 4);
	const head = truncateToTokenBudget(cleanValue.slice(0, -finalInstruction.length).trimEnd(), headBudget);
	return {
		value: `${head.trimEnd()}${marker}${finalInstruction}`,
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

function generationTimeToFirstToken(generationTimings: GenerationTiming[], operation: string): number | null {
	const timing = generationTimings.find((item) => item.operation === operation);
	return typeof timing?.timeToFirstTokenMs === 'number'
		? Math.max(0, Math.trunc(timing.timeToFirstTokenMs))
		: null;
}

const DURABLE_STATE_SIGNAL_PATTERN = /\b(accepts?|allies?|arrives?|attacks?|betrays?|burns?|buys?|dead|dies?|discovers?|destroys?|enters?|exits?|finds?|gives?|gave|hands?|injures?|kills?|learns?|leaves?|locks?|moves?|oaths?|opens?|promises?|reveals?|sells?|steals?|takes?|travels?|unlocks?|wounds?)\b/i;
const EXPLICIT_NO_DURABLE_STATE_PATTERN = /\b(no durable|no lasting|nothing lasting changes|nothing changes|remains unchanged|state does not change|without lasting change)\b/i;

export function shouldExtractDurableState(playerText: string, narration: string): boolean {
	const text = `${playerText}\n${narration}`;
	if (DURABLE_STATE_SIGNAL_PATTERN.test(text)) return true;
	return !EXPLICIT_NO_DURABLE_STATE_PATTERN.test(text);
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

function countUnresolvedCharacterReferences(patchProposals: TurnContext['patchProposals']): number {
	const seen = new Set<string>();
	for (const proposal of patchProposals) {
		if (proposal.proposalType !== 'character_reference_review') continue;
		if (!['pending', 'needs_review'].includes(proposal.status)) continue;
		const metadata = asRecord(proposal.metadata);
		const sourceName = typeof metadata.sourceName === 'string' ? metadata.sourceName.trim() : '';
		const operations = Array.isArray(proposal.operations) ? proposal.operations : [];
		const operationName = operations
			.map((operation) => asRecord(asRecord(operation).value))
			.map((value) => typeof value.name === 'string' ? value.name.trim() : '')
			.find(Boolean) ?? '';
		const name = sourceName || operationName || proposal.targetRecordId;
		if (name) seen.add(name.toLowerCase());
	}
	return seen.size;
}

function unresolvedCharacterReferenceContextLabel(metadata: Record<string, unknown>): string {
	const referenceContext = typeof metadata.referenceContext === 'string' ? metadata.referenceContext.trim() : '';
	if (!referenceContext) return '';
	const detail = typeof metadata.agreementCategory === 'string' && metadata.agreementCategory.trim()
		? metadata.agreementCategory.trim()
		: typeof metadata.factionName === 'string' && metadata.factionName.trim()
			? metadata.factionName.trim()
			: typeof metadata.timelineTitle === 'string' && metadata.timelineTitle.trim()
				? metadata.timelineTitle.trim()
				: '';
	return detail ? `${referenceContext}/${detail.slice(0, 60)}` : referenceContext;
}

function unresolvedCharacterReferenceNameAndReason(proposal: TurnContext['patchProposals'][number]): { name: string; reason: string } {
	const metadata = asRecord(proposal.metadata);
	const operations = Array.isArray(proposal.operations) ? proposal.operations : [];
	const operationValue = operations
		.map((operation) => asRecord(asRecord(operation).value))
		.find((value) => typeof value.name === 'string' && value.name.trim().length > 0);
	const sourceName = typeof metadata.sourceName === 'string' ? metadata.sourceName.trim() : '';
	const operationName = typeof operationValue?.name === 'string' ? operationValue.name.trim() : '';
	const operationDescription = typeof operationValue?.description === 'string' ? operationValue.description.trim() : '';
	return {
		name: sourceName || operationName || proposal.targetRecordId,
		reason: operationDescription || proposal.reason,
	};
}

function summarizeUnresolvedCharacterReferences(patchProposals: TurnContext['patchProposals']): TurnContextReceipt['unresolvedCharacterReferences'] {
	const seen = new Set<string>();
	const references: TurnContextReceipt['unresolvedCharacterReferences'] = [];
	for (const proposal of patchProposals) {
		if (proposal.proposalType !== 'character_reference_review') continue;
		if (!['pending', 'needs_review'].includes(proposal.status)) continue;
		const { name, reason } = unresolvedCharacterReferenceNameAndReason(proposal);
		if (!name) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		references.push({
			proposalId: proposal.id,
			name: name.slice(0, 120),
			contextLabel: unresolvedCharacterReferenceContextLabel(asRecord(proposal.metadata)),
			reason: reason.slice(0, 180),
			sourceEntryIds: proposal.sourceEntryIds.slice(0, 3),
		});
		if (references.length >= 12) break;
	}
	return references;
}

function sanitizeContinuityLedger(input?: Partial<TurnContextReceipt['continuityLedger']>): TurnContextReceipt['continuityLedger'] {
	return {
		facts: (input?.facts ?? [])
			.map((fact) => ({
				id: fact.id.trim(),
				statement: fact.statement.trim().slice(0, 180),
				sourceEntryIds: sourceIds(...fact.sourceEntryIds).slice(0, 3),
				sourcePatchIds: sourceIds(...fact.sourcePatchIds).slice(0, 3),
			}))
			.filter((fact) => fact.id && fact.statement)
			.slice(0, 6),
		patchProposals: (input?.patchProposals ?? [])
			.map((proposal) => ({
				id: proposal.id.trim(),
				status: proposal.status.trim(),
				proposalType: proposal.proposalType.trim(),
				targetTable: proposal.targetTable.trim(),
				targetRecordId: proposal.targetRecordId.trim(),
				reason: proposal.reason.trim().slice(0, 180),
				sourceEntryIds: sourceIds(...proposal.sourceEntryIds).slice(0, 3),
				sourcePatchIds: sourceIds(...proposal.sourcePatchIds).slice(0, 3),
			}))
			.filter((proposal) => proposal.id && proposal.proposalType)
			.slice(0, 6),
		warnings: (input?.warnings ?? [])
			.map((warning) => ({
				id: warning.id.trim(),
				level: warning.level.trim(),
				status: warning.status.trim(),
				title: warning.title.trim().slice(0, 120),
				sourceEntryIds: sourceIds(...warning.sourceEntryIds).slice(0, 3),
				sourcePatchIds: sourceIds(...warning.sourcePatchIds).slice(0, 3),
			}))
			.filter((warning) => warning.id && warning.title)
			.slice(0, 6),
	};
}

function summarizeContinuityLedger(ctx: TurnContext): TurnContextReceipt['continuityLedger'] {
	return sanitizeContinuityLedger({
		facts: ctx.facts.slice(0, 6).map((fact) => ({
			id: fact.id,
			statement: fact.statement,
			sourceEntryIds: fact.sourceEntryIds,
			sourcePatchIds: fact.sourcePatchIds,
		})),
		patchProposals: ctx.patchProposals.slice(0, 6).map((proposal) => ({
			id: proposal.id,
			status: proposal.status,
			proposalType: proposal.proposalType,
			targetTable: proposal.targetTable,
			targetRecordId: proposal.targetRecordId,
			reason: proposal.reason,
			sourceEntryIds: proposal.sourceEntryIds,
			sourcePatchIds: proposal.sourcePatchIds,
		})),
		warnings: ctx.continuityWarnings.slice(0, 6).map((warning) => ({
			id: warning.id,
			level: warning.level,
			status: warning.status,
			title: warning.title,
			sourceEntryIds: warning.sourceEntryIds,
			sourcePatchIds: warning.sourcePatchIds,
		})),
	});
}

export function buildTurnContextReceipt(input: {
	turnId: string;
	storyId: string;
	truncated?: boolean;
	recentEntryCount?: number | null;
	memoryNodeCount?: number | null;
	wikiChunkCount?: number | null;
	timelineEventCount?: number | null;
	chapterCount?: number | null;
	arcCount?: number | null;
	chaptersSuppressedByArcs?: number | null;
	promptChars?: number | null;
	promptTokens?: number | null;
	factCount?: number | null;
	patchProposalCount?: number | null;
	unresolvedCharacterReferenceCount?: number | null;
	continuityWarningCount?: number | null;
	factionIds?: string[];
	skipped?: Array<{ source: string; reason: string }>;
	unresolvedCharacterReferences?: Array<{
		proposalId?: string | null;
		name?: string | null;
		contextLabel?: string | null;
		reason?: string | null;
		sourceEntryIds?: string[] | null;
	}>;
	continuityLedger?: Partial<TurnContextReceipt['continuityLedger']>;
	cacheSegments?: Array<{
		kind?: string | null;
		cacheKey?: string | null;
		contentHash?: string | null;
		hit?: boolean | null;
		invalidated?: boolean | null;
		tokenEstimate?: number | null;
		dependencyCount?: number | null;
	}>;
	budgets?: Partial<TurnContextReceipt['budgets']>;
}): TurnContextReceipt {
	const clampCount = (value: number | null | undefined) => Math.max(0, Math.trunc(Number.isFinite(value) ? Number(value) : 0));
	const factionSheets = [...new Set((input.factionIds ?? []).map((id) => id.trim()).filter(Boolean))];
	const skipped = (input.skipped ?? [])
		.map((item) => ({ source: item.source.trim(), reason: item.reason.trim() }))
		.filter((item) => item.source && item.reason);
	const unresolvedCharacterReferences = (input.unresolvedCharacterReferences ?? [])
		.map((reference) => ({
			proposalId: (reference.proposalId ?? '').trim(),
			name: (reference.name ?? '').trim(),
			contextLabel: (reference.contextLabel ?? '').trim(),
			reason: (reference.reason ?? '').trim(),
			sourceEntryIds: [...new Set((reference.sourceEntryIds ?? []).map((id) => id.trim()).filter(Boolean))].slice(0, 3),
		}))
		.filter((reference) => reference.proposalId && reference.name)
		.slice(0, 12);
	const continuityLedger = sanitizeContinuityLedger(input.continuityLedger);
	const cacheSegments = (input.cacheSegments ?? [])
		.map((segment) => ({
			kind: (segment.kind ?? '').trim(),
			cacheKey: (segment.cacheKey ?? '').trim(),
			contentHash: (segment.contentHash ?? '').trim(),
			hit: segment.hit === true,
			invalidated: segment.invalidated === true,
			tokenEstimate: clampCount(segment.tokenEstimate),
			dependencyCount: clampCount(segment.dependencyCount),
		}))
		.filter((segment) => segment.kind && segment.cacheKey && segment.contentHash)
		.slice(0, 12);
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
			chapters: clampCount(input.chapterCount),
			arcs: clampCount(input.arcCount),
			chaptersSuppressedByArcs: clampCount(input.chaptersSuppressedByArcs),
			chaptersSent: clampCount(input.chapterCount),
			arcsSent: clampCount(input.arcCount),
			chaptersSuppressedByArc: clampCount(input.chaptersSuppressedByArcs),
			memoryNodesSent: clampCount(input.memoryNodeCount),
			totalChars: clampCount(input.promptChars),
			totalTokens: input.promptTokens == null ? null : clampCount(input.promptTokens),
			facts: clampCount(input.factCount),
			patchProposals: clampCount(input.patchProposalCount),
			unresolvedCharacterReferences: clampCount(input.unresolvedCharacterReferenceCount),
			continuityWarnings: clampCount(input.continuityWarningCount),
			factionSheets,
		},
		skipped,
		unresolvedCharacterReferences,
		continuityLedger,
		cacheSegments,
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
		providerTimeToFirstTokenMs: generationTimeToFirstToken(input.generationTimings, 'turn.narration'),
		providerTotalMs: generationDuration(input.generationTimings, 'turn.narration'),
		providerRetries: input.generationTimings.reduce((sum, timing) => sum + Math.max(0, Math.trunc(timing.retryCount ?? 0)), 0),
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
	const finishReason = 'finishReason' in result ? result.finishReason ?? null : null;
	return {
		operation,
		serviceId,
		model: result.model ?? null,
		status,
		durationMs: Math.max(0, Math.trunc(result.durationMs)),
		timeToFirstTokenMs: 'timeToFirstTokenMs' in result && typeof result.timeToFirstTokenMs === 'number'
			? Math.max(0, Math.trunc(result.timeToFirstTokenMs))
			: null,
		retryCount: Math.max(0, Math.trunc(result.retryCount ?? 0)),
		finishReason,
		requestTokens: usage?.requestTokens ?? null,
		responseTokens: usage?.responseTokens ?? null,
		totalTokens: usage?.totalTokens ?? null,
	};
}

function hitMaxOutputLimit(result: ServerGenerationResult, maxTokens: number | undefined): boolean {
	const reason = result.finishReason?.trim().toLowerCase();
	if (reason && ['length', 'max_tokens', 'max_output_tokens', 'token_limit', 'content_filter_length'].includes(reason)) {
		return true;
	}
	const responseTokens = result.usage.responseTokens;
	if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) return false;
	if (typeof responseTokens !== 'number' || !Number.isFinite(responseTokens)) return false;
	return Math.trunc(responseTokens) >= Math.trunc(maxTokens);
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
	const continuityChapters = chaptersForPromptContinuity(ctx.chapters, ctx.arcs);
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
		facts: ctx.facts.length,
		patchProposals: ctx.patchProposals.length,
		unresolvedCharacterReferences: countUnresolvedCharacterReferences(ctx.patchProposals),
		continuityWarnings: ctx.continuityWarnings.length,
		chapters: continuityChapters.length,
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
		.where(and(
			eq(storyEntries.storyId, storyId),
			inArray(storyEntries.id, [playerEntryId, assistantEntryId]),
		))
		.limit(2);
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

async function reserveTurnCommand(request: TurnRequest, createdAt: string): Promise<boolean> {
	const [row] = await getDb().insert(syncOps).values({
		id: `turn_${request.clientTurnId}`,
		storyId: request.storyId,
		type: 'turn_command',
		payload: {
			playerText: request.playerText,
			clientContext: request.clientContext ?? null,
			status: 'running',
			reservedAt: createdAt,
		},
		clientVersion: request.localVersion,
		status: 'running',
		createdAt,
	}).onConflictDoNothing().returning({ id: syncOps.id });
	return Boolean(row);
}

async function markTurnCommandApplied(request: TurnRequest, updatedAt: string): Promise<void> {
	await getDb().update(syncOps).set({
		payload: {
			playerText: request.playerText,
			clientContext: request.clientContext ?? null,
			status: 'applied',
			appliedAt: updatedAt,
		},
		clientVersion: request.localVersion,
		status: 'applied',
	}).where(eq(syncOps.id, `turn_${request.clientTurnId}`));
}

async function markTurnCommandFailed(request: TurnRequest, error: unknown): Promise<void> {
	const failedAt = nowIso();
	await getDb().update(syncOps).set({
		payload: {
			playerText: request.playerText,
			clientContext: request.clientContext ?? null,
			status: 'failed',
			failedAt,
			error: error instanceof Error ? error.message : String(error),
		},
		clientVersion: request.localVersion,
		status: 'failed',
	}).where(eq(syncOps.id, `turn_${request.clientTurnId}`));
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
	const memoryTokenBudget = clampInt(request.clientContext?.memoryTokenBudget, 160, 2400, DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET);
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
	const [retrievalResult, ctx, gmBriefResult, wikiContextResult] = await recorder.time('turn.context_assembly', {
		parallel: true,
		memoryTokenBudget,
	}, () => Promise.all([
		recorder.time('turn.memory_retrieval', {
			memoryTokenBudget,
			sceneEntityIds: retrievalRequest.sceneEntityIds.length,
			presentNpcIds: retrievalRequest.presentNpcIds.length,
			budgetMs: MEMORY_RETRIEVAL_BUDGET_MS,
		}, async () => {
			try {
				const result = await withBudgetStatus(
					() => retrieveMemoryPacket(retrievalRequest),
					MEMORY_RETRIEVAL_BUDGET_MS,
					emptyRetrievedMemoryPacket(request.storyId, request.playerText),
				);
				return { ok: true as const, ...result };
			} catch (error) {
				return {
					ok: false as const,
					error,
					value: emptyRetrievedMemoryPacket(request.storyId, request.playerText),
					budgetExceeded: false,
				};
			}
		}),
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
		recorder.time('turn.wiki_context', {
			budgetMs: WIKI_CONTEXT_BUDGET_MS,
			maxChars: WIKI_CONTEXT_MAX_CHARS,
		}, async () => {
			try {
				const result = await withBudgetStatus(
					() => loadServerWikiContext(request.storyId, request.playerText),
					WIKI_CONTEXT_BUDGET_MS,
					emptyServerWikiContext(),
				);
				return { ok: true as const, ...result };
			} catch (error) {
				return {
					ok: false as const,
					error,
					value: emptyServerWikiContext(),
					budgetExceeded: false,
				};
			}
		}),
	]));
	const retrieved = retrievalResult.value;
	if (retrievalResult.ok) {
		if (retrievalResult.budgetExceeded) {
			contextSkipped.push({ source: 'memory_retrieval', reason: 'budget_exceeded' });
			warnings.push(`Memory retrieval skipped after ${MEMORY_RETRIEVAL_BUDGET_MS}ms budget.`);
		}
	} else {
		const error = retrievalResult.error;
		contextSkipped.push({ source: 'memory_retrieval', reason: 'unavailable' });
		warnings.push(`Memory retrieval unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
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
	const wikiContext: ServerWikiContext = wikiContextResult.value;
	if (wikiContextResult.ok) {
		if (wikiContextResult.budgetExceeded) {
			contextSkipped.push({ source: 'wiki_context', reason: 'budget_exceeded' });
			warnings.push(`Wiki context skipped after ${WIKI_CONTEXT_BUDGET_MS}ms budget.`);
		}
	} else {
		const error = wikiContextResult.error;
		contextSkipped.push({ source: 'wiki_context', reason: 'unavailable' });
		warnings.push(`Wiki context unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const contextCounts = turnContextCounts(ctxWithTimeline);
	const prompt = recorder.timeSync('turn.prompt_assembly', {
		retrievedMemoryNodes: retrieved.nodes.length,
		wikiContextChars: wikiContext?.markdown.length ?? 0,
		...contextCounts,
	}, () => buildServerTurnPrompt(ctxWithTimeline, retrieved, playerEntryId, {
		currentFactionId: request.clientContext?.currentFactionId ?? null,
		sceneEntityIds: request.clientContext?.sceneEntityIds ?? [],
		presentNpcIds: request.clientContext?.presentNpcIds ?? [],
		wikiContextMarkdown: wikiContext?.markdown ?? null,
	}));
	const promptSectionTrace = buildPromptSectionTrace(prompt.compiledPrompt);
	const narrativeSystem = narrativeService.systemPromptOverride?.trim() || prompt.system;
	const promptBudget = applyPromptContextBudget(prompt.prompt, request.clientContext?.contextBudget ?? 0);
	if (promptBudget.truncated) {
		contextSkipped.push({ source: 'dynamic_context', reason: 'truncated_by_context_budget' });
		warnings.push(`Dynamic prompt context budget applied: ${countTokens(prompt.prompt)} -> ${countTokens(promptBudget.value)} tokens.`);
	}
	const narrativeSystemDynamic = promptBudget.value;
	const narrativePrompt = `Player action:\n${request.playerText}`;
	const narrativeStablePromptHash = hashText(narrativeSystem);
	const narrativePromptCacheKey = buildProviderPromptCacheKey({
		providerType: narrativeProfile.providerType,
		model: narrativeGeneration.model ?? null,
		storyId: request.storyId,
		stablePromptHash: narrativeStablePromptHash,
		storyStaticHash: prompt.compiledPrompt.stablePrefix[0]?.contentHash ?? null,
	});
	const narrativeDebugPrompt = `${narrativeSystemDynamic}\n\n${narrativePrompt}`;
	const promptMessageChars = prompt.messages.reduce((sum, message) => sum + message.content.length, 0);
	const promptTotalChars = narrativeSystem.length + narrativeSystemDynamic.length + narrativePrompt.length + promptMessageChars;
	const promptTokenEstimate = Math.max(1, Math.ceil(promptTotalChars / 4));
	recorder.record('turn.prompt_payload', 0, {
		systemChars: narrativeSystem.length,
		systemDynamicChars: narrativeSystemDynamic.length,
		promptChars: narrativePrompt.length,
		messageCount: prompt.messages.length,
		messageChars: promptMessageChars,
		promptCacheKeyHash: hashText(narrativePromptCacheKey),
	});
	let promptCacheStats: { hitCount: number; missCount: number; segments: RecordEngineCacheSegmentResult[] } | null = null;
	const continuityChapters = chaptersForPromptContinuity(ctxWithTimeline.chapters, ctxWithTimeline.arcs);
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
					kind: 'campaign_continuity',
					cacheKey: buildEngineCacheKey({
						storyId: request.storyId,
						kind: 'campaign_continuity',
						parts: ['chapters-arcs-sagas'],
					}),
					value: stableJson(buildCampaignContinuityCachePayload(ctxWithTimeline)),
					dependencyHashes: [
						...continuityChapters.map((chapter) => engineCacheDependencyHash({
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
						chapterCount: continuityChapters.length,
						coveredChapterCount: ctxWithTimeline.chapters.length - continuityChapters.length,
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
		chapterCount: continuityChapters.length,
		arcCount: ctxWithTimeline.arcs.length,
		chaptersSuppressedByArcs: Math.max(0, ctxWithTimeline.chapters.length - continuityChapters.length),
		promptChars: promptTotalChars,
		promptTokens: promptTokenEstimate,
		factCount: contextCounts.facts,
		patchProposalCount: contextCounts.patchProposals,
		unresolvedCharacterReferenceCount: contextCounts.unresolvedCharacterReferences,
		continuityWarningCount: contextCounts.continuityWarnings,
		factionIds: [
			request.clientContext?.currentFactionId ?? '',
			...ctxWithTimeline.factions.map((faction) => faction.id),
		].filter(Boolean).slice(0, 20),
		skipped: contextSkipped,
		unresolvedCharacterReferences: summarizeUnresolvedCharacterReferences(ctxWithTimeline.patchProposals),
		continuityLedger: summarizeContinuityLedger(ctxWithTimeline),
		cacheSegments: (promptCacheStats?.segments ?? []).map(({ entry, hit, invalidated }) => ({
			kind: entry.kind,
			cacheKey: entry.cacheKey,
			contentHash: entry.contentHash,
			hit,
			invalidated,
			tokenEstimate: entry.tokenEstimate,
			dependencyCount: entry.dependencyHashes.length,
		})),
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
		promptSectionTrace,
		narrativeService,
		narrativeProfile,
		narrativeGeneration,
		narrativeSystem,
		narrativeSystemDynamic,
		narrativePrompt,
		narrativePromptCacheKey,
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

export async function processServerTurn(input: unknown, options: ProcessServerTurnOptions = {}): Promise<TurnResponse> {
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

	const reservedAt = nowIso();
	const reserved = await recorder.time('turn.command.reserve', {}, () => reserveTurnCommand(request, reservedAt));
	if (!reserved) {
		const existingAfterReserve = await recorder.time('turn.idempotency_check_after_reserve_conflict', {}, () => existingTurn(request.storyId, request.clientTurnId));
		if (existingAfterReserve) {
			recorder.record('turn.response_cached_after_reserve_conflict', 0, { serverVersion: existingAfterReserve.serverVersion });
			return existingAfterReserve;
		}
		throw new Error(`Turn ${request.clientTurnId} is already reserved or running for story ${request.storyId}.`);
	}

	try {
	const db = getDb();
	const createdAt = reservedAt;
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
		narrativePromptCacheKey,
		narrativeDebugPrompt,
		promptSectionTrace,
		contextCounts,
		engineCacheDebug,
		contextReceipt,
		memoryTokenBudget,
		memorySettings,
	} = prepared;
	const warnings: string[] = [...prepared.warnings];
	const classifierService = await recorder.time('turn.service_config.classifier', {}, () => resolveServiceGeneration('classifier'));
	const useNarrativeClassifierFallback = shouldUseLegacyClassifierFallback(classifierService);
	const classifierExplicitlyDisabled = classifierService.setting?.enabled === false;
	const classifierProfile = classifierService.profile ?? (useNarrativeClassifierFallback ? narrativeProfile : null);
	const effectiveClassifierServiceId = classifierService.profile
		? 'classifier'
		: useNarrativeClassifierFallback
			? 'narrative'
			: null;
	const classifierGeneration = classifierService.profile
		? {
			...classifierService.generation,
			temperature: classifierService.generation.temperature ?? 0.2,
			maxTokens: classifierGenerationMaxTokens(classifierService.generation),
		}
		: useNarrativeClassifierFallback ? {
			model: narrativeGeneration.model,
			temperature: 0.2,
			maxTokens: classifierGenerationMaxTokens(narrativeGeneration),
		} : {
			temperature: 0.2,
			maxTokens: classifierGenerationMaxTokens({}),
		};
	if (classifierService.missingReason) {
		const label = classifierExplicitlyDisabled
			? 'Classifier disabled'
			: useNarrativeClassifierFallback
				? 'Classifier legacy fallback to narrative'
				: 'Classifier unavailable';
		warnings.push(`${label}: ${classifierService.missingReason}`);
	}
	const deferStateExtraction = request.clientContext?.deferStateExtraction !== false;
	const generationTimings: GenerationTiming[] = [];
	const narrativeDebugBase = {
		kind: 'narration' as const,
		playerText: request.playerText,
		system: narrativeSystem,
		messages: prompt.messages,
		prompt: narrativeDebugPrompt,
		promptSectionTrace,
		retrievedMemory: retrieved,
		wikiContext,
		contextCounts,
		engineCache: engineCacheDebug,
	};

	let narration = '';
	let narrationOperation = 'turn.narration';
	try {
		const result = await generateServerTextWithMetrics({
			profile: narrativeProfile,
			model: narrativeGeneration.model,
			temperature: narrativeGeneration.temperature,
			maxTokens: narrativeGeneration.maxTokens,
			reasoningEffort: narrativeGeneration.reasoningEffort,
			system: narrativeSystem,
			systemDynamic: narrativeSystemDynamic,
			messages: prompt.messages,
			prompt: narrativePrompt,
			cache: {
				key: narrativePromptCacheKey,
				retention: 'in_memory',
			},
			onTextDelta: options.onNarrationChunk,
		});
		narration = result.text;
		const maxOutputLimitHit = hitMaxOutputLimit(result, narrativeGeneration.maxTokens);
		if (maxOutputLimitHit) {
			warnings.push(`Narrative response hit the ${narrativeGeneration.maxTokens ?? 'configured'} token output limit and may be cut off. Raise narrative maxTokens or continue from the last complete sentence.`);
		}
		generationTimings.push(timingFromResult('turn.narration', 'narrative', result, 'success'));
		recorder.record('turn.llm.narration', result.durationMs, {
			serviceId: 'narrative',
			model: result.model,
			status: 'success',
			finishReason: result.finishReason ?? null,
			promptChars: result.promptChars,
			responseChars: result.responseChars,
			timeToFirstTokenMs: result.timeToFirstTokenMs ?? null,
			requestTokens: result.usage.requestTokens,
			responseTokens: result.usage.responseTokens,
			totalTokens: result.usage.totalTokens,
			cachedInputTokens: result.usage.cachedInputTokens,
			cacheWriteTokens: result.usage.cacheWriteTokens,
			reasoningTokens: result.usage.reasoningTokens,
			maxOutputTokens: narrativeGeneration.maxTokens,
			maxOutputLimitHit,
			retryCount: result.retryCount ?? 0,
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
				promptCacheKeyHash: hashText(narrativePromptCacheKey),
				finishReason: result.finishReason ?? null,
				maxOutputLimitHit,
				cachedInputTokens: result.usage.cachedInputTokens,
				cacheWriteTokens: result.usage.cacheWriteTokens,
				reasoningTokens: result.usage.reasoningTokens,
				debugSnapshot: buildTurnDebugSnapshot({
					...narrativeDebugBase,
					output: narration,
				}),
			},
		});

		const roll = resolveNarrationRoll(narration);
		if (roll) {
			narrationOperation = 'turn.narration.roll_continuation';
			const continuation = await generateServerTextWithMetrics({
				profile: narrativeProfile,
				model: narrativeGeneration.model,
				temperature: narrativeGeneration.temperature,
				maxTokens: narrativeGeneration.maxTokens,
				reasoningEffort: narrativeGeneration.reasoningEffort,
				system: narrativeSystem,
				systemDynamic: narrativeSystemDynamic,
				messages: [...prompt.messages, { role: 'assistant', content: roll.preText }],
				prompt: `${roll.rollSummary}\n\nContinue immediately after the roll result. Do not repeat the turn header or include another roll marker.`,
				onTextDelta: options.onNarrationChunk,
			});
			generationTimings.push(timingFromResult(narrationOperation, 'narrative', continuation, 'success'));
			recorder.record('turn.llm.narration_roll_continuation', continuation.durationMs, {
				serviceId: 'narrative',
				model: continuation.model,
				status: 'success',
			});
			await logGenerationCall({
				storyId: request.storyId,
				clientTurnId: request.clientTurnId,
				serviceId: 'narrative',
				operation: narrationOperation,
				profile: narrativeProfile,
				result: continuation,
				status: 'success',
				metadata: { dice: roll.result.notation, dc: roll.result.dc, success: roll.result.success },
			});
			narration = `${roll.preText}\n\n${roll.diceMarker}\n\n${continuation.text}`.trim();
		}
	} catch (error) {
		const failedResult = generationErrorResult(error);
		if (failedResult) {
			generationTimings.push(timingFromResult(narrationOperation, 'narrative', failedResult, 'error'));
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
				retryCount: failedResult.retryCount ?? 0,
				statusCode: failedResult.statusCode ?? null,
			});
			await logGenerationCall({
				storyId: request.storyId,
				clientTurnId: request.clientTurnId,
				serviceId: 'narrative',
				operation: narrationOperation,
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
	const stateExtractionMode: 'deferred' | 'sync' | 'none' = !classifierExplicitlyDisabled
		&& shouldExtractDurableState(request.playerText, narration)
		? deferStateExtraction ? 'deferred' : 'sync'
		: 'none';

	const [position, turnVersion] = await recorder.time('turn.persistence.allocate_position_version', {}, () => Promise.all([
		nextEntryPosition(request.storyId),
		bumpStoryVersion(request.storyId),
	]));

	await recorder.time('turn.persistence.entries', {
		writes: 3,
		narrationChars: narration.length,
		playerTextChars: request.playerText.length,
	}, () => Promise.all([
		markTurnCommandApplied(request, createdAt),
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
					mode: stateExtractionMode,
				},
				memoryTokenBudget,
				engineCache: engineCacheDebug ?? null,
			},
			serverVersion: turnVersion,
			createdAt,
			updatedAt: createdAt,
		}).onConflictDoNothing(),
	]));

	let parsedUpdate = {
		update: worldStateUpdateSchema.parse({}),
		warnings: [] as string[],
		operationCount: 0,
	};
	let classifierExtractionResult: ServerGenerationResult | null = null;
	let classifierExtractionPrompt = '';
	let classifierExtractionSystem = '';
	let classifierParseSucceeded = false;
	const classifierLogMetadata = {
		configuredServiceId: 'classifier',
		effectiveServiceId: effectiveClassifierServiceId,
		legacyNarrativeFallback: useNarrativeClassifierFallback,
		maxOutputTokens: classifierGeneration.maxTokens,
		responseFormat: 'json_schema',
		responseSchemaName: 'mtherios_state_patch',
	};
	if (classifierProfile && stateExtractionMode === 'sync') {
		classifierExtractionSystem = classifierService.systemPromptOverride?.trim() || DEFAULT_STATE_EXTRACTION_SYSTEM;
		classifierExtractionPrompt = buildStateExtractionPrompt(request.playerText, narration);
		try {
			const extractionResult = await generateServerTextWithMetrics({
				profile: classifierProfile,
				model: classifierGeneration.model,
				temperature: classifierGeneration.temperature,
				maxTokens: classifierGeneration.maxTokens,
				system: classifierExtractionSystem,
				prompt: classifierExtractionPrompt,
				responseSchema: buildStateExtractionResponseSchema(),
			});
			classifierExtractionResult = extractionResult;
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
				responseFormat: 'json_schema',
				responseSchemaName: 'mtherios_state_patch',
				retryCount: extractionResult.retryCount ?? 0,
			});
			parsedUpdate = recorder.timeSync('turn.validation.parse_update', {}, () => parseStateExtractionResult(extractionResult.text));
			classifierParseSucceeded = true;
		} catch (error) {
			const failedResult = generationErrorResult(error);
			const loggedResult = classifierExtractionResult ?? failedResult;
			if (failedResult && !classifierExtractionResult) {
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
					responseFormat: 'json_schema',
					responseSchemaName: 'mtherios_state_patch',
					retryCount: failedResult.retryCount ?? 0,
					statusCode: failedResult.statusCode ?? null,
				});
			}
			if (loggedResult) {
				await logGenerationCall({
					storyId: request.storyId,
					clientTurnId: request.clientTurnId,
					serviceId: 'classifier',
					operation: 'turn.state_extraction',
					profile: classifierProfile,
					result: loggedResult,
					status: 'error',
					error,
					metadata: {
						...classifierLogMetadata,
						parseOutcome: classifierExtractionResult ? 'error' : 'not_started',
						applyOutcome: 'not_started',
						finishReason: classifierExtractionResult?.finishReason ?? null,
						reasoningTokens: classifierExtractionResult?.usage.reasoningTokens ?? null,
						statusCode: failedResult?.statusCode ?? null,
						debugSnapshot: buildTurnDebugSnapshot({
							kind: 'state_extraction',
							playerText: request.playerText,
							system: classifierExtractionSystem,
							prompt: classifierExtractionPrompt,
							output: classifierExtractionResult?.text,
						}),
					},
				});
			}
			warnings.push(`State extraction failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	warnings.push(...parsedUpdate.warnings);
	let applied: Awaited<ReturnType<typeof applyValidatedTurnUpdate>>;
	try {
		applied = await recorder.time('turn.validation.apply_update', {
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
	} catch (error) {
		if (classifierProfile && classifierExtractionResult && classifierParseSucceeded) {
			await logGenerationCall({
				storyId: request.storyId,
				clientTurnId: request.clientTurnId,
				serviceId: 'classifier',
				operation: 'turn.state_extraction',
				profile: classifierProfile,
				result: classifierExtractionResult,
				status: 'error',
				error,
				metadata: {
					...classifierLogMetadata,
					parseOutcome: 'valid',
					applyOutcome: 'error',
					operationCount: parsedUpdate.operationCount,
					finishReason: classifierExtractionResult.finishReason ?? null,
					reasoningTokens: classifierExtractionResult.usage.reasoningTokens ?? null,
					debugSnapshot: buildTurnDebugSnapshot({
						kind: 'state_extraction',
						playerText: request.playerText,
						system: classifierExtractionSystem,
						prompt: classifierExtractionPrompt,
						output: classifierExtractionResult.text,
					}),
				},
			});
		}
		throw error;
	}
	if (classifierProfile && classifierExtractionResult && classifierParseSucceeded) {
		await logGenerationCall({
			storyId: request.storyId,
			clientTurnId: request.clientTurnId,
			serviceId: 'classifier',
			operation: 'turn.state_extraction',
			profile: classifierProfile,
			result: classifierExtractionResult,
			status: 'success',
			metadata: {
				...classifierLogMetadata,
				parseOutcome: 'valid',
				applyOutcome: parsedUpdate.operationCount > 0 ? 'applied' : 'no_changes',
				operationCount: parsedUpdate.operationCount,
				appliedEventCount: applied.eventIds.length,
				appliedPatchCount: applied.patchIds.length,
				appliedMemoryNodeCount: applied.memoryNodeIds.length,
				applyWarningCount: applied.warnings.length,
				finishReason: classifierExtractionResult.finishReason ?? null,
				reasoningTokens: classifierExtractionResult.usage.reasoningTokens ?? null,
				debugSnapshot: buildTurnDebugSnapshot({
					kind: 'state_extraction',
					playerText: request.playerText,
					system: classifierExtractionSystem,
					prompt: classifierExtractionPrompt,
					output: classifierExtractionResult.text,
				}),
			},
		});
	}
	warnings.push(...applied.warnings);
	if (stateExtractionMode === 'deferred') {
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
				serverVersion: turnVersion,
				retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
				memorySettings,
			}));
			warnings.push(`State extraction queued as background job: ${jobId}`);
		} catch (error) {
			warnings.push(`State extraction enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (shouldQueueChapterSummaryWithoutState(stateExtractionMode, {
		eventIds: applied.eventIds.length,
		memoryNodeIds: applied.memoryNodeIds.length,
		patchIds: applied.patchIds.length,
	})) {
		try {
			const chapterJobId = await recorder.time('turn.chapter_summary.enqueue_without_state_changes', {
				stateExtractionMode,
			}, () => enqueueChapterSummaryJob({
				storyId: request.storyId,
				serverVersion: turnVersion,
				dedupeKey: `chapter-summary-${assistantEntryId}`,
				memorySettings,
			}));
			warnings.push(`Chapter checkpoint queued independently of state extraction: ${chapterJobId}`);
		} catch (error) {
			warnings.push(`Chapter checkpoint enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
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
		stateExtractionMode,
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
	} catch (error) {
		await recorder.time('turn.command.mark_failed', {}, () => markTurnCommandFailed(request, error));
		throw error;
	}
}
