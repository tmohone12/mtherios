import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
 mode: 'success', calls: 0,
 story: { id: 'accounting-story', currentTurn: 5, currentWorldTime: 'Day 1', serverVersion: 1, metadata: {} } as any,
 receipts: new Map<string, any>(), writes: 0,
}));

vi.mock('$lib/server/db/client', () => {
 const query = (table: any): any => {
  const rows = () => {
   const name = table?.[Symbol.for('drizzle:Name')];
   return name === 'stories' ? [state.story] : name === 'story_threads' ? [{ id: 'request', description: 'A request for relief remains open.', status: 'open' }] : [];
  };
  const chain: any = { then: (resolve: any, reject: any) => Promise.resolve(rows()).then(resolve, reject) };
  for (const method of ['where', 'orderBy', 'limit', 'for']) chain[method] = () => chain;
  return chain;
 };
 const db: any = {
  execute: async () => [{ acquired: true }],
  select: () => ({ from: (table: any) => query(table) }),
  update: () => ({ set: (value: any) => ({ where: async () => { Object.assign(state.story, value); } }) }),
  transaction: async (work: any) => work(db),
 };
 return { getDb: () => db };
});
vi.mock('$lib/server/engine/llmSettings', () => ({
 resolveServiceGeneration: async () => ({ profile: { id: 'mock', providerType: 'openai-compatible', name: 'Mock' }, generation: { model: 'mock-model' } }),
 requireResolvedServiceProfile: (_: string, resolved: any) => resolved.profile,
}));
vi.mock('$lib/server/engine/apiCallLogs', () => ({ recordApiCallLog: async (input: any, options?: { id: string }) => {
 state.writes++;
 const id = options?.id ?? `fallback-${state.writes}`;
 state.receipts.set(id, input);
 return { id };
} }));
vi.mock('$lib/server/turn/provider', async importOriginal => {
 const actual = await importOriginal<typeof import('$lib/server/turn/provider')>();
 return { ...actual, parseJsonFromGeneratedText: JSON.parse, generateServerTextWithMetrics: async (input: any) => {
  state.calls++;
  const usage = { requestTokens: 30, responseTokens: 8, totalTokens: 38, inputTokens: 30, outputTokens: 8,
   cachedInputTokens: 10, cacheWriteTokens: null, reasoningTokens: 2, estimatedCostUsd: null, providerCostUsd: 0.005 };
  const attempt = { attemptId: 'provider-attempt', providerRequestId: 'provider-request', requestHash: 'hash', attempt: 0,
   startedAt: '2026-10-03T00:00:00Z', model: 'mock-model', endpoint: 'https://example.test/chat',
   status: state.mode === 'failure' ? 'error' : 'success', statusCode: state.mode === 'failure' ? 503 : 200,
   durationMs: 1, promptChars: input.prompt.length, responseChars: 15,
   finishReason: state.mode === 'truncated' ? 'length' : 'stop', usage: state.mode === 'missing' ? undefined : usage,
   error: state.mode === 'failure' ? 'Provider unavailable.' : null,
  };
  await input.onAttempt?.(attempt);
  const result = { model: attempt.model, endpoint: attempt.endpoint, durationMs: 1, promptChars: attempt.promptChars,
   responseChars: 15, finishReason: attempt.finishReason, usage: attempt.usage, attempts: [attempt] };
  if (state.mode === 'failure') throw new actual.ServerGenerationError('Provider unavailable.', result as any);
  return { ...result, text: state.mode === 'invalid' ? '{' : '{"forecasts":[]}' };
 } };
});

import { reviewGardener } from './workflow';

beforeEach(() => {
 state.mode = 'success'; state.calls = 0; state.writes = 0; state.receipts.clear();
 state.story = { id: 'accounting-story', currentTurn: 5, currentWorldTime: 'Day 1', serverVersion: 1, metadata: {} };
});

describe('faction provider accounting', () => {
 it('retains usage and provider identity once across callback and result logging', async () => {
  expect(await reviewGardener(state.story.id)).toMatchObject({ status: 'reviewed', forecastCount: 0 });
  expect(state.calls).toBe(1); expect(state.receipts.size).toBe(1);
  expect(state.receipts.get('provider-attempt')).toMatchObject({ status: 'success', requestTokens: 30, responseTokens: 8,
   metadata: { providerRequestId: 'provider-request', providerCostUsd: 0.005, cachedInputTokens: 10, reasoningTokens: 2 } });
 });
 it.each(['failure', 'truncated', 'invalid'])('retains %s attempt usage and coalesces unchanged failure', async mode => {
  state.mode = mode;
  expect(await reviewGardener(state.story.id)).toMatchObject({ status: 'held', forecastCount: 0 });
  expect(state.calls).toBe(1); expect(state.receipts.size).toBe(1);
  expect(state.receipts.get('provider-attempt')).toMatchObject({ status: 'error', totalTokens: 38,
   metadata: { providerRequestId: 'provider-request', providerCostUsd: 0.005 } });
  expect(await reviewGardener(state.story.id)).toMatchObject({ status: 'skipped', reason: 'unchanged_context' });
  expect(state.calls).toBe(1);
 });
 it('keeps unavailable usage unknown rather than inventing a zero cost', async () => {
  state.mode = 'missing';
  expect(await reviewGardener(state.story.id)).toMatchObject({ status: 'reviewed' });
  expect(state.receipts.size).toBe(1);
  expect(state.receipts.get('provider-attempt')).toMatchObject({ requestTokens: null, responseTokens: null,
   metadata: { usageAvailable: false, providerCostUsd: null, costSource: 'unavailable' } });
 });
});
