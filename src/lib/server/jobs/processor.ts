import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { arcs, backendJobs, chapters, entities, factions, memoryNodes, patchProposals, stories, storyEntries, storyEvents } from '$lib/server/db/schema';
import type { MemoryNode } from '$lib/contracts/memory';
import { getServerMemoryConfig } from '$lib/server/env';
import {
	embedMemoryTexts,
	memoryEmbeddingConfig,
	memoryNodeEmbeddingText,
	validateMemoryEmbeddingVector,
} from '$lib/server/memory/embeddings';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { getStoryVaultStatus, materializeStoryVault, writeStoryVaultLintReport, type StoryVaultStatus } from '$lib/server/wiki/storyVault';
import { indexWiki, lintWiki } from '$lib/server/wiki/wikiCore';
import { claimBackendJobs, enqueueBackendJob, enqueueChapterSummaryJob, enqueuePlotBrainJob, enqueueStoryVaultSyncJob, markBackendJobComplete, markBackendJobFailed, type BackendJobType } from './outbox';
import { indexCanonicalRecords } from '$lib/server/engine/canonicalSearch';
import { recordApiCallLog } from '$lib/server/engine/apiCallLogs';
import { publishEngineEvent } from '$lib/server/engine/events';
import { resolveServiceGeneration } from '$lib/server/engine/llmSettings';
import { createTimingRecorder, type TimingEntry, type TimingRecorder } from '$lib/server/performance/timing';
import { mapWithConcurrency, readGenerationConcurrency } from '$lib/server/performance/concurrency';
import { buildTurnDebugSnapshot } from '$lib/server/turn/debugSnapshot';
import { applyValidatedTurnUpdate } from '$lib/server/turn/patchValidator';
import { buildStateExtractionPrompt } from '$lib/server/turn/promptPacket';
import {
	buildStateExtractionResponseSchema,
	classifierGenerationMaxTokens,
	DEFAULT_STATE_EXTRACTION_SYSTEM,
	parseStateExtractionResult,
	shouldExtractDurableState,
	shouldUseLegacyClassifierFallback,
} from '$lib/server/turn/orchestrator';
import { applyChapterScribeCharacterContextProposals } from '$lib/server/engine/canonRepair';
import { refineChapterCharacterUpdates } from '$lib/server/engine/characterDrafts';
import { isCharacterTitleOnlyName, resolveEntityIdentity, shouldReuseResolvedEntity } from '$lib/server/memory/entityResolver';
import {
	ServerGenerationError,
	generateServerTextWithMetrics,
	parseJsonFromGeneratedText,
	type ServerGenerationResult,
} from '$lib/server/turn/provider';
import { buildMtheriosSummaryInstruction, extractMtheriosSummarySection, formatMtheriosMemorySummary, summarizeMtheriosMemoryForRollup, type MtheriosCharacterState } from '$lib/services/ai/context/mtheriosSummaryFormat';
import { hasStrategicPlotContent } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';

type BackendJobRow = typeof backendJobs.$inferSelect;
type ArcRow = typeof arcs.$inferSelect;
type ChapterRow = typeof chapters.$inferSelect;
type FactionRow = typeof factions.$inferSelect;
type StoryEntryRow = typeof storyEntries.$inferSelect;
type StoryEventRow = typeof storyEvents.$inferSelect;
type ProviderProfile = NonNullable<Awaited<ReturnType<typeof resolveServiceGeneration>>['profile']>;
type GenerationResult = ServerGenerationResult | ServerGenerationError['result'];

const ARC_ROLLUP_KEY_POINT_CHAR_LIMIT = 1200;
const ARC_ROLLUP_CHARACTER_DEVELOPMENT_CHAR_LIMIT = 420;
const ARC_ROLLUP_THREAD_CHAR_LIMIT = 240;
const ARC_ROLLUP_THREAD_LIMIT = 20;
const ARC_ROLLUP_OVERVIEW_CHAR_LIMIT = 1050;
const ARC_ROLLUP_SUMMARY_ITEM_LIMIT = 3;
const CHARACTER_CONTEXT_AUTO_APPLY_CHAPTER_INTERVAL = 2;

export interface ChapterMemoryDigest {
	title: string;
	summary: string;
	keywords: string[];
	keyCharacters: string[];
	keyLocations: string[];
	plotThreads: string[];
	emotionalTone: string;
	source: 'deterministic' | 'llm';
	model?: string;
}

export interface ChapterCharacterReferenceCandidate {
	name: string;
	description: string | null;
	sourceEventIds: string[];
	confidence: number;
	reason: string;
}

export interface ChapterCharacterContextPatch {
	state: Record<string, unknown>;
	sourceEventIds: string[];
	did: string[];
	saw: string[];
}

export function chapterCharacterContextProposalValues(input: {
	storyId: string;
	entityId: string;
	entityName: string;
	chapterId: string;
	chapterNumber: number;
	chapterTitle: string | null;
	patch: ChapterCharacterContextPatch;
	sourceEntryIds: string[];
	serverVersion: number;
	now: string;
}): typeof patchProposals.$inferInsert {
	return {
		id: stableId('proposal_chapter_character_context', [input.storyId, input.chapterId, input.entityId]),
		storyId: input.storyId,
		proposalType: 'character_context_update',
		targetTable: 'entities',
		targetRecordId: input.entityId,
		proposedBy: 'chapter_scribe',
		operations: [{ op: 'replace', path: `/characters/${input.entityId}/state`, value: input.patch.state }],
		reason: `${input.entityName} appears in chapter ${input.chapterNumber}: ${input.chapterTitle ?? 'Untitled chapter'}.`,
		suggestion: 'Review this chapter-derived character memory before applying it to canon.',
		status: 'pending',
		affectedEntityIds: [input.entityId],
		confidence: 0.68,
		sourceEntryIds: input.sourceEntryIds,
		sourceEventIds: input.patch.sourceEventIds,
		sourcePatchIds: [],
		metadata: {
			sourceType: 'chapter_character_context',
			characterName: input.entityName,
			chapterId: input.chapterId,
			chapterNumber: input.chapterNumber,
		},
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	};
}

export function refreshChapterCharacterContextProposalValues(
	existingProposal: Pick<typeof patchProposals.$inferSelect, 'operations' | 'sourceEntryIds' | 'sourceEventIds' | 'metadata'>,
	values: typeof patchProposals.$inferInsert,
): Partial<typeof patchProposals.$inferInsert> {
	const metadata = asRecord(values.metadata);
	return {
		operations: mergeChapterCharacterContextOperations(existingProposal.operations, values.operations),
		reason: values.reason,
		suggestion: values.suggestion,
		affectedEntityIds: values.affectedEntityIds,
		confidence: values.confidence,
		sourceEntryIds: uniqueStrings([...(existingProposal.sourceEntryIds ?? []), ...(values.sourceEntryIds ?? [])]),
		sourceEventIds: uniqueStrings([...(existingProposal.sourceEventIds ?? []), ...(values.sourceEventIds ?? [])]),
		metadata: {
			...asRecord(existingProposal.metadata),
			...metadata,
			refreshedFromChapterId: metadata.chapterId,
			refreshedFromChapterNumber: metadata.chapterNumber,
		},
		serverVersion: values.serverVersion,
		updatedAt: values.updatedAt,
	};
}

function characterContextOperationState(operations: unknown): Record<string, unknown> | null {
	if (!Array.isArray(operations)) return null;
	for (const rawOperation of operations) {
		const operation = asRecord(rawOperation);
		if (operation.op !== 'replace' || !/^\/(?:characters|entities)\/[^/]+\/state$/.test(String(operation.path ?? ''))) continue;
		const state = asRecord(operation.value);
		if (Object.keys(state).length > 0) return state;
	}
	return null;
}

export function replaceCharacterContextOperationState(
	operations: unknown,
	state: Record<string, unknown>,
): (typeof patchProposals.$inferInsert)['operations'] {
	if (!Array.isArray(operations)) return [];
	return operations.map((rawOperation) => {
		const operation = asRecord(rawOperation);
		return operation.op === 'replace' && /^\/(?:characters|entities)\/[^/]+\/state$/.test(String(operation.path ?? ''))
			? { ...operation, value: state }
			: rawOperation;
	}) as (typeof patchProposals.$inferInsert)['operations'];
}

function mergeChapterCharacterContextOperations(
	previous: unknown,
	next: (typeof patchProposals.$inferInsert)['operations'],
): (typeof patchProposals.$inferInsert)['operations'] {
	const previousState = characterContextOperationState(previous);
	const nextState = characterContextOperationState(next);
	if (!previousState || !nextState || !Array.isArray(next)) return next;
	const previousMemory = asRecord(previousState.eventMemory);
	const nextMemory = asRecord(nextState.eventMemory);
	const mergedState = {
		...previousState,
		...nextState,
		eventMemory: {
			...previousMemory,
			...nextMemory,
			did: mergeStringList(previousMemory.did, asStringArray(nextMemory.did)),
			saw: mergeStringList(previousMemory.saw, asStringArray(nextMemory.saw)),
			knew: mergeStringList(previousMemory.knew, asStringArray(nextMemory.knew)),
		},
	};
	return next.map((rawOperation) => {
		const operation = asRecord(rawOperation);
		return operation.op === 'replace' && /^\/(?:characters|entities)\/[^/]+\/state$/.test(String(operation.path ?? ''))
			? { ...operation, value: mergedState }
			: rawOperation;
	}) as (typeof patchProposals.$inferInsert)['operations'];
}

export function shouldAutoApplyChapterCharacterContext(chapterNumber: number): boolean {
	return Number.isInteger(chapterNumber)
		&& chapterNumber > 0
		&& chapterNumber % CHARACTER_CONTEXT_AUTO_APPLY_CHAPTER_INTERVAL === 0;
}

export interface BackendJobTimingReport {
	jobId: string;
	storyId: string;
	type: string;
	status: 'completed' | 'failed';
	durationMs: number;
	phases: TimingEntry[];
}

