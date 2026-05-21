import { describe, expect, it } from 'vitest';
import { budgetPromptSections, getDynamicPromptBudget } from './ContextBudgetService';
import { countTokens } from '$lib/utils/tokens';

describe('getDynamicPromptBudget', () => {
	it('caps the auto budget for large adventure models', () => {
		expect(getDynamicPromptBudget(128000, 0, 'adventure')).toBe(12000);
	});

	it('keeps small-context models inside a model-aware ceiling', () => {
		expect(getDynamicPromptBudget(8192, 0, 'adventure')).toBeLessThanOrEqual(2457);
	});

	it('uses a smaller hard cap for creative-writing mode', () => {
		expect(getDynamicPromptBudget(128000, 0, 'creative-writing')).toBe(3600);
	});

	it('honors the memory settings token cap', () => {
		expect(getDynamicPromptBudget(128000, 0, 'adventure', 2400)).toBe(2400);
	});
});

describe('budgetPromptSections', () => {
	it('keeps short sections unchanged', () => {
		const result = budgetPromptSections(
			[
				{ key: 'characters', text: '## Characters\n- A' },
				{ key: 'finalInstructions', text: '## Final\nContinue.' },
			],
			{ totalBudget: 1200 },
		);

		expect(result.text).toContain('## Characters');
		expect(result.text).toContain('## Final');
		expect(result.truncated).toEqual([]);
	});

	it('truncates oversized low-budget sections', () => {
		const longLore = `## World Lore\n${'ancient pact '.repeat(800)}`;
		const result = budgetPromptSections(
			[
				{ key: 'lore', text: longLore },
				{ key: 'finalInstructions', text: '## Final Instructions\nStop when input is needed.' },
			],
			{ totalBudget: 260 },
		);

		expect(result.truncated).toContain('lore');
		expect(countTokens(result.text)).toBeLessThan(countTokens(longLore));
		expect(result.text).toContain('## Final Instructions');
	});
});
