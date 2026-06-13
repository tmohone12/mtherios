import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { arcs, backendJobs, chapters, factions, memoryNodes, stories, storyEntries, storyEvents } from '$lib/server/db/schema';
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
import { claimBackendJobs, enqueueStoryVaultSyncJob, markBackendJobComplete, markBackendJobFailed, type BackendJobType } from './outbox';
import { indexCanonicalRecords } from '$lib/server/engine/canonicalSearch';
import { recordApiCallLog } from '$lib/server/engine/apiCallLogs';
import { publishEngineEvent } from '$lib/server/engine/events';
import { resolveServiceGeneration } from '$lib/server/engine/llmSettings';
import { createTimingRecorder, type TimingEntry, type TimingRecorder } from '$lib/server/performance/timing';
import { mapWithConcurrency, readGenerationConcurrency } from '$lib/server/performance/concurrency';
import { buildTurnDebugSnapshot } from '$lib/server/turn/debugSnapshot';
import { applyValidatedTurnUpdate, parseTurnUpdate, turnUpdateOperationCount } from '$lib/server/turn/patchValidator';
import { buildStateExtractionPrompt } from '$lib/server/turn/promptPacket';
import {
	ServerGenerationError,
	generateServerTextWithMetrics,
	parseJsonFromGeneratedText,
	type ServerGenerationResult,
} from '$lib/server/turn/provider';
import { formatMtheriosMemorySummary } from '$lib/services/ai/context/mtheriosSummaryFormat';

type BackendJobRow = typeof backendJobs.$inferSelect;
type ArcRow = typeof arcs.$inferSelect;
type ChapterRow = typeof chapters.$inferSelect;
type FactionRow = typeof factions.$inferSelect;
type StoryEntryRow = typeof storyEntries.$inferSelect;
type StoryEventRow = typeof storyEvents.$inferSelect;
type ProviderProfile = NonNullable<Awaited<ReturnType<typeof resolveServiceGeneration>>['profile']>;
type GenerationResult = ServerGenerationResult | ServerGenerationError['result'];

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
	if (row.type === 'promise' || row.type === 'betrayal' || row.type === 'agreement') return 0.9;
	if (row.type === 'faction_move' || row.type === 'death' || row.type === 'reveal') return 0.8;
	return 0.65;
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
	for (const row of rows) {
		await db.insert(memoryNodes).values({
			id: `mem_event_${row.id}`,
			storyId: row.storyId,
			type: eventMemoryType(row),
			title: row.title,
			content: row.body,
			summary: row.body.replace(/\s+/g, ' ').slice(0, 360),
			keywords: [row.type],
			entityIds: [...asStringArray(row.actorEntityIds), ...asStringArray(row.targetEntityIds)],
			factionIds: [],
			threadIds: asStringArray(row.threadIds),
			locationId: row.locationId ?? null,
			visibility: row.visibility,
			importance: eventImportance(row),
			sourceEntryIds: asStringArray(row.sourceEntryIds),
			sourceEventIds: [row.id],
			sourcePatchIds: asStringArray(row.sourcePatchIds),
			metadata: { sourceType: 'event_projection', jobId: job.id },
			serverVersion: row.serverVersion,
			createdAt: row.createdAt,
			updatedAt,
		}).onConflictDoUpdate({
			target: memoryNodes.id,
			set: {
				type: eventMemoryType(row),
				title: row.title,
				content: row.body,
				summary: row.body.replace(/\s+/g, ' ').slice(0, 360),
				keywords: [row.type],
				entityIds: [...asStringArray(row.actorEntityIds), ...asStringArray(row.targetEntityIds)],
				threadIds: asStringArray(row.threadIds),
				locationId: row.locationId ?? null,
				visibility: row.visibility,
				importance: eventImportance(row),
				sourceEntryIds: asStringArray(row.sourceEntryIds),
				sourceEventIds: [row.id],
				sourcePatchIds: asStringArray(row.sourcePatchIds),
				metadata: { sourceType: 'event_projection', jobId: job.id },
				serverVersion: row.serverVersion,
				updatedAt,
			},
		});
	}
	return rows.length;
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
	if (entry.type === 'user_action') return `Player: ${summarizePlayerAction(entry.content)}`;
	if (entry.type === 'narration') return `Narrator: ${cleanSummaryBeat(entry.content)}`;
	return `${entry.type}: ${cleanSummaryBeat(entry.content)}`;
}

