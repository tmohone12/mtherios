import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMtheriosAppConfig, type MtheriosAppConfig } from '$lib/server/app/config';
import { canonicalSearchCollection, ensureCanonicalSearchCollection } from '$lib/server/engine/canonicalSearch';
import { deleteStoryVaultArtifacts, storyVaultCollection } from '$lib/server/wiki/storyVault';

type QdrantConfig = { url: string; collection: string; lockDir?: string; lockTimeoutMs?: number; lockStaleMs?: number; lockPollMs?: number };
type WikiPoint = { id: string; vector: number[]; payload: Record<string, unknown> };

async function importScriptModule(filePath: string): Promise<unknown> {
	return import(pathToFileURL(resolve(process.cwd(), filePath)).href);
}

const { ensureCollection, prepareAndSyncWikiIndex, syncWikiPoints, withQdrantCollectionLock } = await importScriptModule('scripts/wiki-core/lib/qdrant.mjs') as {
	ensureCollection: (vectorSize: number, config: QdrantConfig, options?: { recreate?: boolean }) => Promise<void>;
	prepareAndSyncWikiIndex: (
		prepare: () => Promise<{ vectorSize: number | null; points: WikiPoint[] }>,
		config: QdrantConfig,
		batchSize?: number,
	) => Promise<{ upserted: number; removed: number }>;
	syncWikiPoints: (
		points: WikiPoint[],
		config: QdrantConfig,
		batchSize?: number,
	) => Promise<{ upserted: number; removed: number }>;
	withQdrantCollectionLock: <T>(config: QdrantConfig, run: () => Promise<T>) => Promise<T>;
};

const { chunkMarkdown } = await importScriptModule('scripts/wiki-core/lib/vault.mjs') as {
	chunkMarkdown: (page: {
		relPath: string;
		title: string;
		layer: string;
		frontmatter: Record<string, unknown>;
		headings: string[];
		links: string[];
		backlinks: string[];
		body: string;
		updatedAt: string;
	}) => WikiPoint[];
};

