import type { ServerGenerationUsage } from '$lib/server/turn/provider';

export type AssistantUsageRow = { model: string; durationMs: number; usage: ServerGenerationUsage };

export function summarizeAssistantUsage(rows: AssistantUsageRow[], attemptedCalls = rows.length) {
  const unaccountedCalls = Math.max(0, attemptedCalls - rows.length);
  const sum = (key: keyof ServerGenerationUsage) =>
    rows.length && !unaccountedCalls && rows.every(row => typeof row.usage[key] === 'number' && Number.isFinite(row.usage[key]))
      ? rows.reduce((total, row) => total + (row.usage[key] as number), 0)
      : null;
  return {
    model: rows.at(-1)?.model ?? null,
    durationMs: rows.reduce((total, row) => total + row.durationMs, 0),
    requestTokens: sum('requestTokens'),
    responseTokens: sum('responseTokens'),
    totalTokens: sum('totalTokens'),
    providerCostUsd: sum('providerCostUsd'),
    estimatedCostUsd: sum('estimatedCostUsd'),
    attemptedCalls,
    completedCalls: rows.length,
    unaccountedCalls,
    calls: rows,
  };
}

export function assistantRunUsage(result: unknown) {
  if (!result || typeof result !== 'object') return summarizeAssistantUsage([]);
  const record = result as Record<string, unknown>;
  const rows = Array.isArray(record.usageRows) ? record.usageRows as AssistantUsageRow[] : [];
  const attemptedCalls = typeof record.attemptedCalls === 'number' && Number.isInteger(record.attemptedCalls) && record.attemptedCalls >= rows.length
    ? record.attemptedCalls : rows.length;
  return summarizeAssistantUsage(rows, attemptedCalls);
}