function meaningfulEventString(event: StoryEventRow): string | null {
	const title = compactWhitespace(event.title);
	const body = cleanSummaryBeat(event.body, 180);
	if (!title || title.toLowerCase() === 'turn resolved') return null;
	return `${event.type}: ${title}${body ? ` - ${body}` : ''}`;
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
			return `${date || 'day/date unknown'} | ${time || 'time unknown'} | ${location || 'location unknown'} | ${weather || 'weather unknown'}`;
		}
	}
	return `positions ${first.position}-${last.position} | time unknown | location unknown | weather unknown, temp C unknown`;
}

function deriveChapterTitle(number: number, entries: StoryEntryRow[], events: StoryEventRow[]): string {
	const eventTitle = events.find((event) => event.title.trim())?.title;
	const firstAction = entries.find((entry) => entry.type === 'user_action')?.content;
	const seed = eventTitle || firstAction || entries[0]?.content || `Chapter ${number}`;
	const title = snippet(seed, 70).replace(/[.!?]+$/g, '');
	return title || `Chapter ${number}`;
}

export function buildChapterSummary(entries: StoryEntryRow[], events: StoryEventRow[]): string {
	const first = entries[0];
	const last = entries[entries.length - 1];
	const recentLines = entries.slice(0, 8).map(checkpointBeat);
	if (entries.length > recentLines.length) recentLines.push(`${entries.length - recentLines.length} more transcript entries are covered by this checkpoint.`);
	const importantStrings = [
		...events.map(meaningfulEventString).filter((event): event is string => Boolean(event)).slice(0, 8),
		`Source coverage: transcript positions ${first.position}-${last.position}; ${entries.length} entries; ${events.length} source event records.`,
	];
	return formatMtheriosMemorySummary({
		beginning: `Terminal checkpoint covering transcript positions ${first.position}-${last.position}.`,
		recent: recentLines,
		charAppearance: 'not established',
		charDemeanor: 'not established',
		userAppearance: 'not established',
		sideCharacters: uniqueStrings(events.flatMap((event) => asStringArray(event.actorEntityIds))).slice(0, 12),
		importantStrings,
		currently: parseCurrentAnchor(entries, first, last),
	});
}