export interface BackendJobPreview {
	id: string;
	storyId: string;
	type: string;
	status: string;
	attemptCount: number;
	maxAttempts: number;
	runAfter: string;
	lockedAt: string | null;
	lockedBy: string | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface BackendJobStats {
	total: number;
	queued: number;
	retry: number;
	running: number;
	complete: number;
	failed: number;
	ready: number;
	delayed: number;
	storyCount: number;
	byStatus: Record<string, number>;
	byType: Record<string, number>;
	readyByType: Record<string, number>;
	failedByType: Record<string, number>;
	oldestReadyAt: string | null;
	nextRunAfter: string | null;
	recentFailures: BackendJobPreview[];
	runningJobs: BackendJobPreview[];
}

type BackendJobStatusEventStatus = 'running' | 'completed' | 'failed';

type FactionPressureReason = {
	eventId: string;
	eventType: string;
	title: string;
	delta: number;
	reason: string;
	updatedAt: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

function id(prefix = 'job'): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

async function timePhase<T>(
	recorder: TimingRecorder | undefined,
	phase: string,
	metadata: Record<string, unknown>,
	fn: () => Promise<T>,
): Promise<T> {
	return recorder ? recorder.time(phase, metadata, fn) : fn();
}

function timePhaseSync<T>(
	recorder: TimingRecorder | undefined,
	phase: string,
	metadata: Record<string, unknown>,
	fn: () => T,
): T {
	return recorder ? recorder.timeSync(phase, metadata, fn) : fn();
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asOptionalInt(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	return clamp(Math.trunc(value), min, max);
}

function requirePayloadString(payload: Record<string, unknown>, key: string): string {
	const value = payload[key];
	if (typeof value === 'string' && value.trim()) return value;
	throw new Error(`extract_turn_state job is missing payload.${key}`);
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function snippet(value: string, max = 220): string {
	const clean = compactWhitespace(value);
	return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}...` : clean;
}

function arcSummarySnippet(value: string, max: number): string {
	const clean = compactWhitespace(value).replace(/\s*\.\.\.$/u, '');
	if (clean.length <= max) return clean;
	const slice = clean.slice(0, max).trimEnd();
	const sentence = [...slice.matchAll(/[.!?]["')\]]?(?=\s|$)/g)].at(-1);
	if (sentence && sentence.index !== undefined && sentence.index > max * 0.45) {
		return slice.slice(0, sentence.index + sentence[0].length).trim();
	}
	const wordBreak = slice.lastIndexOf(' ');
	return slice.slice(0, wordBreak > max * 0.45 ? wordBreak : max).replace(/[,:;("-]+$/u, '').trim();
}

export function backendJobStatusEventData(
	job: Pick<BackendJobRow, 'id' | 'storyId' | 'type' | 'attemptCount' | 'maxAttempts'>,
	status: BackendJobStatusEventStatus,
	details: { result?: Record<string, unknown>; error?: string } = {},
): Record<string, unknown> {
	return {
		jobId: job.id,
		storyId: job.storyId,
		type: job.type,
		status,
		attemptCount: job.attemptCount,
		maxAttempts: job.maxAttempts,
		...(details.result ? { result: details.result } : {}),
		...(details.error ? { error: snippet(details.error, 500) } : {}),
	};
}

function publishBackendJobStatus(
	job: Pick<BackendJobRow, 'id' | 'storyId' | 'type' | 'attemptCount' | 'maxAttempts'>,
	status: BackendJobStatusEventStatus,
	details: { result?: Record<string, unknown>; error?: string } = {},
): void {
	publishEngineEvent({
		storyId: job.storyId,
		type: 'job.status',
		data: backendJobStatusEventData(job, status, details),
	});
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stableId(prefix: string, parts: string[]): string {
	const normalized = parts
		.join('_')
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 160);
	return `${prefix}_${normalized || id('stable')}`;
}

function normalizedCharacterReference(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function chapterCharacterNamesMatch(left: string, right: string): boolean {
	const leftName = normalizedCharacterReference(left);
	const rightName = normalizedCharacterReference(right);
	if (!leftName || !rightName) return false;
	if (leftName === rightName) return true;
	const leftTokens = leftName.split(' ');
	const rightTokens = rightName.split(' ');
	if (leftTokens.length === rightTokens.length
		&& [...leftTokens].sort().join(' ') === [...rightTokens].sort().join(' ')) return true;
	const [shorter, longer] = leftTokens.length <= rightTokens.length
		? [leftTokens, rightTokens]
		: [rightTokens, leftTokens];
	return shorter.length === 1 && shorter[0].length >= 4 && longer.includes(shorter[0]);
}

function characterReferenceMentioned(text: string, name: string): boolean {
	const normalizedText = ` ${normalizedCharacterReference(text)} `;
	const normalizedName = normalizedCharacterReference(name);
	return Boolean(normalizedName) && normalizedText.includes(` ${normalizedName} `);
}

function cleanCharacterReferenceName(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function plausibleCharacterReferenceName(value: string): boolean {
	const normalized = normalizedCharacterReference(value);
	if (!normalized || normalized.length < 3) return false;
	if (isCharacterTitleOnlyName(value)) return false;
	if (normalized === 'dancer' || normalized === 'fire wyrm' || normalized.endsWith(' warrior')) return false;
	if (['player', 'narrator', 'chapter', 'scene', 'unknown', 'someone', 'innkeep'].includes(normalized)) return false;
	if (/\b(house|court|empire|kingdom|city|quarter|market|fleet|army|bank|temple|palace)\b/.test(normalized)) return false;
	return true;
}

export function chapterCharacterReferenceCandidates(input: {
	digest: ChapterMemoryDigest;
	events: Array<{ id?: string | null; title?: string | null; body?: string | null }>;
	existingNames?: string[];
}): ChapterCharacterReferenceCandidate[] {
	const existing = new Set((input.existingNames ?? []).map(normalizedCharacterReference));
	const candidates: ChapterCharacterReferenceCandidate[] = [];
	for (const rawName of input.digest.keyCharacters) {
		const name = cleanCharacterReferenceName(rawName);
		const normalized = normalizedCharacterReference(name);
		if (!plausibleCharacterReferenceName(name) || existing.has(normalized)) continue;

		const sourceEventIds = uniqueStrings(input.events
			.filter((event) => characterReferenceMentioned(`${event.title ?? ''} ${event.body ?? ''}`, name))
			.map((event) => event.id ?? '')
			.filter(Boolean));
		const summaryHit = characterReferenceMentioned(input.digest.summary, name);
		const importance = sourceEventIds.length + (summaryHit ? 1 : 0);
		if (importance < 3) continue;

		candidates.push({
			name,
			description: snippet(`${name} is important in this chapter checkpoint.`, 180),
			sourceEventIds,
			confidence: Math.min(0.82, 0.52 + (importance * 0.1)),
			reason: summaryHit
				? `${name} appears in the chapter summary and source events.`
				: `${name} appears in multiple source events for this chapter.`,
		});
	}
	return candidates;
}

function mergeStringList(previous: unknown, next: string[], max = 16): string[] {
	return uniqueStrings([...asStringArray(previous), ...next]).slice(-max);
}

export function chapterCharacterContextPatch(input: {
	entityId: string;
	currentState: Record<string, unknown>;
	digest: ChapterMemoryDigest;
	events: StoryEventRow[];
}): ChapterCharacterContextPatch | null {
	const didEvents = input.events.filter((event) => asStringArray(event.actorEntityIds).includes(input.entityId));
	const sawEvents = input.events.filter((event) =>
		!asStringArray(event.actorEntityIds).includes(input.entityId) &&
		asStringArray(event.targetEntityIds).includes(input.entityId)
	);
	const did = uniqueStrings(didEvents.map(eventSummaryForCharacter)).slice(-6);
	const saw = uniqueStrings(sawEvents.map(eventSummaryForCharacter)).slice(-6);
	if (!did.length && !saw.length) return null;

	const memory = asRecord(input.currentState.eventMemory ?? input.currentState.npcEventMemory);
	const state: Record<string, unknown> = {
		...input.currentState,
		currentAction: snippet([...did, ...saw].at(-1) ?? input.digest.title, 220),
		eventMemory: {
			...memory,
			did: mergeStringList(memory.did, did),
			saw: mergeStringList(memory.saw, saw),
		},
	};
	const location = input.digest.keyLocations[0]?.trim();
	if (location) state.currentLocation = location;
	return {
		state,
		sourceEventIds: uniqueStrings([...didEvents, ...sawEvents].map((event) => event.id)),
		did,
		saw,
	};
}

async function bumpStoryVersion(storyId: string): Promise<number> {
	const [row] = await getDb()
		.update(stories)
		.set({
			serverVersion: sql`${stories.serverVersion} + 1`,
			updatedAt: nowIso(),
		})
		.where(eq(stories.id, storyId))
		.returning({ serverVersion: stories.serverVersion });
	return row?.serverVersion ?? 1;
}

function generationErrorResult(error: unknown): ServerGenerationError['result'] | null {
	return error instanceof ServerGenerationError ? error.result : null;
}

async function logDeferredStateExtractionCall(options: {
	job: BackendJobRow;
	clientTurnId: string;
	profile: ProviderProfile;
	result: GenerationResult;
	status: 'success' | 'error';
	error?: unknown;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	const usage = 'usage' in options.result ? options.result.usage : undefined;
	await recordApiCallLog({
		storyId: options.job.storyId,
		serviceId: 'classifier',
		operation: 'turn.state_extraction',
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
			jobId: options.job.id,
			clientTurnId: options.clientTurnId,
			deferred: true,
			...options.metadata,
		},
	});
}

function eventMemoryType(row: StoryEventRow): MemoryNode['type'] {
	if (row.type === 'faction_move') return 'faction';
	if (row.type === 'agreement' || row.type === 'promise' || row.type === 'betrayal') return 'plot_ledger';
	return 'episodic';
}

function eventImportance(row: StoryEventRow): number {
	const impact = asRecord(row.memoryImpact);
	const explicitImportance = asNumber(impact.importance, Number.NaN);
	if (Number.isFinite(explicitImportance)) return clamp(explicitImportance, 0, 1);
	if (row.type === 'promise' || row.type === 'betrayal' || row.type === 'agreement') return 0.9;
	if (row.type === 'faction_move' || row.type === 'death' || row.type === 'reveal') return 0.8;
	return 0.65;
}

function eventMemoryKind(row: StoryEventRow): 'episodic' | 'prospective' {
	return row.status === 'scheduled' && row.scheduledTurn !== null ? 'prospective' : 'episodic';
}

function eventMemoryKeywords(row: StoryEventRow): string[] {
	const impact = asRecord(row.memoryImpact);
	return uniqueStrings([
		row.type,
		row.status !== 'committed' ? row.status : '',
		typeof impact.durability === 'string' ? impact.durability : '',
		impact.requiresReflection === true ? 'requires_reflection' : '',
	]);
}

function eventProjectionMetadata(row: StoryEventRow, options: { jobId: string }): Record<string, unknown> {
	const impact = asRecord(row.memoryImpact);
	const metadata: Record<string, unknown> = {
		...asRecord(row.metadata),
		sourceType: 'event_projection',
		jobId: options.jobId,
		memoryKind: eventMemoryKind(row),
		status: row.status,
		validFromTurn: row.occurredTurn ?? row.createdTurn,
		occurredTurn: row.occurredTurn,
		scheduledTurn: row.scheduledTurn,
		worldTime: row.worldTime,
	};
	for (const key of ['emotionalValence', 'durability', 'decayRate', 'confidence'] as const) {
		if (impact[key] !== undefined) metadata[key] = impact[key];
	}
	const emotions = asStringArray(impact.emotions);
	if (emotions.length > 0) metadata.emotions = emotions;
	if (impact.requiresReflection !== undefined) metadata.requiresReflection = Boolean(impact.requiresReflection);
	return metadata;
}

export function buildEventMemoryNodeValues(
	row: StoryEventRow,
	options: { jobId: string; updatedAt: string },
): typeof memoryNodes.$inferInsert {
	return {
		id: `mem_event_${row.id}`,
		storyId: row.storyId,
		type: eventMemoryType(row),
		title: row.title,
		content: row.body,
		summary: row.body.replace(/\s+/g, ' ').slice(0, 360),
		keywords: eventMemoryKeywords(row),
		entityIds: uniqueStrings([...asStringArray(row.actorEntityIds), ...asStringArray(row.targetEntityIds)]),
		factionIds: asStringArray(row.factionIds),
		threadIds: asStringArray(row.threadIds),
		locationId: row.locationId ?? null,
		visibility: row.visibility,
		importance: eventImportance(row),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: [row.id],
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		metadata: eventProjectionMetadata(row, { jobId: options.jobId }),
		serverVersion: row.serverVersion,
		createdAt: row.createdAt,
		updatedAt: options.updatedAt,
	};
}

export function shouldProjectEventToMemory(row: Pick<StoryEventRow, 'type' | 'title' | 'body'>): boolean {
	if (row.type !== 'correction') return true;
	return !/transcript context removed|poisoned context|deleted a poisoned context|removed transcript context/i.test(`${row.title}\n${row.body}`);
}

async function loadEventRows(storyId: string, eventIds: string[]): Promise<StoryEventRow[]> {
	const db = getDb();
	if (eventIds.length > 0) {
		return db.select().from(storyEvents).where(and(
			eq(storyEvents.storyId, storyId),
			inArray(storyEvents.id, eventIds),
		));
	}
	return db
		.select()
		.from(storyEvents)
		.where(eq(storyEvents.storyId, storyId))
		.orderBy(desc(storyEvents.updatedAt))
		.limit(200);
}

async function createMemoryNodesFromEvents(job: BackendJobRow): Promise<number> {
	const db = getDb();
	const payload = asRecord(job.payload);
	const eventIds = asStringArray(payload.eventIds);
	const rows = await loadEventRows(job.storyId, eventIds);
	const updatedAt = nowIso();
	let created = 0;
	for (const row of rows) {
		if (!shouldProjectEventToMemory(row)) continue;
		const values = buildEventMemoryNodeValues(row, { jobId: job.id, updatedAt });
		const { id: _id, storyId: _storyId, createdAt: _createdAt, ...updateValues } = values;
		void _id;
		void _storyId;
		void _createdAt;
		await db.insert(memoryNodes).values(values).onConflictDoUpdate({
			target: memoryNodes.id,
			set: updateValues,
		});
		created += 1;
	}
	return created;
}

function eventText(row: StoryEventRow): string {
	return compactWhitespace(`${row.type} ${row.title} ${row.body}`);
}

function nameMentioned(text: string, name: string): boolean {
	const normalized = compactWhitespace(name);
	if (normalized.length < 3) return false;
	const pattern = normalized.split(/\s+/).map(escapeRegExp).join('\\s+');
	return new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`, 'i').test(text);
}

function factionAliases(faction: FactionRow): string[] {
	const metadata = asRecord(faction.metadata);
	return uniqueStrings([
		faction.name,
		...asStringArray(metadata.aliases),
		...asStringArray(metadata.names),
	]);
}

function eventMentionsFaction(row: StoryEventRow, faction: FactionRow): boolean {
	const eventEntityIds = new Set([
		...asStringArray(row.actorEntityIds),
		...asStringArray(row.targetEntityIds),
	]);
	const factionEntityIds = uniqueStrings([
		faction.id,
		faction.entityId ?? '',
		...asStringArray(faction.memberEntityIds),
	]);
	if (factionEntityIds.some((entityId) => eventEntityIds.has(entityId))) return true;
	const text = eventText(row);
	return factionAliases(faction).some((alias) => nameMentioned(text, alias));
}

function pressureBase(row: StoryEventRow): number {
	switch (row.type) {
		case 'betrayal':
			return 11;
		case 'death':
			return 9;
		case 'faction_move':
			return 7;
		case 'injury':
			return 6;
		case 'reveal':
			return 5;
		case 'agreement':
		case 'promise':
		case 'relationship_shift':
			return 4;
		case 'clue_discovery':
			return 3;
		case 'correction':
			return 0;
		default:
			return 2;
	}
}

function pressureTextBonus(text: string): { bonus: number; reason: string } {
	const checks: Array<{ pattern: RegExp; bonus: number; reason: string }> = [
		{ pattern: /\b(war|siege|invasion|rebellion|coup|assassin|murder|massacre|hostage|betrayal|treason|dragon|famine|plague)\b/i, bonus: 4, reason: 'crisis language' },
		{ pattern: /\b(debt|blackmail|ultimatum|threat|ambush|raid|sanction|scarcity|shortage)\b/i, bonus: 3, reason: 'strategic stress' },
		{ pattern: /\b(rumor|spy|secret|clue|evidence|scheme|plot|deal|alliance)\b/i, bonus: 2, reason: 'political thread' },
	];
	return checks.find((check) => check.pattern.test(text)) ?? { bonus: 0, reason: 'event type' };
}

function pressureReason(row: StoryEventRow, now: string): FactionPressureReason {
	const base = pressureBase(row);
	const textBonus = pressureTextBonus(eventText(row));
	const delta = clamp(base + textBonus.bonus, 0, 16);
	return {
		eventId: row.id,
		eventType: row.type,
		title: row.title,
		delta,
		reason: textBonus.reason,
		updatedAt: now,
	};
}

function recentPressureReasons(metadata: Record<string, unknown>): FactionPressureReason[] {
	const value = metadata.pressureReasons;
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
		.map((item) => ({
			eventId: typeof item.eventId === 'string' ? item.eventId : '',
			eventType: typeof item.eventType === 'string' ? item.eventType : 'event',
			title: typeof item.title === 'string' ? item.title : '',
			delta: asNumber(item.delta, 0),
			reason: typeof item.reason === 'string' ? item.reason : 'event type',
			updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
		}))
		.filter((item) => item.eventId && item.delta > 0);
}

function factionPressureContent(input: {
	faction: FactionRow;
	pressure: number;
	reasons: FactionPressureReason[];
}): string {
	const recent = input.reasons.slice(-8).reverse();
	const lines = recent.map((reason) => `- +${reason.delta} ${reason.title || reason.eventType} (${reason.reason})`);
	return [
		`${input.faction.name} pressure is ${input.pressure}/100.`,
		lines.length > 0 ? `Recent drivers:\n${lines.join('\n')}` : 'No recent drivers recorded.',
	].join('\n\n');
}

async function upsertFactionPressureMemoryNode(input: {
	faction: FactionRow;
	pressure: number;
	reasons: FactionPressureReason[];
	sourceEventIds: string[];
	serverVersion: number;
	now: string;
	jobId: string;
}): Promise<void> {
	const content = factionPressureContent({
		faction: input.faction,
		pressure: input.pressure,
		reasons: input.reasons,
	});
	const eventTypes = uniqueStrings(input.reasons.map((reason) => reason.eventType));
	await getDb().insert(memoryNodes).values({
		id: `mem_faction_pressure_${input.faction.id}`,
		storyId: input.faction.storyId,
		type: 'faction',
		title: `${input.faction.name} pressure`,
		content,
		summary: snippet(content, 360),
		keywords: uniqueStrings(['faction', 'pressure', 'terminal_pressure_job', ...eventTypes]),
		entityIds: uniqueStrings([input.faction.entityId ?? '', ...asStringArray(input.faction.memberEntityIds)]),
		factionIds: [input.faction.id],
		threadIds: [],
		locationId: null,
		visibility: 'player_known',
		importance: clamp(0.55 + (input.pressure / 220), 0.55, 0.95),
		sourceEntryIds: asStringArray(input.faction.sourceEntryIds),
		sourceEventIds: input.sourceEventIds,
		sourcePatchIds: asStringArray(input.faction.sourcePatchIds),
		metadata: {
			sourceType: 'terminal_faction_pressure_job',
			jobId: input.jobId,
			factionId: input.faction.id,
			factionName: input.faction.name,
			pressure: input.pressure,
		},
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	}).onConflictDoUpdate({
		target: memoryNodes.id,
		set: {
			title: `${input.faction.name} pressure`,
			content,
			summary: snippet(content, 360),
			keywords: uniqueStrings(['faction', 'pressure', 'terminal_pressure_job', ...eventTypes]),
			entityIds: uniqueStrings([input.faction.entityId ?? '', ...asStringArray(input.faction.memberEntityIds)]),
			factionIds: [input.faction.id],
			importance: clamp(0.55 + (input.pressure / 220), 0.55, 0.95),
			sourceEntryIds: asStringArray(input.faction.sourceEntryIds),
			sourceEventIds: input.sourceEventIds,
			sourcePatchIds: asStringArray(input.faction.sourcePatchIds),
			metadata: {
				sourceType: 'terminal_faction_pressure_job',
				jobId: input.jobId,
				factionId: input.faction.id,
				factionName: input.faction.name,
				pressure: input.pressure,
			},
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		},
	});
}

async function updateFactionPressure(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const eventIds = asStringArray(payload.eventIds);
	const rows = await timePhase(recorder, 'job.update_faction_pressure.load_events', { eventIds: eventIds.length }, () => loadEventRows(job.storyId, eventIds));
	if (rows.length === 0) {
		return { updatedFactions: 0, eventCount: 0, reason: 'no_events' };
	}

	const factionRows = await timePhase(recorder, 'job.update_faction_pressure.load_factions', {}, () => getDb()
			.select()
			.from(factions)
			.where(eq(factions.storyId, job.storyId))
			.orderBy(asc(factions.name)));
	if (factionRows.length === 0) {
		return { updatedFactions: 0, eventCount: rows.length, reason: 'no_factions' };
	}

	const now = nowIso();
	const changedFactions = timePhaseSync(recorder, 'job.update_faction_pressure.match_factions', {
		events: rows.length,
		factions: factionRows.length,
	}, () => factionRows.map((faction) => {
		const existingSourceEventIds = asStringArray(faction.sourceEventIds);
		const alreadySeen = new Set(existingSourceEventIds);
		const matchedRows = rows
			.filter((row) => !alreadySeen.has(row.id))
			.filter((row) => eventMentionsFaction(row, faction));
		const reasons = matchedRows
			.map((row) => pressureReason(row, now))
			.filter((reason) => reason.delta > 0);
		if (reasons.length === 0) return null;

		const metadata = asRecord(faction.metadata);
		const recentReasons = [...recentPressureReasons(metadata), ...reasons].slice(-12);
		const delta = reasons.reduce((total, reason) => total + reason.delta, 0);
		const pressure = clamp(faction.pressure + delta, 0, 100);
		const sourceEventIds = uniqueStrings([...existingSourceEventIds, ...reasons.map((reason) => reason.eventId)]);
		return { faction, metadata, recentReasons, reasons, delta, pressure, sourceEventIds };
	}).filter((item): item is {
		faction: FactionRow;
		metadata: Record<string, unknown>;
		recentReasons: FactionPressureReason[];
		reasons: FactionPressureReason[];
		delta: number;
		pressure: number;
		sourceEventIds: string[];
	} => Boolean(item)));

	if (changedFactions.length === 0) {
		return {
			updatedFactions: 0,
			eventCount: rows.length,
			changes: [],
			reason: 'no_new_matching_events',
		};
	}

	const serverVersion = await timePhase(recorder, 'job.update_faction_pressure.bump_version', {}, () => bumpStoryVersion(job.storyId));
	const concurrency = readGenerationConcurrency();
	const changes = await timePhase(recorder, 'job.update_faction_pressure.persist_factions', {
		changedFactions: changedFactions.length,
		concurrency,
	}, () => mapWithConcurrency(changedFactions, concurrency, async (change) => {
		const { faction, metadata, recentReasons, reasons, delta, pressure, sourceEventIds } = change;
		await getDb().update(factions).set({
			pressure,
			sourceEventIds,
			metadata: {
				...metadata,
				pressureUpdatedAt: now,
				pressureJobId: job.id,
				pressureReasons: recentReasons,
			},
			serverVersion,
			updatedAt: now,
		}).where(and(eq(factions.storyId, job.storyId), eq(factions.id, faction.id)));
		await upsertFactionPressureMemoryNode({
			faction,
			pressure,
			reasons: recentReasons,
			sourceEventIds,
			serverVersion,
			now,
			jobId: job.id,
		});
		return {
			factionId: faction.id,
			name: faction.name,
			previousPressure: faction.pressure,
			pressure,
			delta,
			eventIds: reasons.map((reason) => reason.eventId),
			reasons: reasons.map((reason) => reason.reason),
		};
	}));

	return {
		updatedFactions: changes.length,
		eventCount: rows.length,
		changes,
		...(changes.length === 0 ? { reason: 'no_new_matching_events' } : {}),
	};
}

function factionGoalLine(faction: FactionRow): string {
	const goals = asStringArray(faction.goals);
	if (goals.length > 0) return goals.slice(0, 2).join('; ');
	const metadata = asRecord(faction.metadata);
	const goal = typeof metadata.goal === 'string' ? metadata.goal : '';
	return goal || 'its current interests';
}

function pressureUrgency(pressure: number): 'simmering' | 'emerging' | 'critical' {
	if (pressure >= 90) return 'critical';
	if (pressure >= 78) return 'emerging';
	return 'simmering';
}

function worldTickBody(faction: FactionRow, pressure: number, reasons: FactionPressureReason[]): string {
	const recent = reasons.slice(-4).reverse();
	const drivers = recent.length > 0
		? recent.map((reason) => `- ${reason.title || reason.eventType} (+${reason.delta}, ${reason.reason})`).join('\n')
		: '- Pressure accumulated from recent canonical events.';
	return [
		`${faction.name} has reached pressure ${pressure}/100 and converts that pressure into off-screen motion toward ${factionGoalLine(faction)}.`,
		`This is a terminal-owned deterministic world tick. Treat it as pressure, preparation, rumors, envoys, mustering, debt collection, or quiet maneuvering unless the next narration makes the move explicit.`,
		`Recent drivers:\n${drivers}`,
	].join('\n\n');
}

async function upsertWorldTickMemoryNode(input: {
	eventId: string;
	faction: FactionRow;
	title: string;
	body: string;
	pressure: number;
	serverVersion: number;
	now: string;
	jobId: string;
}): Promise<void> {
	const urgency = pressureUrgency(input.pressure);
	await getDb().insert(memoryNodes).values({
		id: `mem_world_tick_${input.eventId}`,
		storyId: input.faction.storyId,
		type: 'faction',
		title: input.title,
		content: input.body,
		summary: snippet(input.body, 360),
		keywords: ['faction', 'world_tick', 'pressure', urgency],
		entityIds: uniqueStrings([input.faction.entityId ?? '', ...asStringArray(input.faction.memberEntityIds)]),
		factionIds: [input.faction.id],
		threadIds: [],
		locationId: null,
		visibility: 'player_known',
		importance: clamp(0.6 + (input.pressure / 240), 0.6, 0.98),
		sourceEntryIds: [],
		sourceEventIds: [input.eventId],
		sourcePatchIds: [],
		metadata: {
			sourceType: 'terminal_world_sim_tick',
			jobId: input.jobId,
			factionId: input.faction.id,
			factionName: input.faction.name,
			pressure: input.pressure,
			urgency,
		},
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	}).onConflictDoUpdate({
		target: memoryNodes.id,
		set: {
			title: input.title,
			content: input.body,
			summary: snippet(input.body, 360),
			keywords: ['faction', 'world_tick', 'pressure', urgency],
			entityIds: uniqueStrings([input.faction.entityId ?? '', ...asStringArray(input.faction.memberEntityIds)]),
			factionIds: [input.faction.id],
			importance: clamp(0.6 + (input.pressure / 240), 0.6, 0.98),
			sourceEventIds: [input.eventId],
			metadata: {
				sourceType: 'terminal_world_sim_tick',
				jobId: input.jobId,
				factionId: input.faction.id,
				factionName: input.faction.name,
				pressure: input.pressure,
				urgency,
			},
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		},
	});
}

async function evaluateWorldSimTick(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const force = payload.force === true;
	const minimumPressure = force ? 45 : 70;
	const factionRows = await timePhase(recorder, 'job.evaluate_world_sim_tick.load_factions', { minimumPressure, force }, () => getDb()
		.select()
		.from(factions)
		.where(eq(factions.storyId, job.storyId))
		.orderBy(desc(factions.pressure), asc(factions.name))
		.limit(12));
	const candidates = timePhaseSync(recorder, 'job.evaluate_world_sim_tick.select_candidates', {
		factions: factionRows.length,
		minimumPressure,
	}, () => factionRows
		.filter((faction) => faction.pressure >= minimumPressure)
		.slice(0, 3));
	if (candidates.length === 0) {
		return {
			createdEvents: 0,
			reason: 'pressure_threshold_not_met',
			minimumPressure,
		};
	}

	const now = nowIso();
	const concurrency = readGenerationConcurrency();
	const cacheChecks = await timePhase(recorder, 'job.evaluate_world_sim_tick.cache_check', {
		candidates: candidates.length,
		concurrency,
	}, () => mapWithConcurrency(candidates, concurrency, async (faction) => {
		const pressureBand = Math.floor(faction.pressure / 10);
		const eventId = stableId('event_world_tick', [job.storyId, faction.id, String(pressureBand)]);
		const [existing] = await getDb()
			.select({ id: storyEvents.id })
			.from(storyEvents)
			.where(and(eq(storyEvents.storyId, job.storyId), eq(storyEvents.id, eventId)))
			.limit(1);
		return existing ? null : { faction, pressureBand, eventId };
	}));
	const toCreate = cacheChecks.filter((item): item is {
		faction: FactionRow;
		pressureBand: number;
		eventId: string;
	} => Boolean(item));
	recorder?.record('job.evaluate_world_sim_tick.cache_summary', 0, {
		hits: candidates.length - toCreate.length,
		misses: toCreate.length,
	});
	if (toCreate.length === 0) {
		return {
			createdEvents: 0,
			minimumPressure,
			events: [],
			reason: 'no_new_pressure_bands',
		};
	}

	const serverVersion = await timePhase(recorder, 'job.evaluate_world_sim_tick.bump_version', {}, () => bumpStoryVersion(job.storyId));
	const created = await timePhase(recorder, 'job.evaluate_world_sim_tick.persist_ticks', {
		createCount: toCreate.length,
		concurrency,
	}, () => mapWithConcurrency(toCreate, concurrency, async ({ faction, pressureBand, eventId }) => {
		const metadata = asRecord(faction.metadata);
		const reasons = recentPressureReasons(metadata);
		const title = `${faction.name} converts pressure into motion`;
		const body = worldTickBody(faction, faction.pressure, reasons);
		await getDb().insert(storyEvents).values({
			id: eventId,
			storyId: job.storyId,
			type: 'faction_move',
			title,
			body,
			actorEntityIds: uniqueStrings([faction.entityId ?? '', faction.id]),
			targetEntityIds: [],
			locationId: null,
			threadIds: [],
			visibility: 'player_known',
			sourceEntryIds: [],
			sourcePatchIds: [],
			metadata: {
				sourceType: 'terminal_world_sim_tick',
				jobId: job.id,
				factionId: faction.id,
				factionName: faction.name,
				pressure: faction.pressure,
				pressureBand,
				force,
			},
			serverVersion,
			createdAt: now,
			updatedAt: now,
		});
		await upsertWorldTickMemoryNode({
			eventId,
			faction,
			title,
			body,
			pressure: faction.pressure,
			serverVersion,
			now,
			jobId: job.id,
		});
		const remainingPressure = clamp(faction.pressure - 18, 0, 100);
		await getDb().update(factions).set({
			pressure: remainingPressure,
			sourceEventIds: uniqueStrings([...asStringArray(faction.sourceEventIds), eventId]),
			metadata: {
				...metadata,
				lastWorldSimTickAt: now,
				lastWorldSimTickJobId: job.id,
				lastWorldSimTickPressure: faction.pressure,
				lastWorldSimTickEventId: eventId,
			},
			serverVersion,
			updatedAt: now,
		}).where(and(eq(factions.storyId, job.storyId), eq(factions.id, faction.id)));
		return {
			eventId,
			factionId: faction.id,
			name: faction.name,
			pressureBefore: faction.pressure,
			pressureAfter: remainingPressure,
			urgency: pressureUrgency(faction.pressure),
		};
	}));

	return {
		createdEvents: created.length,
		minimumPressure,
		events: created,
	};
}

async function loadMemoryNodesForEmbedding(job: BackendJobRow, limit = 100) {
	const payload = asRecord(job.payload);
	const memoryNodeIds = asStringArray(payload.memoryNodeIds);
	const db = getDb();
	if (memoryNodeIds.length > 0) {
		return db
			.select()
			.from(memoryNodes)
			.where(and(
				eq(memoryNodes.storyId, job.storyId),
				inArray(memoryNodes.id, memoryNodeIds),
			))
			.limit(limit);
	}
	return db
		.select()
		.from(memoryNodes)
		.where(and(
			eq(memoryNodes.storyId, job.storyId),
			sql`${memoryNodes.embedding} is null`,
		))
		.orderBy(desc(memoryNodes.importance), desc(memoryNodes.updatedAt))
		.limit(limit);
}

async function embedMemoryNodes(job: BackendJobRow): Promise<Record<string, unknown>> {
	const config = memoryEmbeddingConfig();
	if (!config) {
		return { deferred: true, reason: 'Memory embedding provider/model is not configured.' };
	}
	const nodes = await loadMemoryNodesForEmbedding(job, Math.max(1, config.batchSize * 8));
	if (nodes.length === 0) return { embedded: 0, skipped: 0, reason: 'No memory nodes need embeddings.' };

	let embedded = 0;
	let skipped = 0;
	for (let i = 0; i < nodes.length; i += config.batchSize) {
		const batch = nodes.slice(i, i + config.batchSize);
		const vectors = await embedMemoryTexts(batch.map(memoryNodeEmbeddingText), config);
		for (let j = 0; j < batch.length; j += 1) {
			const node = batch[j];
			let vector: number[];
			try {
				vector = validateMemoryEmbeddingVector(vectors[j], config.dimensions);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes('dimensions')) {
					return {
						embedded,
						skipped: skipped + (nodes.length - embedded),
						reason: message,
						expectedDimensions: config.dimensions,
						provider: config.provider,
						model: config.model,
					};
				}
				throw error;
			}
			const updatedAt = nowIso();
			await getDb().update(memoryNodes).set({
				embedding: vector,
				metadata: {
					...asRecord(node.metadata),
					embedding: {
						provider: config.provider,
						model: config.model,
						dimensions: vector.length,
						jobId: job.id,
						updatedAt,
					},
				},
				updatedAt,
			}).where(and(eq(memoryNodes.storyId, job.storyId), eq(memoryNodes.id, node.id)));
			embedded += 1;
		}
	}
	return {
		embedded,
		skipped,
		provider: config.provider,
		model: config.model,
		dimensions: config.dimensions,
	};
}

async function maxEntryPositionForIds(storyId: string, entryIds: string[]): Promise<number> {
	if (entryIds.length === 0) return -1;
	const rows = await getDb()
		.select({ position: storyEntries.position })
		.from(storyEntries)
		.where(and(
			eq(storyEntries.storyId, storyId),
			inArray(storyEntries.id, entryIds),
		));
	return rows.reduce((max, row) => Math.max(max, row.position), -1);
}

async function lastChapterBoundary(storyId: string): Promise<{ chapter: ChapterRow | null; endPosition: number }> {
	const [chapter] = await getDb()
		.select()
		.from(chapters)
		.where(eq(chapters.storyId, storyId))
		.orderBy(desc(chapters.number))
		.limit(1);
	if (!chapter) return { chapter: null, endPosition: -1 };
	const metadata = asRecord(chapter.metadata);
	const metadataEnd = asNumber(metadata.endPosition, -1);
	const sourceEnd = await maxEntryPositionForIds(storyId, asStringArray(chapter.sourceEntryIds));
	return { chapter, endPosition: Math.max(metadataEnd, sourceEnd) };
}

async function loadEntriesAfter(storyId: string, afterPosition: number, limit: number): Promise<StoryEntryRow[]> {
	return getDb()
		.select()
		.from(storyEntries)
		.where(and(
			eq(storyEntries.storyId, storyId),
			gt(storyEntries.position, afterPosition),
		))
		.orderBy(asc(storyEntries.position))
		.limit(limit);
}

async function loadEventsForEntries(storyId: string, entryIds: string[]): Promise<StoryEventRow[]> {
	if (entryIds.length === 0) return [];
	const entrySet = new Set(entryIds);
	const rows = await getDb()
		.select()
		.from(storyEvents)
		.where(eq(storyEvents.storyId, storyId))
		.orderBy(desc(storyEvents.updatedAt))
		.limit(500);
	return rows
		.filter((row) => asStringArray(row.sourceEntryIds).some((entryId) => entrySet.has(entryId)))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function stripNarrationHeader(value: string): string {
	return value.replace(/^\s*\[[^\]]*(?:Time|Location|Weather)[^\]]*\]\s*/i, '').trim();
}

