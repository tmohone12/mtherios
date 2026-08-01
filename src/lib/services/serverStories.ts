import {
	createStory,
	deleteStory,
	getAllStories,
	getStory,
	updateStory,
} from '$lib/services/database';
import {
	createShelfResponseSchema,
	shelfListResponseSchema,
	shelfSummarySchema,
	type CreateShelfRequest,
	type CreateShelfResponse,
	type ShelfSummary,
	type UpdateShelfRequest,
} from '$lib/contracts/shelves';
import {
	arcCommandResponseSchema,
	arcDeleteResponseSchema,
	bootstrapResponseSchema,
	chapterCommandResponseSchema,
	chapterDeleteResponseSchema,
	contextCheckpointCommandResponseSchema,
	contextCheckpointListResponseSchema,
	contextCheckpointRevertResponseSchema,
	createStoryResponseSchema,
	storyDeleteResponseSchema,
	entityCommandResponseSchema,
	entityDeleteResponseSchema,
	livingMemoryCommandResponseSchema,
	sagaCommandResponseSchema,
	storyEntriesPageResponseSchema,
	type ArcCommandResponse,
	type ArcDeleteResponse,
	type BootstrapResponse,
	type ChapterCommandResponse,
	type ChapterDeleteResponse,
	type ContextCheckpointCommandResponse,
	type ContextCheckpointListResponse,
	type ContextCheckpointRevertResponse,
	type EntityCommandResponse,
	type EntityDeleteResponse,
	type SagaCommandResponse,
	type StoryEntriesPageResponse,
} from '$lib/contracts/memory';
import {
	campaignProjectionSchema,
	engineCacheStatusSchema,
	engineCommandRequestSchema,
	engineCommandResponseSchema,
	type CampaignProjection,
	type EngineCacheStatus,
	type EngineCacheStatusArgs,
	type EngineCommandRequest,
	type EngineCommandResponse,
} from '$lib/contracts/engine';
import type { Arc, Chapter, Entry, Saga, Story, StoryMode, StorySettings } from '$lib/types';
import type { ZodType } from 'zod';

export type LivingMemoryKind = 'conversationMemory' | 'worldEvent' | 'factionAction' | 'rumor' | 'scheme';
export type LivingMemoryCommandResponse = {
	storyId: string;
	serverVersion: number;
	kind: LivingMemoryKind;
	recordIds: string[];
	counts: Record<string, unknown>;
};

export interface BackendStorySummary {
	id: string;
	shelfId?: string | null;
	clientStoryId?: string | null;
	title?: string | null;
	description?: string | null;
	genre?: string | null;
	mode?: string | null;
	settings?: unknown;
	headerPrompt?: string | null;
	metadata?: Record<string, unknown> | null;
	serverVersion?: number | null;
	createdAt?: string | number | null;
	updatedAt?: string | number | null;
}

export interface CreateBackendStoryInput {
	shelfId?: string | null;
	title: string;
	description?: string | null;
	genre?: string | null;
	mode?: StoryMode;
	settings?: StorySettings | null;
	headerPrompt?: string | null;
	playerReputation?: string | null;
	clientStoryId?: string;
	startWorkflow?: {
		sourceMode?: 'blank' | 'lorebook' | 'character_card' | 'import' | 'transcript' | 'source_notes';
		sourceCount?: number;
		requiresCanonReview?: boolean;
		startingSceneReady?: boolean;
		notes?: string | null;
	};
}

export interface CreateBackendStoryResult {
	storyId: string;
	shelfId?: string;
	serverVersion: number;
	createdAt: string;
}

export interface DeleteBackendStoryOptions {
	mode?: 'archive' | 'purge';
	exportBeforeDelete?: boolean;
}

export interface DeleteBackendStoryResult {
	ok: boolean;
	storyId: string;
	mode: 'archive' | 'purge';
	canonDeleted: boolean;
	artifactCleanup: Record<string, unknown> | null;
	warnings: string[];
}

export const CONTROL_SURFACE_BOOTSTRAP_LIMITS = {
	entryLimit: 80,
	entityLimit: 120,
	relationshipLimit: 200,
	factionLimit: 80,
	factionMembershipLimit: 160,
	factionResourceLimit: 160,
	factionGoalLimit: 160,
	factionProjectLimit: 160,
	agreementLimit: 80,
	npcBeliefLimit: 80,
	threadLimit: 80,
	chapterLimit: 80,
	arcLimit: 80,
	sagaLimit: 40,
	eventLimit: 80,
	patchLimit: 80,
	memoryNodeLimit: 80,
} as const;

