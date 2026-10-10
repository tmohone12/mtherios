import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentRuntimeBudget, withAgentRuntimeBudget, type AgentRuntimeState } from '$lib/server/engine/agentRuntime';
import { withWikiQueryEmbedding, wikiQueryEmbeddingConfig } from './wikiQueryEmbedding';

afterEach(() => vi.unstubAllGlobals());
const env = { WIKI_EMBED_PROVIDER: 'openai-compatible', WIKI_EMBED_MODEL: 'wiki-model', WIKI_EMBED_BASE_URL: 'https://wiki-embed.test/v1', WIKI_EMBED_API_KEY: 'secret-wiki-token' };

it('preserves wiki settings while reserving the parent query and giving the child no paid embedding allowance', async () => {
  const state: AgentRuntimeState = { messages: [], budget: createAgentRuntimeBudget() };
  let saved: AgentRuntimeState | undefined, temporaryFile = '', receiptBody = '';
  const fetcher = vi.fn(async (_url, options) => {
    expect(saved?.budget.modelRequests).toBe(1);
    expect(JSON.parse(options.body)).toEqual({ model: 'wiki-model', input: 'Bridge promise' });
    return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }], usage: { prompt_tokens: 3, total_tokens: 3 } }));
  });
  vi.stubGlobal('fetch', fetcher);
  await withAgentRuntimeBudget({ state, onSave: async value => { saved = value; }, onRequest: (_options, _index, request) => { receiptBody = request.serializedBody; } }, () => withWikiQueryEmbedding('context.mjs', ['vault', 'Bridge promise', '--json'], env, async childEnv => {
    expect(childEnv.MYTHENGINE_WIKI_EMBED_MAX_REQUESTS).toBe('0');
    temporaryFile = childEnv.MYTHENGINE_WIKI_QUERY_EMBEDDING_FILE!;
    const file = await fs.readFile(temporaryFile, 'utf8');
    expect(JSON.parse(file)).toEqual({ queryHash: createHash('sha256').update('Bridge promise').digest('hex'), vector: [1, 0] });
    expect(file).not.toContain('secret-wiki-token');
  }));
  await expect(fs.stat(temporaryFile)).rejects.toThrow();
  expect(receiptBody).not.toContain('secret-wiki-token');
  expect(state.budget).toMatchObject({ modelRequests: 1, consumedTokens: 3 });
});

it('an exhausted query budget preserves an explicit exact-search fallback receipt and cannot call a provider', async () => {
  const state: AgentRuntimeState = { messages: [], budget: { ...createAgentRuntimeBudget(), modelRequests: 1 } };
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await withAgentRuntimeBudget({ state, limits: { maxRequests: 1 }, onSave: async () => {} }, () => withWikiQueryEmbedding('search.mjs', ['vault', 'Bridge'], env, async childEnv => {
    const file = JSON.parse(await fs.readFile(childEnv.MYTHENGINE_WIKI_QUERY_EMBEDDING_FILE!, 'utf8'));
    expect(file.error).toBe('request_budget_exhausted'); expect(file.vector).toBeUndefined();
  }));
  expect(fetcher).not.toHaveBeenCalled();
  expect(state.budget.stopReason).toBe('request_budget_exhausted');
});

it('retains standalone indexing and explicit exact search and respects caller model overrides', async () => {
  expect(wikiQueryEmbeddingConfig(['vault', 'Bridge', '--provider', 'local-hash', '--model', 'selected-model'], env)).toMatchObject({ provider: 'local-hash', model: 'selected-model' });
  await withWikiQueryEmbedding('index.mjs', ['vault'], env, async childEnv => { expect(childEnv).toBe(env); });
  await withAgentRuntimeBudget({ state: { messages: [], budget: createAgentRuntimeBudget() }, onSave: async () => {} }, () => withWikiQueryEmbedding('context.mjs', ['vault', 'Bridge', '--exact'], env, async childEnv => { expect(childEnv).toBe(env); }));
});
