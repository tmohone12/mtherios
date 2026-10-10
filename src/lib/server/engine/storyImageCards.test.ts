import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => fixture }));
import { recordStoryImageCard } from './storyImageCards';
beforeEach(() => {
  fixture.execute.mockReset(); fixture.transaction.mockReset();
  fixture.transaction.mockImplementation((work: (tx: unknown) => Promise<void>) => work(fixture));
});
const input = { projectId: 'project', gameId: 'game', jobId: 'job', runId: 'run', callId: 'call', tool: 'generateImage' as const, assetId: 'asset', applied: false };

it('stores the card under the same locked run transaction as origin validation', async () => {
  fixture.execute.mockResolvedValueOnce([{ client_turn_id: 'turn', status: 'running' }]).mockResolvedValue([]);
  await recordStoryImageCard(input);
  expect(fixture.transaction).toHaveBeenCalledOnce(); expect(fixture.execute).toHaveBeenCalledTimes(2);
  const query = fixture.execute.mock.calls[0][0].queryChunks.flatMap((chunk: { value?: unknown[] }) => chunk.value ?? []).join('');
  expect(query).toContain("t.status='reserved'"); expect(query).toContain('for update of r'); expect(query).toContain("j.payload->'origin'");
});

it('canceled or over-budget origins store no story image card', async () => {
  for (const origin of [{ client_turn_id: 'turn', status: 'cancelled' }, { client_turn_id: 'turn', status: 'running', stop_reason: 'cost_budget_exhausted' }]) {
    fixture.execute.mockClear(); fixture.execute.mockResolvedValueOnce(origin ? [origin] : []);
    await recordStoryImageCard(input); expect(fixture.execute).toHaveBeenCalledOnce();
  }
});