const ENGINE_COMMAND_MAX_ATTEMPTS = 3;
const ENGINE_COMMAND_RETRY_DELAY_MS = 200;
const RETRYABLE_ENGINE_COMMAND_MESSAGES = [
	'failed to fetch',
	'fetch failed',
	'networkerror',
	'econnrefused',
	'econnreset',
	'etimedout',
	'socket hang up',
	'connection terminated',
	'connection closed',
	'terminal request failed: 502',
	'terminal request failed: 503',
	'terminal request failed: 504',
];

export function isRetryableEngineCommandFailure(error: unknown): boolean {
	if (error instanceof TypeError) return true;
	const message = error instanceof Error
		? error.message
		: typeof error === 'string'
			? error
			: '';
	const normalized = message.toLowerCase();
	return RETRYABLE_ENGINE_COMMAND_MESSAGES.some((needle) => normalized.includes(needle));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url: string): Promise<unknown> {
	const response = await fetch(url);
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(typeof body.error === 'string' ? body.error : `Terminal request failed: ${response.status}`);
	}
	return response.json();
}

async function sendJson(url: string, method: 'POST' | 'PATCH', payload: unknown): Promise<unknown> {
	const response = await fetch(url, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(typeof body.error === 'string' ? body.error : `Terminal request failed: ${response.status}`);
	}
	return response.json();
}

function cacheStatusArgs(options: Partial<EngineCacheStatusArgs> = {}): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	if (options.includeSegments) args.includeSegments = true;
	if (typeof options.segmentLimit === 'number' && Number.isFinite(options.segmentLimit)) {
		args.segmentLimit = Math.max(1, Math.trunc(options.segmentLimit));
	}
	if (options.kind) args.kind = options.kind;
	return args;
}

export async function listBackendStories(options: { shelfId?: string | null } = {}): Promise<BackendStorySummary[]> {
	const args = options.shelfId ? { shelfId: options.shelfId } : {};
	const response = await sendEngineCommand({
		storyId: '__app__',
		command: 'story.list',
		args,
	});
	if (response.status !== 'succeeded') {
		throw new Error(response.error ?? 'Terminal world database list failed.');
	}
	const raw = response.result;
	if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { stories?: unknown }).stories)) {
		throw new Error('Terminal world database list returned an invalid payload.');
	}
	return (raw as { stories: BackendStorySummary[] }).stories;
}

export async function listBackendShelves(): Promise<ShelfSummary[]> {
	const response = await sendEngineCommand({ storyId: '__app__', command: 'shelf.list', args: {} });
	if (response.status !== 'succeeded') throw new Error(response.error ?? 'Shelf list failed.');
	return shelfListResponseSchema.parse(response.result).shelves;
}

export async function createBackendShelf(input: CreateShelfRequest): Promise<CreateShelfResponse> {
	return sendStoryEngineCommandResult('__app__', 'shelf.create', input, createShelfResponseSchema);
}

export async function updateBackendShelf(shelfId: string, input: UpdateShelfRequest): Promise<ShelfSummary> {
	return sendStoryEngineCommandResult('__app__', 'shelf.update', { shelfId, ...input }, shelfSummarySchema);
}

export async function createBackendStoryShell(input: CreateBackendStoryInput): Promise<CreateBackendStoryResult> {
	return sendStoryEngineCommandResult('__app__', 'story.create', { ...input }, createStoryResponseSchema);
}

export async function fetchBackendStoryBootstrap(serverStoryId: string): Promise<BootstrapResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'campaign.bootstrap', CONTROL_SURFACE_BOOTSTRAP_LIMITS, bootstrapResponseSchema);
}

