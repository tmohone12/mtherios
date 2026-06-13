export const MAX_BACKEND_CONTEXT_BUDGET = 200_000;

export function normalizeBackendContextBudget(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return 0;
	return Math.min(Math.trunc(numeric), MAX_BACKEND_CONTEXT_BUDGET);
}
