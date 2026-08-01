import { describe, expect, it } from 'vitest';
import {
	CONTEXT_BUDGET_STEPS,
	DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET,
	contextBudgetSliderIndexToValue,
	contextBudgetValueToSliderIndex,
	formatTokenBudgetCompact,
} from './memorySettings';

describe('memory settings helpers', () => {
	it('keeps the shared terminal memory packet default explicit', () => {
		expect(DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET).toBe(1200);
	});

	it('maps context slider positions to non-linear budget steps', () => {
		expect(contextBudgetSliderIndexToValue(0)).toBe(0);
		expect(contextBudgetSliderIndexToValue(1)).toBe(8000);
		expect(contextBudgetSliderIndexToValue(999)).toBe(CONTEXT_BUDGET_STEPS.at(-1));
		expect(contextBudgetSliderIndexToValue(Number.NaN)).toBe(0);
	});

	it('places arbitrary saved budgets on the nearest slider step', () => {
		expect(contextBudgetValueToSliderIndex(0)).toBe(0);
		expect(contextBudgetValueToSliderIndex(7800)).toBe(1);
		expect(contextBudgetValueToSliderIndex(33_000)).toBe(5);
		expect(contextBudgetValueToSliderIndex(2_000_000)).toBe(CONTEXT_BUDGET_STEPS.length - 1);
	});

	it('formats compact labels for the memory budget controls', () => {
		expect(formatTokenBudgetCompact(0)).toBe('Auto');
		expect(formatTokenBudgetCompact(32_000)).toBe('32K');
		expect(formatTokenBudgetCompact(200_000)).toBe('200K');
	});
});