export async function resolveBackendStoryBootstrap(story: Pick<Story, 'id' | 'serverStoryId' | 'title'>): Promise<BootstrapResponse> {
	const attempted = new Set<string>();
	let firstError: unknown = null;
	let lastError: unknown = null;
	const tryBootstrap = async (candidateId?: string | null): Promise<BootstrapResponse | null> => {
		const id = String(candidateId ?? '').trim();
		if (!id || attempted.has(id)) return null;
		attempted.add(id);
		try {
			return await fetchBackendStoryBootstrap(id);
		} catch (error) {
			firstError ??= error;
			lastError = error;
			return null;
		}
	};

	const direct = await tryBootstrap(story.serverStoryId) ?? await tryBootstrap(story.id);
	if (direct) return direct;

	try {
		const stories = await listBackendStories();
		const localIds = new Set([story.id, story.serverStoryId].map((value) => String(value ?? '').trim()).filter(Boolean));
		const exactIdMatch = stories.find((candidate) =>
			localIds.has(candidate.id) || (candidate.clientStoryId ? localIds.has(candidate.clientStoryId) : false)
		);
		const titleMatches = stories.filter((candidate) => story.title && candidate.title === story.title);
		const fallbackIds = [
			exactIdMatch?.id,
			titleMatches.length === 1 ? titleMatches[0]?.id : null,
		];
		for (const candidateId of fallbackIds) {
			const recovered = await tryBootstrap(candidateId);
			if (recovered) return recovered;
		}
	} catch (error) {
		lastError = error;
	}

	throw firstError ?? lastError ?? new Error('Terminal world database story could not be resolved.');
}

export async function fetchBackendStoryProjection(serverStoryId: string, limit = 80): Promise<CampaignProjection> {
	return sendStoryEngineCommandResult(serverStoryId, 'campaign.status', {
		entryLimit: Math.max(1, Math.trunc(limit)),
		entityLimit: 200,
	}, campaignProjectionSchema);
}

export async function fetchEngineCacheStatus(
	serverStoryId?: string | null,
	options: Partial<EngineCacheStatusArgs> = {},
): Promise<EngineCacheStatus> {
	const args = cacheStatusArgs(options);
	if (serverStoryId) {
		return sendStoryEngineCommandResult(serverStoryId, 'campaign.cacheStatus', args, engineCacheStatusSchema);
	}
	const params = new URLSearchParams();
	if (serverStoryId) params.set('storyId', serverStoryId);
	if (args.includeSegments) params.set('includeSegments', 'true');
	if (typeof args.segmentLimit === 'number') params.set('segmentLimit', String(args.segmentLimit));
	if (typeof args.kind === 'string') params.set('kind', args.kind);
	const query = params.toString();
	const raw = await getJson(`/api/engine/cache${query ? `?${query}` : ''}`);
	return engineCacheStatusSchema.parse(raw);
}

export async function sendEngineCommand(command: EngineCommandRequest): Promise<EngineCommandResponse> {
	const payload = engineCommandRequestSchema.parse(command);
	let lastFailure: unknown = null;

	for (let attempt = 0; attempt < ENGINE_COMMAND_MAX_ATTEMPTS; attempt += 1) {
		try {
			const raw = await sendJson('/api/engine/command', 'POST', payload);
			const response = engineCommandResponseSchema.parse(raw);
			if (response.status !== 'failed' || !isRetryableEngineCommandFailure(response.error)) {
				return response;
			}
			lastFailure = new Error(response.error ?? `Engine command failed: ${payload.command}`);
		} catch (error) {
			if (!isRetryableEngineCommandFailure(error)) throw error;
			lastFailure = error;
		}

		if (attempt < ENGINE_COMMAND_MAX_ATTEMPTS - 1) {
			await delay(ENGINE_COMMAND_RETRY_DELAY_MS * (attempt + 1));
		}
	}

	throw lastFailure instanceof Error ? lastFailure : new Error(`Engine command failed: ${payload.command}`);
}

export async function repairBackendWikiNow(): Promise<EngineCommandResponse> {
	const response = await sendEngineCommand({
		storyId: '__all_stories__',
		command: 'jobs.storyVaultSync',
		args: {
			allStories: true,
			runNow: true,
			index: true,
		},
	});
	if (response.status !== 'succeeded') {
		throw new Error(response.error ?? 'Failed to repair wiki index.');
	}
	const result = response.result && typeof response.result === 'object'
		? response.result as Record<string, unknown>
		: {};
	if (result.ok === false) {
		throw new Error('Wiki index repair failed.');
	}
	return response;
}

async function sendStoryEngineCommandResult<T>(
	storyId: string,
	command: string,
	args: Record<string, unknown>,
	schema: ZodType<T>,
): Promise<T> {
	const response = await sendEngineCommand({ storyId, command, args });
	if (response.status !== 'succeeded') {
		throw new Error(response.error ?? `Engine command failed: ${command}`);
	}
	return schema.parse(response.result);
}

