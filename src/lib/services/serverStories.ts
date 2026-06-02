import {
	createStory,
	deleteStory,
	getAllStories,
	getStory,
	updateStory,
} from '$lib/services/database';
import {
	arcCommandResponseSchema,
	bootstrapResponseSchema,
	chapterCommandResponseSchema,
	createStoryResponseSchema,
	entityCommandResponseSchema,
	entityDeleteResponseSchema,
	livingMemoryCommandResponseSchema,
	sagaCommandResponseSchema,
	storyEntriesPageResponseSchema,
	type ArcCommandResponse,
	type BootstrapResponse,
	type ChapterCommandResponse,
	type EntityCommandResponse,
	type EntityDeleteResponse,
	type SagaCommandResponse,
	type StoryEntriesPageResponse,
} from '$lib/contracts/memory';
import type { Arc, Chapter, Entry, Saga, Story, StoryMode, StorySettings } from '$lib/types';

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

async function deleteJson(url: string): Promise<unknown> {
	const response = await fetch(url, { method: 'DELETE' });
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(typeof body.error === 'string' ? body.error : `Backend delete failed: ${response.status}`);
	}
	return response.json();
}

export async function listBackendStories(): Promise<BackendStorySummary[]> {
	const raw = await getJson('/api/stories');
	if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { stories?: unknown }).stories)) {
		throw new Error('Terminal world database list returned an invalid payload.');
	}
	return (raw as { stories: BackendStorySummary[] }).stories;
}

export async function createBackendStoryShell(input: CreateBackendStoryInput): Promise<CreateBackendStoryResult> {
	const raw = await sendJson('/api/stories', 'POST', input);
	return createStoryResponseSchema.parse(raw);
}

export async function fetchBackendStoryBootstrap(serverStoryId: string): Promise<BootstrapResponse> {
	const raw = await getJson(`/api/stories/${encodeURIComponent(serverStoryId)}/bootstrap`);
	return bootstrapResponseSchema.parse(raw);
}

export async function fetchBackendStoryEntriesPage(
	serverStoryId: string,
	options: { beforePosition?: number | null; limit?: number | null; branchId?: string | null } = {},
): Promise<StoryEntriesPageResponse> {
	const params = new URLSearchParams();
	if (typeof options.beforePosition === 'number' && Number.isFinite(options.beforePosition)) {
		params.set('beforePosition', String(Math.trunc(options.beforePosition)));
	}
	if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
		params.set('limit', String(Math.trunc(options.limit)));
	}
	if (options.branchId) params.set('branchId', options.branchId);
	const query = params.toString();
	const raw = await getJson(`/api/stories/${encodeURIComponent(serverStoryId)}/entries${query ? `?${query}` : ''}`);
	return storyEntriesPageResponseSchema.parse(raw);
}

export async function upsertBackendLorebookEntry(serverStoryId: string, entry: Entry): Promise<EntityCommandResponse> {
	const raw = await sendJson(`/api/stories/${encodeURIComponent(serverStoryId)}/entities/${encodeURIComponent(entry.id)}`, 'PATCH', { entry });
	return entityCommandResponseSchema.parse(raw);
}

export async function createBackendLorebookEntry(serverStoryId: string, entry: Entry): Promise<EntityCommandResponse> {
	const raw = await sendJson(`/api/stories/${encodeURIComponent(serverStoryId)}/entities`, 'POST', { entry });
	return entityCommandResponseSchema.parse(raw);
}

export async function deleteBackendLorebookEntry(serverStoryId: string, entityId: string): Promise<EntityDeleteResponse> {
	const raw = await deleteJson(`/api/stories/${encodeURIComponent(serverStoryId)}/entities/${encodeURIComponent(entityId)}`);
	return entityDeleteResponseSchema.parse(raw);
}

export async function upsertBackendChapter(serverStoryId: string, chapter: Chapter): Promise<ChapterCommandResponse> {
	const raw = await sendJson(`/api/stories/${encodeURIComponent(serverStoryId)}/chapters/${encodeURIComponent(chapter.id)}`, 'PATCH', { chapter });
	return chapterCommandResponseSchema.parse(raw);
}

export async function createBackendChapter(serverStoryId: string, chapter: Chapter): Promise<ChapterCommandResponse> {
	const raw = await sendJson(`/api/stories/${encodeURIComponent(serverStoryId)}/chapters`, 'POST', { chapter });
	return chapterCommandResponseSchema.parse(raw);
}

export async function upsertBackendArc(serverStoryId: string, arc: Arc): Promise<ArcCommandResponse> {
	const raw = await sendJson(`/api/stories/${encodeURIComponent(serverStoryId)}/arcs/${encodeURIComponent(arc.id)}`, 'PATCH', { arc });
	return arcCommandResponseSchema.parse(raw);
}

export async function createBackendArc(serverStoryId: string, arc: Arc): Promise<ArcCommandResponse> {
	const raw = await sendJson(`/api/stories/${encodeURIComponent(serverStoryId)}/arcs`, 'POST', { arc });
	return arcCommandResponseSchema.parse(raw);
}

export async function upsertBackendSaga(serverStoryId: string, saga: Saga): Promise<SagaCommandResponse> {
	const raw = await sendJson(`/api/stories/${encodeURIComponent(serverStoryId)}/sagas/${encodeURIComponent(saga.id)}`, 'PATCH', { saga });
	return sagaCommandResponseSchema.parse(raw);
}

export async function createBackendSaga(serverStoryId: string, saga: Saga): Promise<SagaCommandResponse> {
	const raw = await sendJson(`/api/stories/${encodeURIComponent(serverStoryId)}/sagas`, 'POST', { saga });
	return sagaCommandResponseSchema.parse(raw);
}

export async function upsertBackendLivingMemory(
	serverStoryId: string,
	kind: LivingMemoryKind,
	records: Array<Record<string, unknown>>,
): Promise<LivingMemoryCommandResponse> {
	const raw = await sendJson(`/api/stories/${encodeURIComponent(serverStoryId)}/living-memory`, 'POST', { kind, records });
	return livingMemoryCommandResponseSchema.parse(raw);
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
		await deleteJson(`/api/stories/${encodeURIComponent(story.serverStoryId)}`);
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
