import { afterEach, expect, it, vi } from 'vitest';
import { reuseQueryEmbedding, withQueryEmbeddingReuse } from './queryEmbeddingReuse';
import { embedMemoryText, type MemoryEmbeddingConfig } from '$lib/server/memory/embeddings';
import { createAgentRuntimeBudget, withAgentRuntimeBudget, type AgentRuntimeState } from './agentRuntime';

afterEach(() => vi.unstubAllGlobals());
const config: MemoryEmbeddingConfig = { provider: 'openai-compatible', model: 'query-model', baseUrl: 'https://embed.test/v1',
  apiKey: 'fixture-secret', customUrl: '', batchSize: 8, dimensions: 2 };
const fetcher = () => vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }], usage: { prompt_tokens: 7, total_tokens: 7 } })));
const state = (): AgentRuntimeState => ({ messages: [], budget: createAgentRuntimeBudget() });

it('reuses unchanged query vectors across fresh preparation scopes without charging a fictitious provider call', async () => {
  const fetch = fetcher(); vi.stubGlobal('fetch', fetch); const ledger = state(); const receipts: unknown[] = [];
  await withQueryEmbeddingReuse({ revision: async () => 'game:source:settings:v1' }, async () => {
    for (let round = 0; round < 3; round++) await withAgentRuntimeBudget({ state: ledger, limits: { maxRequests: 3 },
      onSave: async () => {}, onRequest: (_, index) => { receipts.push(index); } }, async () => {
      expect(await embedMemoryText('Read the letter', config)).toEqual([1, 0]);
      expect(await embedMemoryText('Letter scene', config)).toEqual([1, 0]);
    });
  });
  expect(fetch).toHaveBeenCalledTimes(2); expect(receipts).toEqual([1, 2]);
  expect(ledger.budget).toMatchObject({ modelRequests: 2, consumedTokens: 14, reservedTokens: 0, unknownUsage: true });
});

it.each(['world', 'source', 'profile', 'tools', 'model', 'key', 'dimensions', 'endpoint', 'query'])('invalidates after %s changes', async change => {
  const fetch = fetcher(); vi.stubGlobal('fetch', fetch); let revision = 'v1';
  await withQueryEmbeddingReuse({ revision: async () => revision }, async () => {
    await embedMemoryText('same query', config);
    if (['world', 'source', 'profile', 'tools'].includes(change)) revision = 'v2';
    const cfg = { ...config, ...(change === 'model' ? { model: 'other-model' } : {}), ...(change === 'key' ? { apiKey: 'other-key' } : {}),
      ...(change === 'dimensions' ? { dimensions: 3 } : {}), ...(change === 'endpoint' ? { baseUrl: 'https://other.test' } : {}) };
    await embedMemoryText(change === 'query' ? 'different query' : 'same query', cfg);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not cache a failure or reuse across invocations/restarts/private scopes', async () => {
  const dispatch = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue([[1, 0]]);
  const work = () => reuseQueryEmbedding({ text: 'private query' }, undefined, dispatch);
  await withQueryEmbeddingReuse({ revision: async () => 'v1' }, async () => { await expect(work()).rejects.toThrow('failed'); await work(); await work(); });
  await withQueryEmbeddingReuse({ revision: async () => 'v1' }, work);
  expect(dispatch).toHaveBeenCalledTimes(3);
});

it('keeps concurrent scopes and returned mutable vectors independent', async () => {
  const dispatch = vi.fn(async () => [[1, 0]]);
  await Promise.all(['game-a', 'game-b'].map(game => withQueryEmbeddingReuse({ revision: async () => game }, async () => {
    const first = await reuseQueryEmbedding('same-input', undefined, dispatch); first[0][0] = 999;
    expect(await reuseQueryEmbedding('same-input', undefined, dispatch)).toEqual([[1, 0]]);
  })));
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it('rejects cancelled and terminal runs before a cache hit, without resetting their budget', async () => {
  const controller = new AbortController(); let terminal = false; const dispatch = vi.fn(async () => [[1, 0]]);
  await withQueryEmbeddingReuse({ signal: controller.signal, revision: async () => { if (terminal) throw Error('request_budget_exhausted'); return 'v1'; } }, async () => {
    await reuseQueryEmbedding('same', undefined, dispatch); terminal = true;
    await expect(reuseQueryEmbedding('same', undefined, dispatch)).rejects.toThrow('request_budget_exhausted');
    terminal = false; controller.abort(new Error('cancelled'));
    await expect(reuseQueryEmbedding('same', undefined, dispatch)).rejects.toThrow('cancelled');
  });
  expect(dispatch).toHaveBeenCalledOnce();
});

it('does not populate the cache after revision change or cancellation during dispatch', async () => {
  let revision = 'v1'; const dispatch = vi.fn(async () => { revision = 'v2'; return [[1, 0]]; });
  await withQueryEmbeddingReuse({ revision: async () => revision }, async () => {
    await reuseQueryEmbedding('query', undefined, dispatch); await reuseQueryEmbedding('query', undefined, dispatch);
  });
  expect(dispatch).toHaveBeenCalledTimes(2);
  const controller = new AbortController();
  await withQueryEmbeddingReuse({ revision: async () => 'v1', signal: controller.signal }, async () => {
    await expect(reuseQueryEmbedding('query', undefined, async () => { controller.abort(new Error('late cancelled')); return [[1, 0]]; })).rejects.toThrow('late cancelled');
  });
});
