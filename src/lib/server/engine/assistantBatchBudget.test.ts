import { describe, expect, it } from 'vitest';
import { batchConsumedCost, childCostReservation, configuredAssistantBatchBudget, estimatedBatchUsageCost } from './assistantBatchBudget';

describe('Assistant batch spend reservation', () => {
  const budget = configuredAssistantBatchBudget({ batchBudget: {
    maxCostUsd: 1, inputUsdPerMillion: 2, outputUsdPerMillion: 10,
  } }, 4096);

  it('requires saved pricing and reserves a bounded request before sending', () => {
    expect(() => configuredAssistantBatchBudget({}, 4096)).toThrow('Configure Batch Authoring');
    const reserved = childCostReservation(budget, 'system', 'prompt');
    expect(reserved).toMatchObject({ outputTokens: 4096 });
    expect(reserved.inputTokens).toBeGreaterThan(512);
    expect(reserved.costUsd).toBeGreaterThan(0.04);
    expect(() => childCostReservation(budget, 'system', 'x'.repeat(32_000))).toThrow('input exceeds');
  });

  it('keeps reported, estimated and unknown cost distinct', () => {
    expect(estimatedBatchUsageCost(budget, { inputTokens: 100, outputTokens: 50 })).toBe(0.0007);
    expect(estimatedBatchUsageCost(budget, { inputTokens: null, outputTokens: 50 })).toBeNull();
    expect(batchConsumedCost([{ report: { providerAttempted: true, reservedCostUsd: 0.08 }, usage: null }])).toBe(0.08);
    expect(batchConsumedCost([{ report: { providerAttempted: true }, usage: null }])).toBeNull();
    expect(batchConsumedCost([{ report: { providerAttempted: true, reservedCostUsd: 0.08 },
      usage: { providerCostUsd: 0.02, estimatedCostUsd: 0.03 } }])).toBe(0.03);
  });
});
