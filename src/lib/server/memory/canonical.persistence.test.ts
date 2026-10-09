import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shelves, stories, storyEntries } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), enqueueImportProjectionJobs: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/jobs/outbox', () => ({
	enqueueImportProjectionJobs: mocks.enqueueImportProjectionJobs,
	enqueueStoryVaultSyncJob: vi.fn(),
	enqueueTurnProjectionJobs: vi.fn(),
}));
vi.mock('$lib/server/env', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/server/env')>(),
	getServerMemoryConfig: () => ({ importEntryLimit: 2 }),
}));

import { exportBackendStory, importIndexedDbBundle } from './canonical';

describe('canonical campaign persistence boundaries', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.enqueueImportProjectionJobs.mockResolvedValue([]);
	});

	it('rejects an oversized legacy transcript before opening the database or queuing work', async () => {
		await expect(importIndexedDbBundle({ bundle: {
			story: { id: 'source_story', title: 'Complete source' },
			storyEntries: [0, 1, 2].map((position) => ({ id: `entry_${position}`, content: 'Evidence', position })),
		} })).rejects.toThrow('3 transcript entries; the limit is 2. No records were imported.');
		expect(mocks.getDb).not.toHaveBeenCalled();
		expect(mocks.enqueueImportProjectionJobs).not.toHaveBeenCalled();
	});

	it('imports every transcript entry at the limit, including the final entry', async () => {
		const inserted: Array<{ table: unknown; row: Record<string, unknown> }> = [];
		const db = {
			insert: (table: unknown) => ({ values: (row: Record<string, unknown>) => {
				inserted.push({ table, row });
				return { onConflictDoUpdate: async () => {}, onConflictDoNothing: async () => {} };
			} }),
			update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ serverVersion: 2 }] }) }) }),
		};
		mocks.getDb.mockReturnValue(db);
		const entries = [0, 1].map((position) => ({ id: `entry_${position}`, content: `Evidence ${position}`, position }));
		const imported = await importIndexedDbBundle({ bundle: { story: { id: 'source_story' }, storyEntries: entries } });
		expect(imported.counts.entries).toBe(2);
		expect(inserted.filter(({ table }) => table === storyEntries).map(({ row }) => row.id)).toEqual(['entry_0', 'entry_1']);
		expect(mocks.enqueueImportProjectionJobs).toHaveBeenCalledOnce();
	});

	it('reads the story and every export table through a read-only repeatable-read transaction', async () => {
		const selected: unknown[] = [];
		const tx = { execute: vi.fn().mockResolvedValue([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'p' }]).mockResolvedValueOnce([{ id: 'story_snapshot' }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]), select: () => {
			let table: unknown;
			const rows = () => table === stories ? [{ id: 'story_snapshot', title: 'Snapshot', shelfId: 'p' }]
				: table === shelves ? [{ id: 'p', name: 'Snapshot Project', slug: 'snapshot_project', settings: {} }] : [];
			const query = {
				from: (value: unknown) => { table = value; selected.push(value); return query; },
				innerJoin: () => query,
				where: () => query,
				limit: () => Promise.resolve(rows()),
				orderBy: () => Promise.resolve(rows()),
				then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve),
			};
			return query;
		} };
		const transaction = vi.fn(async (callback: (executor: typeof tx) => unknown) => callback(tx));
		const db = { transaction, select: vi.fn(() => { throw new Error('Read outside snapshot'); }) };
		mocks.getDb.mockReturnValue(db);
		const exported = await exportBackendStory('story_snapshot');
		expect(exported.version).toBe(3);
		expect(exported.shelf).toMatchObject({ id: 'p', name: 'Snapshot Project', slug: 'snapshot_project', settings: {} });
		expect(exported.authoredContent).toMatchObject({ projectId: 'p', gameId: 'story_snapshot', types: [], items: [] });
		expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'repeatable read', accessMode: 'read only' });
		expect(db.select).not.toHaveBeenCalled();
		expect(selected).toHaveLength(27);
		expect(new Set(selected).size).toBe(27);
	});
});