function summarizePlayerAction(value: string): string {
	const text = compactWhitespace(value.replace(/^>\s*/, ''));
	return text
		.replace(/^I\s+say\b/i, 'says')
		.replace(/^I\s+ask\b/i, 'asks')
		.replace(/^I\s+look\b/i, 'looks')
		.replace(/^I\s+walk\b/i, 'walks')
		.replace(/^I\s+rise\b/i, 'rises')
		.replace(/^I\s+/i, 'acts: ');
}

function cleanSummaryBeat(value: string, max = 220): string {
	return snippet(stripNarrationHeader(value).replace(/^OOC:\s*/i, 'OOC correction: '), max);
}

function checkpointBeat(entry: StoryEntryRow): string {
	if (entry.type === 'user_action') {
		const action = summarizePlayerAction(entry.content);
		return /^(?:says|asks|looks|walks|rises|acts:)\b/i.test(action) ? `The player character ${action}` : action;
	}
	if (entry.type === 'narration') return cleanSummaryBeat(entry.content, 1200);
	return cleanSummaryBeat(entry.content, 1200);
}

function meaningfulEventString(event: StoryEventRow): string | null {
	const title = compactWhitespace(event.title);
	const body = cleanSummaryBeat(event.body, 180);
	if (!title || title.toLowerCase() === 'turn resolved') return null;
	return `${event.type}: ${title}${body ? ` - ${body}` : ''}`;
}