const config = { url: 'http://qdrant.test', collection: 'story_test' };
const tempRoots: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('wiki Qdrant synchronization', () => {
	it('never deletes the shared collection when legacy recreate is requested', async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
			result: { config: { params: { vectors: { size: 768 } } } },
		}));
		vi.stubGlobal('fetch', fetchMock);

		await ensureCollection(768, config, { recreate: true });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
	});

	it('removes an obsolete vault vector while preserving canonical and current vectors', async () => {
		const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const body = typeof init?.body === 'string'
				? JSON.parse(init.body) as Record<string, unknown>
				: null;
			requests.push({ url, method: init?.method ?? 'GET', body });

			if (url.endsWith('/points/scroll')) {
				return jsonResponse({
					result: {
						points: [
							{ id: 'wiki-current', payload: { kind: 'wiki_chunk' } },
							{ id: 'wiki-stale', payload: { path: 'events/deleted-event.md' } },
							{ id: 'canonical-live', payload: { kind: 'canonical_record' } },
						],
						next_page_offset: null,
					},
				});
			}
			return jsonResponse({ result: { status: 'completed' } });
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await syncWikiPoints([{
			id: 'wiki-current',
			vector: [0.1, 0.2],
			payload: { kind: 'wiki_chunk', path: 'events/current-event.md' },
		}], config);

		expect(result).toEqual({ upserted: 1, removed: 1 });
		expect(requests.map((request) => request.url)).toEqual([
			'http://qdrant.test/collections/story_test/points?wait=true',
			'http://qdrant.test/collections/story_test/points/scroll',
			'http://qdrant.test/collections/story_test/points/delete?wait=true',
		]);
		expect(requests[1]?.body).toMatchObject({
			filter: { must_not: [{ key: 'kind', match: { value: 'canonical_record' } }] },
		});
		expect(requests[2]?.body).toEqual({ points: ['wiki-stale'] });
	});

	it('serializes overlapping exact-set syncs for the same collection', async () => {
		const lockDir = await mkdtemp(resolve(os.tmpdir(), 'mtherios-qdrant-lock-'));
		tempRoots.push(lockDir);
		const lockedConfig = { ...config, lockDir, lockPollMs: 5, lockTimeoutMs: 2_000, lockStaleMs: 5_000 };
		const livePoints = new Map<string, { id: string; payload: Record<string, unknown> }>();
		const operations: string[] = [];
		let releaseFirstScroll!: () => void;
		let firstScrollStarted!: () => void;
		const firstScrollGate = new Promise<void>((resolveGate) => { releaseFirstScroll = resolveGate; });
		const firstScrollSeen = new Promise<void>((resolveSeen) => { firstScrollStarted = resolveSeen; });
		let scrollCount = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, any> : {};
			if (url.endsWith('/points?wait=true')) {
				const ids = (body.points ?? []).map((point: WikiPoint) => point.id);
				operations.push(`upsert:${ids.join(',')}`);
				for (const point of body.points ?? []) livePoints.set(point.id, point);
				return jsonResponse({ result: { status: 'completed' } });
			}
			if (url.endsWith('/points/scroll')) {
				scrollCount += 1;
				operations.push(`scroll:${scrollCount}`);
				if (scrollCount === 1) {
					firstScrollStarted();
					await firstScrollGate;
				}
				return jsonResponse({ result: { points: [...livePoints.values()], next_page_offset: null } });
			}
			if (url.endsWith('/points/delete?wait=true')) {
				const ids = body.points as string[];
				operations.push(`delete:${ids.join(',')}`);
				for (const id of ids) livePoints.delete(id);
				return jsonResponse({ result: { status: 'completed' } });
			}
			throw new Error(`Unexpected Qdrant request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const first = syncWikiPoints([{ id: 'wiki-a', vector: [0.1], payload: { kind: 'wiki_chunk' } }], lockedConfig);
		await firstScrollSeen;
		const second = syncWikiPoints([{ id: 'wiki-b', vector: [0.2], payload: { kind: 'wiki_chunk' } }], lockedConfig);
		await new Promise((resolveWait) => setTimeout(resolveWait, 40));
		expect(operations).toEqual(['upsert:wiki-a', 'scroll:1']);

		releaseFirstScroll();
		await Promise.all([first, second]);

		expect(operations).toEqual([
			'upsert:wiki-a',
			'scroll:1',
			'upsert:wiki-b',
			'scroll:2',
			'delete:wiki-a',
		]);
		expect([...livePoints.keys()]).toEqual(['wiki-b']);
	});

	it('releases the collection lock when Qdrant synchronization fails', async () => {
		const lockDir = await mkdtemp(resolve(os.tmpdir(), 'mtherios-qdrant-lock-'));
		tempRoots.push(lockDir);
		const lockedConfig = { ...config, lockDir, lockPollMs: 5, lockTimeoutMs: 1_000, lockStaleMs: 5_000 };
		let fail = true;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			if (fail) throw new Error('simulated Qdrant outage');
			if (String(input).endsWith('/points/scroll')) {
				return jsonResponse({ result: { points: [], next_page_offset: null } });
			}
			return jsonResponse({ result: { status: 'completed' } });
		});
		vi.stubGlobal('fetch', fetchMock);
		const point = { id: 'wiki-current', vector: [0.1], payload: { kind: 'wiki_chunk' } };

		await expect(syncWikiPoints([point], lockedConfig)).rejects.toThrow('simulated Qdrant outage');
		fail = false;
		await expect(syncWikiPoints([point], lockedConfig)).resolves.toEqual({ upserted: 1, removed: 0 });
	});

	it('does not steal a live owner lock, including the Windows kernel-mutex path', async () => {
		const lockDir = await mkdtemp(resolve(os.tmpdir(), 'mtherios-qdrant-lock-'));
		tempRoots.push(lockDir);
		const lockedConfig = { ...config, lockDir, lockPollMs: 5, lockTimeoutMs: 1_000, lockStaleMs: 5_000 };
		let releaseFirst!: () => void;
		let firstStarted!: () => void;
		const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
		const firstSeen = new Promise<void>((resolveSeen) => { firstStarted = resolveSeen; });
		const first = withQdrantCollectionLock(lockedConfig, async () => {
			firstStarted();
			await firstGate;
		});
		await firstSeen;
		const lockName = (await readdir(lockDir)).find((name) => name.endsWith('.lock'));
		if (lockName) {
			const old = new Date(Date.now() - 10_000);
			await utimes(resolve(lockDir, lockName), old, old);
		} else {
			expect(process.platform).toBe('win32');
		}
		let secondEntered = false;
		const second = withQdrantCollectionLock(lockedConfig, async () => {
			secondEntered = true;
		});

		try {
			await new Promise((resolveWait) => setTimeout(resolveWait, 40));
			expect(secondEntered).toBe(false);
		} finally {
			releaseFirst();
		}
		await Promise.all([first, second]);
		expect(secondEntered).toBe(true);
	});

	it('holds the collection lock from vault preparation through sync before replacement cleanup can delete it', async () => {
		const lockDir = await mkdtemp(resolve(os.tmpdir(), 'mtherios-qdrant-lock-'));
		tempRoots.push(lockDir);
		vi.stubEnv('MTHERIOS_QDRANT_LOCK_DIR', lockDir);
		const appConfig: MtheriosAppConfig = {
			...getMtheriosAppConfig(),
			dataRoot: resolve(lockDir, 'data'),
			vaultRoot: resolve(lockDir, 'vaults'),
			defaultVault: resolve(lockDir, 'vaults', 'default'),
			qdrantUrl: 'http://qdrant.cleanup.test',
			qdrantCollection: 'mtherios_cleanup',
		};
		const storyId = 'story_cleanup';
		const collection = storyVaultCollection(storyId, appConfig);
		const lockedConfig = { ...config, url: appConfig.qdrantUrl, collection, lockDir, lockPollMs: 5, lockTimeoutMs: 2_000 };
		const operations: string[] = [];
		let releasePreparation!: () => void;
		let preparationStarted!: () => void;
		const preparationGate = new Promise<void>((resolveGate) => { releasePreparation = resolveGate; });
		const preparationSeen = new Promise<void>((resolveSeen) => { preparationStarted = resolveSeen; });
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			if (method === 'GET' && url.endsWith(`/collections/${collection}`)) {
				operations.push('sync:ensure');
				return jsonResponse({ result: { config: { params: { vectors: { size: 2 } } } } });
			}
			if (url.endsWith('/points?wait=true')) {
				operations.push('sync:upsert');
				return jsonResponse({ result: { status: 'completed' } });
			}
			if (url.endsWith('/points/scroll')) {
				operations.push('sync:scroll');
				return jsonResponse({ result: { points: [], next_page_offset: null } });
			}
			if (method === 'DELETE' && url.endsWith(`/collections/${collection}`)) {
				operations.push('cleanup:delete');
				return jsonResponse({ result: true });
			}
			throw new Error(`Unexpected Qdrant request: ${method} ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const sync = prepareAndSyncWikiIndex(async () => {
			preparationStarted();
			await preparationGate;
			return {
				vectorSize: 2,
				points: [{ id: 'wiki-current', vector: [0.1, 0.2], payload: { kind: 'wiki_chunk' } }],
			};
		}, lockedConfig);
		await preparationSeen;
		const cleanup = deleteStoryVaultArtifacts(storyId, appConfig);
		await new Promise((resolveWait) => setTimeout(resolveWait, 40));
		expect(operations).toEqual([]);

		releasePreparation();
		await Promise.all([sync, cleanup]);
		expect(operations).toEqual(['sync:ensure', 'sync:upsert', 'sync:scroll', 'cleanup:delete']);
	});

	it('serializes canonical collection creation behind an active wiki sync', async () => {
		const lockDir = await mkdtemp(resolve(os.tmpdir(), 'mtherios-qdrant-lock-'));
		tempRoots.push(lockDir);
		vi.stubEnv('MTHERIOS_QDRANT_LOCK_DIR', lockDir);
		const appConfig = getMtheriosAppConfig();
		const collection = canonicalSearchCollection('story_recreate_lock');
		const lockedConfig = { url: appConfig.qdrantUrl, collection, lockDir, lockPollMs: 5, lockTimeoutMs: 2_000 };
		const operations: string[] = [];
		let releaseScroll!: () => void;
		let scrollStarted!: () => void;
		const scrollGate = new Promise<void>((resolveGate) => { releaseScroll = resolveGate; });
		const scrollSeen = new Promise<void>((resolveSeen) => { scrollStarted = resolveSeen; });
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			if (url.endsWith('/points?wait=true')) {
				operations.push('sync:upsert');
				return jsonResponse({ result: { status: 'completed' } });
			}
			if (url.endsWith('/points/scroll')) {
				operations.push('sync:scroll');
				scrollStarted();
				await scrollGate;
				return jsonResponse({ result: { points: [], next_page_offset: null } });
			}
			if (method === 'GET' && url.endsWith(`/collections/${collection}`)) {
				operations.push('ensure:get');
				return new Response('', { status: 404 });
			}
			if (method === 'PUT' && url.endsWith(`/collections/${collection}`)) {
				operations.push('ensure:create');
				return jsonResponse({ result: true });
			}
			throw new Error(`Unexpected Qdrant request: ${method} ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const sync = syncWikiPoints([{ id: 'wiki-current', vector: [0.1], payload: { kind: 'wiki_chunk' } }], lockedConfig);
		await scrollSeen;
		const ensure = ensureCanonicalSearchCollection(collection, 1);
		await new Promise((resolveWait) => setTimeout(resolveWait, 40));
		expect(operations).toEqual(['sync:upsert', 'sync:scroll']);

		releaseScroll();
		await Promise.all([sync, ensure]);
		expect(operations).toEqual([
			'sync:upsert',
			'sync:scroll',
			'ensure:get',
			'ensure:create',
		]);
	});

	it('marks new vault chunks with explicit wiki ownership', () => {
		const [chunk] = chunkMarkdown({
			relPath: 'events/current-event.md',
			title: 'Current Event',
			layer: 'root',
			frontmatter: { type: 'event' },
			headings: [],
			links: [],
			backlinks: [],
			body: '# Current Event\n\nThe current event remains true.',
			updatedAt: '2026-08-31T00:00:00.000Z',
		});

		expect(chunk?.payload.kind).toBe('wiki_chunk');
	});
});
