import { expect, it, vi } from 'vitest';
import { assertAgentRunCanCommit } from './agentRunGuard';

it('requires the locked run to remain committing before canonical writes', async () => {
  for (const status of ['cancelled', 'failed', 'running', 'completed', null]) {
    const tx = { execute: vi.fn(async () => status ? [{ status }] : []) };
    await expect(assertAgentRunCanCommit(tx as any, 'game', 'run')).rejects.toThrow('stopped');
    expect(tx.execute).toHaveBeenCalledOnce();
  }
  await expect(assertAgentRunCanCommit({ execute: vi.fn(async () => [{ status: 'committing' }]) } as any, 'game', 'run')).resolves.toBeUndefined();
});

it('checks cancellation again after acquiring the run lock', async () => {
  const controller = new AbortController();
  const tx = { execute: vi.fn(async () => { controller.abort(new Error('Stopped while waiting for run lock.')); return [{ status: 'committing' }]; }) };
  await expect(assertAgentRunCanCommit(tx as any, 'game', 'run', controller.signal)).rejects.toThrow('Stopped while waiting');
});

it('rejects an old worker after a newer lease owns the committing run', async () => {
  const tx = { execute: vi.fn(async () => [{ status: 'committing', lease_owner: 'new-owner' }]) };
  await expect(assertAgentRunCanCommit(tx as any, 'game', 'run', undefined, 'old-owner')).rejects.toThrow('lease changed');
  await expect(assertAgentRunCanCommit(tx as any, 'game', 'run', undefined, 'new-owner')).resolves.toBeUndefined();
  const active = { execute: vi.fn(async () => [{ status: 'running', lease_owner: 'new-owner' }]) };
  await expect(assertAgentRunCanCommit(active as any, 'game', 'run', undefined, 'new-owner', 'running')).resolves.toBeUndefined();
  await expect(assertAgentRunCanCommit(active as any, 'game', 'run', undefined, 'old-owner', 'running')).rejects.toThrow('lease changed');
});

it('a caught specialist budget refusal or expired deadline still prevents the turn commit', async () => {
  for (const budget of [{ stopReason: 'request_budget_exhausted', deadlineAt: Date.now() + 10000 },
    { deadlineAt: Date.now() - 1 }, null]) {
    const tx = { execute: vi.fn(async () => [{ status: 'committing', runtime: 'pi-v1', budget }]) };
    await expect(assertAgentRunCanCommit(tx as any, 'game', 'run')).rejects.toThrow(/cannot commit|deadline/);
  }
});
