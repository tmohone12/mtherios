import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { emptyLocationMap } from '$lib/contracts/locationMap';

const mocks = vi.hoisted(() => ({ db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn(), insert: vi.fn(), update: vi.fn() } }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.db }));
import { saveLocationMap } from './locationMaps';

const dialect = new PgDialect();
const map = emptyLocationMap();
const input = { locationId: 'bridge', expectedRevision: 2, map, reason: 'Confirm current geometry.' };
const actor = { kind: 'agent', runId: 'run', callId: 'map-call', leaseOwner: 'owner' };
const owned = () => ({ status: 'running', lease_owner: 'owner', runtime: 'pi-v1', budget: { deadlineAt: Date.now() + 10000 } });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.transaction.mockImplementation((work: (tx: typeof mocks.db) => Promise<unknown>) => work(mocks.db));
});

describe('atomic agent map writer admission', () => {
  it.each([
    ['cancelled', () => ({ ...owned(), status: 'cancelled' })],
    ['replaced lease', () => ({ ...owned(), lease_owner: 'new-owner' })],
    ['expired deadline', () => ({ ...owned(), budget: { deadlineAt: Date.now() - 1 } })],
    ['terminal budget refusal', () => ({ ...owned(), budget: { deadlineAt: Date.now() + 10000, stopReason: 'tool_budget_exhausted' } })],
  ])('rejects %s before touching canonical map state', async (_label, row) => {
    mocks.db.execute.mockResolvedValue([row()]);
    await expect(saveLocationMap('game', input, actor)).rejects.toThrow();
    expect(mocks.db.execute).toHaveBeenCalledOnce();
    const query = dialect.sqlToQuery(mocks.db.execute.mock.calls[0][0]);
    expect(query.sql).toContain('for update');
    expect(query.params).toEqual(['run', 'game']);
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it('holds the run row before the story lock and keeps existing map idempotency', async () => {
    const order: string[] = [];
    mocks.db.execute.mockImplementation(async () => { order.push('run lock'); return [owned()]; });
    const rows = [[{ id: 'game', shelfId: 'project', serverVersion: 4 }], [{ id: 'bridge', status: 'active' }], [{ revision: 2, map }], []];
    mocks.db.select.mockImplementation(() => {
      const builder = {
        from: () => builder, where: () => builder, orderBy: () => builder,
        for: () => { order.push('story lock'); return builder; }, limit: async () => rows.shift(),
      };
      return builder;
    });
    await expect(saveLocationMap('game', input, actor)).resolves.toMatchObject({ revision: 2, map, unchanged: true });
    expect(order).toEqual(['run lock', 'story lock']);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it('checks the deadline again after waiting for canonical state and before a map change', async () => {
    mocks.db.execute.mockResolvedValueOnce([owned()]).mockResolvedValueOnce([{ ...owned(), budget: { deadlineAt: Date.now() - 1 } }]);
    const rows = [[{ id: 'game', shelfId: 'project', serverVersion: 4 }], [{ id: 'bridge', status: 'active' }], [{ revision: 2, map: { ...map, title: 'Previous map' } }], []];
    mocks.db.select.mockImplementation(() => {
      const builder = { from: () => builder, where: () => builder, orderBy: () => builder, for: () => builder, limit: async () => rows.shift() };
      return builder;
    });
    await expect(saveLocationMap('game', input, actor)).rejects.toThrow('deadline exceeded');
    expect(mocks.db.execute).toHaveBeenCalledTimes(2);
    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.db.update).not.toHaveBeenCalled();
  });
});
