import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { shippedAgentSettings } from '$lib/contracts/agentTools';
import { agentRunHash } from './agentRunHash';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), readSource: vi.fn(), update: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => ({ execute: mocks.execute, transaction: async (fn: (tx: { execute: typeof mocks.execute }) => Promise<unknown>) => fn({ execute: mocks.execute }) }) }));
vi.mock('./agentSettings', () => ({ getAgentSettings: async () => ({ effective: shippedAgentSettings }) }));
vi.mock('./sourceFiles', () => ({ listSourceFiles: vi.fn(), searchSourceFiles: vi.fn(), readSourceFile: mocks.readSource }));
vi.mock('./content', async original => ({ ...await original<typeof import('./content')>(), updateContentInTransaction: mocks.update }));

import { executeAssistantTool } from './assistantTools';

const authority = { runId: 'run', conversationId: 'conversation', projectId: 'project', gameId: null };
const dialect = new PgDialect();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockImplementation(async statement => {
    const { sql } = dialect.sqlToQuery(statement);
    return sql.includes('for update of r') ? [{ status: 'running', result: {}, project_id: 'project', game_id: null }] : [];
  });
});

describe('Assistant Pi domain boundary', () => {
  it('binds file reads to Assistant scope and saves the complete observed range receipt', async () => {
    const result = { sourceRef: 'content:bridge', text: 'The keeper made a bridge promise.', sha256: 'a'.repeat(64), revision: '1:1', startLine: 5, endLine: 6, truncated: true };
    mocks.readSource.mockResolvedValue(result);
    const call = { tool: 'read', callId: 'read-bridge', args: { kind: 'source', sourceRef: 'content:bridge', startLine: 5, lineCount: 2 } };
    expect(await executeAssistantTool(authority, call)).toEqual(result);
    expect(mocks.readSource).toHaveBeenCalledWith({ role: 'assistant', projectId: 'project', gameId: null }, { sourceRef: 'content:bridge', startLine: 5, lineCount: 2 });
    const committed = mocks.execute.mock.calls.map(([statement]) => dialect.sqlToQuery(statement)).find(query => query.sql.includes("set status='completed'"));
    expect(committed?.params).toContain(JSON.stringify(result));
    await expect(executeAssistantTool(authority, { ...call, args: { ...call.args, role: 'gm', projectId: 'other' } })).rejects.toThrow();
    expect(mocks.readSource).toHaveBeenCalledTimes(1);
  });

  it('replays an exact completed call without reading or writing again and rejects swapped tools', async () => {
    const args = { kind: 'item', id: 'bridge' };
    mocks.execute.mockImplementation(async statement => {
      const { sql } = dialect.sqlToQuery(statement);
      if (sql.includes('for update of r')) return [{ status: 'running', result: {}, project_id: 'project', game_id: null }];
      if (sql.includes('select tool,status,args_hash')) return [{ tool: 'read', args_hash: agentRunHash(args), status: 'completed', result: { id: 'bridge', revision: 3 } }];
      return [];
    });
    expect(await executeAssistantTool(authority, { tool: 'read', callId: 'saved', args })).toEqual({ id: 'bridge', revision: 3 });
    expect(mocks.readSource).not.toHaveBeenCalled();
    await expect(executeAssistantTool(authority, { tool: 'list', callId: 'saved', args: { kind: 'item' } })).rejects.toThrow('different arguments or tool');
  });

  it('throws inside the write transaction when cancellation arrives before receipt commit', async () => {
    const controller = new AbortController();
    mocks.update.mockImplementation(async () => {
      controller.abort(new Error('cancelled'));
      return { item: { id: 'bridge', title: 'Bridge', revision: 3, type_revision: 1 } };
    });
    await expect(executeAssistantTool({ ...authority, signal: controller.signal }, { tool: 'update', callId: 'edit', args: {
      id: 'bridge', expectedRevision: 2, expectedTypeRevision: 1, changes: { title: 'Bridge' },
    } })).rejects.toThrow('cancelled');
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), { projectId: 'project', id: 'bridge', expectedRevision: 2, expectedTypeRevision: 1, changes: { title: 'Bridge' } }, { role: 'assistant', runId: 'run', callId: 'edit', initiatedBy: 'local-user' });
    expect(mocks.execute.mock.calls.map(([statement]) => dialect.sqlToQuery(statement).sql).some(sql => sql.includes("set status='completed'"))).toBe(false);
  });

  it('stops an expired durable deadline before a canonical writer runs', async () => {
    mocks.execute.mockResolvedValue([{ status: 'running', result: { runtime: { budget: { deadlineAt: Date.now() - 1 } } }, project_id: 'project', game_id: null }]);
    await expect(executeAssistantTool(authority, { tool: 'update', callId: 'late', args: { id: 'bridge', expectedRevision: 2, expectedTypeRevision: 1, changes: { title: 'Late' } } })).rejects.toThrow('deadline elapsed');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects a stale execution token before a canonical writer runs', async () => {
    mocks.execute.mockResolvedValue([{ status: 'running', result: { leaseOwner: 'replacement' }, project_id: 'project', game_id: null }]);
    await expect(executeAssistantTool({ ...authority, leaseOwner: 'old-worker' }, { tool: 'update', callId: 'late', args: { id: 'bridge', expectedRevision: 2, expectedTypeRevision: 1, changes: { title: 'Late' } } })).rejects.toThrow('another execution');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