function meaningfulEventStoryString(event: StoryEventRow): string | null {
	const title = compactWhitespace(event.title);
	const body = cleanSummaryBeat(event.body, 800);
	if (!title || title.toLowerCase() === 'turn resolved') return null;
	if (!body || body.toLowerCase() === title.toLowerCase()) return title;
	return `${title} - ${body}`;
}

function chapterSynopsisParagraphs(beats: string[]): string[] {
	if (beats.length <= 14) return beats;
	const chunkSize = Math.ceil(beats.length / 3);
	const groups = [
		['Opening', beats.slice(0, chunkSize)],
		['Middle', beats.slice(chunkSize, chunkSize * 2)],
		['Ending', beats.slice(chunkSize * 2)],
	] as const;
	return groups
		.filter(([, group]) => group.length > 0)
		.flatMap(([label, group]) => [`${label}:`, ...group]);
}

function entryTimeMinutes(entry: StoryEntryRow): number | null {
	const match = entry.content.match(/^\s*\[[^\]]*\bTime\s+(\d{1,2}):(\d{2})\b/i);
	if (!match) return null;
	const hours = Number.parseInt(match[1], 10);
	const minutes = Number.parseInt(match[2], 10);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
	return (hours * 60) + minutes;
}

function chapterTimePassed(entries: StoryEntryRow[]): string {
	const times = entries.map(entryTimeMinutes).filter((time): time is number => time !== null);
	if (times.length < 2) return 'Time passed in this chapter: not established.';
	const elapsed = times[times.length - 1] - times[0];
	if (elapsed < 0) return 'Time passed in this chapter: not established.';
	if (elapsed <= 1) return 'Time passed in this chapter: a minute or less.';
	if (elapsed <= 5) return 'Time passed in this chapter: a few minutes.';
	if (elapsed < 60) return `Time passed in this chapter: about ${elapsed} minutes.`;
	const hours = Math.floor(elapsed / 60);
	const minutes = elapsed % 60;
	return `Time passed in this chapter: about ${hours} hour${hours === 1 ? '' : 's'}${minutes ? ` and ${minutes} minutes` : ''}.`;
}

function titleCaseFromId(value: string): string {
	return value
		.replace(/^(npc|pc|entity|character|char)_+/i, '')
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
		.join(' ')
		.trim() || value;
}

function eventEntityIds(events: StoryEventRow[]): string[] {
	return uniqueStrings(events.flatMap((event) => [
		...asStringArray(event.actorEntityIds),
		...asStringArray(event.targetEntityIds),
	])).slice(0, 16);
}

function eventSummaryForCharacter(event: StoryEventRow): string {
	return meaningfulEventString(event) ?? (cleanSummaryBeat(event.body, 220) || 'Linked to this source event.');
}

function characterStatesForEvents(events: StoryEventRow[]): MtheriosCharacterState[] {
	return eventEntityIds(events).map((entityId) => {
		const relevantEvents = events
			.filter((event) => [
				...asStringArray(event.actorEntityIds),
				...asStringArray(event.targetEntityIds),
			].includes(entityId))
			.map(eventSummaryForCharacter)
			.filter(Boolean);
		return {
			name: titleCaseFromId(entityId),
			entityId,
			bullets: uniqueStrings(relevantEvents).slice(0, 3),
		};
	});
}

function parseCurrentAnchor(entries: StoryEntryRow[], first: StoryEntryRow, last: StoryEntryRow): string {
	for (const entry of [...entries].reverse()) {
		if (entry.type !== 'narration') continue;
		const header = entry.content.match(/^\s*\[([^\]]*(?:Time|Location|Weather)[^\]]*)\]/i)?.[1];
		if (!header) continue;
		const time = header.match(/Time\s+([^|]+)/i)?.[1]?.trim();
		const date = header.match(/Day\s+([^|]+)/i)?.[1]?.trim();
		const location = header.match(/Location\s+([^|]+)/i)?.[1]?.trim();
		const weather = header.match(/Weather\s+(.+)$/i)?.[1]?.trim();
		if (time || date || location || weather) {
			const day = date ? `Day ${date.replace(/^Day\s+/i, '')}` : 'day/date unknown';
			return `${day} | ${time || 'time unknown'} | ${location || 'location unknown'} | ${weather || 'weather unknown'}`;
		}
	}
	return `positions ${first.position}-${last.position} | time unknown | location unknown | weather unknown, temp C unknown`;
}

function deriveChapterTitle(number: number, entries: StoryEntryRow[], events: StoryEventRow[]): string {
	const eventTitle = events
		.map((event) => compactWhitespace(event.title))
		.find((title) => title && title.toLowerCase() !== 'turn resolved');
	const firstAction = entries.find((entry) => entry.type === 'user_action')?.content;
	const seed = eventTitle || firstAction || entries[0]?.content || `Chapter ${number}`;
	const title = snippet(seed, 70).replace(/[.!?]+$/g, '');
	return title || `Chapter ${number}`;
}

export function buildChapterSummary(entries: StoryEntryRow[], events: StoryEventRow[]): string {
	const first = entries[0];
	const last = entries[entries.length - 1];
	const eventStoryLines = events.map(meaningfulEventStoryString).filter((event): event is string => Boolean(event));
	const eventLines = events.map(meaningfulEventString).filter((event): event is string => Boolean(event));
	const recentLines = uniqueStrings([
		...eventStoryLines,
		...chapterSynopsisParagraphs(entries.map(checkpointBeat)),
		chapterTimePassed(entries),
	]);
	const activeThreads = uniqueStrings(eventLines).slice(0, 16);
	return formatMtheriosMemorySummary({
		checkpoint: `Chapter checkpoint covering transcript positions ${first.position}-${last.position}.`,
		sourceCoverage: [
			`Transcript positions ${first.position}-${last.position}.`,
			`${entries.length} entries covered.`,
			`${events.length} source event records.`,
		],
		currentScene: parseCurrentAnchor(entries, first, last),
		recentStoryState: recentLines,
		characterStates: characterStatesForEvents(events),
		activeThreads,
		toneToContinue: 'Continue from the established scene pressure, character choices, and unresolved consequences.',
	});
}

function friendlyEventType(type: string): string {
	return compactWhitespace(type.replace(/[_-]+/g, ' ')).toLowerCase();
}

function locationFromAnchor(anchor: string): string | null {
	const parts = anchor.split('|').map((part) => part.trim()).filter(Boolean);
	const location = parts.length >= 3 ? parts[2] : null;
	if (!location || /location unknown/i.test(location)) return null;
	return location;
}

function locationsForChapter(entries: StoryEntryRow[], events: StoryEventRow[]): string[] {
	const first = entries[0];
	const last = entries[entries.length - 1];
	const anchor = first && last ? locationFromAnchor(parseCurrentAnchor(entries, first, last)) : null;
	return uniqueStrings([
		anchor ?? '',
		...events.flatMap((event) => {
			const metadata = asRecord(event.metadata);
			return [
				metadata.location,
				metadata.locationName,
				metadata.place,
			].filter((value): value is string => typeof value === 'string');
		}),
	].map((value) => compactWhitespace(value)).filter(Boolean)).slice(0, 8);
}

