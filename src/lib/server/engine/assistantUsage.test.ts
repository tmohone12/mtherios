import { describe, expect, it } from 'vitest';
import { assistantRunUsage, summarizeAssistantUsage, type AssistantUsageRow } from './assistantUsage';

const row = (cost: number | null, tokens: number | null): AssistantUsageRow => ({
  model: 'test-model', durationMs: 100,
  usage: { requestTokens: tokens, responseTokens: 10, totalTokens: tokens === null ? null : tokens + 10,
    inputTokens: tokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0,
    providerCostUsd: cost, estimatedCostUsd: null },
});

describe('Assistant provider usage attribution', () => {
  it('sums fully reported calls, including provider-reported zero cost', () => {
    expect(summarizeAssistantUsage([row(0, 100), row(0.02, 200)])).toMatchObject({
      totalTokens: 320, providerCostUsd: 0.02, estimatedCostUsd: null,
      attemptedCalls: 2, completedCalls: 2, unaccountedCalls: 0,
    });
  });

  it('does not present partial provider cost or tokens as a complete total', () => {
    expect(summarizeAssistantUsage([row(0.01, 100), row(null, null)])).toMatchObject({
      totalTokens: null, providerCostUsd: null, attemptedCalls: 2, unaccountedCalls: 0,
    });
    expect(assistantRunUsage({ usageRows: [row(0.01, 100)], attemptedCalls: 2 })).toMatchObject({
      totalTokens: null, providerCostUsd: null, attemptedCalls: 2, completedCalls: 1, unaccountedCalls: 1,
    });
  });
});
