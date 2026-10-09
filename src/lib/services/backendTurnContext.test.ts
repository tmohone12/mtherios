import { describe, expect, it } from 'vitest';
import { MAX_BACKEND_CONTEXT_BUDGET, normalizeBackendContextBudget, latestStoredContextReceipt, recordedDynamicContextBudget } from './backendTurnContext';
import { turnContextReceiptSchema, turnRequestSchema } from '$lib/contracts/memory';

describe('backend turn context budget', () => {
	it('restores the newest valid receipt for this story and ignores foreign or malformed entry metadata', () => {
		const receipt = (turnId: string, storyId = 'story_alpha') => turnContextReceiptSchema.parse({ turnId, storyId, included: {}, budgets: {} });
		const entries = [
			{ type: 'narration', position: 2, metadata: { contextReceipt: receipt('old') } },
			{ type: 'narration', position: 8, metadata: { contextReceipt: receipt('foreign', 'other_story') } },
			{ type: 'narration', position: 9, metadata: { contextReceipt: { storyId: 'story_alpha' } } },
			{ type: 'narration', position: 4, metadata: { contextReceipt: receipt('latest') } },
			{ type: 'user_action', position: 10, metadata: { contextReceipt: receipt('wrong_type') } },
		];
		expect(latestStoredContextReceipt(entries, 'story_alpha')?.turnId).toBe('latest');
		expect(latestStoredContextReceipt(entries, 'no_matching_story')).toBeNull();
		expect(entries[0].position).toBe(2);
	});
	it('compares retained dynamic context with its recorded budget, independently of total request size', () => {
		const receipt = turnContextReceiptSchema.parse({ turnId: 't', storyId: 's', included: { totalTokens: 3000 }, budgets: { dynamicContextTokensMax: 1000 }, selection: { version: 1, groups: [], sections: [{ id: 'context', label: 'Scene', tokens: 500, chars: 1600 }] } });
		expect(recordedDynamicContextBudget(receipt)).toEqual({ used: 500, max: 1000, percent: 50 });
		expect(recordedDynamicContextBudget({ ...receipt, budgets: { ...receipt.budgets, dynamicContextTokensMax: undefined } })).toBeNull();
		expect(recordedDynamicContextBudget({ ...receipt, budgets: { ...receipt.budgets, dynamicContextTokensMax: 0 } })).toBeNull();
	});
	it('accepts structured player modes, including the OOC control lane', () => {
		const base = {
			storyId: 'story_alpha',
			clientTurnId: 'turn_alpha',
			playerText: 'OOC: keep this scene grounded.',
		};

		expect(turnRequestSchema.parse({ ...base, actionType: 'ooc' }).actionType).toBe('ooc');
		expect(turnRequestSchema.parse({ ...base, actionType: 'think' }).actionType).toBe('think');
		expect(turnRequestSchema.safeParse({ ...base, actionType: 'aside' }).success).toBe(false);
	});

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
