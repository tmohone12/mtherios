import { describe, expect, it } from 'vitest';
import { buildFactionMovePlan, eligibleFactionMoveVariants } from './autonomy';

describe('bounded faction choices', () => {
	it('offers only eligible unique moves and lets the planner validate a selected variant', () => {
		const variants = eligibleFactionMoveVariants('commercial', false);
		expect(variants).toEqual([{ actionType: 'internal', projectKind: null }, { actionType: 'intelligence', projectKind: null }]);
		expect(eligibleFactionMoveVariants('commercial', false, false)).toEqual([{ actionType: 'internal', projectKind: null }]);
		const selected = eligibleFactionMoveVariants('commercial', true).find((item) => item.projectKind === 'trade_contract');
		const plan = buildFactionMovePlan({ factionId: 'faction_harbor', factionName: 'Harbor Guild', factionKind: 'commercial',
			pressure: 80, currentTurn: 12, fallbackGoals: ['Secure trade routes'], variant: selected,
			targetFaction: { id: 'faction_neighbor', name: 'Neighbor Guild' } });
		expect(plan.actionType).toBe('economic');
		expect(plan.projectKind).toBe('trade_contract');
		expect(plan.startProject?.projectKind).toBe('trade_contract');
	});
});