function chapterKeywords(entries: StoryEntryRow[], events: StoryEventRow[], keyLocations: string[], keyCharacters: string[]): string[] {
	const eventTypes = events.map((event) => friendlyEventType(event.type)).filter(Boolean);
	const titleTerms = events
		.map((event) => compactWhitespace(event.title))
		.filter((title) => title && title.toLowerCase() !== 'turn resolved')
		.flatMap((title) => title.split(/\s+/).filter((part) => /^[A-Za-z][A-Za-z'-]{3,}$/.test(part)))
		.map((part) => part.replace(/[^\w'-]/g, '').toLowerCase());
	const locationTerms = keyLocations.flatMap((location) => location.split(/,\s*|\s+-\s+/).map((part) => part.trim().toLowerCase()));
	const characterTerms = keyCharacters.map((character) => character.toLowerCase());
	const chapterTerms = entries.length ? ['chapter', 'continuity memory'] : [];
	return uniqueStrings([
		...eventTypes,
		...characterTerms,
		...locationTerms,
		...titleTerms,
		...chapterTerms,
	]).slice(0, 16);
}

function chapterTone(events: StoryEventRow[]): string {
	const types = new Set(events.map((event) => event.type));
	if (types.has('betrayal')) return 'betrayal pressure';
	if (types.has('death') || types.has('injury')) return 'danger and consequence';
	if (types.has('relationship_shift')) return 'courtly tension';
	if (types.has('faction_move')) return 'political pressure';
	if (types.has('reveal') || types.has('clue_discovery')) return 'revelatory tension';
	return 'unresolved pressure';
}

export function buildChapterMemoryDigest(number: number, entries: StoryEntryRow[], events: StoryEventRow[]): ChapterMemoryDigest {
	const keyCharacters = eventEntityIds(events).map(titleCaseFromId);
	const keyLocations = locationsForChapter(entries, events);
	const eventThreads = events.map(meaningfulEventString).filter((event): event is string => Boolean(event));
	const eventTitles = events
		.map((event) => compactWhitespace(event.title))
		.filter((title) => title && title.toLowerCase() !== 'turn resolved');
	const threadIds = uniqueStrings(events.flatMap((event) => asStringArray(event.threadIds)));
	const plotThreads = uniqueStrings([
		...threadIds,
		...eventTitles,
		...eventThreads,
	]).slice(0, 12);
	const keywords = chapterKeywords(entries, events, keyLocations, keyCharacters);
	return {
		title: deriveChapterTitle(number, entries, events),
		summary: buildChapterSummary(entries, events),
		keywords,
		keyCharacters,
		keyLocations,
		plotThreads,
		emotionalTone: chapterTone(events),
		source: 'deterministic',
	};
}

function generatedTextDigestPrompt(entries: StoryEntryRow[], events: StoryEventRow[], fallback: ChapterMemoryDigest): string {
	const transcript = entries.map((entry) => `[${entry.position}] [${entry.type}] ${entry.content}`).join('\n\n');
	const sourceEvents = events.map((event) => JSON.stringify({
		id: event.id,
		type: event.type,
		title: event.title,
		body: snippet(event.body, 800),
		actorEntityIds: event.actorEntityIds,
		targetEntityIds: event.targetEntityIds,
		threadIds: event.threadIds,
		metadata: event.metadata,
	})).join('\n');
	return [
		'Condense this chapter window into durable story memory for the control surface.',
		'Return strict JSON with title, summary, keywords, keyCharacters, keyLocations, plotThreads, emotionalTone.',
		'Fill every array with useful values. Preserve entity ids inside summary character headers when source events provide ids.',
		'Do not invent new canon. If a name or place is only implied by the text, include it as text evidence, not as a newly created entity.',
		'Use plotThreads for unresolved dangers, promises, relationship tensions, mysteries, or thread ids that must carry forward.',
		`Fallback title if needed: ${fallback.title}`,
		'',
		'Source events:',
		sourceEvents || '(no structured source events)',
		'',
		'Transcript:',
		transcript,
	].join('\n');
}

function coerceGeneratedDigest(raw: unknown, fallback: ChapterMemoryDigest, result: ServerGenerationResult): ChapterMemoryDigest | null {
	const record = asRecord(raw);
	const title = compactWhitespace(typeof record.title === 'string' ? record.title : fallback.title);
	const summary = typeof record.summary === 'string' ? record.summary.trim() : fallback.summary;
	if (!title || !summary) return null;
	return {
		title,
		summary,
		keywords: uniqueStrings([...asStringArray(record.keywords), ...fallback.keywords]).slice(0, 16),
		keyCharacters: uniqueStrings([
			...asStringArray(record.keyCharacters),
			...asStringArray(record.characters),
			...fallback.keyCharacters,
		]).slice(0, 16),
		keyLocations: uniqueStrings([
			...asStringArray(record.keyLocations),
			...asStringArray(record.locations),
			...fallback.keyLocations,
		]).slice(0, 12),
		plotThreads: uniqueStrings([
			...asStringArray(record.plotThreads),
			...asStringArray(record.activeThreads),
			...fallback.plotThreads,
		]).slice(0, 16),
		emotionalTone: compactWhitespace(typeof record.emotionalTone === 'string' ? record.emotionalTone : fallback.emotionalTone),
		source: 'llm',
		model: result.model,
	};
}

async function summarizeChapterMemoryWithLlm(entries: StoryEntryRow[], events: StoryEventRow[], fallback: ChapterMemoryDigest): Promise<ChapterMemoryDigest> {
	const serviceIds = ['memory', 'classifier', 'narrative'];
	for (const serviceId of serviceIds) {
		const resolved = await resolveServiceGeneration(serviceId);
		if (!resolved.profile) continue;
		try {
			const result = await generateServerTextWithMetrics({
				profile: resolved.profile,
				model: resolved.generation.model,
				temperature: resolved.generation.temperature ?? 0.35,
				maxTokens: Math.max(2048, Math.min(resolved.generation.maxTokens ?? 4096, 8192)),
				timeoutMs: 90000,
				system: [
					'You are Mtherios chapter memory, not a narrator.',
					'Write durable continuity memory that lets future scenes, POV switches, canon repair, and the frontend control surface remember what happened.',
					buildMtheriosSummaryInstruction('chapter'),
					'The response must be valid JSON only.',
				].join('\n\n'),
				prompt: generatedTextDigestPrompt(entries, events, fallback),
				responseFormat: 'json_object',
			});
			const digest = coerceGeneratedDigest(parseJsonFromGeneratedText(result.text), fallback, result);
			if (digest) return digest;
		} catch (error) {
			console.warn(`[jobs] chapter memory LLM summarization failed via ${serviceId}:`, error);
		}
	}
	return fallback;
}

async function upsertChapterMemoryNode(input: {
	storyId: string;
	chapterId: string;
	title: string;
	summary: string;
	keywords: string[];
	entityIds: string[];
	sourceEntryIds: string[];
	sourceEventIds: string[];
	threadIds: string[];
	serverVersion: number;
	now: string;
	jobId: string;
}): Promise<void> {
	await getDb().insert(memoryNodes).values({
		id: `mem_chapter_${input.chapterId}`,
		storyId: input.storyId,
		type: 'episodic',
		title: input.title,
		content: input.summary,
		summary: input.summary,
		keywords: uniqueStrings(['chapter', 'terminal_checkpoint', ...input.keywords]).slice(0, 24),
		entityIds: input.entityIds,
		factionIds: [],
		threadIds: input.threadIds,
		locationId: null,
		visibility: 'player_known',
		importance: 0.7,
		sourceEntryIds: input.sourceEntryIds,
		sourceEventIds: input.sourceEventIds,
		sourcePatchIds: [],
		metadata: { sourceType: 'terminal_chapter_job', jobId: input.jobId },
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	}).onConflictDoUpdate({
		target: memoryNodes.id,
		set: {
			title: input.title,
			content: input.summary,
			summary: input.summary,
			keywords: uniqueStrings(['chapter', 'terminal_checkpoint', ...input.keywords]).slice(0, 24),
			entityIds: input.entityIds,
			threadIds: input.threadIds,
			sourceEntryIds: input.sourceEntryIds,
			sourceEventIds: input.sourceEventIds,
			metadata: { sourceType: 'terminal_chapter_job', jobId: input.jobId },
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		},
	});
}

async function createChapterCharacterReferenceProposals(input: {
	storyId: string;
	chapter: typeof chapters.$inferSelect;
	digest: ChapterMemoryDigest;
	events: StoryEventRow[];
	sourceEntryIds: string[];
	serverVersion: number;
	now: string;
}): Promise<Record<string, unknown>> {
	const db = getDb();
	const candidates = chapterCharacterReferenceCandidates({ digest: input.digest, events: input.events });
	let created = 0;
	let skipped = 0;

	for (const candidate of candidates) {
		if (isCharacterTitleOnlyName(candidate.name)) {
			skipped += 1;
			continue;
		}
		const targetRecordId = stableId('unresolved_character', [candidate.name]);
		const resolution = await resolveEntityIdentity({
			storyId: input.storyId,
			candidate: {
				type: 'character',
				name: candidate.name,
				description: candidate.description,
				sourceEntryIds: input.sourceEntryIds,
				sourceEventIds: candidate.sourceEventIds,
			},
			includeSemantic: false,
		});
		if (shouldReuseResolvedEntity(resolution) || resolution.decision === 'ask') {
			skipped += 1;
			continue;
		}

		const [existingProposal] = await db.select({ id: patchProposals.id }).from(patchProposals).where(and(
			eq(patchProposals.storyId, input.storyId),
			eq(patchProposals.proposalType, 'character_reference_review'),
			eq(patchProposals.targetRecordId, targetRecordId),
			inArray(patchProposals.status, ['pending', 'needs_review']),
		)).limit(1);
		if (existingProposal) {
			skipped += 1;
			continue;
		}

		const [inserted] = await db.insert(patchProposals).values({
			id: stableId('proposal_auto_character', [input.storyId, candidate.name]),
			storyId: input.storyId,
			proposalType: 'character_reference_review',
			targetTable: 'entities',
			targetRecordId,
			proposedBy: 'chapter_scribe',
			operations: [{
				op: 'review',
				path: '/entities/character',
				value: {
					storyId: input.storyId,
					type: 'character',
					name: candidate.name,
					description: candidate.description,
					status: 'active',
					visibility: 'player_known',
					state: {
						type: 'character',
						firstSeenChapterId: input.chapter.id,
						firstSeenChapterNumber: input.chapter.number,
						eventMemory: { did: [], saw: [], knew: [] },
					},
				},
			}],
			reason: candidate.reason,
			suggestion: 'Review this chapter-important character before creating canon.',
			status: 'pending',
			affectedEntityIds: [],
			confidence: candidate.confidence,
			sourceEntryIds: input.sourceEntryIds,
			sourceEventIds: candidate.sourceEventIds,
			sourcePatchIds: [],
			metadata: {
				sourceType: 'chapter_character_reference',
				sourceName: candidate.name,
				chapterId: input.chapter.id,
				chapterNumber: input.chapter.number,
			},
			serverVersion: input.serverVersion,
			createdAt: input.now,
			updatedAt: input.now,
		}).onConflictDoNothing().returning({ id: patchProposals.id });
		created += inserted ? 1 : 0;
		skipped += inserted ? 0 : 1;
	}

	return { candidates: candidates.length, created, skipped };
}

async function createChapterCharacterContextUpdateProposals(input: {
	storyId: string;
	chapter: typeof chapters.$inferSelect;
	digest: ChapterMemoryDigest;
	events: StoryEventRow[];
	sourceEntryIds: string[];
	serverVersion: number;
	now: string;
}): Promise<Record<string, unknown>> {
	const db = getDb();
	const ids = eventEntityIds(input.events);
	const idSet = new Set(ids);
	const activeCharacters = await db.select().from(entities).where(and(
		eq(entities.storyId, input.storyId),
		eq(entities.type, 'character'),
		eq(entities.status, 'active'),
	)).limit(160);
	const rows = activeCharacters.filter((entity) =>
		idSet.has(entity.id) || Boolean(chapterCharacterSummaryForEntity(input.digest, entity))
	).slice(0, 12);
	let created = 0;
	let updated = 0;
	let skipped = 0;

	for (const entity of rows) {
		const currentState = asRecord(entity.state);
		const patch = chapterCharacterContextPatch({
			entityId: entity.id,
			currentState,
			digest: input.digest,
			events: input.events,
		}) ?? chapterCharacterSummaryContextPatch({
			entityName: entity.name,
			aliases: entityCharacterNames(entity).slice(1),
			currentState,
			digest: input.digest,
			chapterNumber: input.chapter.number,
			events: input.events,
		});
		if (!patch) {
			skipped += 1;
			continue;
		}
		const values = chapterCharacterContextProposalValues({
			storyId: input.storyId,
			entityId: entity.id,
			entityName: entity.name,
			chapterId: input.chapter.id,
			chapterNumber: input.chapter.number,
			chapterTitle: input.chapter.title,
			patch,
			sourceEntryIds: input.sourceEntryIds,
			serverVersion: input.serverVersion,
			now: input.now,
		});
		const [existingProposal] = await db.select().from(patchProposals).where(and(
			eq(patchProposals.storyId, input.storyId),
			eq(patchProposals.proposalType, 'character_context_update'),
			eq(patchProposals.targetRecordId, entity.id),
			eq(patchProposals.proposedBy, 'chapter_scribe'),
			inArray(patchProposals.status, ['pending', 'needs_review']),
		)).limit(1);
		if (existingProposal) {
			await db.update(patchProposals).set(refreshChapterCharacterContextProposalValues(existingProposal, values))
				.where(eq(patchProposals.id, existingProposal.id));
			updated += 1;
			continue;
		}

		const [inserted] = await db.insert(patchProposals).values(values).onConflictDoNothing().returning({ id: patchProposals.id });
		created += inserted ? 1 : 0;
		skipped += inserted ? 0 : 1;
	}

	return { candidates: rows.length, created, updated, skipped };
}

function storedChapterMemoryDigest(chapter: ChapterRow): ChapterMemoryDigest {
	const metadata = asRecord(chapter.metadata);
	return {
		title: chapter.title ?? `Chapter ${chapter.number}`,
		summary: chapter.sceneOutcome,
		keywords: asStringArray(metadata.legacyKeywords),
		keyCharacters: asStringArray(metadata.legacyCharacters),
		keyLocations: asStringArray(metadata.legacyLocations),
		plotThreads: asStringArray(chapter.openThreads),
		emotionalTone: typeof metadata.emotionalTone === 'string' ? metadata.emotionalTone : 'continuity',
		source: metadata.summarySource === 'llm' ? 'llm' : 'deterministic',
		model: typeof metadata.summaryModel === 'string' ? metadata.summaryModel : undefined,
	};
}

async function autoApplyChapterCharacterContextUpdates(input: {
	storyId: string;
	chapterNumber: number;
}): Promise<Record<string, unknown>> {
	const cadence = CHARACTER_CONTEXT_AUTO_APPLY_CHAPTER_INTERVAL;
	if (!shouldAutoApplyChapterCharacterContext(input.chapterNumber)) {
		return { applied: false, deferred: true, cadence };
	}

	const windowStart = Math.max(1, input.chapterNumber - cadence + 1);
	const db = getDb();
	const proposals = await db.select({
		id: patchProposals.id,
		targetRecordId: patchProposals.targetRecordId,
		operations: patchProposals.operations,
		metadata: patchProposals.metadata,
	}).from(patchProposals).where(and(
		eq(patchProposals.storyId, input.storyId),
		eq(patchProposals.proposalType, 'character_context_update'),
		eq(patchProposals.proposedBy, 'chapter_scribe'),
		inArray(patchProposals.status, ['pending', 'needs_review']),
	));
	const eligibleProposals = proposals.filter((proposal) => {
			const metadata = asRecord(proposal.metadata);
			const chapterNumber = asNumber(metadata.chapterNumber, 0);
			return metadata.sourceType === 'chapter_character_context'
				&& chapterNumber >= windowStart
				&& chapterNumber <= input.chapterNumber;
		});
	const proposalIds = eligibleProposals.map((proposal) => proposal.id);
	let characterUpdate: Record<string, unknown> = {
		status: 'skipped',
		reason: proposalIds.length ? 'No valid character states were available.' : 'No pending character proposals.',
		updatedCount: 0,
	};
	const candidates = eligibleProposals.flatMap((proposal) => {
		const state = characterContextOperationState(proposal.operations);
		if (!proposal.targetRecordId || !state) return [];
		const metadata = asRecord(proposal.metadata);
		return [{
			entityId: proposal.targetRecordId,
			name: typeof metadata.characterName === 'string' && metadata.characterName.trim()
				? metadata.characterName.trim()
				: proposal.targetRecordId,
			state,
		}];
	});

	if (candidates.length > 0) {
		try {
			const chapterRows = await db.select({
				number: chapters.number,
				title: chapters.title,
				sceneOutcome: chapters.sceneOutcome,
				irreversibleChanges: chapters.irreversibleChanges,
				npcKnowledgeChanges: chapters.npcKnowledgeChanges,
				relationshipChanges: chapters.relationshipChanges,
				openThreads: chapters.openThreads,
			}).from(chapters).where(and(
				eq(chapters.storyId, input.storyId),
				inArray(chapters.number, [windowStart, input.chapterNumber]),
			)).orderBy(asc(chapters.number));
			const refinement = await refineChapterCharacterUpdates({
				storyId: input.storyId,
				chapterWindow: [windowStart, input.chapterNumber],
				chapterEvidence: chapterRows.map((chapter) => ({
					number: chapter.number,
					title: chapter.title ?? `Chapter ${chapter.number}`,
					summary: [
						chapter.sceneOutcome,
						...chapter.irreversibleChanges,
						...chapter.relationshipChanges,
						...chapter.openThreads,
						JSON.stringify(chapter.npcKnowledgeChanges),
					].filter(Boolean).join('\n'),
				})),
				candidates,
			});
			const proposalsByEntityId = new Map(
				eligibleProposals
					.filter((proposal) => proposal.targetRecordId)
					.map((proposal) => [proposal.targetRecordId as string, proposal]),
			);
			let updatedCount = 0;
			for (const update of refinement.updates) {
				const proposal = proposalsByEntityId.get(update.entityId);
				if (!proposal) continue;
				await db.update(patchProposals).set({
					operations: replaceCharacterContextOperationState(proposal.operations, update.state),
					metadata: {
						...asRecord(proposal.metadata),
						characterUpdateServiceId: refinement.effectiveServiceId,
						characterUpdateModel: refinement.model,
						characterUpdatePromptChars: refinement.promptChars,
						characterUpdatedAt: nowIso(),
					},
					updatedAt: nowIso(),
				}).where(and(
					eq(patchProposals.storyId, input.storyId),
					eq(patchProposals.id, proposal.id),
					inArray(patchProposals.status, ['pending', 'needs_review']),
				));
				updatedCount += 1;
			}
			characterUpdate = {
				status: refinement.status,
				reason: refinement.reason,
				requestedServiceId: refinement.requestedServiceId,
				effectiveServiceId: refinement.effectiveServiceId,
				model: refinement.model,
				candidateCount: candidates.length,
				updatedCount,
			};
		} catch (error) {
			console.warn('[jobs] character update refinement failed; applying deterministic chapter evidence:', error);
			characterUpdate = {
				status: 'failed_fallback',
				reason: error instanceof Error ? error.message : String(error),
				candidateCount: candidates.length,
				updatedCount: 0,
			};
		}
	}

	const result = await applyChapterScribeCharacterContextProposals({
		storyId: input.storyId,
		proposalIds,
		reviewer: 'chapter_scribe_auto',
		notes: `Automatic character continuity refresh after chapters ${windowStart}-${input.chapterNumber}.`,
	});
	return {
		deferred: false,
		cadence,
		chapterWindow: [windowStart, input.chapterNumber],
		proposalCount: proposalIds.length,
		characterUpdate,
		...result,
		applied: asNumber(result.appliedCount, 0) > 0,
	};
}

function chapterCharacterStateBlocks(summary: string): Array<{ name: string; summary: string }> {
	const section = extractMtheriosSummarySection(summary, 'CHARACTER STATE');
	const identified = [...section.matchAll(/^([^\n:]+?)\s+\[[^\]\n]+\]:\s*([\s\S]*?)(?=^[^\n:]+?\s+\[[^\]\n]+\]:|(?![\s\S]))/gmu)]
		.map((match) => ({ name: match[1].trim(), summary: compactWhitespace(match[2]) }))
		.filter((block) => block.name && block.summary);
	if (identified.length > 0) return identified;
	return section.split(/\n\s*\n/)
		.map((block) => block.trim())
		.map((block) => {
			const separator = block.indexOf(':');
			if (separator < 1) return null;
			const name = block.slice(0, separator).replace(/\s+\[[^\]]+\]\s*$/u, '').trim();
			const characterSummary = compactWhitespace(block.slice(separator + 1));
			return name && characterSummary ? { name, summary: characterSummary } : null;
		})
		.filter((block): block is { name: string; summary: string } => Boolean(block));
}

function entityCharacterNames(entity: typeof entities.$inferSelect): string[] {
	const state = asRecord(entity.state);
	const metadata = asRecord(entity.metadata);
	return uniqueStrings([
		entity.name,
		...asStringArray(state.aliases),
		...asStringArray(metadata.aliases),
	]);
}

export function chapterMemoryEntityIds(input: {
	eventEntityIds: string[];
	keyCharacters: string[];
	canonicalCharacters: Array<typeof entities.$inferSelect>;
}): string[] {
	return uniqueStrings([
		...input.eventEntityIds,
		...input.canonicalCharacters
			.filter((entity) => input.keyCharacters.some((character) =>
				entityCharacterNames(entity).some((name) => chapterCharacterNamesMatch(name, character))))
			.map((entity) => entity.id),
	]);
}

function chapterCharacterSummaryForEntity(
	digest: ChapterMemoryDigest,
	entity: typeof entities.$inferSelect,
): string | null {
	const names = entityCharacterNames(entity);
	const block = chapterCharacterStateBlocks(digest.summary)
		.find((candidate) => names.some((name) => chapterCharacterNamesMatch(name, candidate.name)));
	return block?.summary ?? null;
}

export function chapterCharacterSummaryContextPatch(input: {
	entityName: string;
	aliases?: string[];
	currentState: Record<string, unknown>;
	digest: ChapterMemoryDigest;
	chapterNumber: number;
	events: StoryEventRow[];
}): ChapterCharacterContextPatch | null {
	const names = uniqueStrings([input.entityName, ...(input.aliases ?? [])]);
	const characterSummary = chapterCharacterStateBlocks(input.digest.summary)
		.find((candidate) => names.some((name) => chapterCharacterNamesMatch(name, candidate.name)))?.summary;
	if (!characterSummary) return null;
	const memory = asRecord(input.currentState.eventMemory ?? input.currentState.npcEventMemory);
	const chapterMemory = snippet(`Chapter ${input.chapterNumber}: ${characterSummary}`, 360);
	return {
		state: {
			...input.currentState,
			eventMemory: {
				...memory,
				did: mergeStringList(memory.did, [chapterMemory]),
			},
		},
		sourceEventIds: uniqueStrings(input.events.map((event) => event.id)),
		did: [chapterMemory],
		saw: [],
	};
}

async function createChapterCheckpoint(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const config = getServerMemoryConfig();
	const threshold = Math.max(1, asNumber(payload.chapterThreshold, config.chapterThreshold));
	const buffer = Math.max(0, asNumber(payload.postChapterBuffer, config.postChapterBuffer));
	const { chapter: previousChapter, endPosition } = await timePhase(recorder, 'job.summarize_chapter.load_boundary', {}, () => lastChapterBoundary(job.storyId));
	const entries = await timePhase(recorder, 'job.summarize_chapter.load_entries', {
		endPosition,
		limit: threshold + buffer,
	}, () => loadEntriesAfter(job.storyId, endPosition, threshold + buffer));
	const eligible = buffer > 0 ? entries.slice(0, Math.max(0, entries.length - buffer)) : entries;
	if (eligible.length < threshold) {
		return {
			created: false,
			reason: 'chapter_threshold_not_met',
			entriesAfterLastChapter: entries.length,
			eligibleEntries: eligible.length,
			threshold,
			buffer,
		};
	}

	const chapterEntries = eligible.slice(0, threshold);
	const first = chapterEntries[0];
	const last = chapterEntries[chapterEntries.length - 1];
	const sourceEntryIds = chapterEntries.map((entry) => entry.id);
	const events = await timePhase(recorder, 'job.summarize_chapter.load_events', {
		sourceEntryIds: sourceEntryIds.length,
	}, () => loadEventsForEntries(job.storyId, sourceEntryIds));
	const sourceEventIds = events.map((event) => event.id);
	const threadIds = uniqueStrings(events.flatMap((event) => asStringArray(event.threadIds)));
	const eventIds = eventEntityIds(events);
	const number = (previousChapter?.number ?? 0) + 1;
	const chapterId = stableId('chapter', [first.id, last.id]);
	const fallbackDigest = timePhaseSync(recorder, 'job.summarize_chapter.build_summary', {
		entries: chapterEntries.length,
		events: events.length,
	}, () => buildChapterMemoryDigest(number, chapterEntries, events));
	const digest = await timePhase(recorder, 'job.summarize_chapter.llm_memory_digest', {
		entries: chapterEntries.length,
		events: events.length,
	}, () => summarizeChapterMemoryWithLlm(chapterEntries, events, fallbackDigest));
	const { title, summary } = digest;
	const canonicalCharacters = await timePhase(recorder, 'job.summarize_chapter.resolve_character_tags', {
		keyCharacters: digest.keyCharacters.length,
	}, () => getDb().select().from(entities).where(and(
		eq(entities.storyId, job.storyId),
		eq(entities.type, 'character'),
	)));
	const entityIds = chapterMemoryEntityIds({
		eventEntityIds: eventIds,
		keyCharacters: digest.keyCharacters,
		canonicalCharacters,
	});
	const now = nowIso();
	const serverVersion = await timePhase(recorder, 'job.summarize_chapter.bump_version', {}, () => bumpStoryVersion(job.storyId));
	const irreversibleChanges = events
		.filter((event) => ['death', 'injury', 'reveal', 'betrayal'].includes(event.type))
		.map((event) => event.title);
	const promisesDebtsOaths = events
		.filter((event) => ['promise', 'agreement', 'betrayal'].includes(event.type))
		.map((event) => event.title);
	const factionChanges = events
		.filter((event) => event.type === 'faction_move')
		.map((event) => event.title);

	const [chapter] = await timePhase(recorder, 'job.summarize_chapter.persist_chapter', {}, () => getDb().insert(chapters).values({
		id: chapterId,
		storyId: job.storyId,
		number,
		title,
		sceneOutcome: summary,
		irreversibleChanges,
		npcKnowledgeChanges: [],
		promisesDebtsOaths,
		discoveredClues: events.filter((event) => event.type === 'clue_discovery').map((event) => event.title),
		relationshipChanges: events.filter((event) => event.type === 'relationship_shift').map((event) => event.title),
		factionChanges,
		openThreads: digest.plotThreads,
		sourceEntryIds,
		sourceEventIds,
		metadata: {
			sourceType: 'terminal_chapter_job',
			jobId: job.id,
			summarySource: digest.source,
			summaryModel: digest.model ?? null,
			entryCount: chapterEntries.length,
			startPosition: first.position,
			endPosition: last.position,
			threshold,
			postChapterBuffer: buffer,
			trackedEntityIds: entityIds,
			legacyKeywords: digest.keywords,
			legacyCharacters: digest.keyCharacters,
			legacyLocations: digest.keyLocations,
			emotionalTone: digest.emotionalTone,
		},
		serverVersion,
		createdAt: now,
		updatedAt: now,
	}).onConflictDoUpdate({
		target: chapters.id,
		set: {
			number,
			title,
			sceneOutcome: summary,
			irreversibleChanges,
			promisesDebtsOaths,
			discoveredClues: events.filter((event) => event.type === 'clue_discovery').map((event) => event.title),
			relationshipChanges: events.filter((event) => event.type === 'relationship_shift').map((event) => event.title),
			factionChanges,
			openThreads: digest.plotThreads,
			sourceEntryIds,
			sourceEventIds,
			metadata: {
				sourceType: 'terminal_chapter_job',
				jobId: job.id,
				summarySource: digest.source,
				summaryModel: digest.model ?? null,
				entryCount: chapterEntries.length,
				startPosition: first.position,
				endPosition: last.position,
				threshold,
				postChapterBuffer: buffer,
				trackedEntityIds: entityIds,
				legacyKeywords: digest.keywords,
				legacyCharacters: digest.keyCharacters,
				legacyLocations: digest.keyLocations,
				emotionalTone: digest.emotionalTone,
			},
			serverVersion,
			updatedAt: now,
		},
	}).returning());

	await timePhase(recorder, 'job.summarize_chapter.persist_memory_node', {}, () => upsertChapterMemoryNode({
		storyId: job.storyId,
		chapterId,
		title,
		summary,
		keywords: digest.keywords,
		entityIds,
		sourceEntryIds,
		sourceEventIds,
		threadIds,
		serverVersion,
		now,
		jobId: job.id,
	}));

	const characterReferences = await timePhase(recorder, 'job.summarize_chapter.character_references', {
		keyCharacters: digest.keyCharacters.length,
	}, () => createChapterCharacterReferenceProposals({
		storyId: job.storyId,
		chapter,
		digest,
		events,
		sourceEntryIds,
		serverVersion,
		now,
	}));
	const previousCharacterContextUpdates = previousChapter
		&& previousChapter.number === number - 1
		&& shouldAutoApplyChapterCharacterContext(number)
		? await timePhase(recorder, 'job.summarize_chapter.previous_character_context_updates', {
			chapterNumber: previousChapter.number,
		}, async () => {
			const previousEvents = await loadEventsForEntries(job.storyId, asStringArray(previousChapter.sourceEntryIds));
			return createChapterCharacterContextUpdateProposals({
				storyId: job.storyId,
				chapter: previousChapter,
				digest: storedChapterMemoryDigest(previousChapter),
				events: previousEvents,
				sourceEntryIds: asStringArray(previousChapter.sourceEntryIds),
				serverVersion,
				now,
			});
		})
		: { candidates: 0, created: 0, updated: 0, skipped: 0, deferred: true };
	const characterContextUpdates = await timePhase(recorder, 'job.summarize_chapter.character_context_updates', {
		entityIds: entityIds.length,
	}, () => createChapterCharacterContextUpdateProposals({
		storyId: job.storyId,
		chapter,
		digest,
		events,
		sourceEntryIds,
		serverVersion,
		now,
	}));

	const chapterScopedJob = {
		...job,
		payload: {
			...payload,
			eventIds: sourceEventIds,
			chapterId,
			chapterNumber: number,
			serverVersion,
		},
	};
	const [{ factionPressure, worldTick }, arc] = await timePhase(recorder, 'job.summarize_chapter.post_chapter_parallel', {
		branches: 2,
	}, () => Promise.all([
		(async () => {
			const factionPressure = await updateFactionPressure(chapterScopedJob, recorder);
			const worldTick = await evaluateWorldSimTick(chapterScopedJob, recorder);
			return { factionPressure, worldTick };
		})(),
		rollupArc(job, recorder),
	]));
	const automaticCharacterContextUpdates = await timePhase(recorder, 'job.summarize_chapter.auto_apply_character_context', {
		chapterNumber: number,
		cadence: CHARACTER_CONTEXT_AUTO_APPLY_CHAPTER_INTERVAL,
	}, () => autoApplyChapterCharacterContextUpdates({
		storyId: job.storyId,
		chapterNumber: number,
	}));
	return {
		created: true,
		chapterId: chapter.id,
		number: chapter.number,
		entryCount: chapterEntries.length,
		eventCount: events.length,
		characterReferences,
		previousCharacterContextUpdates,
		characterContextUpdates,
		automaticCharacterContextUpdates,
		factionPressure,
		worldTick,
		arc,
	};
}

function arcTitle(number: number, arcChapters: ChapterRow[]): string {
	const first = arcChapters[0];
	const last = arcChapters[arcChapters.length - 1];
	if (first.id === last.id) return `Arc ${number}: ${first.title ?? `Chapter ${first.number}`}`;
	return `Arc ${number}: ${first.title ?? `Chapter ${first.number}`} to ${last.title ?? `Chapter ${last.number}`}`;
}

type ArcSummaryChapter = Pick<ChapterRow, 'number' | 'title' | 'sceneOutcome' | 'irreversibleChanges' | 'promisesDebtsOaths' | 'openThreads' | 'metadata'>;

export interface ArcMemoryFields {
	keyPlotPoints: string[];
	characterArcs: Array<{ name: string; development: string }>;
	unresolvedThreads: string[];
	emotionalProgression: string;
	trackedEntityIds: string[];
}

function sectionLines(section: string): string[] {
	return section
		.split(/\r?\n/)
		.map((line) => line.replace(/^[-*]\s+/, '').trim())
		.filter((line) => line && !/^No (?:new events|character-specific state|durable threats)/i.test(line));
}

function cleanArcThreadLine(value: string): string {
	const text = compactWhitespace(value.replace(/^[a-z_]+:\s*/i, ''));
	const [title, body] = text.split(/\s+-\s+/, 2);
	if (title && body && body.replace(/\.$/u, '').toLowerCase() === title.toLowerCase()) return title;
	return text;
}

function buildCharacterArcFields(arcChapters: ArcSummaryChapter[]): Array<{ name: string; development: string }> {
	const byName = new Map<string, string[]>();
	for (const chapter of arcChapters) {
		const section = extractMtheriosSummarySection(chapter.sceneOutcome, 'CHARACTER STATE');
		let currentName = '';
		let currentBullets: string[] = [];
		const flush = () => {
			const development = compactWhitespace(currentBullets.join(' '));
			if (!currentName || !development) return;
			byName.set(currentName, [
				...(byName.get(currentName) ?? []),
				`Chapter ${chapter.number}: ${snippet(development, ARC_ROLLUP_CHARACTER_DEVELOPMENT_CHAR_LIMIT)}`,
			]);
		};

		for (const line of sectionLines(section)) {
			const heading = /^(.+?)(?:\s+\[[^\]]+\])?:$/.exec(line);
			if (heading) {
				flush();
				currentName = heading[1].trim();
				currentBullets = [];
			} else {
				currentBullets.push(line);
			}
		}
		flush();
	}

	return [...byName.entries()]
		.map(([name, developments]) => ({
			name,
			development: uniqueStrings(developments).slice(0, 4).join(' '),
		}))
		.filter((item) => item.name && item.development)
		.slice(0, 16);
}

export function buildArcMemoryFields(arcChapters: ArcSummaryChapter[]): ArcMemoryFields {
	const keyPlotPoints = arcChapters
		.map((chapter) => {
			const digest = summarizeMtheriosMemoryForRollup(chapter.sceneOutcome) || snippet(chapter.sceneOutcome, ARC_ROLLUP_KEY_POINT_CHAR_LIMIT);
			if (!digest) return '';
			return `Chapter ${chapter.number}${chapter.title ? ` (${chapter.title})` : ''}: ${snippet(digest, ARC_ROLLUP_KEY_POINT_CHAR_LIMIT)}`;
		})
		.filter(Boolean);
	const unresolvedThreads = uniqueStrings(arcChapters.flatMap((chapter) => [
		...asStringArray(chapter.irreversibleChanges),
		...asStringArray(chapter.promisesDebtsOaths),
		...asStringArray(chapter.openThreads),
		...sectionLines(extractMtheriosSummarySection(chapter.sceneOutcome, 'ACTIVE THREADS')),
	].map((value) => snippet(cleanArcThreadLine(value), ARC_ROLLUP_THREAD_CHAR_LIMIT)))).slice(0, ARC_ROLLUP_THREAD_LIMIT);
	const tones = uniqueStrings(arcChapters
		.map((chapter) => asRecord(chapter.metadata).emotionalTone)
		.filter((tone): tone is string => typeof tone === 'string' && Boolean(tone.trim()))
		.map((tone) => tone.trim()));

	return {
		keyPlotPoints,
		characterArcs: buildCharacterArcFields(arcChapters),
		unresolvedThreads,
		emotionalProgression: tones.length
			? tones.join(' -> ')
			: 'Carry forward the arc consequences, unresolved threads, and character pressure established by these chapters.',
		trackedEntityIds: uniqueStrings(arcChapters.flatMap((chapter) =>
			asStringArray(asRecord(chapter.metadata).trackedEntityIds))),
	};
}

export function buildArcSummary(arcChapters: ArcSummaryChapter[]): string {
	const fields = buildArcMemoryFields(arcChapters);
	const overview = fields.keyPlotPoints
		.map((point) => point
			.replace(/^Chapter\s+\d+(?:\s+\([^)]+\))?:\s*/i, '')
			.replace(/^(?:Opening|Middle|Ending):\s*/i, ''))
		.filter(Boolean)
		.join(' ');
	const sections = [
		`Arc overview:\n${arcSummarySnippet(overview, ARC_ROLLUP_OVERVIEW_CHAR_LIMIT)}`,
		fields.unresolvedThreads.length
			? `Open threads:\n${fields.unresolvedThreads.slice(0, ARC_ROLLUP_SUMMARY_ITEM_LIMIT).map((thread) => `- ${arcSummarySnippet(thread, 160)}`).join('\n')}`
			: '',
		fields.characterArcs.length
			? `Character movement:\n${fields.characterArcs.slice(0, ARC_ROLLUP_SUMMARY_ITEM_LIMIT).map((arc) => `- ${arc.name}: ${arcSummarySnippet(arc.development, 190)}`).join('\n')}`
			: '',
		fields.emotionalProgression ? `Tone to carry forward:\n${arcSummarySnippet(fields.emotionalProgression, 320)}` : '',
	];
	return sections.filter(Boolean).join('\n\n');
}

export function selectArcRollupBatches<T extends { id: string }>(
	chapterRows: T[],
	arcRows: Array<{ chapterIds: string[] }>,
	chaptersPerArc: number,
): T[][] {
	const covered = new Set(arcRows.flatMap((arc) => asStringArray(arc.chapterIds)));
	const uncovered = chapterRows.filter((chapter) => !covered.has(chapter.id));
	const batches: T[][] = [];
	for (let index = 0; index + chaptersPerArc <= uncovered.length; index += chaptersPerArc) {
		batches.push(uncovered.slice(index, index + chaptersPerArc));
	}
	return batches;
}

async function upsertArcMemoryNode(input: {
	storyId: string;
	arcId: string;
	title: string;
	summary: string;
	chapterIds: string[];
	entityIds: string[];
	sourceEventIds: string[];
	openThreadIds: string[];
	serverVersion: number;
	now: string;
	jobId: string;
}): Promise<void> {
	await getDb().insert(memoryNodes).values({
		id: `mem_arc_${input.arcId}`,
		storyId: input.storyId,
		type: 'plot_ledger',
		title: input.title,
		content: input.summary,
		summary: input.summary,
		keywords: ['arc', 'terminal_rollup'],
		entityIds: input.entityIds,
		factionIds: [],
		threadIds: input.openThreadIds,
		locationId: null,
		visibility: 'player_known',
		importance: 0.78,
		sourceEntryIds: [],
		sourceEventIds: input.sourceEventIds,
		sourcePatchIds: [],
		metadata: { sourceType: 'terminal_arc_job', jobId: input.jobId, chapterIds: input.chapterIds },
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	}).onConflictDoUpdate({
		target: memoryNodes.id,
		set: {
			title: input.title,
			content: input.summary,
			summary: input.summary,
			entityIds: input.entityIds,
			threadIds: input.openThreadIds,
			sourceEventIds: input.sourceEventIds,
			metadata: { sourceType: 'terminal_arc_job', jobId: input.jobId, chapterIds: input.chapterIds },
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		},
	});
}

async function rollupArc(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const config = getServerMemoryConfig();
	const chaptersPerArc = Math.max(1, asNumber(payload.chaptersPerArc, config.chaptersPerArc));
	const db = getDb();
	const [chapterRows, arcRows] = await timePhase(recorder, 'job.rollup_arc.load_context', { chaptersPerArc }, () => Promise.all([
		db.select().from(chapters).where(eq(chapters.storyId, job.storyId)).orderBy(asc(chapters.number)).limit(500),
		db.select().from(arcs).where(eq(arcs.storyId, job.storyId)).orderBy(asc(arcs.number)).limit(200),
	]));
	const covered = new Set(arcRows.flatMap((arc) => asStringArray(arc.chapterIds)));
	const uncovered = chapterRows.filter((chapter) => !covered.has(chapter.id));
	const batches = selectArcRollupBatches(chapterRows, arcRows, chaptersPerArc);
	if (batches.length === 0) {
		return {
			created: false,
			reason: 'arc_threshold_not_met',
			uncoveredChapters: uncovered.length,
			chaptersPerArc,
		};
	}

	const createdArcs: Array<{ arcId: string; number: number; chapterCount: number }> = [];
	for (const arcChapters of batches) {
		const first = arcChapters[0];
		const last = arcChapters[arcChapters.length - 1];
		const chapterIds = arcChapters.map((chapter) => chapter.id);
		const arcId = stableId('arc', [first.id, last.id]);
		const [existing] = await db.select().from(arcs).where(and(eq(arcs.storyId, job.storyId), eq(arcs.id, arcId))).limit(1);
		const number = existing?.number ?? ((arcRows[arcRows.length - 1]?.number ?? 0) + createdArcs.length + 1);
		const title = arcTitle(number, arcChapters);
		const summary = buildArcSummary(arcChapters);
		const fields = buildArcMemoryFields(arcChapters);
		const sourceEventIds = uniqueStrings(arcChapters.flatMap((chapter) => asStringArray(chapter.sourceEventIds)));
		const openThreadIds = uniqueStrings(arcChapters.flatMap((chapter) => asStringArray(chapter.openThreads)));
		const now = nowIso();
		const serverVersion = await timePhase(recorder, 'job.rollup_arc.bump_version', {}, () => bumpStoryVersion(job.storyId));
		const metadata = {
			sourceType: 'terminal_arc_job',
			jobId: job.id,
			chapterCount: arcChapters.length,
			startChapterNumber: first.number,
			endChapterNumber: last.number,
			keyPlotPoints: fields.keyPlotPoints,
			characterArcs: fields.characterArcs,
			unresolvedThreads: fields.unresolvedThreads,
			emotionalProgression: fields.emotionalProgression,
			trackedEntityIds: fields.trackedEntityIds,
		};

		const [arc] = await timePhase(recorder, 'job.rollup_arc.persist_arc', {
			chapterCount: arcChapters.length,
		}, () => db.insert(arcs).values({
			id: arcId,
			storyId: job.storyId,
			number,
			title,
			summary,
			chapterIds,
			sourceEventIds,
			openThreadIds,
			metadata,
			serverVersion,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		}).onConflictDoUpdate({
			target: arcs.id,
			set: {
				number,
				title,
				summary,
				chapterIds,
				sourceEventIds,
				openThreadIds,
				metadata,
				serverVersion,
				updatedAt: now,
			},
		}).returning());

		await timePhase(recorder, 'job.rollup_arc.persist_memory_node', {}, () => upsertArcMemoryNode({
			storyId: job.storyId,
			arcId,
			title,
			summary,
			chapterIds,
			entityIds: fields.trackedEntityIds,
			sourceEventIds,
			openThreadIds,
			serverVersion,
			now,
			jobId: job.id,
		}));
		createdArcs.push({ arcId: arc.id, number: arc.number, chapterCount: arcChapters.length });
	}

	const firstArc = createdArcs[0];
	const latestArc = createdArcs[createdArcs.length - 1];
	const plotBrainJobId = await timePhase(recorder, 'job.rollup_arc.enqueue_plot_brain', {}, () => enqueuePlotBrainJob({
		storyId: job.storyId,
		trigger: 'arc_created',
		scopeId: latestArc.arcId,
	}));
	return {
		created: true,
		arcId: firstArc.arcId,
		number: firstArc.number,
		chapterCount: firstArc.chapterCount,
		arcCount: createdArcs.length,
		arcs: createdArcs,
		plotBrainJobId,
	};
}

async function syncStoryVault(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const config = getMtheriosAppConfig();
	const requestedVersion = asNumber(payload.serverVersion, 0);
	const beforeStatus = await timePhase(recorder, 'job.sync_story_vault.status_before', { requestedVersion }, () => getStoryVaultStatus(job.storyId, config));
	const alreadyFresh = beforeStatus.exists &&
		beforeStatus.vaultFresh &&
		(requestedVersion <= 0 || (beforeStatus.manifestVersion ?? 0) >= requestedVersion);
	const vault = alreadyFresh
		? {
			vaultPath: beforeStatus.vaultPath,
			collection: beforeStatus.collection,
			counts: beforeStatus.manifest?.counts ?? {},
		}
		: await timePhase(recorder, 'job.sync_story_vault.materialize', { clean: payload.clean !== false }, () => materializeStoryVault({
			storyId: job.storyId,
			clean: payload.clean !== false,
		}));
	const shouldIndex = payload.index === true || config.wikiAutoIndexStoryVaults;
	const indexed = shouldIndex
		? await timePhase(recorder, 'job.sync_story_vault.index', {
			recreate: payload.recreate === true,
			dryRun: payload.dryRun === true,
		}, () => indexWiki({
			storyId: job.storyId,
			recreate: payload.recreate === true,
			dryRun: payload.dryRun === true,
			provider: typeof payload.provider === 'string' ? payload.provider : null,
			model: typeof payload.model === 'string' ? payload.model : null,
		}))
		: null;
	const shouldLint = payload.lint === true || config.wikiAutoLintStoryVaults;
	const lintReport = shouldLint
		? await timePhase(recorder, 'job.sync_story_vault.lint', {
			thinChars: asNumber(payload.thinChars, 240),
		}, () => lintWiki({
			storyId: job.storyId,
			thinChars: asNumber(payload.thinChars, 240),
			orphanLayer: payload.orphanLayer === 'all' ? 'all' : 'derived',
		}))
		: null;
	const linted = lintReport
		? await timePhase(recorder, 'job.sync_story_vault.write_lint_report', {}, () => writeStoryVaultLintReport({ storyId: job.storyId, report: lintReport }, config))
		: null;

	const status = await timePhase(recorder, 'job.sync_story_vault.status_after', {}, () => getStoryVaultStatus(job.storyId, config));
	const followupVersion = storyVaultFollowupVersion(status);
	const followupJobId = followupVersion
		? await timePhase(recorder, 'job.sync_story_vault.enqueue_followup', { followupVersion }, () => enqueueStoryVaultSyncJob({
			storyId: job.storyId,
			serverVersion: followupVersion,
			reason: 'catchup',
			payload: {
				clean: payload.clean,
				index: payload.index,
				lint: payload.lint,
				recreate: payload.recreate,
				provider: payload.provider,
				model: payload.model,
				sourceJobId: job.id,
			},
		}))
		: null;
	return {
		storyId: job.storyId,
		vaultPath: vault.vaultPath,
		collection: vault.collection,
		counts: vault.counts,
		indexed,
		linted,
		autoIndex: config.wikiAutoIndexStoryVaults,
		autoLint: config.wikiAutoLintStoryVaults,
		followupJobId,
		followupVersion,
		status,
	};
}

export function storyVaultFollowupVersion(
	status: Pick<StoryVaultStatus, 'serverVersion' | 'manifestVersion'>,
): number | null {
	const serverVersion = Number.isFinite(status.serverVersion) ? Math.trunc(status.serverVersion) : 0;
	const manifestVersion = Number.isFinite(status.manifestVersion ?? 0)
		? Math.trunc(status.manifestVersion ?? 0)
		: 0;
	return serverVersion > 0 && manifestVersion < serverVersion ? serverVersion : null;
}

async function indexCanonicalRecordsJob(job: BackendJobRow): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const maxRecords = Number(payload.maxRecords);
	const result = await indexCanonicalRecords({
		storyId: job.storyId,
		recordTypes: asStringArray(payload.recordTypes),
		recordId: typeof payload.recordId === 'string' ? payload.recordId : null,
		recreate: payload.recreate === true,
		maxRecords: Number.isFinite(maxRecords) ? maxRecords : 40,
	});
	if (result.partial === true) {
		await enqueueBackendJob({
			storyId: job.storyId,
			type: 'index_canonical_records',
			dedupeKey: `canonical-index-cont-${job.id}-${Date.now()}`,
			payload: {
				...payload,
				recreate: false,
				maxRecords: Number.isFinite(maxRecords) ? maxRecords : 40,
				continuedFromJobId: job.id,
			},
			maxAttempts: 3,
		});
	}
	return result;
}