export async function fetchBackendStoryEntriesPage(
	serverStoryId: string,
	options: { beforePosition?: number | null; limit?: number | null; branchId?: string | null } = {},
): Promise<StoryEntriesPageResponse> {
	const args: Record<string, unknown> = {};
	if (typeof options.beforePosition === 'number' && Number.isFinite(options.beforePosition)) {
		args.beforePosition = Math.trunc(options.beforePosition);
	}
	if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
		args.limit = Math.trunc(options.limit);
	}
	if (options.branchId) args.branchId = options.branchId;
	return sendStoryEngineCommandResult(serverStoryId, 'campaign.transcriptPage', args, storyEntriesPageResponseSchema);
}

export async function upsertBackendLorebookEntry(serverStoryId: string, entry: Entry): Promise<EntityCommandResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'entity.upsert', { entry }, entityCommandResponseSchema);
}

export async function createBackendLorebookEntry(serverStoryId: string, entry: Entry): Promise<EntityCommandResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'entity.create', { entry }, entityCommandResponseSchema);
}

export async function deleteBackendLorebookEntry(serverStoryId: string, entityId: string): Promise<EntityDeleteResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'entity.delete', { entityId }, entityDeleteResponseSchema);
}

export async function upsertBackendChapter(serverStoryId: string, chapter: Chapter): Promise<ChapterCommandResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'chapter.upsert', { chapter }, chapterCommandResponseSchema);
}

export async function createBackendChapter(serverStoryId: string, chapter: Chapter): Promise<ChapterCommandResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'chapter.create', { chapter }, chapterCommandResponseSchema);
}

export async function deleteBackendChapter(serverStoryId: string, chapterId: string): Promise<ChapterDeleteResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'chapter.delete', { chapterId }, chapterDeleteResponseSchema);
}

export async function upsertBackendArc(serverStoryId: string, arc: Arc): Promise<ArcCommandResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'arc.upsert', { arc }, arcCommandResponseSchema);
}

export async function createBackendArc(serverStoryId: string, arc: Arc): Promise<ArcCommandResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'arc.create', { arc }, arcCommandResponseSchema);
}

export async function deleteBackendArc(serverStoryId: string, arcId: string): Promise<ArcDeleteResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'arc.delete', { arcId }, arcDeleteResponseSchema);
}

export async function createContextCheckpoint(
	serverStoryId: string,
	input: { label?: string; reason?: string | null } = {},
): Promise<ContextCheckpointCommandResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'context.checkpoint.create', input, contextCheckpointCommandResponseSchema);
}

export async function listContextCheckpoints(serverStoryId: string, limit = 50): Promise<ContextCheckpointListResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'context.checkpoint.list', { limit }, contextCheckpointListResponseSchema);
}

export async function revertToContextCheckpoint(
	serverStoryId: string,
	checkpointId: string,
	reason?: string | null,
): Promise<ContextCheckpointRevertResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'context.checkpoint.revert', { checkpointId, reason }, contextCheckpointRevertResponseSchema);
}

export async function upsertBackendSaga(serverStoryId: string, saga: Saga): Promise<SagaCommandResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'saga.upsert', { saga }, sagaCommandResponseSchema);
}

export async function createBackendSaga(serverStoryId: string, saga: Saga): Promise<SagaCommandResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'saga.create', { saga }, sagaCommandResponseSchema);
}

export async function upsertBackendLivingMemory(
	serverStoryId: string,
	kind: LivingMemoryKind,
	records: Array<Record<string, unknown>>,
): Promise<LivingMemoryCommandResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'livingMemory.upsert', { kind, records }, livingMemoryCommandResponseSchema);
}

export async function cacheBackendStoryFromBootstrap(
	bootstrap: BootstrapResponse,
	preferredLocalStoryId?: string | null,
): Promise<Story> {
	return cacheBackendStory({
		...(bootstrap.story as unknown as BackendStorySummary),
		clientStoryId: preferredLocalStoryId ?? (bootstrap.story as unknown as BackendStorySummary).clientStoryId ?? null,
		serverVersion: bootstrap.serverVersion,
	});
}

