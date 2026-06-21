import {
	createStory,
	deleteStory,
	getAllStories,
	getStory,
	updateStory,
} from '$lib/services/database';
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
	title: string;
	description?: string | null;
	genre?: string | null;
	mode?: StoryMode;
	settings?: StorySettings | null;
	headerPrompt?: string | null;
	playerReputation?: string | null;
	clientStoryId?: string;
}

export interface CreateBackendStoryResult {
	storyId: string;
	serverVersion: number;
	createdAt: string;
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

export async function listBackendStories(): Promise<BackendStorySummary[]> {
	const response = await sendEngineCommand({
		storyId: '__app__',
		command: 'story.list',
		args: {},
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

export async function createBackendStoryShell(input: CreateBackendStoryInput): Promise<CreateBackendStoryResult> {
	return sendStoryEngineCommandResult('__app__', 'story.create', { ...input }, createStoryResponseSchema);
}

export async function fetchBackendStoryBootstrap(serverStoryId: string): Promise<BootstrapResponse> {
	return sendStoryEngineCommandResult(serverStoryId, 'campaign.bootstrap', CONTROL_SURFACE_BOOTSTRAP_LIMITS, bootstrapResponseSchema);
}

export async function fetchBackendStoryProjection(serverStoryId: string, limit = 80): Promise<CampaignProjection> {
	return sendStoryEngineCommandResult(serverStoryId, 'campaign.status', {
		entryLimit: Math.max(1, Math.trunc(limit)),
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
	const raw = await sendJson('/api/engine/command', 'POST', payload);
	return engineCommandResponseSchema.parse(raw);
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

export async function cacheBackendStoryFromBootstrap(bootstrap: BootstrapResponse): Promise<Story> {
	return cacheBackendStory({
		...(bootstrap.story as unknown as BackendStorySummary),
		serverVersion: bootstrap.serverVersion,
	});
}

export async function refreshStoryCatalog(): Promise<Story[]> {
	const localStories = await getAllStories();
	let serverStories: Story[] = [];

	try {
		serverStories = await cacheBackendStories(await listBackendStories());
	} catch (error) {
		console.warn('[ServerStories] Backend story catalog unavailable; using local cache:', error);
	}

	const byId = new Map<string, Story>();
	for (const story of localStories) byId.set(story.id, story);
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

export async function deleteStoryEverywhere(story: Story): Promise<void> {
	if (story.serverStoryId) {
		const response = await sendEngineCommand({
			storyId: story.serverStoryId,
			command: 'story.delete',
			args: {},
		});
		if (response.status !== 'succeeded') {
			throw new Error(response.error ?? 'Backend delete failed.');
		}
	}
	await deleteStory(story.id);
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