async function extractTurnState(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const playerEntryId = requirePayloadString(payload, 'playerEntryId');
	const assistantEntryId = requirePayloadString(payload, 'assistantEntryId');
	const playerText = requirePayloadString(payload, 'playerText');
	const narration = requirePayloadString(payload, 'narration');
	const memorySettingsPayload = asRecord(payload.memorySettings);
	const memorySettings = {
		chapterThreshold: asOptionalInt(memorySettingsPayload.chapterThreshold, 5, 200),
		postChapterBuffer: asOptionalInt(memorySettingsPayload.postChapterBuffer, 0, 100),
		chaptersPerArc: asOptionalInt(memorySettingsPayload.chaptersPerArc, 2, 50),
	};
	const chapterSummaryJobId = await timePhase(recorder, 'job.extract_turn_state.enqueue_chapter_summary', {
		assistantEntryId,
	}, () => enqueueChapterSummaryJob({
		storyId: job.storyId,
		serverVersion: asNumber(payload.serverVersion, 0),
		dedupeKey: `chapter-summary-${assistantEntryId}`,
		memorySettings,
	}));
	if (!shouldExtractDurableState(playerText, narration)) {
		return {
			status: 'no_changes',
			operationCount: 0,
			skipped: 'deterministic_no_durable_state',
			chapterSummaryJobId,
		};
	}
	const clientTurnId = typeof payload.clientTurnId === 'string' && payload.clientTurnId.trim()
		? payload.clientTurnId
		: job.id;
	const timelineTurn = typeof payload.timelineTurn === 'number' && Number.isFinite(payload.timelineTurn)
		? Math.max(0, Math.trunc(payload.timelineTurn))
		: null;
	const classifierService = await timePhase(recorder, 'job.extract_turn_state.resolve_service', {}, () => resolveServiceGeneration('classifier'));
	if (classifierService.setting?.enabled === false) {
		return {
			status: 'classifier_disabled',
			missingReason: classifierService.missingReason,
			chapterSummaryJobId,
		};
	}
	const useNarrativeFallback = shouldUseLegacyClassifierFallback(classifierService);
	const fallbackNarrativeService = useNarrativeFallback
		? await timePhase(recorder, 'job.extract_turn_state.resolve_narrative_fallback', {}, () => resolveServiceGeneration('narrative'))
		: null;
	const classifierProfile = classifierService.profile ?? fallbackNarrativeService?.profile ?? null;
	if (!classifierProfile) {
		throw new Error(classifierService.missingReason
			?? fallbackNarrativeService?.missingReason
			?? 'Classifier service is unavailable.');
	}

	const generationService = classifierService.profile ? classifierService : fallbackNarrativeService ?? classifierService;
	const classifierGeneration = generationService.generation;
	const classifierMaxTokens = classifierGenerationMaxTokens(classifierGeneration);
	const classifierSystem = classifierService.systemPromptOverride?.trim() || DEFAULT_STATE_EXTRACTION_SYSTEM;
	const extractionPrompt = buildStateExtractionPrompt(playerText, narration);
	const effectiveServiceId = classifierService.profile ? 'classifier' : 'narrative';
	const logMetadata = {
		configuredServiceId: 'classifier',
		effectiveServiceId,
		legacyNarrativeFallback: useNarrativeFallback,
		maxOutputTokens: classifierMaxTokens,
		responseFormat: 'json_schema',
		responseSchemaName: 'mtherios_state_patch',
	};
	let extractionResult: ServerGenerationResult;
	try {
		extractionResult = await timePhase(recorder, 'job.extract_turn_state.llm', {
			serviceId: 'classifier',
			effectiveServiceId,
			model: classifierGeneration.model ?? null,
		}, () => generateServerTextWithMetrics({
			profile: classifierProfile,
			model: classifierGeneration.model,
			temperature: classifierGeneration.temperature,
			maxTokens: classifierMaxTokens,
			system: classifierSystem,
			prompt: extractionPrompt,
			responseSchema: buildStateExtractionResponseSchema(),
		}));
	} catch (error) {
		const failedResult = generationErrorResult(error);
		if (failedResult) {
			await timePhase(recorder, 'job.extract_turn_state.log_error', {
				statusCode: failedResult.statusCode ?? null,
			}, () => logDeferredStateExtractionCall({
				job,
				clientTurnId,
				profile: classifierProfile,
				result: failedResult,
				status: 'error',
				error,
				metadata: {
					...logMetadata,
					parseOutcome: 'not_started',
					applyOutcome: 'not_started',
					reasoningTokens: failedResult.usage?.reasoningTokens ?? null,
					statusCode: failedResult.statusCode ?? null,
					debugSnapshot: buildTurnDebugSnapshot({
						kind: 'state_extraction',
						playerText,
						system: classifierSystem,
						prompt: extractionPrompt,
					}),
				},
			}));
		}
		throw error;
	}

	let parsedUpdate: ReturnType<typeof parseStateExtractionResult> | null = null;
	let applyStarted = false;
	try {
		parsedUpdate = timePhaseSync(recorder, 'job.extract_turn_state.parse_update', {}, () => parseStateExtractionResult(extractionResult.text));
		if (parsedUpdate.operationCount === 0) {
			await timePhase(recorder, 'job.extract_turn_state.log_success', {}, () => logDeferredStateExtractionCall({
				job,
				clientTurnId,
				profile: classifierProfile,
				result: extractionResult,
				status: 'success',
				metadata: {
					...logMetadata,
					parseOutcome: 'valid',
					applyOutcome: 'no_changes',
					operationCount: 0,
					finishReason: extractionResult.finishReason ?? null,
					reasoningTokens: extractionResult.usage.reasoningTokens ?? null,
					debugSnapshot: buildTurnDebugSnapshot({
						kind: 'state_extraction',
						playerText,
						system: classifierSystem,
						prompt: extractionPrompt,
						output: extractionResult.text,
					}),
				},
			}));
			return { status: 'no_changes', operationCount: 0, chapterSummaryJobId };
		}

		applyStarted = true;
		const serverVersion = await timePhase(recorder, 'job.extract_turn_state.bump_version', {
			operationCount: parsedUpdate.operationCount,
		}, () => bumpStoryVersion(job.storyId));
		const applied = await timePhase(recorder, 'job.extract_turn_state.apply_update', {
			operationCount: parsedUpdate.operationCount,
			serverVersion,
		}, () => applyValidatedTurnUpdate({
			storyId: job.storyId,
			playerEntryId,
			assistantEntryId,
			narration,
			update: parsedUpdate!.update,
			parseWarnings: parsedUpdate!.warnings,
			retrievedMemoryIds: asStringArray(payload.retrievedMemoryIds),
			serverVersion,
			mode: 'supplemental',
			timelineTurn,
			memorySettings,
		}));
		await timePhase(recorder, 'job.extract_turn_state.log_success', {}, () => logDeferredStateExtractionCall({
			job,
			clientTurnId,
			profile: classifierProfile,
			result: extractionResult,
			status: 'success',
			metadata: {
				...logMetadata,
				parseOutcome: 'valid',
				applyOutcome: 'applied',
				operationCount: parsedUpdate!.operationCount,
				appliedEventCount: applied.eventIds.length,
				appliedPatchCount: applied.patchIds.length,
				appliedMemoryNodeCount: applied.memoryNodeIds.length,
				applyWarningCount: applied.warnings.length,
				finishReason: extractionResult.finishReason ?? null,
				reasoningTokens: extractionResult.usage.reasoningTokens ?? null,
				debugSnapshot: buildTurnDebugSnapshot({
					kind: 'state_extraction',
					playerText,
					system: classifierSystem,
					prompt: extractionPrompt,
					output: extractionResult.text,
				}),
			},
		}));
		return {
			status: 'applied',
			serverVersion,
			operationCount: parsedUpdate.operationCount,
			parseWarnings: parsedUpdate.warnings.length,
			warnings: applied.warnings,
			eventIds: applied.eventIds,
			patchIds: applied.patchIds,
			memoryNodeIds: applied.memoryNodeIds,
			chapterSummaryJobId,
		};
	} catch (error) {
		await timePhase(recorder, 'job.extract_turn_state.log_error', {}, () => logDeferredStateExtractionCall({
			job,
			clientTurnId,
			profile: classifierProfile,
			result: extractionResult,
			status: 'error',
			error,
			metadata: {
				...logMetadata,
				parseOutcome: parsedUpdate ? 'valid' : 'error',
				applyOutcome: applyStarted ? 'error' : 'not_started',
				operationCount: parsedUpdate?.operationCount ?? null,
				finishReason: extractionResult.finishReason ?? null,
				reasoningTokens: extractionResult.usage.reasoningTokens ?? null,
				debugSnapshot: buildTurnDebugSnapshot({
					kind: 'state_extraction',
					playerText,
					system: classifierSystem,
					prompt: extractionPrompt,
					output: extractionResult.text,
				}),
			},
		}));
		throw error;
	}
}