async function upsertChapterMemoryNode(input: {
	storyId: string;
	chapterId: string;
	title: string;
	summary: string;
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
		keywords: ['chapter', 'terminal_checkpoint'],
		entityIds: [],
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
			threadIds: input.threadIds,
			sourceEntryIds: input.sourceEntryIds,
			sourceEventIds: input.sourceEventIds,
			metadata: { sourceType: 'terminal_chapter_job', jobId: input.jobId },
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		},
	});
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
	const number = (previousChapter?.number ?? 0) + 1;
	const chapterId = stableId('chapter', [first.id, last.id]);
	const { title, summary } = timePhaseSync(recorder, 'job.summarize_chapter.build_summary', {
		entries: chapterEntries.length,
		events: events.length,
	}, () => ({
		title: deriveChapterTitle(number, chapterEntries, events),
		summary: buildChapterSummary(chapterEntries, events),
	}));
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
		openThreads: threadIds,
		sourceEntryIds,
		sourceEventIds,
		metadata: {
			sourceType: 'terminal_chapter_job',
			jobId: job.id,
			entryCount: chapterEntries.length,
			startPosition: first.position,
			endPosition: last.position,
			threshold,
			postChapterBuffer: buffer,
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
			openThreads: threadIds,
			sourceEntryIds,
			sourceEventIds,
			serverVersion,
			updatedAt: now,
		},
	}).returning());

	await timePhase(recorder, 'job.summarize_chapter.persist_memory_node', {}, () => upsertChapterMemoryNode({
		storyId: job.storyId,
		chapterId,
		title,
		summary,
		sourceEntryIds,
		sourceEventIds,
		threadIds,
		serverVersion,
		now,
		jobId: job.id,
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
	return {
		created: true,
		chapterId: chapter.id,
		number: chapter.number,
		entryCount: chapterEntries.length,
		eventCount: events.length,
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

function arcSummary(arcChapters: ChapterRow[]): string {
	const first = arcChapters[0];
	const last = arcChapters[arcChapters.length - 1];
	return formatMtheriosMemorySummary({
		beginning: `Terminal arc rollup covering chapters ${first.number}-${last.number}.`,
		recent: arcChapters.map((chapter) => `Chapter ${chapter.number}${chapter.title ? ` (${chapter.title})` : ''}: ${snippet(chapter.sceneOutcome, 360)}`),
		charAppearance: 'not established',
		charDemeanor: 'not established',
		userAppearance: 'not established',
		sideCharacters: [],
		importantStrings: uniqueStrings(arcChapters.flatMap((chapter) => [
			...asStringArray(chapter.irreversibleChanges),
			...asStringArray(chapter.promisesDebtsOaths),
			...asStringArray(chapter.openThreads),
		])).slice(0, 16),
		currently: `chapters ${first.number}-${last.number} | time unknown | location unknown | weather unknown, temp°C unknown`,
	});
}

async function upsertArcMemoryNode(input: {
	storyId: string;
	arcId: string;
	title: string;
	summary: string;
	chapterIds: string[];
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
		entityIds: [],
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
	if (uncovered.length < chaptersPerArc) {
		return {
			created: false,
			reason: 'arc_threshold_not_met',
			uncoveredChapters: uncovered.length,
			chaptersPerArc,
		};
	}

	const arcChapters = uncovered.slice(0, chaptersPerArc);
	const first = arcChapters[0];
	const last = arcChapters[arcChapters.length - 1];
	const chapterIds = arcChapters.map((chapter) => chapter.id);
	const arcId = stableId('arc', [first.id, last.id]);
	const [existing] = await db.select().from(arcs).where(and(eq(arcs.storyId, job.storyId), eq(arcs.id, arcId))).limit(1);
	const number = existing?.number ?? ((arcRows[arcRows.length - 1]?.number ?? 0) + 1);
	const title = arcTitle(number, arcChapters);
	const summary = arcSummary(arcChapters);
	const sourceEventIds = uniqueStrings(arcChapters.flatMap((chapter) => asStringArray(chapter.sourceEventIds)));
	const openThreadIds = uniqueStrings(arcChapters.flatMap((chapter) => asStringArray(chapter.openThreads)));
	const now = nowIso();
	const serverVersion = await timePhase(recorder, 'job.rollup_arc.bump_version', {}, () => bumpStoryVersion(job.storyId));

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
		metadata: {
			sourceType: 'terminal_arc_job',
			jobId: job.id,
			chapterCount: arcChapters.length,
			startChapterNumber: first.number,
			endChapterNumber: last.number,
		},
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
		sourceEventIds,
		openThreadIds,
		serverVersion,
		now,
		jobId: job.id,
	}));

	return {
		created: true,
		arcId: arc.id,
		number: arc.number,
		chapterCount: arcChapters.length,
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
	return indexCanonicalRecords({
		storyId: job.storyId,
		recordTypes: asStringArray(payload.recordTypes),
		recreate: payload.recreate === true,
	});
}

async function extractTurnState(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const payload = asRecord(job.payload);
	const playerEntryId = requirePayloadString(payload, 'playerEntryId');
	const assistantEntryId = requirePayloadString(payload, 'assistantEntryId');
	const playerText = requirePayloadString(payload, 'playerText');
	const narration = requirePayloadString(payload, 'narration');
	const clientTurnId = typeof payload.clientTurnId === 'string' && payload.clientTurnId.trim()
		? payload.clientTurnId
		: job.id;
	const timelineTurn = typeof payload.timelineTurn === 'number' && Number.isFinite(payload.timelineTurn)
		? Math.max(0, Math.trunc(payload.timelineTurn))
		: null;
	const memorySettingsPayload = asRecord(payload.memorySettings);
	const memorySettings = {
		chapterThreshold: asOptionalInt(memorySettingsPayload.chapterThreshold, 5, 200),
		postChapterBuffer: asOptionalInt(memorySettingsPayload.postChapterBuffer, 0, 100),
		chaptersPerArc: asOptionalInt(memorySettingsPayload.chaptersPerArc, 2, 50),
	};
	const classifierService = await timePhase(recorder, 'job.extract_turn_state.resolve_service', {}, () => resolveServiceGeneration('classifier'));
	const fallbackNarrativeService = classifierService.profile
		? null
		: await timePhase(recorder, 'job.extract_turn_state.resolve_narrative_fallback', {}, () => resolveServiceGeneration('narrative'));
	const classifierProfile = classifierService.profile ?? fallbackNarrativeService?.profile ?? null;
	if (!classifierProfile) {
		return {
			status: 'classifier_unavailable',
			missingReason: classifierService.missingReason ?? fallbackNarrativeService?.missingReason ?? null,
		};
	}

	const generationService = classifierService.profile ? classifierService : fallbackNarrativeService ?? classifierService;
	const classifierGeneration = generationService.generation;
	const classifierSystem = generationService.systemPromptOverride?.trim() || 'You extract canonical state changes for a text adventure. Return strict JSON only.';
	const extractionPrompt = buildStateExtractionPrompt(playerText, narration);
	let rawUpdate: unknown = null;
	try {
		const extractionResult = await timePhase(recorder, 'job.extract_turn_state.llm', {
			serviceId: 'classifier',
			model: classifierGeneration.model ?? null,
		}, () => generateServerTextWithMetrics({
			profile: classifierProfile,
			model: classifierGeneration.model,
			temperature: classifierGeneration.temperature,
			maxTokens: Math.min(classifierGeneration.maxTokens ?? 2048, 2048),
			system: classifierSystem,
			prompt: extractionPrompt,
			responseFormat: 'json_object',
		}));
		await timePhase(recorder, 'job.extract_turn_state.log_success', {}, () => logDeferredStateExtractionCall({
			job,
			clientTurnId,
			profile: classifierProfile,
			result: extractionResult,
			status: 'success',
			metadata: {
				responseFormat: 'json_object',
				debugSnapshot: buildTurnDebugSnapshot({
					kind: 'state_extraction',
					playerText,
					system: classifierSystem,
					prompt: extractionPrompt,
					output: extractionResult.text,
				}),
			},
		}));
		rawUpdate = parseJsonFromGeneratedText(extractionResult.text);
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
					responseFormat: 'json_object',
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
		return {
			status: 'llm_error',
			error: error instanceof Error ? error.message : String(error),
			statusCode: failedResult?.statusCode ?? null,
		};
	}

	const parsedUpdate = timePhaseSync(recorder, 'job.extract_turn_state.parse_update', {}, () => parseTurnUpdate(rawUpdate));
	const operationCount = turnUpdateOperationCount(parsedUpdate.update);
	if (operationCount === 0 && parsedUpdate.warnings.length === 0) {
		return {
			status: 'no_changes',
			operationCount,
		};
	}

	const serverVersion = await timePhase(recorder, 'job.extract_turn_state.bump_version', {
		operationCount,
		parseWarnings: parsedUpdate.warnings.length,
	}, () => bumpStoryVersion(job.storyId));
	const applied = await timePhase(recorder, 'job.extract_turn_state.apply_update', {
		operationCount,
		parseWarnings: parsedUpdate.warnings.length,
		serverVersion,
	}, () => applyValidatedTurnUpdate({
		storyId: job.storyId,
		playerEntryId,
		assistantEntryId,
		narration,
		update: parsedUpdate.update,
		parseWarnings: parsedUpdate.warnings,
		retrievedMemoryIds: asStringArray(payload.retrievedMemoryIds),
		serverVersion,
		mode: 'supplemental',
		timelineTurn,
		memorySettings,
	}));

	return {
		status: 'applied',
		serverVersion,
		operationCount,
		parseWarnings: parsedUpdate.warnings.length,
		warnings: applied.warnings,
		eventIds: applied.eventIds,
		patchIds: applied.patchIds,
		memoryNodeIds: applied.memoryNodeIds,
	};
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
