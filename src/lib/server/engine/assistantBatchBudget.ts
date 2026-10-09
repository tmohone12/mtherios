import { z } from 'zod';
import { MutationError } from './mutationSafety';

const pricingSchema = z.object({
  maxCostUsd: z.number().positive().max(1000),
  inputUsdPerMillion: z.number().min(0).max(1000),
  outputUsdPerMillion: z.number().min(0).max(1000),
}).strict();

export const assistantBatchBudgetSchema = pricingSchema.extend({
  maxOutputTokens: z.number().int().min(128).max(4096),
});

export type AssistantBatchBudget = z.infer<typeof assistantBatchBudgetSchema>;

export function configuredAssistantBatchBudget(metadata: unknown, maxOutputTokens: number): AssistantBatchBudget {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : {};
  const envBudget = process.env.MYTHENGINE_BATCH_MAX_COST_USD !== undefined
    ? { maxCostUsd: Number(process.env.MYTHENGINE_BATCH_MAX_COST_USD),
        inputUsdPerMillion: Number(process.env.MYTHENGINE_BATCH_INPUT_USD_PER_MILLION),
        outputUsdPerMillion: Number(process.env.MYTHENGINE_BATCH_OUTPUT_USD_PER_MILLION) } : null;
  const parsed = pricingSchema.safeParse(record.batchBudget ?? envBudget);
  if (!parsed.success) throw new MutationError('BUDGET_REQUIRED',
    'Configure Batch Authoring maximum USD and upper-bound input/output prices in AI Services before planning paid helpers.');
  return assistantBatchBudgetSchema.parse({ ...parsed.data, maxOutputTokens: Math.min(Math.trunc(maxOutputTokens), 4096) });
}

function roundUpUsd(value: number) {
  return Math.ceil((value - Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function childCostReservation(budget: AssistantBatchBudget, system: string, prompt: string) {
  // A token cannot cover less than one UTF-8 byte; this intentionally over-reserves input.
  const inputTokens = Buffer.byteLength(system, 'utf8') + Buffer.byteLength(prompt, 'utf8') + 512;
  if (inputTokens > 32_000) throw new MutationError('BUDGET_EXCEEDED', 'Batch child input exceeds the 32,000-token reservation limit.');
  const outputTokens = budget.maxOutputTokens;
  const costUsd = roundUpUsd((inputTokens * budget.inputUsdPerMillion + outputTokens * budget.outputUsdPerMillion) / 1_000_000);
  return { inputTokens, outputTokens, costUsd };
}

export function estimatedBatchUsageCost(budget: AssistantBatchBudget, usage: unknown): number | null {
  const row = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : {};
  const inputTokens = row.inputTokens;
  const outputTokens = row.outputTokens;
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens < 0
    || typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens < 0) return null;
  return roundUpUsd((inputTokens * budget.inputUsdPerMillion + outputTokens * budget.outputUsdPerMillion) / 1_000_000);
}

export function batchConsumedCost(rows: Array<{ report: unknown; usage: unknown }>): number | null {
  let total = 0;
  for (const row of rows) {
    const report = row.report && typeof row.report === 'object' && !Array.isArray(row.report)
      ? row.report as Record<string, unknown> : {};
    if (report.providerAttempted !== true) continue;
    const usage = row.usage && typeof row.usage === 'object' && !Array.isArray(row.usage)
      ? row.usage as Record<string, unknown> : {};
    const known = [usage.providerCostUsd, usage.estimatedCostUsd]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const reserved = report.reservedCostUsd;
    if (!known.length && (typeof reserved !== 'number' || !Number.isFinite(reserved) || reserved < 0)) return null;
    total += known.length ? Math.max(...known) : reserved as number;
  }
  return roundUpUsd(total);
}