async function continuityAudit(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const assistantEntryId = typeof payload.assistantEntryId === 'string' ? payload.assistantEntryId : null;
	const playerEntryId = typeof payload.playerEntryId === 'string' ? payload.playerEntryId : null;
	const serverVersion = typeof payload.serverVersion === 'number' && Number.isFinite(payload.serverVersion)
		? Math.trunc(payload.serverVersion)
		: null;
	const entryIds = [assistantEntryId, playerEntryId].filter((value): value is string => Boolean(value));
	const rows = entryIds.length
		? await timePhase(recorder, 'job.continuity_audit.load_entries', { entryIds: entryIds.length }, () => getDb()
			.select()
			.from(storyEntries)
			.where(and(eq(storyEntries.storyId, job.storyId), inArray(storyEntries.id, entryIds)))
			.limit(entryIds.length))
		: [];
	const contextReceipt = asRecord(payload.contextReceipt);
	const truncated = contextReceipt.truncated === true;
	const warnings = [
		truncated ? 'Turn context was truncated; continuity should prefer canonical state over omitted transcript.' : '',
		entryIds.length > 0 && rows.length === 0 ? 'Continuity audit could not load turn entries.' : '',
	].filter(Boolean);
	const result = {
		status: warnings.length ? 'needs_review' : 'ok',
		playerEntryId,
		assistantEntryId,
		serverVersion,
		entryCount: rows.length,
		truncated,
		warnings,
	};
	publishEngineEvent({ storyId: job.storyId, type: 'state.changed', data: { continuityAudit: result } });
	return result;
}

