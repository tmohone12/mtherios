import { advanceNegotiation, reviewFactionIntentions, reviewGardener } from '$lib/server/factions/workflow';
import { validateProjectAgentSettings } from '$lib/server/engine/agentSettings';
import { processImageJob } from '$lib/server/engine/imageJobs';
import { processAssistantBatchJob } from '$lib/server/engine/assistantBatchWorker';
import { createHash } from 'node:crypto';
import { countTokens } from '$lib/utils/tokens';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { agreements, arcs, backendJobs, chapters, continuityWarnings, entities, factionGoals, factionProjects, factionResources, factions, memoryNodes, npcBeliefs, npcEventLinks, patchProposals, relationships, sagas, stories, storyEntries, storyEvents, storyThreads } from '$lib/server/db/schema';
import { gmTurnReceiptSchema, type MemoryNode } from '$lib/contracts/memory';
import { campaignStateExtractionContext, type CampaignStateFact, type ChapterCampaignFactAction } from '$lib/contracts/campaignState';
import { CHAPTER_TURN_COUNT, CHAPTERS_PER_ARC, selectArcRollupBatches, selectCompletedChapterTurns, selectNextChapterWindow } from '$lib/services/chapterCadence';
export { selectArcRollupBatches } from '$lib/services/chapterCadence';
import { generateChronologicalMemory, type MemoryInput } from './summaryGeneration';
import { chapterSourceForArc } from './chapterSummarySource';
export { chapterSourceForArc } from './chapterSummarySource';
import {
	embedMemoryTexts,
	memoryEmbeddingConfig,
	memoryNodeEmbeddingText,
	validateMemoryEmbeddingVector,
} from '$lib/server/memory/embeddings';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { getStoryVaultStatus, materializeStoryVault, type StoryVaultStatus } from '$lib/server/wiki/storyVault';
import { indexWiki } from '$lib/server/wiki/wikiCore';
import { claimBackendJobs, enqueueBackendJob, enqueueChapterSummaryJob, enqueuePlotBrainJob, enqueueStoryVaultSyncJob, enqueueTurnProjectionJobs, enqueueTurnStateExtractionJob, markBackendJobComplete, markBackendJobFailed, turnStateSourceFingerprint, type BackendJobType } from './outbox';
import { refreshSceneCheckpoint } from '$lib/server/memory/sceneCheckpoint';
import { indexCanonicalRecords } from '$lib/server/engine/canonicalSearch';
import { recordApiCallLog } from '$lib/server/engine/apiCallLogs';
import { generationAttemptResult, recordGenerationApiCalls, reuseGenerationResult } from '$lib/server/engine/generationAccounting';
import { publishEngineEvent } from '$lib/server/engine/events';
import { resolveServiceGeneration } from '$lib/server/engine/llmSettings';
import { getJevCooldownRemainingMs } from '$lib/server/turn/jev';
import { createTimingRecorder, type TimingEntry, type TimingRecorder } from '$lib/server/performance/timing';
import { mapWithConcurrency, readGenerationConcurrency } from '$lib/server/performance/concurrency';
import { buildTurnDebugSnapshot } from '$lib/server/turn/debugSnapshot';
import { filterNarrativeContextEntries, loadCanonicalCharacters, loadClassifierAgreements, loadClassifierLocations, loadClassifierFactions } from '$lib/server/turn/context';
import type { CharacterContextRecord } from '$lib/utils/characterState';
import { classifyBackendJobFailure, describeBackendJobError, type BackendJobFailureCause, type BackendJobFailureClass } from './failureClassification';
export { classifyBackendJobFailure } from './failureClassification';
export type { BackendJobFailureCause, BackendJobFailureClass } from './failureClassification';
import { applyValidatedTurnUpdate, turnUpdateOperationCount } from '$lib/server/turn/patchValidator';
import type { WorldStateUpdate } from '$lib/services/ai/tools/schemas';
import { buildCharacterCreationInstructions, buildClassifierAgreementContext, buildClassifierCharacterContext, buildClassifierLocationContext, buildStateExtractionPrompt, isPlayerCorrectionEntry, type AgreementContextRecord, type LocationIdentityRecord } from '$lib/server/turn/promptPacket';
import { buildBatchTurnMemoryPrompt, parseBatchTurnMemoryResult, type BatchTurnSource } from './batchTurnMemory';
import {
	buildStateExtractionResponseSchema,
	buildStateExtractionRepairPrompt,
	classifierGenerationMaxTokens,
	classifierRepairGeneration,
	DEFAULT_STATE_EXTRACTION_SYSTEM,
	parseStateExtractionResult,
	shouldExtractDurableState,
} from '$lib/server/turn/orchestrator';
import { applyChapterScribeCharacterContextProposals } from '$lib/server/engine/canonRepair';
import { refineChapterCharacterUpdates } from '$lib/server/engine/characterDrafts';
import { isCharacterTitleOnlyName, resolveEntityIdentity, shouldReuseResolvedEntity } from '$lib/server/memory/entityResolver';
import { deriveMemoryCoverage, findMemoryCoverageGaps, type MemoryCoverage } from './memoryCoverage';
import {
	ServerGenerationError,
	generateServerTextWithMetrics,
	getProviderCapabilities,
	getProviderCooldownRemainingMs,
	parseJsonFromGeneratedText,
	type ServerGenerationResult,
	type ServerGenerationAttempt,
} from '$lib/server/turn/provider';
import { extractMtheriosSummarySection, formatMtheriosMemorySummary, summarizeMtheriosMemoryForContext, summarizeMtheriosMemoryForRollup, type MtheriosCharacterState } from '$lib/services/ai/context/mtheriosSummaryFormat';
import { type PlotBrainLifecycleState } from '$lib/server/plotBrain/lifecycle';
import { closeThreadPressure } from '$lib/server/engine/plotEditing';
import { applyDueEventFeedback, applyFactionCueFeedback, dueEventCandidateSchema, isFactionCueCandidate, type DueEventCandidate } from '$lib/server/events/dueEventFeedback';
import {
	coerceChapterThreadDirectives,
	formatChapterThreadCatalog,
	type ChapterNewThread,
	type ChapterThreadChange,
	type ChapterThreadPlan,
} from '$lib/server/plotBrain/chapterThreads';
import { auditDueFactionProjects } from '$lib/server/factions/projects';
import {
	canonicalFactionIdentity,
	isWorldSimEligibleFaction,
	type FactionDoctrineKind,
	type FactionMovePlan,
} from '$lib/server/factions/autonomy';

export {
	buildFactionMovePlan,
	canonicalFactionIdentity,
	inferFactionDoctrine,
	isWorldSimEligibleFaction,
	isExplicitDynasticParticipant,
	selectFactionWorldTickCandidates,
} from '$lib/server/factions/autonomy';
export type { FactionDoctrineKind, FactionMovePlan } from '$lib/server/factions/autonomy';

type AnyBackendJobRow = typeof backendJobs.$inferSelect;
export type BackendJobRow = AnyBackendJobRow & { storyId: string };
type ArcRow = typeof arcs.$inferSelect;
export type ChapterRow = typeof chapters.$inferSelect;
type FactionRow = typeof factions.$inferSelect;
type FactionProjectRow = typeof factionProjects.$inferSelect;
type EntityRow = typeof entities.$inferSelect;
export type StoryEntryRow = typeof storyEntries.$inferSelect;
export type StoryEventRow = typeof storyEvents.$inferSelect;
type RelationshipRow = typeof relationships.$inferSelect;
type ProcessorDb = ReturnType<typeof getDb>;
type ProcessorTransaction = Parameters<Parameters<ProcessorDb['transaction']>[0]>[0];
type DbWriter = Pick<ReturnType<typeof getDb>, 'insert'>;
type ProjectionWriter = Pick<ProcessorDb, 'insert'>;
type ProviderProfile = NonNullable<Awaited<ReturnType<typeof resolveServiceGeneration>>['profile']>;
type GenerationResult = ServerGenerationResult | ServerGenerationError['result'];

const ARC_ROLLUP_THREAD_LIMIT = 20;
export const CHARACTER_CONTEXT_AUTO_APPLY_CHAPTER_INTERVAL = 1;
export const CHAPTER_PROJECTION_COMPILER = 'chapter-projection-v3';
export const ARC_PROJECTION_COMPILER = 'arc-projection-v3';
export const SAGA_PROJECTION_COMPILER = 'saga-projection-v1';
const SAGA_ROLLUP_ARCS = 5;

type ProjectionSourceRow = Pick<StoryEntryRow, 'id' | 'position' | 'content' | 'serverVersion'>
	& Partial<Pick<StoryEntryRow, 'type' | 'parentId' | 'branchId' | 'metadata'>>;
type ProjectionEventSourceRow = Pick<StoryEventRow, 'id' | 'status' | 'title' | 'body' | 'sourceEntryIds' | 'serverVersion'>;

export function projectionSourceEntriesMatch(expected: ProjectionSourceRow[], actual: ProjectionSourceRow[]): boolean {
	if (expected.length !== actual.length) return false;
	const currentById = new Map(actual.map((entry) => [entry.id, entry]));
	return expected.every((entry) => {
		const current = currentById.get(entry.id);
		if (!current) return false;
		return current.position === entry.position
			&& current.content === entry.content
			&& current.serverVersion === entry.serverVersion
			&& (entry.type === undefined || current.type === entry.type)
			&& (entry.parentId === undefined || current.parentId === entry.parentId)
			&& (entry.branchId === undefined || current.branchId === entry.branchId)
			&& (entry.metadata === undefined || JSON.stringify(current.metadata) === JSON.stringify(entry.metadata));
	});
}

export function projectionSourceEventsMatch(expected: ProjectionEventSourceRow[], actual: ProjectionEventSourceRow[]): boolean {
	if (expected.length !== actual.length) return false;
	const currentById = new Map(actual.map((event) => [event.id, event]));
	return expected.every((event) => {
		const current = currentById.get(event.id);
		if (!current) return false;
		return current.status === event.status
			&& current.title === event.title
			&& current.body === event.body
			&& JSON.stringify(current.sourceEntryIds) === JSON.stringify(event.sourceEntryIds)
			&& current.serverVersion === event.serverVersion;
	});
}


async function projectionChaptersStillMatch(storyId: string, expected: Array<Pick<ChapterRow, 'id' | 'serverVersion' | 'metadata' | 'sourceEntryIds' | 'sourceEventIds'>>): Promise<boolean> {
	if (expected.length === 0) return true;
	const current = await getDb().select({ id: chapters.id, serverVersion: chapters.serverVersion, metadata: chapters.metadata, sourceEntryIds: chapters.sourceEntryIds, sourceEventIds: chapters.sourceEventIds })
		.from(chapters)
		.where(and(eq(chapters.storyId, storyId), inArray(chapters.id, expected.map((chapter) => chapter.id))));
	if (current.length !== expected.length) return false;
	const currentById = new Map(current.map((chapter) => [chapter.id, chapter]));
	return expected.every((chapter) => {
		const row = currentById.get(chapter.id);
		if (!row) return false;
		return row.serverVersion === chapter.serverVersion
			&& JSON.stringify(row.metadata) === JSON.stringify(chapter.metadata)
			&& JSON.stringify(row.sourceEntryIds) === JSON.stringify(chapter.sourceEntryIds)
			&& JSON.stringify(row.sourceEventIds) === JSON.stringify(chapter.sourceEventIds);
	});
}

async function projectionArcsStillMatch(storyId: string, expected: Array<Pick<ArcRow, 'id' | 'serverVersion' | 'metadata' | 'chapterIds' | 'sourceEventIds'>>): Promise<boolean> {
	if (expected.length === 0) return true;
	const current = await getDb().select({ id: arcs.id, serverVersion: arcs.serverVersion, metadata: arcs.metadata, chapterIds: arcs.chapterIds, sourceEventIds: arcs.sourceEventIds })
		.from(arcs)
		.where(and(eq(arcs.storyId, storyId), inArray(arcs.id, expected.map((arc) => arc.id))));
	if (current.length !== expected.length) return false;
	const currentById = new Map(current.map((arc) => [arc.id, arc]));
	return expected.every((arc) => {
		const row = currentById.get(arc.id);
		if (!row) return false;
		return row.serverVersion === arc.serverVersion
			&& JSON.stringify(row.metadata) === JSON.stringify(arc.metadata)
			&& JSON.stringify(row.chapterIds) === JSON.stringify(arc.chapterIds)
			&& JSON.stringify(row.sourceEventIds) === JSON.stringify(arc.sourceEventIds);
	});
}

export interface ChapterMemoryDigest {
	title: string;
	summary: string;
	keywords: string[];
	keyCharacters: string[];
	keyLocations: string[];
	plotThreads: string[];
	emotionalTone: string;
	threadChanges?: ChapterThreadChange[];
	newThreads?: ChapterNewThread[];
	source: 'deterministic' | 'llm';
	model?: string;
	sourceAccounts?: Array<{ sourceId: string; summary: string }>;
	campaignFactReview?: ChapterCampaignFactAction[];
	characterStates?: MtheriosCharacterState[];
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
	storyId: string | null;
	projectId?: string;
	type: string;
	status: 'completed' | 'failed';
	durationMs: number;
	phases: TimingEntry[];
}

export interface BackendJobPreview {
	id: string;
	storyId: string | null;
	projectId?: string;
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
	payload?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	failureCause?: BackendJobFailureCause | null;
	sourceVersion?: number | null;
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
	failureClasses: BackendJobFailureClass[];
	oldestReadyAt: string | null;
	nextRunAfter: string | null;
	recentFailures: BackendJobPreview[];
	runningJobs: BackendJobPreview[];
	memoryProcessing: { complete: number; failed: number; waiting: number; running: number };
	memoryStageFreshness: MemoryStageFreshnessReport;
	memoryCoverage?: MemoryCoverage;
	providerCooldownMs?: number;
}

export type MemoryStageFreshnessStatus = 'current' | 'updating' | 'attention' | 'unknown';

export interface MemoryStageFreshness {
	status: MemoryStageFreshnessStatus;
	jobCount: number;
	completedCount: number;
	activeCount: number;
	failedCount: number;
	latestUpdatedAt: string | null;
	latestSourceVersion: number | null;
}

