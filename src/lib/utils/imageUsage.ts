export function imageUsageCostLabel(usage: Record<string, unknown> | null | undefined): string {
  const reported = usage?.costUsd ?? usage?.cost_usd ?? usage?.cost;
  const estimated = usage?.estimatedCostUsd;
  const providerCost = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 ? reported : null;
  const estimate = typeof estimated === 'number' && Number.isFinite(estimated) && estimated >= 0 ? estimated : null;
  if (providerCost !== null && estimate !== null) return `provider-reported ${providerCost} USD · catalog estimate ${estimate} USD`;
  if (providerCost !== null) return `provider-reported ${providerCost} USD`;
  if (estimate !== null) return `catalog estimate ${estimate} USD`;
  return 'cost unknown';
}
