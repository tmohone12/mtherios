import { describe, expect, it } from 'vitest';
import { npcAgencySchema, readNpcAgency } from './npcAgency';
import { worldStateCharacterSchema } from '$lib/services/ai/tools/schemas';

describe('NPC agency contract', () => {
	it('keeps explicit cleared fields empty instead of resurrecting old intent or inferring plans from history', () => {
		expect(readNpcAgency({ currentPlan: null, goals: ['Find a patron'], eventMemory: { did: ['Opened the gate'] } }, {
			currentPlan: 'Bribe the old steward', constraint: 'Will not endanger her brother',
		})).toEqual({ currentPlan: null, constraint: 'Will not endanger her brother' });
		expect(npcAgencySchema.safeParse({ currentPlan: { hidden: 'invented' } }).success).toBe(false);
	});
	it('allows partial intent updates and explicit clears, but requires evidence for a completed move', () => {
		expect(worldStateCharacterSchema.parse({ name: 'Mira', currentPlan: null, nextOpportunity: 'Meet her cousin tomorrow' })).toMatchObject({ currentPlan: null, nextOpportunity: 'Meet her cousin tomorrow' });
		expect(worldStateCharacterSchema.safeParse({ name: 'Mira', lastIndependentAction: 'Asked her cousin for an apprenticeship.' }).success).toBe(false);
		expect(worldStateCharacterSchema.safeParse({ name: 'Mira', currentGoal: 'x'.repeat(601) }).success).toBe(false);
	});
});
