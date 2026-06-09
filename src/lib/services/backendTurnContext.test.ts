import { describe, expect, it } from 'vitest';
import { MAX_BACKEND_CONTEXT_BUDGET, normalizeBackendContextBudget } from './backendTurnContext';
import { turnRequestSchema } from '$lib/contracts/memory';

describe('backend turn context budget', () => {
	it('clamps oversized saved context budgets before terminal turn validation', () => {
		const contextBudget = normalizeBackendContextBudget(2_000_000);

		expect(contextBudget).toBe(MAX_BACKEND_CONTEXT_BUDGET);
		expect(() => turnRequestSchema.parse({
			storyId: 'story_alpha',
			clientTurnId: 'turn_alpha',
			playerText: 'I look around.',
			clientContext: { contextBudget },
		})).not.toThrow();
	});

	it('keeps auto and invalid context budgets as auto', () => {
		expect(normalizeBackendContextBudget(0)).toBe(0);
		expect(normalizeBackendContextBudget(-1)).toBe(0);
		expect(normalizeBackendContextBudget(Number.NaN)).toBe(0);
	});
});