export async function refreshStoryCatalog(options: { shelfId?: string | null } = {}): Promise<Story[]> {
	const localStories = await getAllStories();
	let serverStories: Story[] = [];
	let liveServerIds: Set<string> | null = null;
	let liveClientStoryIds = new Set<string>();

	try {
		const serverRows = await listBackendStories(options);
		liveServerIds = new Set(serverRows.map((row) => row.id).filter(Boolean));
		liveClientStoryIds = new Set(serverRows.map((row) => row.clientStoryId).filter((id): id is string => Boolean(id)));
		const localByServerId = new Map(
			localStories
				.filter((story) => story.serverStoryId)
				.map((story) => [story.serverStoryId, story]),
		);
		serverStories = [];
		for (const row of serverRows) {
			const matchedLocalId = row.clientStoryId ?? localByServerId.get(row.id)?.id ?? null;
			serverStories.push(await cacheBackendStory({
				...row,
				clientStoryId: matchedLocalId,
			}));
		}
	} catch (error) {
		console.warn('[ServerStories] Backend story catalog unavailable; using local cache:', error);
	}

	const byId = new Map<string, Story>();
	for (const story of localStories) {
		if (options.shelfId && (story.shelfId ?? 'shelf_default') !== options.shelfId) continue;
		if (liveServerIds && story.syncStatus === 'local-only') continue;
		if (
			liveServerIds
			&& story.serverStoryId
			&& !liveServerIds.has(story.serverStoryId)
			&& !liveClientStoryIds.has(story.id)
		) continue;
		byId.set(story.id, story);
	}
	for (const story of serverStories) byId.set(story.id, { ...byId.get(story.id), ...story });
	return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function cacheBackendStories(rows: BackendStorySummary[]): Promise<Story[]> {
	const cached: Story[] = [];
	for (const row of rows) cached.push(await cacheBackendStory(row));
	return cached;
}

export async function cacheBackendStory(row: BackendStorySummary): Promise<Story> {
	if (!row.id) throw new Error('Terminal world database row is missing id.');
	const localId = row.clientStoryId || row.id;
	const now = Date.now();
	const createdAt = toTime(row.createdAt, now);
	const updatedAt = toTime(row.updatedAt, createdAt);
	const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};

	const story: Story = {
		id: localId,
		shelfId: row.shelfId ?? 'shelf_default',
		title: row.title || 'Untitled Chronicle',
		description: row.description ?? null,
		genre: row.genre ?? null,
		templateId: null,
		mode: toStoryMode(row.mode),
		createdAt,
		updatedAt,
		settings: toStorySettings(row.settings),
		memoryConfig: {
			tokenThreshold: 16000,
			chapterBuffer: 10,
			autoSummarize: true,
			enableRetrieval: true,
			maxChaptersPerRetrieval: 5,
		},
		retryState: null,
		styleReviewState: null,
		timeTracker: null,
		currentBranchId: null,
		currentBgImage: null,
		headerPrompt: row.headerPrompt ?? null,
		playerReputation: typeof metadata.playerReputation === 'string' ? metadata.playerReputation : null,
		serverStoryId: row.id,
		serverVersion: row.serverVersion ?? 1,
		syncStatus: 'synced',
		lastWorldSimDay: null,
		compactedLore: null,
		compactedLoreHistory: null,
		meters: null,
	};

	const existing = await getStory(localId);
	if (existing) {
		await updateStory(localId, {
			shelfId: story.shelfId,
			title: story.title,
			description: story.description,
			genre: story.genre,
			mode: story.mode,
			settings: story.settings,
			headerPrompt: story.headerPrompt,
			playerReputation: story.playerReputation,
			serverStoryId: story.serverStoryId,
			serverVersion: story.serverVersion,
			syncStatus: 'synced',
		});
		return { ...existing, ...story, updatedAt: Date.now() };
	}

	await createStory(story);
	return story;
}

export async function deleteStoryEverywhere(
	story: Story,
	options: DeleteBackendStoryOptions = {},
): Promise<DeleteBackendStoryResult | null> {
	let backendResult: DeleteBackendStoryResult | null = null;
	if (story.serverStoryId) {
		const args = {
			mode: options.mode ?? 'purge',
			exportBeforeDelete: options.exportBeforeDelete ?? false,
		};
		const response = await sendEngineCommand({
			storyId: story.serverStoryId,
			command: 'story.delete',
			args,
		});
		if (response.status !== 'succeeded') {
			throw new Error(response.error ?? 'Backend delete failed.');
		}
		backendResult = storyDeleteResponseSchema.parse(response.result);
	}
	await deleteStory(story.id);
	return backendResult;
}

function toStoryMode(value: unknown): StoryMode {
	return value === 'creative-writing' ? 'creative-writing' : 'adventure';
}

function toStorySettings(value: unknown): StorySettings | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as StorySettings : null;
}

function toTime(value: unknown, fallback: number): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}
