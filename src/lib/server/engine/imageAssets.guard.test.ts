import { expect, it, vi } from 'vitest';
import { assertImageOriginActive } from './imageAssets';
import { withServerProviderHooks } from '$lib/server/turn/provider';

it('a canceled GM or Assistant origin cannot attach an image', async () => {
  for (const role of ['gm', 'assistant'] as const) {
    const tx = { execute: vi.fn(async () => [{ status: 'cancelled' }]) };
    await expect(assertImageOriginActive(tx as any, { projectId: 'project', gameId: 'game',
      origin: { role, runId: 'run', conversationId: 'conversation' } })).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    expect(tx.execute).toHaveBeenCalledOnce();
  }
});

it('paid asset receipts can attach for a completed authorized run, while terminal budgets cannot', async () => {
  const input = { projectId: 'project', gameId: 'game', origin: { role: 'gm' as const, runId: 'run' } };
  await expect(assertImageOriginActive({ execute: vi.fn(async () => [{ status: 'completed' }]) } as any, input)).resolves.toBeUndefined();
  await expect(assertImageOriginActive({ execute: vi.fn(async () => [{ status: 'running', stop_reason: 'cost_budget_exhausted' }]) } as any, input)).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
});

it('checks the inherited cancellation signal after acquiring the image origin lock', async () => {
  const controller = new AbortController();
  await expect(withServerProviderHooks({ signal: controller.signal, beforeRequest: async () => async () => {} }, () =>
    assertImageOriginActive({ execute: vi.fn(async () => { controller.abort(new Error('Canceled after lock.')); return [{ status: 'running' }]; }) } as any,
      { projectId: 'project', gameId: 'game', origin: { role: 'gm', runId: 'run' } }))).rejects.toThrow('Canceled after lock');
});
