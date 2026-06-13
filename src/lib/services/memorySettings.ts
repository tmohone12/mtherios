import { MAX_BACKEND_CONTEXT_BUDGET, normalizeBackendContextBudget } from './backendTurnContext';

export const DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET = 800;

export const CONTEXT_BUDGET_STEPS = [
	0,
	8_000,
	12_000,
	16_000,
	24_000,
	32_000,
	48_000,
	64_000,
	96_000,
	128_000,
	160_000,
	MAX_BACKEND_CONTEXT_BUDGET,
] as const;

export function contextBudgetSliderIndexToValue(index: unknown): number {
	const numeric = typeof index === 'number' ? index : Number(index);
	const bounded = Number.isFinite(numeric)
		? Math.min(CONTEXT_BUDGET_STEPS.length - 1, Math.max(0, Math.round(numeric)))
		: 0;
	return CONTEXT_BUDGET_STEPS[bounded] ?? 0;
}

export function contextBudgetValueToSliderIndex(value: unknown): number {
	const budget = normalizeBackendContextBudget(value);
	if (budget <= 0) return 0;

	let bestIndex = 1;
	let bestDistance = Math.abs(CONTEXT_BUDGET_STEPS[1] - budget);
	for (let index = 2; index < CONTEXT_BUDGET_STEPS.length; index += 1) {
		const distance = Math.abs(CONTEXT_BUDGET_STEPS[index] - budget);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestIndex = index;
		}
	}
	return bestIndex;
}

export function formatTokenBudgetCompact(value: unknown): string {
	const budget = normalizeBackendContextBudget(value);
	if (budget <= 0) return 'Auto';
	if (budget >= 1_000_000) return `${(budget / 1_000_000).toFixed(1)}M`;
	if (budget >= 1000) return `${Math.round(budget / 1000)}K`;
	return String(budget);
}