export interface MemoryStageFreshnessReport {
	checkpoint: MemoryStageFreshness;
	consolidation: MemoryStageFreshness;
	optionalIndex: MemoryStageFreshness;
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

export function nowIso(): string {
	return new Date().toISOString();
}

function id(prefix = 'job'): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

export async function timePhase<T>(
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

export function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function factionIsOperational(
	faction: Pick<FactionRow, 'goals' | 'memberEntityIds' | 'territoryIds' | 'metadata'> & { pressure?: number },
	hasNormalizedAnchor = false,
): boolean {
	return hasNormalizedAnchor
		|| asRecord(faction.metadata).worldSimEnabled === true
		|| (typeof faction.pressure === 'number' && faction.pressure > 0)
		|| asStringArray(faction.goals).length > 0
		|| asStringArray(faction.memberEntityIds).length > 0
		|| asStringArray(faction.territoryIds).length > 0;
}

export function factionMoveWakesPlotDirector(move: {
	urgency: 'low' | 'medium' | 'high' | 'critical';
	autonomousProjectCompleted?: boolean;
}): boolean {
	return move.urgency === 'high' || move.urgency === 'critical' || move.autonomousProjectCompleted === true;
}

export function hasCurrentStoryFactionSimulationMetadata(metadataValue: unknown): boolean {
	const metadata = asRecord(metadataValue);
	return metadata.currentStoryEvidence === true
		&& metadata.worldSimEnabled === true
		&& metadata.worldSimPromoted === true
		&& typeof metadata.factionType === 'string'
		&& Boolean(metadata.factionType.trim());
}

export function factionCanReceiveCharacterTagSync(
	faction: Pick<FactionRow, 'id' | 'metadata'>,
): boolean {
	const metadata = asRecord(faction.metadata);
	return metadata.scratchSeed !== true && !faction.id.startsWith('veil_scratch_');
}

export function asNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asOptionalInt(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	return clamp(Math.trunc(value), min, max);
}

export function requirePayloadString(payload: Record<string, unknown>, key: string): string {
	const value = payload[key];
	if (typeof value === 'string' && value.trim()) return value;
	throw new Error(`extract_turn_state job is missing payload.${key}`);
}

export function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function snippet(value: string, max = 220): string {
	const clean = compactWhitespace(value);
	return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}...` : clean;
}

type DeferredExtractionSourceEntry = Pick<StoryEntryRow, 'id' | 'type' | 'content' | 'parentId' | 'metadata'> & {
	position?: number;
	branchId?: string | null;
};

export function deferredExtractionSourcePairError(input: {
	playerEntryId: string;
	assistantEntryId: string;
	playerText: string;
	narration: string;
	entries: DeferredExtractionSourceEntry[];
}): string | null {
	const player = input.entries.find((entry) => entry.id === input.playerEntryId);
	const assistant = input.entries.find((entry) => entry.id === input.assistantEntryId);
	if (!player || !assistant) return 'source_entries_missing';
	if (player.type !== 'user_action' || assistant.type !== 'narration') return 'source_entry_types_changed';
	if (assistant.parentId !== player.id) return 'source_entry_pair_changed';
	if (player.content !== input.playerText || assistant.content !== input.narration) return 'source_entry_content_changed';
	for (const entry of [player, assistant]) {
		const metadata = asRecord(entry.metadata);
		if (metadata.nonCanon === true || metadata.actionType === 'ooc' || metadata.narrativeMode === 'ooc') {
			return 'source_entries_non_canon';
		}
	}
	return null;
}

async function loadDeferredExtractionSourcePair(input: {
	storyId: string;
	playerEntryId: string;
	assistantEntryId: string;
	playerText: string;
	narration: string;
}, db: Pick<ProcessorDb, 'select'> | ProcessorTransaction = getDb(), lock = false): Promise<{ entries: DeferredExtractionSourceEntry[]; error: string | null }> {
	const query = db.select({
		id: storyEntries.id,
		type: storyEntries.type,
		content: storyEntries.content,
		position: storyEntries.position,
		branchId: storyEntries.branchId,
		parentId: storyEntries.parentId,
		metadata: storyEntries.metadata,
	}).from(storyEntries).where(and(
		eq(storyEntries.storyId, input.storyId),
		inArray(storyEntries.id, [input.playerEntryId, input.assistantEntryId]),
	));
	const entries = lock
		? await query.for('update').limit(2)
		: await query.limit(2);
	return { entries, error: deferredExtractionSourcePairError({ ...input, entries }) };
}

export function deferredExtractionStoryLockSql(storyId: string) {
	return sql`select pg_advisory_xact_lock(hashtextextended(${`mtherios:story-entry:${storyId}`}, 0))`;
}

type DeferredExtractionAppliedReceipt = {
	assistantEntryId: string;
	serverVersion: number;
	operationCount: number;
	suppressedTransientState: boolean;
	noChanges: boolean;
	eventIds: string[];
	patchIds: string[];
	memoryNodeIds: string[];
	warnings: string[];
	appliedAt: string | null;
	sourceFingerprint?: string;
};

const DEFERRED_STALE_TRANSIENT_WARNING = 'Skipped obsolete transient state because a later canonical turn exists; durable facts were preserved.';

export function deferredExtractionAppliedReceipt(
	job: Pick<BackendJobRow, 'metadata' | 'payload'>,
): DeferredExtractionAppliedReceipt | null {
	const payload = asRecord(job.payload);
	const marker = asRecord(asRecord(job.metadata).deferredExtractionApplyReceipt);
	const assistantEntryId = typeof payload.assistantEntryId === 'string' ? payload.assistantEntryId : '';
	if (!assistantEntryId || marker.assistantEntryId !== assistantEntryId) return null;
	const payloadFingerprint = typeof payload.sourceFingerprint === 'string' ? payload.sourceFingerprint : null;
	const markerFingerprint = typeof marker.sourceFingerprint === 'string' ? marker.sourceFingerprint : null;
	if (payloadFingerprint && markerFingerprint !== payloadFingerprint) return null;
	if (typeof marker.serverVersion !== 'number' || !Number.isFinite(marker.serverVersion)) return null;
	const receipt: DeferredExtractionAppliedReceipt = {
		assistantEntryId,
		serverVersion: Math.max(0, Math.trunc(marker.serverVersion)),
		operationCount: typeof marker.operationCount === 'number' && Number.isFinite(marker.operationCount)
			? Math.max(0, Math.trunc(marker.operationCount))
			: 0,
		suppressedTransientState: marker.suppressedTransientState === true,
		noChanges: marker.noChanges === true,
		eventIds: asStringArray(marker.eventIds),
		patchIds: asStringArray(marker.patchIds),
		memoryNodeIds: asStringArray(marker.memoryNodeIds),
		warnings: asStringArray(marker.warnings),
		appliedAt: typeof marker.appliedAt === 'string' ? marker.appliedAt : null,
	};
	if (markerFingerprint) receipt.sourceFingerprint = markerFingerprint;
	return receipt;
}

function hasDurableCharacterState(character: WorldStateUpdate['characters'][number]): boolean {
	const eventMemory = asRecord(character.eventMemory);
	return Boolean(
		character.status
		|| character.creation_evidence?.trim()
		|| character.description?.trim()
		|| character.aliases.length
		|| character.traits.length
		|| character.pressures.length
		|| character.faction_tags.length
		|| typeof character.party_member === 'boolean'
		|| character.party_role?.trim()
		|| (typeof character.affinity_delta === 'number' && character.affinity_delta !== 0)
		|| character.appearance?.trim()
		|| character.background?.trim()
		|| character.goals.length
		|| Boolean(character.lastIndependentAction)
		|| character.speechStyle?.trim()
		|| character.speech_style?.trim()
		|| Object.values(eventMemory).some((value) => Array.isArray(value) && value.length > 0)
	);
}

/** Keep append-only/durable facts from an old turn while withholding its obsolete "current" state. */
export function preserveDurableDeferredState(update: WorldStateUpdate): WorldStateUpdate {
	const characters = update.characters.flatMap((character) => {
		const {
			present: _present,
			relationship: _relationship,
			currentLocation: _currentLocation,
			current_location: _currentLocationSnake,
			currentAction: _currentAction,
			current_action: _currentActionSnake,
			currentGoal: _currentGoal,
			currentPlan: _currentPlan,
			nextOpportunity: _nextOpportunity,
			constraint: _constraint,
			emotionalState: _emotionalState,
			emotional_state: _emotionalStateSnake,
			...durable
		} = character;
		return hasDurableCharacterState(character) ? [{ ...durable, relationship: null }] : [];
	});
	const locations = update.locations.map(({ current: _current, connections, ...location }) => ({
		...location,
		...(connections?.length ? { connections } : {}),
	})) as WorldStateUpdate['locations'];
	const items = update.items.map(({ quantity: _quantity, equipped: _equipped, location: _location, ...item }) => item);
	return {
		...update,
		characters,
		locations,
		items,
		// Absolute upserts from an overtaken turn can regress newer canon. Without
		// source-ordered field versions, dropping them is the only monotonic merge.
		relationships: [],
		lorebook_entries: [],
		time_delta: null,
		mood: null,
		player_reputation: null,
		player_ledger: null,
	};
}

function deferredStateUpdateHasOperations(update: WorldStateUpdate): boolean {
	return turnUpdateOperationCount(update) > 0;
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
	job: Pick<AnyBackendJobRow, 'id' | 'storyId' | 'type' | 'attemptCount' | 'maxAttempts'> & { projectId?: string },
	status: BackendJobStatusEventStatus,
	details: { result?: Record<string, unknown>; error?: string } = {},
): Record<string, unknown> {
	return {
		jobId: job.id,
		storyId: job.storyId,
		projectId: job.projectId,
		type: job.type,
		status,
		attemptCount: job.attemptCount,
		maxAttempts: job.maxAttempts,
		...(details.result ? { result: details.result } : {}),
		...(details.error ? { error: snippet(details.error, 500) } : {}),
	};
}

function publishBackendJobStatus(
	job: Pick<AnyBackendJobRow, 'id' | 'storyId' | 'type' | 'attemptCount' | 'maxAttempts'> & { projectId?: string },
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

export function stableId(prefix: string, parts: string[]): string {
	const normalized = parts
		.join('_')
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!normalized) return `${prefix}_${id('stable')}`;
	if (normalized.length <= 160) return `${prefix}_${normalized}`;
	const hash = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 12);
	return `${prefix}_${normalized.slice(0, 147)}_${hash}`;
}

export function worldTickEventId(input: {
	storyId: string;
	factionId: string;
	currentTurn: number;
	pressureBand: number;
	jevEnabled: boolean;
	projectOrGoalId: string;
	plan: FactionMovePlan;
}): string {
	return stableId('event_world_tick', input.jevEnabled ? [
		input.storyId, input.factionId, String(input.currentTurn), String(input.pressureBand),
	] : [
		input.storyId, input.factionId, input.projectOrGoalId, String(input.pressureBand),
		input.plan.actionType, input.plan.projectKind ?? 'none',
		input.plan.targetFactionIds.slice().sort().join(','),
		input.plan.projectProgressBefore == null
			? `turn:${input.currentTurn}`
			: `prior:${Math.round(input.plan.projectProgressBefore * 10000)}`,
	]);
}

export function projectionFingerprint(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

export function buildDeferredStateExtractionPrompt(input: {
	campaignMetadata?: unknown;
	playerText: string;
	narration: string;
	responseSchema: Record<string, unknown>;
	attemptCount: number;
	lastError?: string | null;
	characters?: CharacterContextRecord[];
	agreements?: AgreementContextRecord[];
	locations?: LocationIdentityRecord[];
	factions?: LocationIdentityRecord[];
	dueEventCandidates?: DueEventCandidate[];
}): { prompt: string; compactRecovery: boolean } {
	if (input.attemptCount <= 1) {
		return {
			prompt: buildStateExtractionPrompt(input.playerText, input.narration, input.responseSchema, input.characters, input.agreements, input.locations, input.factions, input.campaignMetadata, input.dueEventCandidates),
			compactRecovery: false,
		};
	}
	return {
		prompt: buildStateExtractionRepairPrompt({
			campaignMetadata: input.campaignMetadata,
			dueEventCandidates: input.dueEventCandidates,
			characters: input.characters,
			agreements: input.agreements,
			locations: input.locations,
			factions: input.factions,
			playerText: input.playerText,
			narration: input.narration,
			validationError: input.lastError,
			attempt: input.attemptCount,
		}),
		compactRecovery: true,
	};
}

function normalizedCharacterReference(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function reconcileDeferredExtractionReceipt(
	job: Pick<BackendJobRow, 'id' | 'storyId' | 'payload' | 'attemptCount' | 'maxAttempts'>,
	status: 'running' | 'succeeded' | 'skipped' | 'queued' | 'failed',
	details: { result?: Record<string, unknown>; error?: string } = {},
): Promise<void> {
	if (job.payload == null) return;
	const assistantEntryId = asRecord(job.payload).assistantEntryId;
	if (typeof assistantEntryId !== 'string' || !assistantEntryId.trim()) return;
	try {
		const [entry] = await getDb().select({ metadata: storyEntries.metadata })
			.from(storyEntries)
			.where(and(eq(storyEntries.storyId, job.storyId), eq(storyEntries.id, assistantEntryId)))
			.limit(1);
		const metadata = asRecord(entry?.metadata);
		const parsed = gmTurnReceiptSchema.safeParse(metadata.gmTurnReceipt);
		if (!parsed.success) return;
		const result = details.result ?? {};
		const count = (key: string) => Array.isArray(result[key]) ? result[key].length : 0;
		const receipt = {
			...parsed.data,
			stateExtractionStatus: status,
			stateExtractionJobId: job.id,
			stateExtractionError: details.error ?? null,
			changes: status === 'succeeded' ? {
				statePatches: count('patchIds'),
				events: count('eventIds'),
				memoryNodes: count('memoryNodeIds'),
			} : parsed.data.changes,
			steps: parsed.data.steps.map((step) => step.id === 'canon' ? {
				...step,
				status: status === 'queued' || status === 'running' ? 'running' as const : status,
				detail: details.error ?? (typeof result.status === 'string' ? result.status : job.id),
			} : step),
		};
		await getDb().update(storyEntries).set({
			metadata: { ...metadata, gmTurnReceipt: receipt },
			updatedAt: nowIso(),
		}).where(and(eq(storyEntries.storyId, job.storyId), eq(storyEntries.id, assistantEntryId)));
	} catch (error) {
		console.warn('[jobs] deferred extraction receipt reconciliation failed:', error);
	}
}

export function deferredExtractionTerminalReceiptStatus(result: Record<string, unknown>): 'succeeded' | 'skipped' {
	const status = typeof result.status === 'string' ? result.status : '';
	return status === 'classifier_disabled' || status.startsWith('skipped_') ? 'skipped' : 'succeeded';
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
	recurringNames?: string[];
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
		const recurring = (input.recurringNames ?? []).some((value) => normalizedCharacterReference(value) === normalized);
		if (importance < 3 && !(recurring && summaryHit)) continue;

		candidates.push({
			name,
			description: snippet(`${name} is important in this chapter checkpoint.`, 180),
			sourceEventIds,
			confidence: Math.min(0.82, 0.52 + (importance * 0.1)),
			reason: recurring && importance < 3 ? `${name} recurs across multiple saved chapter summaries.` : summaryHit
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
	// Being the target of an event is not evidence of noticing it: a secret plot against a
	// character, or the player's private thought about them, never becomes their memory.
	const sawEvents = input.events.filter((event) =>
		!asStringArray(event.actorEntityIds).includes(input.entityId) &&
		asStringArray(event.targetEntityIds).includes(input.entityId) &&
		event.visibility !== 'secret' &&
		!['think', 'thought'].includes(String(asRecord(event.metadata).actionType ?? asRecord(event.metadata).narrativeMode ?? ''))
	);
	const did = uniqueStrings(didEvents.map(eventSummaryForCharacter)).slice(-6);
	const saw = uniqueStrings(sawEvents.map(eventSummaryForCharacter)).slice(-6);
	if (!did.length && !saw.length) return null;

	const state: Record<string, unknown> = {
		// A completed chapter adds history; it cannot locate or reset a character in the current scene.
		eventMemory: { did, saw },
	};
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
	await recordGenerationApiCalls({
		storyId: options.job.storyId,
		serviceId: 'classifier',
		operation: 'turn.state_extraction',
		profile: options.profile,
		result: options.result,
		status: options.status,
		error: options.error,
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
			eq(storyEvents.status, 'committed'),
		));
	}
	return db
		.select()
		.from(storyEvents)
		.where(and(eq(storyEvents.storyId, storyId), eq(storyEvents.status, 'committed')))
		.orderBy(desc(storyEvents.updatedAt))
		.limit(200);
}

async function createMemoryNodesFromEvents(job: BackendJobRow): Promise<{
	created: number;
	memoryNodeIds: string[];
	embeddingJobId: string | null;
}> {
	const db = getDb();
	const payload = asRecord(job.payload);
	const eventIds = asStringArray(payload.eventIds);
	const rows = await loadEventRows(job.storyId, eventIds);
	const updatedAt = nowIso();
	let created = 0;
	const memoryNodeIds: string[] = [];
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
		memoryNodeIds.push(values.id);
	}
	const embeddingJobId = memoryNodeIds.length > 0
		? await enqueueBackendJob({
			storyId: job.storyId,
			type: 'embed_memory_nodes',
			dedupeKey: `embed-event-memory-${job.id}`,
			payload: { memoryNodeIds, sourceJobId: job.id },
		})
		: null;
	return { created, memoryNodeIds, embeddingJobId };
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
	if (asStringArray(row.factionIds).includes(faction.id)) return true;
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
	db?: DbWriter;
}): Promise<void> {
	const content = factionPressureContent({
		faction: input.faction,
		pressure: input.pressure,
		reasons: input.reasons,
	});
	const eventTypes = uniqueStrings(input.reasons.map((reason) => reason.eventType));
	await (input.db ?? getDb()).insert(memoryNodes).values({
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
		visibility: 'secret',
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
			visibility: 'secret',
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
	const pressure = await scoreFactionPressure(job, recorder);
	// Due projects become reviewable proposals, keyed by a project fingerprint, so a repeat writes nothing.
	const factionProjectAudit = await timePhase(recorder, 'job.update_faction_pressure.faction_projects', {}, () => auditDueFactionProjects({
		storyId: job.storyId,
	}));
	return { ...pressure, factionProjectAudit };
}

async function scoreFactionPressure(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const eventIds = asStringArray(payload.eventIds);
	const rows = await timePhase(recorder, 'job.update_faction_pressure.load_events', { eventIds: eventIds.length }, () => loadEventRows(job.storyId, eventIds));
	if (rows.length === 0) {
		return { updatedFactions: 0, eventCount: 0, reason: 'no_events' };
	}

	const [allFactionRows, goalAnchors, projectAnchors, resourceAnchors] = await timePhase(recorder, 'job.update_faction_pressure.load_factions', {}, () => Promise.all([
		getDb().select().from(factions).where(eq(factions.storyId, job.storyId)).orderBy(asc(factions.name)),
		getDb().select({ factionId: factionGoals.factionId }).from(factionGoals).where(and(eq(factionGoals.storyId, job.storyId), inArray(factionGoals.status, ['active', 'in_progress']))),
		getDb().select({ factionId: factionProjects.factionId }).from(factionProjects).where(and(eq(factionProjects.storyId, job.storyId), inArray(factionProjects.status, ['planned', 'active']))),
		getDb().select({ factionId: factionResources.factionId }).from(factionResources).where(eq(factionResources.storyId, job.storyId)),
	]));
	const normalizedAnchorIds = new Set([...goalAnchors, ...projectAnchors, ...resourceAnchors].map((row) => row.factionId));
	const factionEntityIds = uniqueStrings(allFactionRows.map((faction) => faction.entityId ?? ''));
	const factionEntityRows = factionEntityIds.length > 0
		? await getDb().select().from(entities).where(and(
			eq(entities.storyId, job.storyId),
			inArray(entities.id, factionEntityIds),
		)).limit(factionEntityIds.length)
		: [];
	const factionEntityById = new Map(factionEntityRows.map((entity) => [entity.id, entity]));
	const factionRows = allFactionRows.filter((faction) =>
		isWorldSimEligibleFaction(faction, faction.entityId ? factionEntityById.get(faction.entityId) : null)
		&& (factionIsOperational(faction, normalizedAnchorIds.has(faction.id))
			|| rows.some((row) => eventMentionsFaction(row, faction))));
	if (factionRows.length === 0) {
		return { updatedFactions: 0, eventCount: rows.length, reason: allFactionRows.length > 0 ? 'no_operational_factions' : 'no_factions' };
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
		await getDb().transaction(async (tx) => {
			await tx.update(factions).set({
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
				db: tx,
			});
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
	const highestPressure = Math.max(...changes.map((change) => change.pressure));
	const [currentStory] = highestPressure >= 70 && payload.deferWorldTick !== true
		? await getDb().select({ currentTurn: stories.currentTurn }).from(stories).where(eq(stories.id, job.storyId)).limit(1)
		: [];
	const worldTickJobId = highestPressure >= 70 && payload.deferWorldTick !== true
		? await timePhase(recorder, 'job.update_faction_pressure.enqueue_world_tick', { highestPressure }, () => enqueueBackendJob({
			storyId: job.storyId,
			type: 'evaluate_world_sim_tick',
			dedupeKey: currentStory ? `world-sim-turn-${currentStory.currentTurn}` : `world-sim-pressure-${serverVersion}`,
			payload: {
				force: false,
				serverVersion,
				sourceJobId: job.id,
			},
			requeueExisting: false,
		}))
		: null;

	return {
		updatedFactions: changes.length,
		eventCount: rows.length,
		changes,
		worldTickJobId,
		...(changes.length === 0 ? { reason: 'no_new_matching_events' } : {}),
	};
}




export function factionProjectIsAutonomous(project: Pick<FactionProjectRow, 'metadata'>): boolean {
	const metadata = asRecord(project.metadata);
	return metadata.sourceType === 'autonomous_faction_project' || metadata.worldSimEnabled === true;
}

export function factionCanStartAutonomousProject(projects: Array<Pick<FactionProjectRow, 'factionId' | 'status' | 'metadata'>>, factionId: string): boolean {
	return !projects.some(project => project.factionId === factionId
		&& ['planned', 'active'].includes(project.status) && factionProjectIsAutonomous(project));
}

export function factionProjectIsReady(project: Pick<FactionProjectRow, 'status' | 'metadata' | 'dueTurn'>, currentTurn: number): boolean {
	if (project.status !== 'active' || !factionProjectIsAutonomous(project)) return false;
	const metadata = asRecord(project.metadata);
	const nextActionTurn = metadata.nextActionTurn;
	if (typeof nextActionTurn === 'number' && Number.isFinite(nextActionTurn)) return nextActionTurn <= currentTurn;
	return project.dueTurn == null || project.dueTurn <= currentTurn;
}

export function factionProjectPausesAmbient(project: Pick<FactionProjectRow, 'status' | 'metadata' | 'dueTurn'>, currentTurn: number): boolean {
	return project.status === 'active' && factionProjectIsAutonomous(project)
		&& !factionProjectIsReady(project, currentTurn);
}


export function factionIsCurrentEra(faction: FactionRow, entityById: Map<string, EntityRow>): boolean {
	const entity = faction.entityId ? entityById.get(faction.entityId) : undefined;
	return isWorldSimEligibleFaction(faction, entity);
}

function worldTickActionKey(plan: Pick<FactionMovePlan, 'action' | 'projectId' | 'targetFactionIds'>): string {
	return JSON.stringify([plan.projectId, plan.action.toLowerCase().replace(/\s+/g, ' ').trim(), [...plan.targetFactionIds].sort()]);
}

export function repeatsFactionMove(plan: Pick<FactionMovePlan, 'action' | 'projectId' | 'targetFactionIds'>,
	factionId: string, factionMetadata: unknown,
	events: Array<Pick<StoryEventRow, 'metadata'>>): boolean {
	if (plan.projectId) return false;
	const key = worldTickActionKey(plan);
	if (asRecord(factionMetadata).lastWorldSimActionKey === key) return true;
	return events.some(event => {
		const previous = asRecord(event.metadata);
		return previous.sourceType === 'terminal_world_sim_tick' && previous.factionId === factionId
			&& !previous.projectId && worldTickActionKey({ projectId: null,
				action: String(previous.action ?? ''), targetFactionIds: asStringArray(previous.targetFactionIds) }) === key;
	});
}

export function chooseFactionTarget(input: {
	faction: FactionRow;
	factionKind: FactionDoctrineKind;
	factions: FactionRow[];
	doctrineByFactionId: Map<string, FactionDoctrineKind>;
	entityById: Map<string, EntityRow>;
	currentTurn: number;
	preferredFactionId?: string | null;
	goalText?: string;
	relationshipRows?: Array<Pick<RelationshipRow, 'sourceEntityId' | 'targetEntityId' | 'type'>>;
	recentEvents?: Array<Pick<StoryEventRow, 'id' | 'factionIds' | 'visibility' | 'status'>>;
}): FactionRow | null {
	const actingIdentity = canonicalFactionIdentity(input.faction, input.faction.entityId ? input.entityById.get(input.faction.entityId) : null);
	if (input.preferredFactionId) {
		const preferred = input.factions.find((faction) => faction.id === input.preferredFactionId);
		const preferredIdentity = preferred
			? canonicalFactionIdentity(preferred, preferred.entityId ? input.entityById.get(preferred.entityId) : null)
			: null;
		return preferred && preferredIdentity !== actingIdentity && factionIsCurrentEra(preferred, input.entityById) ? preferred : null;
	}
	const others = input.factions.filter((faction) => canonicalFactionIdentity(
		faction,
		faction.entityId ? input.entityById.get(faction.entityId) : null,
	) !== actingIdentity && factionIsCurrentEra(faction, input.entityById));
	if (others.length === 0) return null;
	const preferredKinds: Partial<Record<FactionDoctrineKind, FactionDoctrineKind[]>> = {
		feudal_house: ['feudal_house'],
		commercial: ['feudal_house', 'civic', 'commercial'],
		faith: ['feudal_house', 'civic'],
		military_order: ['feudal_house', 'civic', 'military_order'],
		civic: ['feudal_house', 'commercial', 'civic'],
		scholarly: ['feudal_house', 'civic', 'scholarly'],
	};
	const goalText = input.goalText?.toLowerCase() ?? '';
	const tie = (target: FactionRow) => Number.parseInt(createHash('sha256')
		.update(`${input.faction.id}:${input.currentTurn}:${target.id}`).digest('hex').slice(0, 8), 16);
	const score = (target: FactionRow) => {
		let value = 0;
		if (target.name.length > 3 && goalText.includes(target.name.toLowerCase())) value += 8;
		if (input.faction.enemies.includes(target.id) || target.enemies.includes(input.faction.id)) value += 4;
		if (input.faction.allies.includes(target.id) || target.allies.includes(input.faction.id)) value += /allian|treaty|trade|support/i.test(goalText) ? 4 : 1;
		if (input.faction.territoryIds.some(id => target.territoryIds.includes(id))) value += 3;
		if (input.faction.entityId && target.entityId && input.relationshipRows?.some(row =>
			(row.sourceEntityId === input.faction.entityId && row.targetEntityId === target.entityId)
				|| (row.sourceEntityId === target.entityId && row.targetEntityId === input.faction.entityId))) value += 2;
		if (input.recentEvents?.some(event => event.status === 'committed'
			&& event.factionIds.includes(input.faction.id) && event.factionIds.includes(target.id)
			&& (event.visibility === 'player_known' || asStringArray(input.faction.sourceEventIds).includes(event.id)))) value += 3;
		return value ? value + Number(Boolean(preferredKinds[input.factionKind]?.includes(input.doctrineByFactionId.get(target.id) ?? 'generic'))) : 0;
	};
	return others.filter(target => score(target) > 0).sort((a, b) => score(b) - score(a)
		|| tie(a) - tie(b)
		|| a.id.localeCompare(b.id))[0] ?? null;
}







export function eligibleNpcBackgroundActors(rows: EntityRow[], narration: string, currentTurn: number, playerEntityId?: string): EntityRow[] {
	const visibleText = narration.toLowerCase();
	return rows.filter((actor) => {
		if (actor.type !== 'character' || actor.status !== 'active' || actor.id === playerEntityId) return false;
		const state = asRecord(actor.state);
		const relationship = asRecord(state.relationship);
		if (state.isProtagonist === true || state.relationship === 'self' || relationship.status === 'self' || relationship.status === 'player_character') return false;
		if (typeof state.currentPlan !== 'string' || !state.currentPlan.trim()) return false;
		if (asStringArray(actor.sourceEntryIds).length === 0 && asStringArray(actor.sourceEventIds).length === 0) return false;
		if (visibleText.includes(actor.name.toLowerCase())) return false;
		return typeof state.lastIndependentActionTurn !== 'number' || currentTurn - state.lastIndependentActionTurn >= 5;
	}).sort((a, b) => a.id.localeCompare(b.id));
}

async function evaluateWorldSimTick(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
 const payload = asRecord(job.payload);
 // Settlement uses an independent immutable step receipt; a GM cue never settles it.
 const settlement = await advanceNegotiation(job.storyId, stableId('step', [job.id]).slice(0, 50));
 const review = await reviewFactionIntentions(job.storyId, job.id, asStringArray(payload.materialFactionIds));
 if (payload.planAfterTick === true) await enqueuePlotBrainJob({ storyId: job.storyId, trigger: 'scheduled_refresh', scopeId: job.id, skipIfPlanned: true });
 return { ...review, settlement, createdEvents: 0 };
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

export async function lastChapterBoundary(storyId: string): Promise<{ chapter: ChapterRow | null; endPosition: number }> {
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

export async function loadEntriesAfter(storyId: string, afterPosition: number, limit: number): Promise<StoryEntryRow[]> {
	const rows: StoryEntryRow[] = [];
	const pageSize = Math.max(100, limit * 2);
	let cursor = afterPosition;
	while (true) {
		const page = await getDb()
			.select()
			.from(storyEntries)
			.where(and(
				eq(storyEntries.storyId, storyId),
				gt(storyEntries.position, cursor),
			))
			.orderBy(asc(storyEntries.position))
			.limit(pageSize);
		if (page.length === 0) break;
		rows.push(...page);
		const presentIds = new Set(rows.map(entry => entry.id));
		const missingParents = uniqueStrings(page.filter(entry => entry.type === 'narration' && entry.parentId && !presentIds.has(entry.parentId)).map(entry => entry.parentId!));
		if (missingParents.length) {
			const [parents, priorCoverage] = await Promise.all([
				getDb().select().from(storyEntries).where(and(eq(storyEntries.storyId, storyId), inArray(storyEntries.id, missingParents))),
				getDb().select({ sourceEntryIds: chapters.sourceEntryIds }).from(chapters).where(and(
					eq(chapters.storyId, storyId),
					sql`${chapters.sourceEntryIds} ?| array[${sql.join(missingParents.map(id => sql`${id}`), sql`, `)}]::text[]`,
				)),
			]);
			const coveredIds = new Set(priorCoverage.flatMap(chapter => asStringArray(chapter.sourceEntryIds)));
			rows.push(...parents.filter(parent => !coveredIds.has(parent.id)));
		}
		if (selectNextChapterWindow(rows)) return rows;
		const nextCursor = page.at(-1)?.position ?? cursor;
		if (nextCursor <= cursor || page.length < pageSize) break;
		cursor = nextCursor;
	}
	return rows;
}

export function isNarrativeChapterEvent(event: Pick<StoryEventRow, 'status' | 'metadata'>): boolean {
	const metadata = asRecord(event.metadata);
	return event.status !== 'cancelled'
		&& metadata.nonCanon !== true
		&& metadata.actionType !== 'ooc'
		&& metadata.narrativeMode !== 'ooc';
}

export async function loadEventsForEntries(storyId: string, entryIds: string[], db: Pick<ProcessorDb, 'select'> | ProcessorTransaction = getDb()): Promise<StoryEventRow[]> {
	if (entryIds.length === 0) return [];
	const entrySet = new Set(entryIds);
	const rows = await db
		.select()
		.from(storyEvents)
		.where(and(eq(storyEvents.storyId, storyId), sql`exists (select 1 from jsonb_array_elements_text(${storyEvents.sourceEntryIds}) as source(id) where source.id in (${sql.join(entryIds.map(id => sql`${id}`), sql`, `)}))`))
		.orderBy(asc(storyEvents.createdAt));
	return rows
		.filter((row) => isNarrativeChapterEvent(row)
			&& asStringArray(row.sourceEntryIds).some((entryId) => entrySet.has(entryId)))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function narrativeChapterSources(entries: StoryEntryRow[], events: StoryEventRow[]): {
	entries: StoryEntryRow[];
	events: StoryEventRow[];
} {
	const narrativeEntries = filterNarrativeContextEntries(entries);
	const entryIds = new Set(narrativeEntries.map((entry) => entry.id));
	return {
		entries: narrativeEntries,
		events: events.filter((event) => {
			if (!isNarrativeChapterEvent(event)) return false;
			const sourceIds = asStringArray(event.sourceEntryIds);
			return sourceIds.length === 0 || sourceIds.some((entryId) => entryIds.has(entryId));
		}),
	};
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
	return cleanSummaryBeat(entry.content, 320);
}

function meaningfulEventString(event: StoryEventRow): string | null {
	const title = compactWhitespace(event.title);
	const body = cleanSummaryBeat(event.body, 180);
	if (!title || title.toLowerCase() === 'turn resolved') return null;
	return `${event.type}: ${title}${body ? ` - ${body}` : ''}`;
}

function meaningfulEventStoryString(event: StoryEventRow): string | null {
	const title = compactWhitespace(event.title);
	const body = cleanSummaryBeat(event.body, 320);
	if (!title || title.toLowerCase() === 'turn resolved') return null;
	if (!body || body.toLowerCase() === title.toLowerCase()) return title;
	return `${title} - ${body}`;
}

function chapterSynopsisParagraphs(beats: string[]): string[] {
	// Deterministic inspection retains every beat. Failed LLM work is never promoted to a completed chapter.
	return uniqueStrings(beats);
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
	({ entries, events } = narrativeChapterSources(entries, events));
	if (entries.length === 0) {
		return formatMtheriosMemorySummary({
			checkpoint: 'Chapter checkpoint contained no canonical narrative entries.',
			sourceCoverage: ['Non-canon control turns were excluded.'],
		});
	}
	const first = entries[0];
	const last = entries[entries.length - 1];
	const eventStoryLines = events.map(meaningfulEventStoryString).filter((event): event is string => Boolean(event));
	const eventLines = events.map(meaningfulEventString).filter((event): event is string => Boolean(event));
	const recentLines = uniqueStrings([
		...chapterSynopsisParagraphs(eventStoryLines),
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
	({ entries, events } = narrativeChapterSources(entries, events));
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

export async function summarizeChapterMemoryWithLlm(
	entries: StoryEntryRow[],
	events: StoryEventRow[],
	_fallback: ChapterMemoryDigest,
	existingThreads: Array<typeof storyThreads.$inferSelect>,
	campaignFacts: CampaignStateFact[] = [],
): Promise<ChapterMemoryDigest> {
	return summarizeChapterMemoryFromInput(chapterMemoryInput(entries, events, existingThreads, campaignFacts), entries);
}

/** The exact summarizer request for a chapter window. Frozen with the window so a
 * restart repeats the same request and reuses its checkpointed result. */
export function chapterMemoryInput(
	entries: StoryEntryRow[],
	events: StoryEventRow[],
	existingThreads: Array<typeof storyThreads.$inferSelect>,
	campaignFacts: CampaignStateFact[] = [],
): MemoryInput {
	const turns = selectCompletedChapterTurns(entries);
	if (turns.length !== CHAPTER_TURN_COUNT) throw new Error(`Chapter requires exactly ${CHAPTER_TURN_COUNT} completed turns.`);
	let previousEnd = -1;
	const pairedIds = new Set(turns.flatMap(turn => [turn.player.id, turn.narration.id]));
	const sources = turns.map(({ player, narration }) => {
		const supplemental = entries.filter(entry => !pairedIds.has(entry.id) && entry.position > previousEnd && entry.position <= narration.position);
		const evidence = [...supplemental, player, narration].sort((left, right) => left.position - right.position);
		previousEnd = narration.position;
		return { id: narration.id, text: evidence.map(entry => `[${entry.position}] [${entry.type}] [branch:${entry.branchId ?? 'primary'}] [POV:${JSON.stringify(asRecord(entry.metadata).parallelPov ?? asRecord(entry.metadata).narrativeMode ?? 'primary')}] ${entry.content}`).join('\n\n') };
	});
	return {
		storyId: entries[0].storyId, kind: 'chapter', sources, campaignFacts,
		evidence: [
			// Extracted/Director event prose can be wrong or describe future intent. It is not transcript history.
			events.filter(isNarrativeChapterEvent).map(event => JSON.stringify({ eventId: event.id, sourceEntryIds: event.sourceEntryIds, threadIds: event.threadIds })).join('\n'),
			`Existing thread catalog:\n${formatChapterThreadCatalog(existingThreads)}\nOptional threadChanges: [{threadId, action: advance|hold|stall|resolve|abandon, currentState, evidenceEventIds}]. Exact catalog IDs only. Resolve/abandon only with source event proof in this window. Optional newThreads: [{title,currentState,significance:minor|moderate|major|critical,evidenceEventIds}]. Never recreate a catalog thread. Accounts remain the priority.`,
		].filter(Boolean).join('\n\n'),
	};
}

export async function summarizeChapterMemoryFromInput(input: MemoryInput, entries: StoryEntryRow[]): Promise<ChapterMemoryDigest> {
	const generated = await generateChronologicalMemory(input);
	const first = entries[0];
	const last = entries[entries.length - 1];
	return {
		title: generated.title,
		summary: formatMtheriosMemorySummary({
			checkpoint: `Chapter covering ${CHAPTER_TURN_COUNT} completed turns, transcript positions ${first.position}-${last.position}.`,
			sourceCoverage: [`${CHAPTER_TURN_COUNT} completed turns; ${entries.length} narrative entries.`, `Transcript positions ${first.position}-${last.position}.`],
			currentScene: generated.endingScene || parseCurrentAnchor(entries, first, last),
			recentStoryNarrative: generated.narrative,
			characterStates: generated.characters,
			activeThreads: generated.openThreads,
			toneToContinue: 'Continue from the established ending situation and consequences.',
		}),
		keywords: uniqueStrings(generated.keywords),
		keyCharacters: generated.characters.map(character => character.name),
		keyLocations: generated.locations,
		plotThreads: generated.openThreads,
		emotionalTone: 'Continue the established scene.',
		source: 'llm', model: generated.model, sourceAccounts: generated.accounts, characterStates: generated.characters,
		campaignFactReview: generated.campaignFactReview,
		...coerceChapterThreadDirectives(generated),
	};
}

export interface ChapterThreadApplyResult {
	updatedThreadIds: string[];
	/** Changed after the chapter snapshot; the newer record is kept. */
	staleThreadIds: string[];
	insertedThreadIds: string[];
	closedThreadIds: string[];
	updatedEventIds: string[];
	staleEventIds: string[];
}

export async function persistChapterThreadPlan<T = ChapterThreadApplyResult>(input: {
	storyId: string;
	chapterId: string;
	chapterNumber: number;
	plan: ChapterThreadPlan;
	serverVersion: number;
	now: string;
	/** Runs in the same transaction, after the thread writes (receipts, dependent jobs). */
	afterApply?: (tx: ProcessorTransaction, applied: ChapterThreadApplyResult) => Promise<T>;
}): Promise<T | ChapterThreadApplyResult | null> {
	return getDb().transaction(async (tx) => {
		const [story] = await tx.select({ metadata: stories.metadata }).from(stories)
			.where(eq(stories.id, input.storyId)).for('update');
		if (!story) return null;
		const applied: ChapterThreadApplyResult = {
			updatedThreadIds: [], staleThreadIds: [], insertedThreadIds: [], closedThreadIds: [], updatedEventIds: [], staleEventIds: [],
		};
		const closedThreadIds = applied.closedThreadIds;
		for (const update of input.plan.updates) {
			const changed = await tx.update(storyThreads).set(update.values as Partial<typeof storyThreads.$inferInsert>).where(and(
				eq(storyThreads.storyId, input.storyId),
				eq(storyThreads.id, update.threadId),
				sql`coalesce(${storyThreads.closureReason}, '') not like '[player:%'`,
				// A plan applied after its snapshot never overwrites a newer thread edit.
				typeof update.expectedServerVersion === 'number' ? eq(storyThreads.serverVersion, update.expectedServerVersion) : undefined,
			)).returning({ id: storyThreads.id });
			if (changed.length) applied.updatedThreadIds.push(update.threadId);
			else if (typeof update.expectedServerVersion === 'number') applied.staleThreadIds.push(update.threadId);
			if (update.values.status === 'closed' && changed.length) closedThreadIds.push(update.threadId);
		}
		if (input.plan.inserts.length > 0) {
			const inserted = await tx.insert(storyThreads)
				.values(input.plan.inserts as Array<typeof storyThreads.$inferInsert>)
				.onConflictDoNothing()
				.returning({ id: storyThreads.id });
			applied.insertedThreadIds.push(...(inserted ?? []).map(row => row.id));
		}
		for (const event of input.plan.eventUpdates) {
			const changed = await tx.update(storyEvents).set({
				threadIds: event.threadIds,
				serverVersion: input.serverVersion,
				updatedAt: input.now,
			}).where(and(
				eq(storyEvents.storyId, input.storyId),
				eq(storyEvents.id, event.eventId),
				event.previousThreadIds ? sql`${storyEvents.threadIds} = ${JSON.stringify(event.previousThreadIds)}::jsonb` : undefined,
			)).returning({ id: storyEvents.id });
			if (changed.length) applied.updatedEventIds.push(event.eventId);
			else if (event.previousThreadIds) applied.staleEventIds.push(event.eventId);
		}
		const metadata = { ...asRecord(story.metadata) };
		const plotBrain = closeThreadPressure(metadata.plotBrain, input.storyId, closedThreadIds);
		for (const threadId of closedThreadIds) {
			const cancelled = await tx.update(storyEvents).set({
				status: 'cancelled', serverVersion: input.serverVersion, updatedAt: input.now,
			}).where(and(
				eq(storyEvents.storyId, input.storyId),
				inArray(storyEvents.status, ['scheduled', 'due']),
				sql`${storyEvents.threadIds} ? ${threadId}`,
			)).returning({ id: storyEvents.id });
			if (cancelled.length) await tx.delete(npcEventLinks).where(and(
				eq(npcEventLinks.storyId, input.storyId),
				inArray(npcEventLinks.eventId, cancelled.map((row) => row.id)),
			));
		}
		plotBrain.needsDevelopment = true;
		plotBrain.developmentChapterId = input.chapterId;
		plotBrain.developmentChapterNumber = input.chapterNumber;
		if (closedThreadIds.length) delete metadata.sceneCheckpoint;
		await tx.update(stories).set({
			metadata: { ...metadata, plotBrain },
			updatedAt: input.now,
		}).where(eq(stories.id, input.storyId));
		return input.afterApply ? input.afterApply(tx, applied) : applied;
	});
}

export async function upsertChapterMemoryNode(input: {
	db?: ProjectionWriter;
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
	sourceFingerprint: string;
	sourceStart: number;
	sourceEnd: number;
	branchIds: string[];
}): Promise<void> {
	const db = input.db ?? getDb();
	await db.insert(memoryNodes).values({
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
	metadata: {
			sourceType: 'terminal_chapter_job',
			jobId: input.jobId,
			projectionCompiler: CHAPTER_PROJECTION_COMPILER,
			projectionFingerprint: input.sourceFingerprint,
			campaignId: input.storyId,
			sourceStart: input.sourceStart,
			sourceEnd: input.sourceEnd,
			branchIds: input.branchIds,
			pov: 'primary',
		},
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
			metadata: {
				sourceType: 'terminal_chapter_job',
				jobId: input.jobId,
				projectionCompiler: CHAPTER_PROJECTION_COMPILER,
				projectionFingerprint: input.sourceFingerprint,
				campaignId: input.storyId,
				sourceStart: input.sourceStart,
				sourceEnd: input.sourceEnd,
				branchIds: input.branchIds,
				pov: 'primary',
			},
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		},
		setWhere: sql`${memoryNodes.serverVersion} <= excluded.server_version`,
	});
}

export function refreshChapterCharacterReferenceEvidence(input: {
	proposal: Pick<typeof patchProposals.$inferSelect, 'sourceEntryIds' | 'sourceEventIds' | 'metadata' | 'confidence'>;
	sourceEntryIds: string[];
	sourceEventIds: string[];
	chapterId: string;
	chapterNumber: number;
	confidence: number;
}) {
	const metadata = asRecord(input.proposal.metadata);
	const previousChapterNumber = Number(metadata.latestChapterNumber ?? metadata.chapterNumber ?? 0);
	return {
		sourceEntryIds: uniqueStrings([...input.proposal.sourceEntryIds, ...input.sourceEntryIds]),
		sourceEventIds: uniqueStrings([...input.proposal.sourceEventIds, ...input.sourceEventIds]),
		confidence: Math.max(input.proposal.confidence ?? 0, input.confidence),
		metadata: {
			...metadata,
			sourceChapterIds: uniqueStrings([...asStringArray(metadata.sourceChapterIds), ...(typeof metadata.chapterId === 'string' ? [metadata.chapterId] : []), input.chapterId]),
			latestChapterId: input.chapterNumber >= previousChapterNumber ? input.chapterId : metadata.latestChapterId ?? metadata.chapterId,
			latestChapterNumber: Math.max(previousChapterNumber, input.chapterNumber),
		},
	};
}

export async function createChapterCharacterReferenceProposals(input: {
	storyId: string;
	chapter: typeof chapters.$inferSelect;
	digest: ChapterMemoryDigest;
	events: StoryEventRow[];
	sourceEntryIds: string[];
	serverVersion: number;
	now: string;
	recurringNames?: string[];
}): Promise<Record<string, unknown>> {
	const db = getDb();
	const candidates = chapterCharacterReferenceCandidates({ digest: input.digest, events: input.events, recurringNames: input.recurringNames });
	let created = 0;
	let updated = 0;
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

		const refreshed = await db.transaction(async (tx) => {
			const [existingProposal] = await tx.select().from(patchProposals).where(and(
				eq(patchProposals.storyId, input.storyId),
				eq(patchProposals.proposalType, 'character_reference_review'),
				eq(patchProposals.targetRecordId, targetRecordId),
				eq(patchProposals.proposedBy, 'chapter_scribe'),
				inArray(patchProposals.status, ['pending', 'needs_review']),
			)).for('update');
			if (!existingProposal) return false;
			const evidence = refreshChapterCharacterReferenceEvidence({ proposal: existingProposal, sourceEntryIds: input.sourceEntryIds, sourceEventIds: candidate.sourceEventIds, chapterId: input.chapter.id, chapterNumber: input.chapter.number, confidence: candidate.confidence });
			if (JSON.stringify(evidence.sourceEntryIds) === JSON.stringify(existingProposal.sourceEntryIds) && JSON.stringify(evidence.sourceEventIds) === JSON.stringify(existingProposal.sourceEventIds) && evidence.confidence === existingProposal.confidence && JSON.stringify(evidence.metadata) === JSON.stringify(existingProposal.metadata)) return 'unchanged';
			const [version] = await tx.update(stories).set({ serverVersion: sql`${stories.serverVersion} + 1`, updatedAt: input.now }).where(eq(stories.id, input.storyId)).returning({ serverVersion: stories.serverVersion });
			await tx.update(patchProposals).set({ ...evidence, serverVersion: version?.serverVersion ?? input.serverVersion, updatedAt: input.now }).where(eq(patchProposals.id, existingProposal.id));
			return 'updated';
		});
		if (refreshed) {
			if (refreshed === 'updated') updated += 1;
			else skipped += 1;
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
				sourceChapterIds: [input.chapter.id],
			},
			serverVersion: input.serverVersion,
			createdAt: input.now,
			updatedAt: input.now,
		}).onConflictDoNothing().returning({ id: patchProposals.id });
		created += inserted ? 1 : 0;
		skipped += inserted ? 0 : 1;
	}

	return { candidates: candidates.length, created, updated, skipped };
}

export async function createChapterCharacterContextUpdateProposals(input: {
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

export function storedChapterMemoryDigest(chapter: ChapterRow): ChapterMemoryDigest {
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

export async function findChapterCharacterCandidates(storyId: string, chapterLimit = 8): Promise<Record<string, unknown>> {
	const db = getDb();
	const [story] = await db.select({ id: stories.id, serverVersion: stories.serverVersion }).from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);
	const chapterRows = await db.select().from(chapters).where(eq(chapters.storyId, storyId)).orderBy(desc(chapters.number)).limit(Math.max(1, Math.min(12, Math.floor(chapterLimit))));
	const namedChapters = chapterRows.filter((chapter) => {
		const metadata = asRecord(chapter.metadata);
		return metadata.visibility !== 'secret' && metadata.nonCanon !== true && metadata.non_canon !== true && metadata.superseded !== true;
	}).map((chapter) => ({ chapter, digest: storedChapterMemoryDigest(chapter) }));
	const appearances = new Map<string, { name: string; count: number }>();
	for (const { digest } of namedChapters) {
		const chapterNames = new Map(digest.keyCharacters.filter((value) => characterReferenceMentioned(digest.summary, value)).map((name) => [normalizedCharacterReference(name), name]));
		for (const name of chapterNames.values()) {
			const key = normalizedCharacterReference(name);
			const previous = appearances.get(key);
			appearances.set(key, { name, count: (previous?.count ?? 0) + 1 });
		}
	}
	const recurringNames = [...appearances.values()].filter((value) => value.count >= 2).map((value) => value.name);
	const result = { storyId, chaptersScanned: chapterRows.length, namedChapters: namedChapters.filter(({ digest }) => digest.keyCharacters.length > 0).length, candidates: 0, created: 0, updated: 0, skipped: 0 };
	for (const { chapter, digest } of [...namedChapters].reverse()) {
		if (!digest.keyCharacters.length) continue;
		const eventRows = chapter.sourceEventIds.length ? await db.select().from(storyEvents).where(and(eq(storyEvents.storyId, storyId), inArray(storyEvents.id, chapter.sourceEventIds), eq(storyEvents.status, 'committed'))) : [];
		const visibleEvents = eventRows.filter((event) => event.visibility !== 'secret' && asRecord(event.metadata).nonCanon !== true && asRecord(event.metadata).non_canon !== true && asRecord(event.metadata).superseded !== true);
		const saved = await createChapterCharacterReferenceProposals({ storyId, chapter, digest, events: visibleEvents, sourceEntryIds: chapter.sourceEntryIds, serverVersion: story.serverVersion, now: nowIso(), recurringNames });
		for (const key of ['candidates', 'created', 'updated', 'skipped'] as const) result[key] += Number(saved[key] ?? 0);
	}
	return { ...result, reason: result.namedChapters === 0 ? 'The saved chapters contain no named-character digest tags. No candidates were invented.' : result.candidates === 0 ? 'No recurring or sufficiently evidenced unresolved characters were found in these saved chapters.' : null };
}

export function selectChapterCharacterSourceEvidence(input: {
	entries: Array<typeof storyEntries.$inferSelect>;
	chapterSourceEntryIds: string[];
	proposalSourceEntryIds: string[];
	canonicalSourceEntryIds: string[];
}): Array<{ id: string; content: string }> {
	const chapterIds = new Set(input.chapterSourceEntryIds);
	const proposalIds = new Set(input.proposalSourceEntryIds);
	const canonicalIds = new Set(input.canonicalSourceEntryIds);
	const priority = (id: string) => chapterIds.has(id) ? 0 : proposalIds.has(id) ? 1 : 2;
	return filterNarrativeContextEntries(input.entries)
		.filter(entry => ['user_action', 'narration'].includes(entry.type)
			&& (chapterIds.has(entry.id) || proposalIds.has(entry.id) || canonicalIds.has(entry.id)))
		// The bounded refinement must see the newest chapter evidence before older
		// biography provenance; SQL row order must not choose which facts survive.
		.sort((a, b) => priority(a.id) - priority(b.id) || b.position - a.position)
		.slice(0, 32)
		.sort((a, b) => a.position - b.position)
		.map(entry => ({ id: entry.id, content: entry.content }));
}

export async function autoApplyChapterCharacterContextUpdates(input: {
	storyId: string;
	chapterNumber: number;
}): Promise<Record<string, unknown>> {
	const cadence = CHARACTER_CONTEXT_AUTO_APPLY_CHAPTER_INTERVAL;
	if (!shouldAutoApplyChapterCharacterContext(input.chapterNumber)) {
		return { applied: false, deferred: true, cadence };
	}

	// Keep one prior chapter eligible so an interrupted refresh can catch up.
	const windowStart = Math.max(1, input.chapterNumber - 1);
	const db = getDb();
	const proposals = await db.select({
		id: patchProposals.id,
		targetRecordId: patchProposals.targetRecordId,
		operations: patchProposals.operations,
		metadata: patchProposals.metadata,
		sourceEntryIds: patchProposals.sourceEntryIds,
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
	const candidateIds = [...new Set(eligibleProposals.map(proposal => proposal.targetRecordId).filter((id): id is string => !!id))];
	const canonicalRows = candidateIds.length ? await db.select().from(entities).where(and(eq(entities.storyId, input.storyId), inArray(entities.id, candidateIds))) : [];
	const canonicalById = new Map(canonicalRows.map(row => [row.id, row]));
	for (const proposal of eligibleProposals) {
		const canonical = canonicalById.get(proposal.targetRecordId);
		if (!canonical) continue;
		proposal.metadata = { ...asRecord(proposal.metadata), characterUpdateBaseVersion: canonical.serverVersion };
		await db.update(patchProposals).set({ metadata: proposal.metadata }).where(and(
			eq(patchProposals.storyId, input.storyId), eq(patchProposals.id, proposal.id),
			inArray(patchProposals.status, ['pending', 'needs_review']),
		));
	}
	const candidates = eligibleProposals.flatMap((proposal) => {
		const state = characterContextOperationState(proposal.operations);
		if (!proposal.targetRecordId || !state) return [];
		const metadata = asRecord(proposal.metadata);
		const canonical = canonicalById.get(proposal.targetRecordId);
		return [{
			entityId: proposal.targetRecordId,
			name: typeof metadata.characterName === 'string' && metadata.characterName.trim()
				? metadata.characterName.trim()
				: proposal.targetRecordId,
			state: { ...state, ...asRecord(canonical?.state) },
			description: canonical?.description,
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
				sourceEntryIds: chapters.sourceEntryIds,
			}).from(chapters).where(and(
				eq(chapters.storyId, input.storyId),
				inArray(chapters.number, [windowStart, input.chapterNumber]),
			)).orderBy(asc(chapters.number));
			const chapterSourceEntryIds = uniqueStrings(chapterRows.flatMap(chapter => chapter.sourceEntryIds));
			const proposalSourceEntryIds = uniqueStrings(eligibleProposals.flatMap(proposal => proposal.sourceEntryIds));
			const canonicalSourceEntryIds = uniqueStrings(canonicalRows.flatMap(row => [...(row.sourceEntryIds ?? []).slice(0, 2), ...(row.sourceEntryIds ?? []).slice(-2)])).slice(0, 32);
			const sourceIds = uniqueStrings([...chapterSourceEntryIds, ...proposalSourceEntryIds, ...canonicalSourceEntryIds]);
			const sourceRows = sourceIds.length ? await db.select().from(storyEntries)
				.where(and(eq(storyEntries.storyId, input.storyId), inArray(storyEntries.id, sourceIds))) : [];
			// Include linked actions in filtering even when only a narration is cited,
			// so an OOC answer cannot become character evidence through its parent.
			const loadedIds = new Set(sourceRows.map(entry => entry.id));
			const missingParentIds = uniqueStrings(sourceRows.map(entry => entry.parentId).filter((id): id is string => !!id && !loadedIds.has(id)));
			const parentRows = missingParentIds.length ? await db.select().from(storyEntries)
				.where(and(eq(storyEntries.storyId, input.storyId), inArray(storyEntries.id, missingParentIds))) : [];
			const sourceEvidence = selectChapterCharacterSourceEvidence({
				entries: [...sourceRows, ...parentRows], chapterSourceEntryIds, proposalSourceEntryIds, canonicalSourceEntryIds,
			});
			const refinement = await refineChapterCharacterUpdates({
				sourceEvidence,
				storyId: input.storyId,
				chapterWindow: [windowStart, input.chapterNumber],
				chapterEvidence: chapterRows.map((chapter) => ({
					number: chapter.number,
					title: chapter.title ?? `Chapter ${chapter.number}`,
					summary: [
						summarizeMtheriosMemoryForContext(chapter.sceneOutcome),
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
					confidence: update.confidence,
					operations: replaceCharacterContextOperationState(proposal.operations, {
						...characterContextOperationState(proposal.operations),
						...update.state,
					}),
					metadata: {
						...asRecord(proposal.metadata),
						characterUpdateServiceId: refinement.effectiveServiceId,
						characterUpdateModel: refinement.model,
						characterUpdatePromptChars: refinement.promptChars,
						characterUpdateEvidence: update.evidence,
						characterUpdateSourceIds: sourceEvidence.map(entry => entry.id),
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
	const chapterMemory = snippet(`Chapter ${input.chapterNumber}: ${characterSummary}`, 360);
	return {
		state: {
			eventMemory: { did: [chapterMemory] },
		},
		sourceEventIds: uniqueStrings(input.events.map((event) => event.id)),
		did: [chapterMemory],
		saw: [],
	};
}

import { applyChapterCharacterFollowUp, applyChapterThreadFollowUp, createChapterCheckpoint } from './chapterCheckpoint';
export { applyChapterCharacterFollowUp, applyChapterThreadFollowUp, createChapterCheckpoint };

type ArcSummaryChapter = Pick<ChapterRow, 'number' | 'title' | 'sceneOutcome' | 'irreversibleChanges' | 'promisesDebtsOaths' | 'openThreads' | 'metadata'>
	& Partial<Pick<ChapterRow, 'id' | 'npcKnowledgeChanges' | 'relationshipChanges' | 'sourceEntryIds' | 'sourceEventIds'>>;

export interface ArcMemoryFields {
	keyPlotPoints: string[];
	characterArcs: Array<{ name: string; development: string; sourceChapterIds: string[]; sourceEntryIds: string[]; sourceEventIds: string[] }>;
	unresolvedThreads: string[];
	emotionalProgression: string;
	trackedEntityIds: string[];
}

export function canonicalArcOpenThreadIds(
	arcChapters: Array<Pick<ChapterRow, 'metadata' | 'openThreads'>>,
	canonicalThreads: Array<Pick<typeof storyThreads.$inferSelect, 'id' | 'status'>>,
): string[] {
	const activeIds = new Set(canonicalThreads
		.filter(thread => thread.status !== 'closed' && thread.status !== 'abandoned')
		.map(thread => thread.id));
	return uniqueStrings(arcChapters.flatMap((chapter) => {
		const metadata = asRecord(chapter.metadata);
		return Array.isArray(metadata.openThreadIds)
			? asStringArray(metadata.openThreadIds)
			: asStringArray(chapter.openThreads);
	})).filter(id => activeIds.has(id));
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

function buildCharacterArcFields(arcChapters: ArcSummaryChapter[]): ArcMemoryFields['characterArcs'] {
	const byName = new Map<string, Array<{ text: string; chapter: ArcSummaryChapter; structured: boolean }>>();
	for (const chapter of arcChapters) {
		const add = (name: string, text: string, structured = false) => {
			if (!name.trim() || !text.trim()) return;
			byName.set(name, [...(byName.get(name) ?? []), { text: compactWhitespace(text), chapter, structured }]);
		};
		for (const raw of chapter.npcKnowledgeChanges ?? []) {
			const change = asRecord(raw);
			const name = [change.npcName, change.npc, change.name, change.entityId, change.npcEntityId, change.npcId]
				.find((value): value is string => typeof value === 'string' && Boolean(value.trim())) ?? 'NPC knowledge';
			const detail = [change.learned, change.knows, change.npcLearned, change.knowledge, change.fact, change.change]
				.flatMap((value) => typeof value === 'string' ? [value] : asStringArray(value)).join('; ');
			// Imported knowledge records have varied keys. Keep unrecognized data
			// attributable instead of inventing an actor or silently dropping it.
			add(name.trim(), detail ? `learned ${detail}` : JSON.stringify(change), true);
		}
		for (const change of asStringArray(chapter.relationshipChanges)) add('Relationships', change, true);
		const section = extractMtheriosSummarySection(chapter.sceneOutcome, 'CHARACTER STATE');
		let currentName = '';
		let currentBullets: string[] = [];
		const flush = () => {
			const development = compactWhitespace(currentBullets.join(' '));
			if (!currentName || !development) return;
			add(currentName, development);
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
		.sort(([, a], [, b]) => Number(b.some((item) => item.structured)) - Number(a.some((item) => item.structured)))
		.map(([name, developments]) => {
			const seen = new Set<string>();
			const selected = developments.sort((a, b) => Number(b.structured) - Number(a.structured) || b.chapter.number - a.chapter.number)
				.filter((item) => {
					if (seen.has(item.text)) return false;
					seen.add(item.text);
					return true;
				}).slice(0, 4);
			return {
				name,
				development: selected.map((item) => `Chapter ${item.chapter.number}: ${item.text}`).join(' '),
				sourceChapterIds: uniqueStrings(selected.flatMap((item) => item.chapter.id ? [item.chapter.id] : [])),
				sourceEntryIds: uniqueStrings(selected.flatMap((item) => asStringArray(item.chapter.sourceEntryIds))),
				sourceEventIds: uniqueStrings(selected.flatMap((item) => asStringArray(item.chapter.sourceEventIds))),
			};
		})
		.filter((item) => item.name && item.development)
		.slice(0, 16);
}

export function buildArcMemoryFields(arcChapters: ArcSummaryChapter[]): ArcMemoryFields {
	const keyPlotPoints = arcChapters
		.map((chapter) => {
			const digest = summarizeMtheriosMemoryForRollup(chapter.sceneOutcome) || chapter.sceneOutcome;
			if (!digest) return '';
			return `Chapter ${chapter.number}${chapter.title ? ` (${chapter.title})` : ''}: ${digest}`;
		})
		.filter(Boolean);
	const unresolvedThreads = uniqueStrings(arcChapters.flatMap((chapter) => [
		...asStringArray(chapter.irreversibleChanges),
		...asStringArray(chapter.promisesDebtsOaths),
		...asStringArray(chapter.openThreads),
		...sectionLines(extractMtheriosSummarySection(chapter.sceneOutcome, 'ACTIVE THREADS')),
	].map((value) => cleanArcThreadLine(value)))).slice(0, ARC_ROLLUP_THREAD_LIMIT);
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
	return [
		`Arc overview:\n${arcChapters.map(chapter => summarizeMtheriosMemoryForRollup(chapter.sceneOutcome)).join('\n\n')}`,
		fields.unresolvedThreads.length ? `Open threads:\n${fields.unresolvedThreads.map(thread => `- ${thread}`).join('\n')}` : '',
		fields.characterArcs.length ? `Character movement:\n${fields.characterArcs.map(arc => `- ${arc.name}: ${arc.development}`).join('\n')}` : '',
	].filter(Boolean).join('\n\n');
}

export async function summarizeArcMemoryWithLlm(storyId: string, arcChapters: ChapterRow[]) {
	if (arcChapters.length !== CHAPTERS_PER_ARC || arcChapters.some((chapter, index) => index > 0 && chapter.number !== arcChapters[index - 1].number + 1)) {
		throw new Error(`Arc requires ${CHAPTERS_PER_ARC} consecutive chapters.`);
	}
	const generated = await generateChronologicalMemory({ storyId, kind: 'arc', sources: arcChapters.map(chapterSourceForArc) });
	const sourceChapterIds = arcChapters.map(chapter => chapter.id);
	const sourceEntryIds = uniqueStrings(arcChapters.flatMap(chapter => chapter.sourceEntryIds));
	const sourceEventIds = uniqueStrings(arcChapters.flatMap(chapter => chapter.sourceEventIds));
	const fields: ArcMemoryFields = {
		keyPlotPoints: generated.accounts.map(account => account.summary),
		characterArcs: generated.characters.map(character => ({ name: character.name, development: character.bullets.join(' '), sourceChapterIds, sourceEntryIds, sourceEventIds })),
		unresolvedThreads: generated.openThreads,
		emotionalProgression: '',
		trackedEntityIds: uniqueStrings(arcChapters.flatMap(chapter => asStringArray(asRecord(chapter.metadata).trackedEntityIds))),
	};
	const summary = [
		`Arc overview:\n${generated.narrative}`,
		generated.characters.length ? `Character movement:\n${generated.characters.map(character => `${character.name}: ${character.bullets.join(' ')}`).join('\n')}` : '',
		generated.openThreads.length ? `Open threads:\n${generated.openThreads.map(thread => `- ${thread}`).join('\n')}` : '',
	].filter(Boolean).join('\n\n');
	return { title: generated.title, summary, model: generated.model, fields, sourceAccounts: generated.accounts };
}

export async function upsertArcMemoryNode(input: {
	db?: ProjectionWriter;
	storyId: string;
	arcId: string;
	title: string;
	summary: string;
	chapterIds: string[];
	sourceEntryIds: string[];
	entityIds: string[];
	sourceEventIds: string[];
	openThreadIds: string[];
	serverVersion: number;
	now: string;
	jobId: string;
	sourceFingerprint: string;
	sourceStart: number;
	sourceEnd: number;
	branchIds: string[];
}): Promise<void> {
	const db = input.db ?? getDb();
	await db.insert(memoryNodes).values({
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
		sourceEntryIds: input.sourceEntryIds,
		sourceEventIds: input.sourceEventIds,
		sourcePatchIds: [],
		metadata: {
			sourceType: 'terminal_arc_job',
			jobId: input.jobId,
			chapterIds: input.chapterIds,
			projectionCompiler: ARC_PROJECTION_COMPILER,
			projectionFingerprint: input.sourceFingerprint,
			campaignId: input.storyId,
			sourceStart: input.sourceStart,
			sourceEnd: input.sourceEnd,
			branchIds: input.branchIds,
			pov: 'primary',
		},
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
			sourceEntryIds: input.sourceEntryIds,
			sourceEventIds: input.sourceEventIds,
			metadata: {
				sourceType: 'terminal_arc_job',
				jobId: input.jobId,
				chapterIds: input.chapterIds,
				projectionCompiler: ARC_PROJECTION_COMPILER,
				projectionFingerprint: input.sourceFingerprint,
				campaignId: input.storyId,
				sourceStart: input.sourceStart,
				sourceEnd: input.sourceEnd,
				branchIds: input.branchIds,
				pov: 'primary',
			},
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		},
		setWhere: sql`${memoryNodes.serverVersion} <= excluded.server_version`,
	});
}

export async function rollupArc(
	job: BackendJobRow,
	recorder?: TimingRecorder,
	options: { enqueuePlotBrain?: boolean } = {},
): Promise<Record<string, unknown>> {
	const chaptersPerArc = CHAPTERS_PER_ARC;
	const db = getDb();
	const [chapterRows, arcRows, canonicalThreadRows] = await timePhase(recorder, 'job.rollup_arc.load_context', { chaptersPerArc }, () => Promise.all([
		db.select().from(chapters).where(eq(chapters.storyId, job.storyId)).orderBy(asc(chapters.number)),
		db.select().from(arcs).where(eq(arcs.storyId, job.storyId)).orderBy(asc(arcs.number)),
		db.select({ id: storyThreads.id, status: storyThreads.status }).from(storyThreads).where(eq(storyThreads.storyId, job.storyId)),
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

	const createdArcs: Array<{ arcId: string; number: number; chapterCount: number; sagaJobId: string; plotBrainJobId: string | null }> = [];
	for (const arcChapters of batches) {
		const first = arcChapters[0];
		const last = arcChapters[arcChapters.length - 1];
		const chapterIds = arcChapters.map((chapter) => chapter.id);
		const arcId = stableId('arc', [first.id, last.id]);
		const generated = await summarizeArcMemoryWithLlm(job.storyId, arcChapters);
		const { title, summary, fields } = generated;
		const sourceEntryIds = uniqueStrings(arcChapters.flatMap((chapter) => asStringArray(chapter.sourceEntryIds)));
		const sourceEventIds = uniqueStrings(arcChapters.flatMap((chapter) => asStringArray(chapter.sourceEventIds)));
		const branchIds = uniqueStrings(arcChapters.flatMap((chapter) => asStringArray(asRecord(chapter.metadata).branchIds)));
		const sourceStart = Math.min(...arcChapters.map((chapter) => asNumber(asRecord(chapter.metadata).startPosition, Number.MAX_SAFE_INTEGER)));
		const sourceEnd = Math.max(...arcChapters.map((chapter) => asNumber(asRecord(chapter.metadata).endPosition, 0)));
		const sourceFingerprint = projectionFingerprint({
			compiler: ARC_PROJECTION_COMPILER,
			campaignId: job.storyId,
			chapterIds,
			sourceEntryIds,
			sourceEventIds,
			chapterFingerprints: arcChapters.map((chapter) => asRecord(chapter.metadata).projectionFingerprint ?? null),
		});
		const openThreadIds = canonicalArcOpenThreadIds(arcChapters, canonicalThreadRows);
		const chaptersStillMatch = await timePhase(recorder, 'job.rollup_arc.revalidate_chapters', {
			chapters: arcChapters.length,
		}, () => projectionChaptersStillMatch(job.storyId, arcChapters));
		if (!chaptersStillMatch) {
			return {
				created: false,
				reason: 'projection_dependencies_changed',
				uncoveredChapters: uncovered.length,
				chaptersPerArc,
			};
		}
		const now = nowIso();
		const serverVersion = await timePhase(recorder, 'job.rollup_arc.bump_version', {}, () => bumpStoryVersion(job.storyId));
		const metadata = {
			sourceType: 'terminal_arc_job',
			summarySource: 'llm',
			summaryModel: generated.model,
			sourceAccounts: generated.sourceAccounts,
			jobId: job.id,
			projectionCompiler: ARC_PROJECTION_COMPILER,
			projectionFingerprint: sourceFingerprint,
			campaignId: job.storyId,
			sourceStart: Number.isFinite(sourceStart) ? sourceStart : null,
			sourceEnd,
			branchIds,
			pov: 'primary',
			sourceEntryIds,
			chapterCount: arcChapters.length,
			startChapterNumber: first.number,
			endChapterNumber: last.number,
			keyPlotPoints: fields.keyPlotPoints,
			characterArcs: fields.characterArcs,
			unresolvedThreads: fields.unresolvedThreads,
			emotionalProgression: fields.emotionalProgression,
			trackedEntityIds: fields.trackedEntityIds,
		};

		const [arc] = await timePhase(recorder, 'job.rollup_arc.persist_projection', {
			chapterCount: arcChapters.length,
		}, () => db.transaction(async (tx) => {
			await tx.select({ id: stories.id }).from(stories).where(eq(stories.id, job.storyId)).for('update');
			// Another rollup may have completed while this batch was being summarized.
			const currentArcs = await tx.select({ number: arcs.number, chapterIds: arcs.chapterIds }).from(arcs).where(eq(arcs.storyId, job.storyId));
			const currentCoverage = new Set(currentArcs.flatMap(arc => asStringArray(arc.chapterIds)));
			if (chapterIds.some(id => currentCoverage.has(id))) return [];
			const number = currentArcs.reduce((latest, arc) => Math.max(latest, arc.number), 0) + 1;
			const currentChapters = await tx.select().from(chapters).where(and(eq(chapters.storyId, job.storyId), inArray(chapters.id, chapterIds)));
			if (currentChapters.length !== arcChapters.length || arcChapters.some(chapter => {
				const current = currentChapters.find(row => row.id === chapter.id);
				return !current || current.sceneOutcome !== chapter.sceneOutcome || current.serverVersion !== chapter.serverVersion;
			})) return [];

			const [savedArc] = await tx.insert(arcs).values({
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
				createdAt: now,
				updatedAt: now,
			}).onConflictDoNothing().returning();
			if (!savedArc) return [];
			await upsertArcMemoryNode({
				db: tx,
				storyId: job.storyId,
				arcId,
				title,
				summary,
				chapterIds,
				sourceEntryIds,
				entityIds: fields.trackedEntityIds,
				sourceEventIds,
				openThreadIds,
				serverVersion,
				now,
				jobId: job.id,
				sourceFingerprint,
				sourceStart: Number.isFinite(sourceStart) ? sourceStart : 0,
				sourceEnd,
				branchIds,
			});
			// Dependent work commits with the arc; a retry finds the arc covered and
			// would otherwise never queue the saga or Director review again.
			const sagaJobId = await enqueueBackendJob({
				storyId: job.storyId,
				type: 'rollup_saga',
				dedupeKey: `saga-rollup-${savedArc.id}`,
				payload: { sourceArcIds: [savedArc.id], sourceJobId: job.id },
				maxAttempts: 3,
				requeueExisting: false,
			}, tx);
			const plotBrainJobId = options.enqueuePlotBrain === false ? null : await enqueuePlotBrainJob({
				storyId: job.storyId,
				trigger: 'arc_created',
				scopeId: savedArc.id,
			}, tx);
			return [{ ...savedArc, sagaJobId, plotBrainJobId }];
		}));
		if (!arc) continue;
		createdArcs.push({ arcId: arc.id, number: arc.number, chapterCount: arcChapters.length, sagaJobId: arc.sagaJobId, plotBrainJobId: arc.plotBrainJobId });
	}
	if (createdArcs.length === 0) return { created: false, reason: 'projection_superseded' };

	const firstArc = createdArcs[0];
	const latestArc = createdArcs[createdArcs.length - 1];
	const plotBrainJobId = latestArc.plotBrainJobId;
	const sagaJobId = latestArc.sagaJobId;
	return {
		created: true,
		arcId: firstArc.arcId,
		number: firstArc.number,
		chapterCount: firstArc.chapterCount,
		arcCount: createdArcs.length,
		arcs: createdArcs,
		plotBrainJobId,
		sagaJobId,
	};
}

type SagaSummaryArc = Pick<ArcRow, 'id' | 'number' | 'title' | 'summary' | 'chapterIds' | 'sourceEventIds' | 'openThreadIds' | 'metadata'>;

export interface SagaMemoryFields {
	keyFactionShifts: string[];
	majorPowerChanges: string[];
	lingeringThreads: string[];
	overallTone: string;
	trackedEntityIds: string[];
}

export function selectSagaRollupBatches<T extends { id: string }>(
	arcRows: T[],
	sagaRows: Array<{ arcIds: string[] }>,
	arcsPerSaga = SAGA_ROLLUP_ARCS,
): T[][] {
	const covered = new Set(sagaRows.flatMap((saga) => asStringArray(saga.arcIds)));
	const uncovered = arcRows.filter((arc) => !covered.has(arc.id));
	const batches: T[][] = [];
	for (let index = 0; index + arcsPerSaga <= uncovered.length; index += arcsPerSaga) {
		batches.push(uncovered.slice(index, index + arcsPerSaga));
	}
	return batches;
}

export function buildSagaMemoryFields(sagaArcs: SagaSummaryArc[]): SagaMemoryFields {
	const metadataRows = sagaArcs.map((arc) => asRecord(arc.metadata));
	const keyFactionShifts = uniqueStrings(metadataRows.flatMap((metadata) => asStringArray(metadata.keyFactionShifts))).slice(0, 24);
	const majorPowerChanges = uniqueStrings(metadataRows.flatMap((metadata) => asStringArray(metadata.majorPowerChanges))).slice(0, 24);
	const lingeringThreads = uniqueStrings(sagaArcs.flatMap((arc) => [
		...asStringArray(arc.openThreadIds),
		...asStringArray(asRecord(arc.metadata).unresolvedThreads),
	])).slice(0, 32);
	const tones = uniqueStrings(metadataRows.flatMap((metadata) => typeof metadata.emotionalProgression === 'string' ? [metadata.emotionalProgression] : [])).slice(0, 12);
	return {
		keyFactionShifts,
		majorPowerChanges,
		lingeringThreads,
		overallTone: tones.length ? tones.join(' -> ') : 'Carry forward the consequences, power shifts, and unresolved threads established by these arcs.',
		trackedEntityIds: uniqueStrings(metadataRows.flatMap((metadata) => asStringArray(metadata.trackedEntityIds))).slice(0, 32),
	};
}

export function buildSagaSummary(sagaArcs: SagaSummaryArc[]): string {
	const fields = buildSagaMemoryFields(sagaArcs);
	const overview = sagaArcs.map((arc) => `Arc ${arc.number} (${arc.title}): ${arc.summary}`).join(' ');
	const sections = [
		`Saga overview:\n${arcSummarySnippet(overview, 1600)}`,
		fields.keyFactionShifts.length ? `Faction shifts:\n${fields.keyFactionShifts.slice(0, 8).map((item) => `- ${arcSummarySnippet(item, 180)}`).join('\n')}` : '',
		fields.majorPowerChanges.length ? `Power changes:\n${fields.majorPowerChanges.slice(0, 8).map((item) => `- ${arcSummarySnippet(item, 180)}`).join('\n')}` : '',
		fields.lingeringThreads.length ? `Lingering threads:\n${fields.lingeringThreads.slice(0, 10).map((item) => `- ${arcSummarySnippet(item, 180)}`).join('\n')}` : '',
		`Tone to carry forward:\n${arcSummarySnippet(fields.overallTone, 320)}`,
	];
	return sections.join('\n\n');
}

export async function upsertSagaMemoryNode(input: {
	db?: ProjectionWriter;
	storyId: string;
	sagaId: string;
	title: string;
	summary: string;
	arcIds: string[];
	sourceEntryIds: string[];
	sourceEventIds: string[];
	openThreadIds: string[];
	entityIds: string[];
	serverVersion: number;
	now: string;
	jobId: string;
	sourceFingerprint: string;
	sourceStart: number;
	sourceEnd: number;
}): Promise<void> {
	const db = input.db ?? getDb();
	const metadata = {
		sourceType: 'terminal_saga_job',
		jobId: input.jobId,
		arcIds: input.arcIds,
		projectionCompiler: SAGA_PROJECTION_COMPILER,
		projectionFingerprint: input.sourceFingerprint,
		campaignId: input.storyId,
		sourceStart: input.sourceStart,
		sourceEnd: input.sourceEnd,
		pov: 'primary',
	};
	await db.insert(memoryNodes).values({
		id: `mem_saga_${input.sagaId}`,
		storyId: input.storyId,
		type: 'plot_ledger',
		title: input.title,
		content: input.summary,
		summary: input.summary,
		keywords: ['saga', 'terminal_rollup'],
		entityIds: input.entityIds,
		factionIds: [],
		threadIds: input.openThreadIds,
		locationId: null,
		visibility: 'player_known',
		importance: 0.86,
		sourceEntryIds: input.sourceEntryIds,
		sourceEventIds: input.sourceEventIds,
		sourcePatchIds: [],
		metadata,
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
			sourceEntryIds: input.sourceEntryIds,
			sourceEventIds: input.sourceEventIds,
			metadata,
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		},
		setWhere: sql`${memoryNodes.serverVersion} <= excluded.server_version`,
	});
}

async function rollupSaga(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const db = getDb();
	const [arcRows, sagaRows, canonicalThreadRows] = await timePhase(recorder, 'job.rollup_saga.load_context', { arcsPerSaga: SAGA_ROLLUP_ARCS }, () => Promise.all([
		db.select().from(arcs).where(eq(arcs.storyId, job.storyId)).orderBy(asc(arcs.number)).limit(200),
		 db.select().from(sagas).where(eq(sagas.storyId, job.storyId)).orderBy(asc(sagas.number)).limit(100),
		db.select({ id: storyThreads.id, status: storyThreads.status }).from(storyThreads).where(eq(storyThreads.storyId, job.storyId)),
	]));
	const coveredSagaArcs = new Set(sagaRows.flatMap((saga) => asStringArray(saga.arcIds)));
	const uncoveredArcs = arcRows.filter((arc) => !coveredSagaArcs.has(arc.id));
	const batches = selectSagaRollupBatches(arcRows, sagaRows, SAGA_ROLLUP_ARCS);
	if (batches.length === 0) return { created: false, reason: 'saga_threshold_not_met', uncoveredArcs: uncoveredArcs.length, arcsPerSaga: SAGA_ROLLUP_ARCS };

	const createdSagas: Array<{ sagaId: string; number: number; arcCount: number }> = [];
	for (const sagaArcs of batches) {
		const first = sagaArcs[0];
		const last = sagaArcs[sagaArcs.length - 1];
		const arcIds = sagaArcs.map((arc) => arc.id);
		const sagaId = stableId('saga', [first.id, last.id]);
		const [existing] = await db.select().from(sagas).where(and(eq(sagas.storyId, job.storyId), eq(sagas.id, sagaId))).limit(1);
		const number = existing?.number ?? ((sagaRows[sagaRows.length - 1]?.number ?? 0) + createdSagas.length + 1);
		const title = `Saga ${number}: ${first.title} to ${last.title}`;
		const fields = buildSagaMemoryFields(sagaArcs);
		const summary = buildSagaSummary(sagaArcs);
		const sourceEntryIds = uniqueStrings(sagaArcs.flatMap((arc) => asStringArray(asRecord(arc.metadata).sourceEntryIds))).slice(0, 500);
		const sourceEventIds = uniqueStrings(sagaArcs.flatMap((arc) => asStringArray(arc.sourceEventIds))).slice(0, 500);
		const sourceStart = Math.min(...sagaArcs.map((arc) => asNumber(asRecord(arc.metadata).sourceStart, Number.MAX_SAFE_INTEGER)));
		const sourceEnd = Math.max(...sagaArcs.map((arc) => asNumber(asRecord(arc.metadata).sourceEnd, 0)));
		const sourceFingerprint = projectionFingerprint({
			compiler: SAGA_PROJECTION_COMPILER,
			campaignId: job.storyId,
			arcIds,
			arcFingerprints: sagaArcs.map((arc) => asRecord(arc.metadata).projectionFingerprint ?? null),
		});
		const activeThreadIds = new Set(canonicalThreadRows.filter((thread) => thread.status !== 'closed' && thread.status !== 'abandoned').map((thread) => thread.id));
		const openThreadIds = uniqueStrings(sagaArcs.flatMap((arc) => arc.openThreadIds)).filter((threadId) => activeThreadIds.has(threadId));
		const arcsStillMatch = await timePhase(recorder, 'job.rollup_saga.revalidate_arcs', {
			arcs: sagaArcs.length,
		}, () => projectionArcsStillMatch(job.storyId, sagaArcs));
		if (!arcsStillMatch) {
			return {
				created: false,
				reason: 'projection_dependencies_changed',
				uncoveredArcs: uncoveredArcs.length,
				arcsPerSaga: SAGA_ROLLUP_ARCS,
			};
		}
		const now = nowIso();
		const serverVersion = await timePhase(recorder, 'job.rollup_saga.bump_version', {}, () => bumpStoryVersion(job.storyId));
		const metadata = {
			sourceType: 'terminal_saga_job',
			jobId: job.id,
			projectionCompiler: SAGA_PROJECTION_COMPILER,
			projectionFingerprint: sourceFingerprint,
			campaignId: job.storyId,
			sourceStart: Number.isFinite(sourceStart) ? sourceStart : null,
			sourceEnd,
			pov: 'primary',
			trackedEntityIds: fields.trackedEntityIds,
		};
		const [saga] = await timePhase(recorder, 'job.rollup_saga.persist_projection', { arcCount: sagaArcs.length }, () => db.transaction(async (tx) => {
			const [savedSaga] = await tx.insert(sagas).values({
				id: sagaId,
				storyId: job.storyId,
				number,
				title,
				summary,
				arcIds,
				keyFactionShifts: fields.keyFactionShifts,
				majorPowerChanges: fields.majorPowerChanges,
				lingeringThreads: fields.lingeringThreads,
				overallTone: fields.overallTone,
				sourceEventIds,
				openThreadIds,
				metadata,
				serverVersion,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			}).onConflictDoUpdate({
				target: sagas.id,
				set: { number, title, summary, arcIds, keyFactionShifts: fields.keyFactionShifts, majorPowerChanges: fields.majorPowerChanges, lingeringThreads: fields.lingeringThreads, overallTone: fields.overallTone, sourceEventIds, openThreadIds, metadata, serverVersion, updatedAt: now },
				setWhere: sql`${sagas.serverVersion} <= excluded.server_version`,
			}).returning();
			if (savedSaga) await upsertSagaMemoryNode({
				db: tx,
				storyId: job.storyId,
				sagaId: savedSaga.id,
				title,
				summary,
				arcIds,
				sourceEntryIds,
				sourceEventIds,
				openThreadIds,
				entityIds: fields.trackedEntityIds,
				serverVersion,
				now,
				jobId: job.id,
				sourceFingerprint,
				sourceStart: Number.isFinite(sourceStart) ? sourceStart : 0,
				sourceEnd,
			});
			return [savedSaga];
		}));
		if (!saga) continue;
		createdSagas.push({ sagaId: saga.id, number: saga.number, arcCount: sagaArcs.length });
	}
	if (createdSagas.length === 0) return { created: false, reason: 'projection_superseded' };
	return { created: true, sagaId: createdSagas[0].sagaId, number: createdSagas[0].number, arcCount: createdSagas[0].arcCount, sagas: createdSagas };
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
		autoIndex: config.wikiAutoIndexStoryVaults,
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
	if (typeof result.failed === 'number' && result.failed > 0) {
		throw new Error(`Canonical indexing failed for ${result.failed} record${result.failed === 1 ? '' : 's'} in ${result.collection}.`);
	}
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

export async function prepareBatchTurnMemory(jobs: BackendJobRow[]): Promise<Map<string, ServerGenerationResult> | null> {
	if (jobs.length < 2 || jobs.length > 5 || jobs.some(job => job.type !== 'extract_turn_state' || job.attemptCount !== 1)) return null;
	const storyId = jobs[0].storyId;
	if (jobs.some(job => job.storyId !== storyId || deferredExtractionAppliedReceipt(job))) return null;
	const sources: BatchTurnSource[] = [];
	for (const job of jobs) {
		const payload = asRecord(job.payload);
		const playerEntryId = typeof payload.playerEntryId === 'string' ? payload.playerEntryId : '';
		const assistantEntryId = typeof payload.assistantEntryId === 'string' ? payload.assistantEntryId : '';
		const playerText = typeof payload.playerText === 'string' ? payload.playerText : '';
		const narration = typeof payload.narration === 'string' ? payload.narration : '';
		if (!playerEntryId || !assistantEntryId || !narration || playerText.length + narration.length > 5_000) return null;
		const pair = await loadDeferredExtractionSourcePair({ storyId, playerEntryId, assistantEntryId, playerText, narration });
		const assistant = pair.entries.find(entry => entry.id === assistantEntryId);
		if (pair.error || !assistant || typeof assistant.position !== 'number' || assistant.branchId || asRecord(assistant.metadata).narrativeMode === 'parallel_pov') return null;
		sources.push({ assistantEntryId, playerText, narration, position: assistant.position });
	}
	const [latest] = await getDb().select({ position: storyEntries.position }).from(storyEntries)
		.where(and(eq(storyEntries.storyId, storyId), eq(storyEntries.type, 'narration')))
		.orderBy(desc(storyEntries.position)).limit(1);
	if (!latest || sources.some(source => source.position >= latest.position)) return null;
	sources.sort((a, b) => a.position - b.position);
	if (sources.reduce((total, source) => total + source.playerText.length + source.narration.length, 0) > 15_000) return null;
	const combinedText = sources.map(source => `${source.playerText}\n${source.narration}`).join('\n');
	const [classifierService, characters, agreements, locations, factions, story] = await Promise.all([
		resolveServiceGeneration('classifier'), loadCanonicalCharacters(storyId),
		loadClassifierAgreements(storyId, combinedText), loadClassifierLocations(storyId),
		loadClassifierFactions(storyId), getDb().select({ metadata: stories.metadata }).from(stories).where(eq(stories.id, storyId)).limit(1),
	]);
	if (classifierService.setting?.enabled === false) return null;
	const profile = classifierService.profile;
	const generation = classifierService.generation;
	if (!profile) return null;
	const sharedContext = [
		buildCharacterCreationInstructions(factions, combinedText), campaignStateExtractionContext(story[0]?.metadata),
		buildClassifierCharacterContext(characters, combinedText, combinedText),
		buildClassifierAgreementContext(agreements), buildClassifierLocationContext(locations, combinedText),
	].filter(Boolean).join('\n\n');
	const prompt = buildBatchTurnMemoryPrompt(sources, sharedContext);
	if (countTokens(prompt) > 12_000) return null;
	let generated: ServerGenerationResult | null = null;
	try {
		generated = await generateServerTextWithMetrics({ profile, model: generation.model,
			temperature: 0, maxTokens: Math.min(8192, classifierGenerationMaxTokens(generation) * sources.length),
			reasoningEffort: generation.reasoningEffort ?? 'off',
			system: 'You are Memory & Context. Return complete, source-separated strict JSON only.',
			prompt, responseFormat: 'json_object', maxRetries: 0,
			onAttempt: attempt => recordGenerationApiCalls({ storyId, serviceId: 'classifier', operation: 'job.extract_turn_state.batch',
				profile, result: generationAttemptResult(attempt), status: attempt.status, error: attempt.error ?? undefined,
				metadata: { assistantEntryIds: sources.map(source => source.assistantEntryId), sourceCount: sources.length, parseOutcome: 'not_started' } }),
		});
		const parsed = parseBatchTurnMemoryResult(generated.text, sources.map(source => source.assistantEntryId));
		await recordGenerationApiCalls({ storyId, serviceId: 'classifier', operation: 'job.extract_turn_state.batch',
			profile, result: generated, status: 'success',
			metadata: { assistantEntryIds: sources.map(source => source.assistantEntryId), sourceCount: sources.length } });
		return new Map(jobs.map(job => {
			const assistantEntryId = String(asRecord(job.payload).assistantEntryId);
			const text = parsed.get(assistantEntryId)!;
			return [job.id, { ...reuseGenerationResult(generated!, { operation: 'job.extract_turn_state.batch' }), text, responseChars: text.length }];
		}));
	} catch (error) {
		const failedResult = generationErrorResult(error) ?? generated;
		if (failedResult) await recordGenerationApiCalls({ storyId, serviceId: 'classifier', operation: 'job.extract_turn_state.batch',
			profile, result: failedResult, status: 'error', error,
			metadata: { assistantEntryIds: sources.map(source => source.assistantEntryId), sourceCount: sources.length } });
		throw error;
	}
}

export async function extractTurnState(job: BackendJobRow, recorder?: TimingRecorder, prefetched?: ServerGenerationResult): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const priorReceipt = deferredExtractionAppliedReceipt(job);
	if (priorReceipt) {
		return {
			status: 'already_applied',
			...priorReceipt,
		};
	}
	const playerEntryId = requirePayloadString(payload, 'playerEntryId');
	const assistantEntryId = requirePayloadString(payload, 'assistantEntryId');
	const playerText = requirePayloadString(payload, 'playerText');
	const narration = requirePayloadString(payload, 'narration');
	const dueEventCandidates = z.array(dueEventCandidateSchema).max(16).catch([]).parse(payload.dueEventCandidates);
	const factionCue = z.object({ cardId: z.string(), sourceKey: z.string(), sceneKey: z.string(),
		title: z.string(), logline: z.string(), mode: z.enum(['ambient', 'direct']).optional() }).strict().safeParse(payload.factionCue);
	const sourceFingerprint = typeof payload.sourceFingerprint === 'string'
		? payload.sourceFingerprint
		: turnStateSourceFingerprint(playerText, narration);
	const validateSources = () => loadDeferredExtractionSourcePair({
		storyId: job.storyId,
		playerEntryId,
		assistantEntryId,
		playerText,
		narration,
	});
	const initialSources = await timePhase(recorder, 'job.extract_turn_state.validate_sources', {}, validateSources);
	if (initialSources.error) {
		return { status: 'skipped_source_invalid', reason: initialSources.error, operationCount: 0 };
	}
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
	if (!dueEventCandidates.length && !shouldExtractDurableState(playerText, narration)) {
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
	// The Classifier role never borrows the GameMaster model implicitly.
	const useNarrativeFallback = false;
	const classifierProfile = classifierService.profile;
	if (!classifierProfile) throw new Error(classifierService.missingReason ?? 'Model configuration needed: Classifier is unavailable.');
	const classifierGeneration = classifierService.generation;
	const classifierMaxTokens = classifierGenerationMaxTokens(classifierGeneration);
	const classifierSystem = classifierService.systemPromptOverride?.trim() || DEFAULT_STATE_EXTRACTION_SYSTEM;
	const stateExtractionResponseSchema = buildStateExtractionResponseSchema();
	const classifierCharacters = await loadCanonicalCharacters(job.storyId);
	const classifierAgreements = await loadClassifierAgreements(job.storyId, `${playerText}\n${narration}`);
	const classifierLocations = await loadClassifierLocations(job.storyId);
	const classifierFactions = await loadClassifierFactions(job.storyId);
	const [campaignStory] = await getDb().select({ metadata: stories.metadata }).from(stories).where(eq(stories.id, job.storyId)).limit(1);
	const extractionPlan = buildDeferredStateExtractionPrompt({
		campaignMetadata: campaignStory?.metadata,
		characters: classifierCharacters,
		agreements: classifierAgreements,
		locations: classifierLocations,
		factions: classifierFactions,
		dueEventCandidates,
		playerText,
		narration,
		responseSchema: stateExtractionResponseSchema.schema,
		attemptCount: job.attemptCount,
		lastError: job.lastError,
	});
	const initialGeneration = extractionPlan.compactRecovery
		? classifierRepairGeneration(classifierGeneration, { finishReason: 'length' })
		: { maxTokens: classifierMaxTokens, reasoningEffort: classifierGeneration.reasoningEffort ?? 'off' };
	let extractionPrompt = extractionPlan.prompt;
	let extractionSystem = extractionPlan.compactRecovery
		? `${classifierSystem}\nRecover the prior invalid extraction. Return strict JSON only.`
		: classifierSystem;
	const effectiveServiceId = 'classifier';
	const responseFormat = getProviderCapabilities(classifierProfile, classifierGeneration.model).structuredOutputs
		? 'json_schema'
		: 'json_object';
	const logMetadata = {
		configuredServiceId: 'classifier',
		effectiveServiceId,
		legacyNarrativeFallback: useNarrativeFallback,
		maxOutputTokens: initialGeneration.maxTokens,
		responseFormat,
		responseSchemaName: 'mtherios_state_patch',
		compactRecovery: extractionPlan.compactRecovery,
	};
	let attemptNumber = 1;
	let attemptLogged = false;
	const logAttempt = async (options: Parameters<typeof logDeferredStateExtractionCall>[0]) => {
		if (attemptLogged) return;
		await logDeferredStateExtractionCall({ ...options, metadata: {
			...options.metadata,
			extractionAttempt: attemptNumber,
			extractionAttemptKind: attemptNumber === 1 ? 'initial' : 'json_repair',
		} });
		attemptLogged = true;
	};
	const recordProviderAttempt = (attempt: ServerGenerationAttempt) => logDeferredStateExtractionCall({
		job, clientTurnId, profile: classifierProfile, result: generationAttemptResult(attempt),
		status: attempt.status, error: attempt.error ?? undefined,
		metadata: { ...logMetadata, extractionAttempt: attemptNumber,
			extractionAttemptKind: attemptNumber === 1 ? 'initial' : 'json_repair',
			parseOutcome: 'not_started', applyOutcome: 'not_started' },
	});
	let extractionResult: ServerGenerationResult;
	try {
		extractionResult = prefetched ?? await timePhase(recorder, 'job.extract_turn_state.llm', {
			serviceId: 'classifier',
			effectiveServiceId,
			model: classifierGeneration.model ?? null,
		}, () => generateServerTextWithMetrics({
			profile: classifierProfile,
			model: classifierGeneration.model,
			temperature: classifierGeneration.temperature,
			maxTokens: initialGeneration.maxTokens,
			reasoningEffort: initialGeneration.reasoningEffort,
			system: extractionSystem,
			prompt: extractionPrompt,
			responseSchema: stateExtractionResponseSchema,
			onAttempt: recordProviderAttempt,
		}));
	} catch (error) {
		const failedResult = generationErrorResult(error);
		if (failedResult) {
			await timePhase(recorder, 'job.extract_turn_state.log_error', {
				statusCode: failedResult.statusCode ?? null,
			}, () => logAttempt({
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
						system: extractionSystem,
						prompt: extractionPrompt,
					}),
				},
			}));
		}
		throw error;
	}
	const postGenerationSources = await timePhase(recorder, 'job.extract_turn_state.revalidate_sources_after_generation', {}, validateSources);
	if (postGenerationSources.error) {
		await logAttempt({ job, clientTurnId, profile: classifierProfile, result: extractionResult,
			status: 'success', metadata: { ...logMetadata, parseOutcome: 'not_started', applyOutcome: 'skipped_source_invalid', reason: postGenerationSources.error } });
		return { status: 'skipped_source_invalid', reason: postGenerationSources.error, operationCount: 0, chapterSummaryJobId };
	}

	let parsedUpdate: ReturnType<typeof parseStateExtractionResult> | null = null;
	let applyStarted = false;
	try {
		try {
			parsedUpdate = timePhaseSync(recorder, 'job.extract_turn_state.parse_update', {}, () => parseStateExtractionResult(extractionResult.text));
		} catch (validationError) {
			if (prefetched) throw validationError;
			if (extractionPlan.compactRecovery) throw validationError;
			await logAttempt({ job, clientTurnId, profile: classifierProfile, result: extractionResult,
				status: 'error', error: validationError, metadata: {
					...logMetadata, parseOutcome: 'error', applyOutcome: 'not_started', repairPlanned: true,
					debugSnapshot: buildTurnDebugSnapshot({ kind: 'state_extraction', playerText,
						system: extractionSystem, prompt: extractionPrompt, output: extractionResult.text }),
				} });
			const repairSources = await timePhase(recorder, 'job.extract_turn_state.revalidate_sources_before_repair', {}, validateSources);
			if (repairSources.error) {
				return { status: 'skipped_source_invalid', reason: repairSources.error, operationCount: 0, chapterSummaryJobId };
			}
			extractionPrompt = buildStateExtractionRepairPrompt({
				campaignMetadata: campaignStory?.metadata,
				dueEventCandidates,
				characters: classifierCharacters,
				agreements: classifierAgreements,
				locations: classifierLocations,
				factions: classifierFactions,
				playerText,
				narration,
				attemptedOutput: extractionResult.text,
				validationError: validationError instanceof Error ? validationError.message : String(validationError),
			});
			extractionSystem = `${classifierSystem}\nRepair invalid extraction JSON. Return strict JSON only.`;
			const repairGeneration = classifierRepairGeneration(classifierGeneration, extractionResult);
			logMetadata.maxOutputTokens = repairGeneration.maxTokens;
			logMetadata.compactRecovery = true;
			attemptNumber += 1;
			try {
				extractionResult = await timePhase(recorder, 'job.extract_turn_state.llm_repair', {
					serviceId: 'classifier',
					effectiveServiceId,
					model: classifierGeneration.model ?? null,
				}, () => generateServerTextWithMetrics({
					profile: classifierProfile,
					model: classifierGeneration.model,
					temperature: 0,
					maxTokens: repairGeneration.maxTokens,
					maxRetries: 0,
					reasoningEffort: repairGeneration.reasoningEffort,
					system: extractionSystem,
					prompt: extractionPrompt,
					responseSchema: stateExtractionResponseSchema,
					onAttempt: recordProviderAttempt,
				}));
			} catch (repairError) {
				const failedResult = generationErrorResult(repairError);
				if (failedResult) {
					attemptLogged = false;
					await logAttempt({ job, clientTurnId, profile: classifierProfile, result: failedResult,
						status: 'error', error: repairError, metadata: {
							...logMetadata, parseOutcome: 'not_started', applyOutcome: 'not_started',
							debugSnapshot: buildTurnDebugSnapshot({ kind: 'state_extraction', playerText,
								system: extractionSystem, prompt: extractionPrompt }),
						} });
				}
				throw repairError;
			}
			attemptLogged = false;
			const repairedSources = await timePhase(recorder, 'job.extract_turn_state.revalidate_sources_after_repair', {}, validateSources);
			if (repairedSources.error) {
				await logAttempt({ job, clientTurnId, profile: classifierProfile, result: extractionResult,
					status: 'success', metadata: { ...logMetadata, parseOutcome: 'not_started', applyOutcome: 'skipped_source_invalid', reason: repairedSources.error } });
				return { status: 'skipped_source_invalid', reason: repairedSources.error, operationCount: 0, chapterSummaryJobId };
			}
			parsedUpdate = timePhaseSync(recorder, 'job.extract_turn_state.parse_repaired_update', {}, () => parseStateExtractionResult(extractionResult.text));
		}
		const realDueEventCandidates = dueEventCandidates.filter(candidate => !isFactionCueCandidate(candidate.id));
		const feedbackAppliedEventIds = realDueEventCandidates.length ? await applyDueEventFeedback({
			storyId: job.storyId, assistantEntryId, playerText, narration, sourceFingerprint,
			currentTurn: timelineTurn ?? 0, candidates: realDueEventCandidates,
			feedback: parsedUpdate.dueEventFeedback,
		}) : [];
		if (factionCue.success && dueEventCandidates.some(candidate => isFactionCueCandidate(candidate.id))) {
			await applyFactionCueFeedback({ storyId: job.storyId, assistantEntryId, playerText, narration,
				sourceFingerprint, cue: factionCue.data, feedback: parsedUpdate.dueEventFeedback });
		}
		if (parsedUpdate.operationCount === 0) {
			await timePhase(recorder, 'job.extract_turn_state.log_success', {}, () => logAttempt({
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
						system: extractionSystem,
						prompt: extractionPrompt,
						output: extractionResult.text,
					}),
				},
			}));
			return { status: feedbackAppliedEventIds.length ? 'event_feedback_applied' : 'no_changes',
				operationCount: 0, eventIds: feedbackAppliedEventIds, chapterSummaryJobId };
		}

		applyStarted = true;
		const serializedApply = await timePhase(recorder, 'job.extract_turn_state.serialized_apply', {
			operationCount: parsedUpdate.operationCount,
		}, () => getDb().transaction(async (tx) => {
			await tx.execute(deferredExtractionStoryLockSql(job.storyId));
			const [currentJob] = await tx.select({
				status: backendJobs.status,
				lockedAt: backendJobs.lockedAt,
				lockedBy: backendJobs.lockedBy,
				metadata: backendJobs.metadata,
			}).from(backendJobs)
				.where(and(eq(backendJobs.id, job.id), eq(backendJobs.storyId, job.storyId)))
				.for('update')
				.limit(1);
			if (!currentJob
				|| currentJob.status !== 'running'
				|| currentJob.lockedAt !== job.lockedAt
				|| currentJob.lockedBy !== job.lockedBy) {
				throw new Error(`Deferred extraction job claim was lost before apply: ${job.id}`);
			}
			const currentReceipt = deferredExtractionAppliedReceipt({ metadata: currentJob.metadata, payload: job.payload });
			if (currentReceipt) return { alreadyApplied: currentReceipt } as const;
			const persistApplyReceipt = async (receipt: Omit<DeferredExtractionAppliedReceipt, 'appliedAt'>) => {
				const appliedAt = nowIso();
				const storedReceipt: DeferredExtractionAppliedReceipt = { ...receipt, appliedAt };
				const [marked] = await tx.update(backendJobs).set({
					metadata: {
						...asRecord(currentJob.metadata),
						deferredExtractionApplyReceipt: storedReceipt,
					},
					updatedAt: appliedAt,
				}).where(and(
					eq(backendJobs.id, job.id),
					eq(backendJobs.status, 'running'),
					job.lockedAt === null ? isNull(backendJobs.lockedAt) : eq(backendJobs.lockedAt, job.lockedAt),
					job.lockedBy === null ? isNull(backendJobs.lockedBy) : eq(backendJobs.lockedBy, job.lockedBy),
				)).returning({ id: backendJobs.id });
				if (!marked) throw new Error(`Deferred extraction job claim was lost while recording apply: ${job.id}`);
				return storedReceipt;
			};
			const [story] = await tx.select({ serverVersion: stories.serverVersion })
				.from(stories)
				.where(eq(stories.id, job.storyId))
				.for('update')
				.limit(1);
			if (!story) throw new Error(`Story not found: ${job.storyId}`);

			const applySources = await loadDeferredExtractionSourcePair({
				storyId: job.storyId,
				playerEntryId,
				assistantEntryId,
				playerText,
				narration,
			}, tx, true);
			if (applySources.error) {
				return { sourceError: applySources.error } as const;
			}
			const sourcePosition = applySources.entries.find((entry) => entry.id === assistantEntryId)?.position;
			if (typeof sourcePosition !== 'number') {
				return { sourceError: 'source_entry_position_missing' } as const;
			}
			const [laterNarration] = await tx.select({ id: storyEntries.id })
				.from(storyEntries)
				.where(and(
					eq(storyEntries.storyId, job.storyId),
					eq(storyEntries.type, 'narration'),
					gt(storyEntries.position, sourcePosition),
					sql`coalesce(${storyEntries.metadata}->>'nonCanon', 'false') <> 'true'`,
					sql`coalesce(${storyEntries.metadata}->>'actionType', '') <> 'ooc'`,
					sql`coalesce(${storyEntries.metadata}->>'narrativeMode', '') <> 'ooc'`,
				))
				.orderBy(asc(storyEntries.position))
				.limit(1);
			const suppressedTransientState = Boolean(laterNarration);
			const update = suppressedTransientState
				? preserveDurableDeferredState(parsedUpdate!.update)
				: parsedUpdate!.update;
			if (!deferredStateUpdateHasOperations(update)) {
				const applied = {
					eventIds: [] as string[],
					patchIds: [] as string[],
					memoryNodeIds: [] as string[],
					warnings: [] as string[],
				};
				if (suppressedTransientState) applied.warnings.push(DEFERRED_STALE_TRANSIENT_WARNING);
				await persistApplyReceipt({
					assistantEntryId,
					serverVersion: story.serverVersion,
					operationCount: 0,
					suppressedTransientState,
					noChanges: true,
					sourceFingerprint,
					...applied,
				});
				return {
					serverVersion: story.serverVersion,
					applied,
					suppressedTransientState,
					noChanges: true,
				} as const;
			}

			const [versionRow] = await tx.update(stories).set({
				serverVersion: sql`${stories.serverVersion} + 1`,
				updatedAt: nowIso(),
			}).where(eq(stories.id, job.storyId)).returning({ serverVersion: stories.serverVersion });
			if (!versionRow) throw new Error(`Story not found while applying deferred state: ${job.storyId}`);
			const applied = await applyValidatedTurnUpdate({
				storyId: job.storyId,
				playerEntryId,
				assistantEntryId,
				narration: suppressedTransientState ? '' : narration,
				update,
				parseWarnings: parsedUpdate!.warnings,
				retrievedMemoryIds: asStringArray(payload.retrievedMemoryIds),
				serverVersion: versionRow.serverVersion,
				mode: 'supplemental',
				timelineTurn,
				suppressCurrentNpcAgency: suppressedTransientState,
				memorySettings,
			}, {
				transaction: tx,
				enqueueProjectionJobs: false,
			});
			if (suppressedTransientState) applied.warnings.push(DEFERRED_STALE_TRANSIENT_WARNING);
			if (applied.eventIds.length > 0 || applied.memoryNodeIds.length > 0 || applied.patchIds.length > 0) {
				await enqueueTurnProjectionJobs({
					storyId: job.storyId,
					eventIds: applied.eventIds,
					memoryNodeIds: applied.memoryNodeIds,
					patchIds: applied.patchIds,
					serverVersion: versionRow.serverVersion,
					chapterDedupeKey: `chapter-summary-${assistantEntryId}`,
					memorySettings,
				}, tx);
			}
			await persistApplyReceipt({
				assistantEntryId,
				serverVersion: versionRow.serverVersion,
				operationCount: parsedUpdate!.operationCount,
				suppressedTransientState,
				noChanges: false,
				eventIds: applied.eventIds,
				patchIds: applied.patchIds,
				memoryNodeIds: applied.memoryNodeIds,
				warnings: applied.warnings,
				sourceFingerprint,
			});
			return {
				serverVersion: versionRow.serverVersion,
				applied,
				suppressedTransientState,
				noChanges: false,
			} as const;
		}));
		if ('alreadyApplied' in serializedApply) {
			await logAttempt({ job, clientTurnId, profile: classifierProfile, result: extractionResult,
				status: 'success', metadata: { ...logMetadata, parseOutcome: 'valid', applyOutcome: 'already_applied' } });
			return {
				status: 'already_applied',
				...serializedApply.alreadyApplied,
				chapterSummaryJobId,
			};
		}
		if ('sourceError' in serializedApply) {
			await logAttempt({ job, clientTurnId, profile: classifierProfile, result: extractionResult,
				status: 'success', metadata: { ...logMetadata, parseOutcome: 'valid', applyOutcome: 'skipped_source_invalid', reason: serializedApply.sourceError } });
			return { status: 'skipped_source_invalid', reason: serializedApply.sourceError, operationCount: 0, chapterSummaryJobId };
		}
		const { applied, serverVersion, suppressedTransientState, noChanges } = serializedApply;
		await timePhase(recorder, 'job.extract_turn_state.log_success', {}, () => logAttempt({
			job,
			clientTurnId,
			profile: classifierProfile,
			result: extractionResult,
			status: 'success',
			metadata: {
				...logMetadata,
				parseOutcome: 'valid',
				applyOutcome: noChanges ? 'no_changes' : 'applied',
				operationCount: noChanges ? 0 : parsedUpdate!.operationCount,
				suppressedTransientState,
				appliedEventCount: applied.eventIds.length,
				appliedPatchCount: applied.patchIds.length,
				appliedMemoryNodeCount: applied.memoryNodeIds.length,
				applyWarningCount: applied.warnings.length,
				finishReason: extractionResult.finishReason ?? null,
				reasoningTokens: extractionResult.usage.reasoningTokens ?? null,
				debugSnapshot: buildTurnDebugSnapshot({
					kind: 'state_extraction',
					playerText,
					system: extractionSystem,
					prompt: extractionPrompt,
					output: extractionResult.text,
				}),
			},
		}));
		return {
			status: noChanges ? 'no_changes' : 'applied',
			serverVersion,
			operationCount: noChanges ? 0 : parsedUpdate.operationCount,
			...(noChanges ? { skipped: 'later_turn_transient_state' } : {}),
			suppressedTransientState,
			parseWarnings: parsedUpdate.warnings.length,
			warnings: applied.warnings,
			eventIds: applied.eventIds,
			patchIds: applied.patchIds,
			memoryNodeIds: applied.memoryNodeIds,
			chapterSummaryJobId,
		};
	} catch (error) {
		await timePhase(recorder, 'job.extract_turn_state.log_error', {}, () => logAttempt({
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
					system: extractionSystem,
					prompt: extractionPrompt,
					output: extractionResult.text,
				}),
			},
		}));
		throw error;
	}
}

export function plotBrainJobSkipReason(
	lifecycle: Pick<PlotBrainLifecycleState, 'fresh' | 'hasPendingFrame' | 'hasStoredPendingFrame' | 'quiet'>,
	skipIfPlanned: boolean,
	wakeQuietPeriod = false,
): 'already_planned' | 'pending_frame' | 'quiet_period' | null {
	if (lifecycle.hasPendingFrame) return 'pending_frame';
	if (lifecycle.quiet && !wakeQuietPeriod) return 'quiet_period';
	if (skipIfPlanned && lifecycle.fresh) return 'already_planned';
	return null;
}

export function stalePlotBrainPendingFrameId(metadataValue: unknown, serverVersion: number): string | null {
	const plotBrain = asRecord(asRecord(metadataValue).plotBrain);
	const pendingFrameId = typeof plotBrain.pendingFrameId === 'string' ? plotBrain.pendingFrameId.trim() : '';
	const frameId = typeof asRecord(plotBrain.pendingFrame).id === 'string' ? String(asRecord(plotBrain.pendingFrame).id).trim() : '';
	if (!pendingFrameId || frameId !== pendingFrameId) return null;
	const baseVersion = typeof plotBrain.pendingBaseServerVersion === 'number' && Number.isFinite(plotBrain.pendingBaseServerVersion)
		? Math.floor(plotBrain.pendingBaseServerVersion)
		: null;
	return baseVersion === serverVersion ? null : pendingFrameId;
}

export function plotBrainJobIsSuperseded(
	job: Pick<BackendJobRow, 'id' | 'payload'>,
	currentTurn: number,
): boolean {
	const payload = asRecord(job.payload);
	if (payload.trigger !== 'scheduled_refresh') return false;
	const idTurn = /(?:^|_)turn_(\d+)$/.exec(job.id)?.[1];
	const scheduledForTurn = typeof payload.scheduledForTurn === 'number' && Number.isFinite(payload.scheduledForTurn)
		? Math.max(0, Math.floor(payload.scheduledForTurn))
		: idTurn
			? Number(idTurn)
			: null;
	return scheduledForTurn !== null && scheduledForTurn < Math.max(0, Math.floor(currentTurn));
}

async function planPlotBrain(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
 return reviewGardener(job.storyId);
}

async function processBackendJob(job: BackendJobRow, recorder?: TimingRecorder, prefetched?: ServerGenerationResult): Promise<Record<string, unknown>> {
	const type = job.type as BackendJobType;
	return timePhase(recorder, `job.${type}.total`, {
		attemptCount: job.attemptCount,
		maxAttempts: job.maxAttempts,
	}, async () => {
		switch (type) {
			case 'create_memory_nodes_from_events':
			case 'rebuild_retrieval_projection': {
				const projection = await createMemoryNodesFromEvents(job);
				return { materializedEventMemories: projection.created, ...projection };
			}
			case 'update_faction_pressure':
				return updateFactionPressure(job, recorder);
			case 'embed_memory_nodes':
				return embedMemoryNodes(job);
			case 'rebuild_summaries': {
				const { rebuildStorySummaries } = await import('./summaryRebuild');
				return rebuildStorySummaries(job);
			}
			case 'summarize_chapter':
				return createChapterCheckpoint(job, recorder);
			case 'chapter_threads':
				return applyChapterThreadFollowUp(job, recorder);
			case 'chapter_characters':
				return applyChapterCharacterFollowUp(job, recorder);
			case 'refresh_scene_checkpoint':
				return refreshSceneCheckpoint(job.storyId);
			case 'rollup_arc':
				return rollupArc(job, recorder);
			case 'rollup_saga':
				return rollupSaga(job, recorder);
			case 'evaluate_world_sim_tick':
				return evaluateWorldSimTick(job, recorder);
			case 'evaluate_npc_background_action':
 return { status: 'held', reason: 'individual_portrayal_owned_by_main_gm' };
			case 'index_canonical_records':
				return indexCanonicalRecordsJob(job);
			case 'sync_story_vault':
				return syncStoryVault(job, recorder);
			case 'extract_turn_state':
				return extractTurnState(job, recorder, prefetched);
			case 'continuity_audit':
				// Retired: nothing reads its warnings. Older queued rows complete without work.
				return { status: 'retired' };
			case 'plan_plot_brain':
				return planPlotBrain(job, recorder);
			default:
				throw new Error(`Unknown backend job type: ${job.type}`);
		}
	});
}

function jobTimingReport(job: AnyBackendJobRow, status: BackendJobTimingReport['status'], phases: TimingEntry[]): BackendJobTimingReport {
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

async function runClaimedJob(job: AnyBackendJobRow, prefetched?: ServerGenerationResult, batchError?: unknown): Promise<{
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
	const campaignJob = job.storyId ? { ...job, storyId: job.storyId } : null;
	try {
		publishBackendJobStatus(job, 'running');
		if (batchError) throw batchError;
		if (job.type === 'extract_turn_state' && campaignJob) await reconcileDeferredExtractionReceipt(campaignJob, 'running');
		const result = job.type === 'generate_image' ? await processImageJob(job)
			: job.type === 'assistant_batch_child' ? await processAssistantBatchJob(job)
			: campaignJob ? await processBackendJob(campaignJob, recorder, prefetched)
				: job.type === 'validate_agent_settings' ? await validateProjectAgentSettings(job.projectId)
					: (() => { throw new Error('Campaign job requires a game.'); })();
		await timePhase(recorder, 'job.mark_complete', {}, () => markBackendJobComplete(job));
		if (job.type === 'extract_turn_state' && campaignJob) {
			await reconcileDeferredExtractionReceipt(campaignJob, deferredExtractionTerminalReceiptStatus(result), { result });
		}
		publishBackendJobStatus(job, 'completed', { result });
		return {
			completed: true,
			result,
			timing: jobTimingReport(job, 'completed', recorder.timings),
		};
	} catch (error) {
		const message = describeBackendJobError(error);
		await timePhase(recorder, 'job.mark_failed', { error: message }, () => markBackendJobFailed(job, error));
		if (job.type === 'extract_turn_state' && campaignJob) {
			await reconcileDeferredExtractionReceipt(campaignJob, job.attemptCount >= job.maxAttempts ? 'failed' : 'queued', { error: message });
		}
		publishBackendJobStatus(job, 'failed', { error: message });
		return {
			completed: false,
			error: message,
			timing: jobTimingReport(job, 'failed', recorder.timings),
		};
	}
}

export async function runDueBackendJobs(workerId = `worker_${Date.now()}`, limit = 10, storyId?: string | null, types?: readonly BackendJobType[], projectId?: string): Promise<{
	claimed: number;
	completed: number;
	failed: Array<{ jobId: string; error: string }>;
	timings: BackendJobTimingReport[];
}> {
	const jobs = await claimBackendJobs(workerId, limit, storyId, projectId, types);
	const failed: Array<{ jobId: string; error: string }> = [];
	const timings: BackendJobTimingReport[] = [];
	let completed = 0;
	const byStory = new Map<string, AnyBackendJobRow[]>();
	let batchLane = 0;
	for (const job of jobs) {
		const key = job.type === 'assistant_batch_child' ? `assistant-batch-lane:${batchLane++ % 2}` : job.storyId ?? `project:${job.projectId}`;
		const group = byStory.get(key) ?? [];
		group.push(job);
		byStory.set(key, group);
	}
	const concurrency = readGenerationConcurrency();
	await mapWithConcurrency([...byStory.values()], concurrency, async (storyJobs) => {
		for (let index = 0; index < storyJobs.length;) {
			const group: AnyBackendJobRow[] = [];
			for (const job of storyJobs.slice(index, index + 5)) {
				if (job.type !== 'extract_turn_state' || !job.storyId) break;
				group.push(job);
			}
			let prefetched: Map<string, ServerGenerationResult> | null = null;
			let batchError: unknown = null;
			if (group.length >= 2) {
				try { prefetched = await prepareBatchTurnMemory(group as BackendJobRow[]); }
				catch (error) { batchError = error; }
			}
			const selected = prefetched || batchError ? group : [storyJobs[index]];
			for (const job of selected) {
				const result = await runClaimedJob(job, prefetched?.get(job.id), batchError);
				timings.push(result.timing);
				if (result.completed) completed += 1;
				else failed.push({ jobId: job.id, error: result.error ?? 'unknown error' });
			}
			index += selected.length;
		}
	});
	return { claimed: jobs.length, completed, failed, timings };
}

export function backendJobManualClaimWhere(jobId: string, claimedAt: string) {
	return and(
		eq(backendJobs.id, jobId),
		inArray(backendJobs.status, ['queued', 'retry']),
		sql`coalesce(${backendJobs.payload}->>'execution','') <> 'api'`,
		lte(backendJobs.runAfter, claimedAt),
		lt(backendJobs.attemptCount, backendJobs.maxAttempts),
		isNull(backendJobs.lockedAt),
		isNull(backendJobs.lockedBy),
	)!;
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
	}).where(backendJobManualClaimWhere(jobId, claimedAt)).returning();
	if (!job) {
		throw new Error(`Backend job is not runnable or was claimed by another worker: ${jobId}`);
	}

	const result = await runClaimedJob(job);
	return {
		jobId: job.id,
		completed: result.completed,
		result: result.result,
		error: result.error,
		timings: result.timing,
	};
}

export async function getBackendJobStats(storyId?: string | null, projectId?: string): Promise<BackendJobStats> {
	const filters = storyId ? [eq(backendJobs.storyId, storyId)] : [];
	if (projectId) filters.push(eq(backendJobs.projectId, projectId));
	const db = getDb();
	const [rows, storyRows] = await Promise.all([db
		.select({
			id: backendJobs.id,
			storyId: backendJobs.storyId,
			projectId: backendJobs.projectId,
			type: backendJobs.type,
			status: backendJobs.status,
			attemptCount: backendJobs.attemptCount,
			maxAttempts: backendJobs.maxAttempts,
			runAfter: backendJobs.runAfter,
			lockedAt: backendJobs.lockedAt,
			lockedBy: backendJobs.lockedBy,
			lastError: backendJobs.lastError,
			payload: backendJobs.payload,
			metadata: backendJobs.metadata,
			createdAt: backendJobs.createdAt,
			updatedAt: backendJobs.updatedAt,
		})
		.from(backendJobs)
		.where(filters.length > 0 ? and(...filters) : undefined),
		db.select({ id: stories.id, metadata: stories.metadata })
			.from(stories)
			.where(storyId ? eq(stories.id, storyId) : projectId ? eq(stories.shelfId, projectId) : undefined),
	]);
	const latestSuccessfulAt = new Map<string, string>();
	for (const story of storyRows) {
		const lastPlanAt = asRecord(asRecord(story.metadata).plotBrain).lastPlanAt;
		if (typeof lastPlanAt === 'string' && Number.isFinite(Date.parse(lastPlanAt))) {
			latestSuccessfulAt.set(`${story.id}:plan_plot_brain`, lastPlanAt);
		}
	}

	const stats = summarizeBackendJobs(rows, latestSuccessfulAt);
	if (!storyId) return { ...stats, providerCooldownMs: Math.max(getProviderCooldownRemainingMs(), getJevCooldownRemainingMs()) };
	const [entries, extractionJobs] = await Promise.all([
		db.select({
			id: storyEntries.id,
			type: storyEntries.type,
			content: storyEntries.content,
			position: storyEntries.position,
			parentId: storyEntries.parentId,
			metadata: storyEntries.metadata,
			serverVersion: storyEntries.serverVersion,
		}).from(storyEntries).where(eq(storyEntries.storyId, storyId)).orderBy(asc(storyEntries.position)),
		db.select({
			status: backendJobs.status,
			createdAt: backendJobs.createdAt,
			updatedAt: backendJobs.updatedAt,
			lastError: backendJobs.lastError,
			payload: backendJobs.payload,
		}).from(backendJobs).where(and(eq(backendJobs.storyId, storyId), eq(backendJobs.type, 'extract_turn_state'))),
	]);
	return {
		...stats,
		providerCooldownMs: Math.max(getProviderCooldownRemainingMs(), getJevCooldownRemainingMs()),
		memoryCoverage: deriveMemoryCoverage(entries, extractionJobs),
	};
}

export async function recoverMemoryCoverage(input: { storyId: string; limit?: number; order?: 'oldest' | 'recent' }): Promise<Record<string, unknown>> {
	const limit = Math.max(1, Math.min(25, Math.trunc(input.limit ?? 1)));
	const db = getDb();
	const [entries, jobs, story] = await Promise.all([
		db.select({
			id: storyEntries.id,
			type: storyEntries.type,
			content: storyEntries.content,
			position: storyEntries.position,
			parentId: storyEntries.parentId,
			metadata: storyEntries.metadata,
			serverVersion: storyEntries.serverVersion,
		}).from(storyEntries).where(eq(storyEntries.storyId, input.storyId)).orderBy(asc(storyEntries.position)),
		db.select({
			status: backendJobs.status,
			createdAt: backendJobs.createdAt,
			updatedAt: backendJobs.updatedAt,
			lastError: backendJobs.lastError,
			payload: backendJobs.payload,
		}).from(backendJobs).where(and(eq(backendJobs.storyId, input.storyId), eq(backendJobs.type, 'extract_turn_state'))),
		db.select({ serverVersion: stories.serverVersion }).from(stories).where(eq(stories.id, input.storyId)).limit(1),
	]);
	const gaps = findMemoryCoverageGaps(entries, jobs);
	const recoverable = gaps.filter((gap) => gap.reason === 'missing' || gap.reason === 'outdated');
	const queued: Array<Record<string, unknown>> = [];
	const ordered = input.order === 'recent' ? [...recoverable].reverse() : recoverable;
	for (const gap of ordered.slice(0, limit)) {
		if (!gap.player) continue;
		const metadata = asRecord(gap.assistant.metadata);
		const clientTurnId = typeof metadata.clientTurnId === 'string' && metadata.clientTurnId.trim()
			? metadata.clientTurnId.trim()
			: gap.assistant.id.replace(/^narration_/, '');
		const jobId = await enqueueTurnStateExtractionJob({
			storyId: input.storyId,
			playerEntryId: gap.player.id,
			assistantEntryId: gap.assistant.id,
			playerText: gap.player.content,
			narration: gap.assistant.content,
			clientTurnId,
			timelineTurn: typeof metadata.timelineTurn === 'number' ? Math.max(0, Math.trunc(metadata.timelineTurn)) : Math.max(0, Math.floor(gap.assistant.position / 2)),
			serverVersion: gap.assistant.serverVersion ?? story[0]?.serverVersion ?? 0,
			retrievedMemoryIds: Array.isArray(metadata.retrievedMemoryIds) ? metadata.retrievedMemoryIds.filter((value): value is string => typeof value === 'string') : [],
			memorySettings: asRecord(metadata.memorySettings) as { chapterThreshold?: number; postChapterBuffer?: number; chaptersPerArc?: number },
		});
		queued.push({ assistantEntryId: gap.assistant.id, position: gap.assistant.position, jobId, reason: gap.reason });
	}
	return {
		ok: true,
		storyId: input.storyId,
		order: input.order ?? 'oldest',
		inspectedGaps: gaps.length,
		recoverableSources: recoverable.length,
		queued,
		remainingRecoverable: Math.max(0, recoverable.length - queued.length),
		manualReview: gaps.filter((gap) => gap.reason === 'failed' || gap.reason === 'outdated').map((gap) => ({ assistantEntryId: gap.assistant.id, position: gap.assistant.position, reason: gap.reason })),
	};
}

const MEMORY_STAGE_JOB_TYPES: Record<keyof MemoryStageFreshnessReport, readonly string[]> = {
	checkpoint: ['refresh_scene_checkpoint'],
	consolidation: ['summarize_chapter', 'rollup_arc', 'rollup_saga'],
	optionalIndex: ['embed_memory_nodes', 'rebuild_retrieval_projection', 'index_canonical_records', 'sync_story_vault'],
};

const UNKNOWN_MEMORY_STAGE_FRESHNESS: MemoryStageFreshness = {
	status: 'unknown',
	jobCount: 0,
	completedCount: 0,
	activeCount: 0,
	failedCount: 0,
	latestUpdatedAt: null,
	latestSourceVersion: null,
};

export function summarizeMemoryStageFreshness(
	rows: BackendJobPreview[],
	latestSuccessfulAt = new Map<string, string>(),
): MemoryStageFreshnessReport {
	const latestCompletedCreatedAt = new Map(latestSuccessfulAt);
	for (const row of rows) {
		if (row.status !== 'complete') continue;
		const key = jobFamilyKey(row);
		const previous = latestCompletedCreatedAt.get(key);
		if (!previous || row.createdAt > previous) latestCompletedCreatedAt.set(key, row.createdAt);
	}

	const summarize = (types: readonly string[]): MemoryStageFreshness => {
		const stageRows = rows.filter((row) => types.includes(row.type));
		if (stageRows.length === 0) return { ...UNKNOWN_MEMORY_STAGE_FRESHNESS };
		let completedCount = 0;
		let activeCount = 0;
		let failedCount = 0;
		let latestRow: BackendJobPreview | null = null;
		for (const row of stageRows) {
			if (!latestRow || row.updatedAt > latestRow.updatedAt) latestRow = row;
			if (row.status === 'complete') completedCount++;
			if (row.status === 'running' || row.status === 'queued' || row.status === 'retry') activeCount++;
			if (row.status === 'failed' && !isSupersededJobFailure(row, latestCompletedCreatedAt)) failedCount++;
		}
		return {
			status: failedCount > 0 ? 'attention' : activeCount > 0 ? 'updating' : completedCount > 0 ? 'current' : 'unknown',
			jobCount: stageRows.length,
			completedCount,
			activeCount,
			failedCount,
			latestUpdatedAt: latestRow?.updatedAt ?? null,
			latestSourceVersion: latestRow ? backendJobSourceVersion(latestRow) : null,
		};
	};

	return {
		checkpoint: summarize(MEMORY_STAGE_JOB_TYPES.checkpoint),
		consolidation: summarize(MEMORY_STAGE_JOB_TYPES.consolidation),
		optionalIndex: summarize(MEMORY_STAGE_JOB_TYPES.optionalIndex),
	};
}

export function summarizeBackendJobs(
	rows: BackendJobPreview[],
	latestSuccessfulAt = new Map<string, string>(),
): BackendJobStats {
	const now = nowIso();
	const byStatus: Record<string, number> = {};
	const byType: Record<string, number> = {};
	const readyByType: Record<string, number> = {};
	const failedByType: Record<string, number> = {};
	const failureClasses = new Map<string, Omit<BackendJobFailureClass, 'sourceVersions'> & { sourceVersions: Set<number> }>();
	const storyIds = new Set<string>();
	const latestCompletedCreatedAt = new Map(latestSuccessfulAt);
	let activeFailed = 0;
	const readyJobs: BackendJobPreview[] = [];
	const delayedJobs: BackendJobPreview[] = [];
	const runningJobs: BackendJobPreview[] = [];
	const recentFailures: BackendJobPreview[] = [];
	const memoryProcessing = { complete: 0, failed: 0, waiting: 0, running: 0 };

	for (const row of rows) {
		if (row.status === 'complete') {
			const key = jobFamilyKey(row);
			const previous = latestCompletedCreatedAt.get(key);
			if (!previous || row.createdAt > previous) latestCompletedCreatedAt.set(key, row.createdAt);
		}
	}

	for (const row of rows) {
		byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
		byType[row.type] = (byType[row.type] ?? 0) + 1;
		if (row.type === 'extract_turn_state') {
			if (row.status === 'complete') memoryProcessing.complete++;
			else if (row.status === 'failed') memoryProcessing.failed++;
			else if (row.status === 'running') memoryProcessing.running++;
			else if (row.status === 'queued' || row.status === 'retry') memoryProcessing.waiting++;
		}
		if (row.storyId) storyIds.add(row.storyId);

		const runnable = row.status === 'queued' || row.status === 'retry';
		if (runnable && row.runAfter <= now) {
			readyJobs.push(row);
			readyByType[row.type] = (readyByType[row.type] ?? 0) + 1;
		} else if (runnable) {
			delayedJobs.push(row);
		}

		if (row.status === 'running') runningJobs.push(row);
		if (row.status === 'failed' || (row.status === 'retry' && row.lastError)) {
			if (!isSupersededJobFailure(row, latestCompletedCreatedAt)) {
				const classification = classifyBackendJobFailure(row.lastError);
				const sourceVersion = backendJobSourceVersion(row);
				const classKey = `${jobFamilyKey(row)}:${classification.cause}`;
				const existing = failureClasses.get(classKey);
				if (existing) {
					existing.count += 1;
					existing.sourceVersions = sourceVersion === null ? existing.sourceVersions : existing.sourceVersions.add(sourceVersion);
					if (row.updatedAt > existing.latestUpdatedAt) {
						existing.latestUpdatedAt = row.updatedAt;
						existing.lastError = row.lastError ? snippet(row.lastError, 500) : existing.lastError;
					}
				} else {
					failureClasses.set(classKey, {
						storyId: row.storyId,
						projectId: row.projectId,
						type: row.type,
						cause: classification.cause,
						count: 1,
						sourceVersions: sourceVersion === null ? new Set() : new Set([sourceVersion]),
						latestUpdatedAt: row.updatedAt,
						lastError: row.lastError ? snippet(row.lastError, 500) : null,
						retryable: classification.retryable,
					});
				}
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
		memoryProcessing,
		memoryStageFreshness: summarizeMemoryStageFreshness(rows, latestSuccessfulAt),
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
		failureClasses: [...failureClasses.values()]
			.sort((a, b) => b.count - a.count || b.latestUpdatedAt.localeCompare(a.latestUpdatedAt))
			.map((failure) => ({ ...failure, sourceVersions: [...failure.sourceVersions].sort((a, b) => a - b) })),
		oldestReadyAt: readyJobs[0]?.runAfter ?? null,
		nextRunAfter: delayedJobs[0]?.runAfter ?? null,
		recentFailures: recentFailures.slice(0, 8).map(compactJobPreview),
		runningJobs: runningJobs.slice(0, 8).map(compactJobPreview),
	};
}

function backendJobSourceVersion(row: Pick<BackendJobPreview, 'payload' | 'metadata'>): number | null {
	for (const source of [row.payload, row.metadata]) {
		for (const key of ['sourceVersion', 'serverVersion', 'source_version', 'server_version']) {
			const value = source?.[key];
			const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
			if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
		}
	}
	return null;
}

function compactJobPreview(row: BackendJobPreview): BackendJobPreview {
	return {
		...row,
		lastError: row.lastError ? snippet(row.lastError, 500) : null,
		failureCause: row.status === 'failed' || (row.status === 'retry' && row.lastError)
			? classifyBackendJobFailure(row.lastError).cause
			: null,
		sourceVersion: backendJobSourceVersion(row),
	};
}

function jobFamilyKey(row: Pick<BackendJobPreview, 'storyId' | 'type' | 'projectId'>): string {
	return `${row.storyId ?? `project:${row.projectId}`}:${row.type}`;
}

export function isSupersededJobFailure(
	row: Pick<BackendJobPreview, 'storyId' | 'projectId' | 'type' | 'status' | 'createdAt'>,
	latestCompletedCreatedAt: Map<string, string>,
): boolean {
	if (row.status !== 'failed' && row.status !== 'retry') return false;
	// A successful later turn does not repair a different turn's missing evidence.
	if (['extract_turn_state', 'create_memory_nodes_from_events', 'embed_memory_nodes'].includes(row.type)) return false;
	const completedCreatedAt = latestCompletedCreatedAt.get(jobFamilyKey(row));
	return Boolean(completedCreatedAt && Date.parse(completedCreatedAt) > Date.parse(row.createdAt));
}
