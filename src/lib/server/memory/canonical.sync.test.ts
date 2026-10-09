import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { stories, storyEntries, storyEvents, syncOps } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	enqueueBackendJob: vi.fn(),
	enqueueStoryVaultSyncJob: vi.fn(),
	enqueueTurnProjectionJobs: vi.fn(),
}));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/jobs/outbox', () => ({
	enqueueBackendJob: mocks.enqueueBackendJob,
	enqueueImportProjectionJobs: vi.fn(),
	enqueueStoryVaultSyncJob: mocks.enqueueStoryVaultSyncJob,
	enqueueTurnProjectionJobs: mocks.enqueueTurnProjectionJobs,
}));

import { applySyncOperation } from './canonical';

function syncDatabase() {
	let receipts: Record<string, unknown>[] = [];
	const inserts: Array<{ table: unknown; row: Record<string, unknown> }> = [];
	const deleteReturning = vi.fn().mockResolvedValue([{ id: 'entry_visible' }, { id: 'entry_not_loaded' }]);
	const deleteWhere = vi.fn((_where: SQL) => ({ returning: deleteReturning }));
	const tx = {
		execute: vi.fn((_sql: SQL) => Promise.resolve()),
		select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => receipts) })) })) })),
		insert: vi.fn((table: unknown) => ({ values: vi.fn((row: Record<string, unknown>) => {
			inserts.push({ table, row });
			if (table === syncOps) receipts.push(row);
			return { onConflictDoNothing: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: row.id }]) })) };
		}) })),
		update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ serverVersion: 9 }]) })) })) })),
		delete: vi.fn(() => ({ where: deleteWhere })),
	};
	const db = { transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => {
		const before = receipts.slice();
		try { return await work(tx); }
		catch (error) { receipts = before; throw error; }
	}) };
	mocks.getDb.mockReturnValue(db);
	return { db, tx, inserts, deleteWhere, deleteReturning };
}

const op = {
	id: 'sync_delete_1', storyId: 'story_1', type: 'delete_entry', clientVersion: 8,
	clientCreatedAt: '2026-09-04T00:00:00.000Z',
	payload: { fromPosition: 10, entryIds: ['entry_visible'] },
};

describe('atomic transcript sync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.enqueueBackendJob.mockResolvedValue('job_scene');
		mocks.enqueueStoryVaultSyncJob.mockResolvedValue('job_vault');
		mocks.enqueueTurnProjectionJobs.mockResolvedValue(['job_turn']);
	});

	it('deletes the server range including unloaded entries and queues scene and vault projections atomically', async () => {
		const { db, tx, inserts, deleteWhere } = syncDatabase();
		const result = await applySyncOperation(op);
		const predicate = new PgDialect().sqlToQuery(deleteWhere.mock.calls[0][0]);
		expect(predicate.sql).toContain('"story_entries"."position" >=');
		expect(predicate.params).toEqual(['story_1', 10]);
		expect(tx.delete).toHaveBeenCalledExactlyOnceWith(storyEntries);
		expect(tx.update).toHaveBeenCalledExactlyOnceWith(stories);
		expect(db.transaction).toHaveBeenCalledOnce();
		expect(new PgDialect().sqlToQuery(tx.execute.mock.calls[0][0]).params).toEqual(['mtherios:story-entry:story_1']);
		expect(inserts.find(({ table }) => table === storyEvents)?.row).toMatchObject({
			sourceEntryIds: ['entry_visible', 'entry_not_loaded'],
			metadata: { transcriptOnly: true, fromPosition: 10 },
		});
		expect(mocks.enqueueTurnProjectionJobs).not.toHaveBeenCalled();
		expect(mocks.enqueueStoryVaultSyncJob).toHaveBeenCalledWith(expect.objectContaining({ storyId: 'story_1', serverVersion: 9 }), tx);
		expect(mocks.enqueueBackendJob).toHaveBeenCalledWith(expect.objectContaining({ storyId: 'story_1', type: 'refresh_scene_checkpoint' }), tx);
		expect(result.projectionJobIds).toEqual(['job_scene', 'job_vault']);
	});

	it('scopes a single-entry deletion to the supplied story and ID', async () => {
		const { deleteWhere } = syncDatabase();
		await applySyncOperation({ ...op, payload: { entryId: 'entry_visible' } });
		const predicate = new PgDialect().sqlToQuery(deleteWhere.mock.calls[0][0]);
		expect(predicate.sql).toContain('"story_entries"."id" in');
		expect(predicate.params).toEqual(['story_1', 'entry_visible']);
	});

	it.each([-1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1])('rejects an invalid range %s before opening a transaction', async (fromPosition) => {
		const { db } = syncDatabase();
		await expect(applySyncOperation({ ...op, payload: { fromPosition } })).rejects.toThrow('non-negative integer');
		expect(db.transaction).not.toHaveBeenCalled();
	});

	it('does not apply a successful sync operation twice', async () => {
		const { tx } = syncDatabase();
		await applySyncOperation(op);
		expect(await applySyncOperation(op)).toMatchObject({ alreadyApplied: true });
		expect(tx.delete).toHaveBeenCalledOnce();
	});

	it('propagates outbox failure through the transaction so a retry is not marked applied', async () => {
		const { db, tx } = syncDatabase();
		mocks.enqueueStoryVaultSyncJob.mockRejectedValueOnce(new Error('outbox unavailable'));
		await expect(applySyncOperation(op)).rejects.toThrow('outbox unavailable');
		expect(await applySyncOperation(op)).not.toHaveProperty('alreadyApplied');
		expect(db.transaction).toHaveBeenCalledTimes(2);
		expect(tx.delete).toHaveBeenCalledTimes(2);
	});

	it('keeps correction jobs inside the same transaction as their sync receipt', async () => {
		const { tx } = syncDatabase();
		await applySyncOperation({ ...op, type: 'state_correction', payload: { operations: [] } });
		expect(mocks.enqueueTurnProjectionJobs).toHaveBeenCalledWith(expect.objectContaining({ storyId: 'story_1' }), tx);
		expect(mocks.enqueueStoryVaultSyncJob).not.toHaveBeenCalled();
	});
});
