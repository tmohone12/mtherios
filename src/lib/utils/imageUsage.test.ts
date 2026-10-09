import { expect, test } from 'vitest';
import { imageUsageCostLabel } from './imageUsage';

test('distinguishes image catalog estimates from provider-reported charges', () => {
  expect(imageUsageCostLabel({ estimatedCostUsd: 0.0085 })).toBe('catalog estimate 0.0085 USD');
  expect(imageUsageCostLabel({ cost: 0, estimatedCostUsd: 0.0085 })).toBe('provider-reported 0 USD · catalog estimate 0.0085 USD');
  expect(imageUsageCostLabel({ estimatedCostUsd: '0.0085' })).toBe('cost unknown');
});
