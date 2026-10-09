import { turnContextReceiptSchema, type TurnContextReceipt } from '$lib/contracts/memory';

export const MAX_BACKEND_CONTEXT_BUDGET = 200_000;

export function normalizeBackendContextBudget(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return 0;
	return Math.min(Math.trunc(numeric), MAX_BACKEND_CONTEXT_BUDGET);
}

/** Restore saved diagnostics only from narration in this backend story. */
export function latestStoredContextReceipt(entries: Array<{ type: string; position: number; metadata?: unknown }>, storyId: string): TurnContextReceipt | null {
	for (const entry of [...entries].sort((a, b) => b.position - a.position)) {
		if (entry.type !== 'narration' || !entry.metadata || typeof entry.metadata !== 'object') continue;
		const parsed = turnContextReceiptSchema.safeParse((entry.metadata as Record<string, unknown>).contextReceipt);
		if (parsed.success && parsed.data.storyId === storyId) return parsed.data;
	}
	return null;
}

export function recordedDynamicContextBudget(receipt: TurnContextReceipt | null) {
	const max = receipt?.budgets.dynamicContextTokensMax;
	const used = receipt?.selection?.sections.find(section => section.id === 'context')?.tokens;
	if (max == null || max <= 0 || used == null) return null;
	return { used, max, percent: Math.min(100, used / max * 100) };
}
