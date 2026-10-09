import { describe, expect, it } from 'vitest';
import { buildFactionMovePlan, eligibleFactionMoveVariants } from './autonomy';

describe('bounded faction choices', () => {
	it('offers only eligible unique moves and lets the planner validate a selected variant', () => {
		const variants = eligibleFactionMoveVariants('commercial', false);
		expect(variants).toEqual([{ actionType: 'intelligence', projectKind: null }]);
		const selected = eligibleFactionMoveVariants('commercial', true).find((item) => item.projectKind === 'trade_contract');
		const plan = buildFactionMovePlan({ factionId: 'faction_harbor', factionName: 'Harbor Guild', factionKind: 'commercial',
			pressure: 80, currentTurn: 12, fallbackGoals: ['Secure trade routes'], variant: selected });
		expect(plan.actionType).toBe('economic');
		expect(plan.projectKind).toBe('trade_contract');
		expect(plan.startProject?.projectKind).toBe('trade_contract');
	});
});