async function planPlotBrain(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	if (payload.skipIfPlanned === true) {
		const [story] = await getDb().select({ metadata: stories.metadata }).from(stories).where(eq(stories.id, job.storyId)).limit(1);
		if (!story) throw new Error(`Story not found: ${job.storyId}`);
		const metadata = asRecord(story.metadata);
		const plotBrain = asRecord(metadata.plotBrain);
		if (hasStrategicPlotContent(plotBrain.lastFrame ?? metadata.strategicWorldFrame)) {
			return { planned: false, reason: 'already_planned' };
		}
	}
	// ponytail: dynamic import avoids the serviceCommands <-> processor static cycle; extract a leaf command if another worker needs it.
	const { runPlotBrainPlanCommand } = await import('$lib/server/engine/serviceCommands');
	const result = await timePhase(recorder, 'job.plan_plot_brain.execute', {}, () => runPlotBrainPlanCommand({
		storyId: job.storyId,
		trigger: typeof payload.trigger === 'string' ? payload.trigger : 'scheduled_refresh',
		execute: true,
		includeSecret: true,
	}));
	return {
		planned: true,
		frameId: result.frameId,
		plotCardCount: result.plotCardCount,
		threadCount: result.threadCount,
		eventCount: result.eventCount,
		proposalCount: result.proposalCount,
		warnings: result.warnings,
	};
}

async function processBackendJob(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const type = job.type as BackendJobType;
	return timePhase(recorder, `job.${type}.total`, {
		attemptCount: job.attemptCount,
		maxAttempts: job.maxAttempts,
	}, async () => {
		switch (type) {
			case 'create_memory_nodes_from_events':
			case 'rebuild_retrieval_projection':
				return { materializedEventMemories: await createMemoryNodesFromEvents(job) };
			case 'update_faction_pressure':
				return updateFactionPressure(job, recorder);
			case 'embed_memory_nodes':
				return embedMemoryNodes(job);
			case 'summarize_chapter':
				return createChapterCheckpoint(job, recorder);
			case 'rollup_arc':
				return rollupArc(job, recorder);
			case 'evaluate_world_sim_tick':
				return evaluateWorldSimTick(job, recorder);
			case 'index_canonical_records':
				return indexCanonicalRecordsJob(job);
			case 'sync_story_vault':
				return syncStoryVault(job, recorder);
			case 'extract_turn_state':
				return extractTurnState(job, recorder);
			case 'continuity_audit':
				return continuityAudit(job, recorder);
			case 'plan_plot_brain':
				return planPlotBrain(job, recorder);
			default:
				throw new Error(`Unknown backend job type: ${job.type}`);
		}
	});
}

function jobTimingReport(job: BackendJobRow, status: BackendJobTimingReport['status'], phases: TimingEntry[]): BackendJobTimingReport {
	const total = [...phases].reverse().find((phase) => phase.phase === `job.${job.type}.total`)?.durationMs
		?? phases.reduce((sum, phase) => sum + phase.durationMs, 0);
	return {
		jobId: job.id,
		storyId: job.storyId,
		type: job.type,
		status,
		durationMs: total,
		phases,
	};
}

async function runClaimedJob(job: BackendJobRow): Promise<{
	completed: boolean;
	result?: Record<string, unknown>;
	error?: string;
	timing: BackendJobTimingReport;
}> {
	const recorder = createTimingRecorder({
		pipeline: 'backend.generation.jobs',
		metadata: {
			jobId: job.id,
			storyId: job.storyId,
			jobType: job.type,
		},
	});
	try {
		publishBackendJobStatus(job, 'running');
		const result = await processBackendJob(job, recorder);
		await timePhase(recorder, 'job.mark_complete', {}, () => markBackendJobComplete(job.id));
		publishBackendJobStatus(job, 'completed', { result });
		return {
			completed: true,
			result,
			timing: jobTimingReport(job, 'completed', recorder.timings),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await timePhase(recorder, 'job.mark_failed', { error: message }, () => markBackendJobFailed(job.id, error));
		publishBackendJobStatus(job, 'failed', { error: message });
		return {
			completed: false,
			error: message,
			timing: jobTimingReport(job, 'failed', recorder.timings),
		};
	}
}

export async function runDueBackendJobs(workerId = `worker_${Date.now()}`, limit = 10, storyId?: string | null): Promise<{
	claimed: number;
	completed: number;
	failed: Array<{ jobId: string; error: string }>;
	timings: BackendJobTimingReport[];
}> {
	const jobs = await claimBackendJobs(workerId, limit, storyId);
	const failed: Array<{ jobId: string; error: string }> = [];
	const timings: BackendJobTimingReport[] = [];
	let completed = 0;
	const byStory = new Map<string, BackendJobRow[]>();
	for (const job of jobs) {
		const group = byStory.get(job.storyId) ?? [];
		group.push(job);
		byStory.set(job.storyId, group);
	}
	const concurrency = readGenerationConcurrency();
	await mapWithConcurrency([...byStory.values()], concurrency, async (storyJobs) => {
		for (const job of storyJobs) {
			const result = await runClaimedJob(job);
			timings.push(result.timing);
			if (result.completed) {
				completed += 1;
			} else {
				failed.push({ jobId: job.id, error: result.error ?? 'unknown error' });
			}
		}
	});
	return { claimed: jobs.length, completed, failed, timings };
}

export async function runBackendJobNow(jobId: string, workerId = `manual_${Date.now()}`): Promise<{
	jobId: string;
	completed: boolean;
	result?: Record<string, unknown>;
	error?: string;
	timings?: BackendJobTimingReport;
}> {
	const claimedAt = nowIso();
	const [job] = await getDb().update(backendJobs).set({
		status: 'running',
		attemptCount: sql`${backendJobs.attemptCount} + 1`,
		lockedAt: claimedAt,
		lockedBy: workerId,
		updatedAt: claimedAt,
	}).where(eq(backendJobs.id, jobId)).returning();
	if (!job) throw new Error(`Backend job not found: ${jobId}`);

	const result = await runClaimedJob(job);
	return {
		jobId: job.id,
		completed: result.completed,
		result: result.result,
		error: result.error,
		timings: result.timing,
	};
}

export async function getBackendJobStats(storyId?: string | null): Promise<BackendJobStats> {
	const filters = storyId ? [eq(backendJobs.storyId, storyId)] : [];
	const rows = await getDb()
		.select({
			id: backendJobs.id,
			storyId: backendJobs.storyId,
			type: backendJobs.type,
			status: backendJobs.status,
			attemptCount: backendJobs.attemptCount,
			maxAttempts: backendJobs.maxAttempts,
			runAfter: backendJobs.runAfter,
			lockedAt: backendJobs.lockedAt,
			lockedBy: backendJobs.lockedBy,
			lastError: backendJobs.lastError,
			createdAt: backendJobs.createdAt,
			updatedAt: backendJobs.updatedAt,
		})
		.from(backendJobs)
		.where(filters.length > 0 ? and(...filters) : undefined);

	return summarizeBackendJobs(rows);
}

export function summarizeBackendJobs(rows: BackendJobPreview[]): BackendJobStats {
	const now = nowIso();
	const byStatus: Record<string, number> = {};
	const byType: Record<string, number> = {};
	const readyByType: Record<string, number> = {};
	const failedByType: Record<string, number> = {};
	const storyIds = new Set<string>();
	const latestCompletedAt = new Map<string, string>();
	let activeFailed = 0;
	const readyJobs: BackendJobPreview[] = [];
	const delayedJobs: BackendJobPreview[] = [];
	const runningJobs: BackendJobPreview[] = [];
	const recentFailures: BackendJobPreview[] = [];

	for (const row of rows) {
		if (row.status === 'complete') {
			const key = jobFamilyKey(row);
			const previous = latestCompletedAt.get(key);
			if (!previous || row.updatedAt > previous) latestCompletedAt.set(key, row.updatedAt);
		}
	}

	for (const row of rows) {
		byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
		byType[row.type] = (byType[row.type] ?? 0) + 1;
		storyIds.add(row.storyId);

		const runnable = row.status === 'queued' || row.status === 'retry';
		if (runnable && row.runAfter <= now) {
			readyJobs.push(row);
			readyByType[row.type] = (readyByType[row.type] ?? 0) + 1;
		} else if (runnable) {
			delayedJobs.push(row);
		}

		if (row.status === 'running') runningJobs.push(row);
		if (row.status === 'failed' || (row.status === 'retry' && row.lastError)) {
			if (!isSupersededJobFailure(row, latestCompletedAt)) {
				recentFailures.push(row);
				if (row.status === 'failed') activeFailed += 1;
				failedByType[row.type] = (failedByType[row.type] ?? 0) + 1;
			}
		}
	}

	readyJobs.sort((a, b) => a.runAfter.localeCompare(b.runAfter) || a.createdAt.localeCompare(b.createdAt));
	delayedJobs.sort((a, b) => a.runAfter.localeCompare(b.runAfter) || a.createdAt.localeCompare(b.createdAt));
	runningJobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	recentFailures.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

	return {
		total: rows.length,
		queued: byStatus.queued ?? 0,
		retry: byStatus.retry ?? 0,
		running: byStatus.running ?? 0,
		complete: byStatus.complete ?? 0,
		failed: activeFailed,
		ready: readyJobs.length,
		delayed: delayedJobs.length,
		storyCount: storyIds.size,
		byStatus,
		byType,
		readyByType,
		failedByType,
		oldestReadyAt: readyJobs[0]?.runAfter ?? null,
		nextRunAfter: delayedJobs[0]?.runAfter ?? null,
		recentFailures: recentFailures.slice(0, 8).map(compactJobPreview),
		runningJobs: runningJobs.slice(0, 8).map(compactJobPreview),
	};
}

function compactJobPreview(row: BackendJobPreview): BackendJobPreview {
	return {
		...row,
		lastError: row.lastError ? snippet(row.lastError, 500) : null,
	};
}

function jobFamilyKey(row: Pick<BackendJobPreview, 'storyId' | 'type'>): string {
	return `${row.storyId}:${row.type}`;
}

export function isSupersededJobFailure(
	row: Pick<BackendJobPreview, 'storyId' | 'type' | 'status' | 'updatedAt'>,
	latestCompletedAt: Map<string, string>,
): boolean {
	if (row.status !== 'failed' && row.status !== 'retry') return false;
	const completedAt = latestCompletedAt.get(jobFamilyKey(row));
	return Boolean(completedAt && completedAt > row.updatedAt);
}
