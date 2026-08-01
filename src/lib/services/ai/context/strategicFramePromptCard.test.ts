import { describe, expect, it } from 'vitest';
import { buildStrategicNarratorBlock, buildStrategicWorldSimBlock } from './strategicFramePromptCard';
import type { StrategicWorldFrame } from '$lib/types';

const frame = {
	storyId: 'story_alpha',
	arcNumber: 3,
	worldMood: { politicalTemperature: 'tense' },
	narratorPromptCard: 'Market rumors should create pressure without spoilers.',
	fastWorldSimInstructions: 'Let prices and rumors move first.',
	warPressureCard: null,
	factionOperations: [],
	strategicClocks: [],
	activationPlan: { activateNow: ['plot_flour_ring'], keepDormant: [], retireOrMerge: [], rationale: '' },
	plotCards: [{
		id: 'plot_flour_ring',
		title: 'The Flour Ring',
		logline: 'Merchants hide flour and blame the watch.',
		lifecycleStage: 'simmer',
		pressure: 66,
		urgency: 'emerging',
		visibility: 'rumored',
		playerTouchpoints: ['identical invoices', 'locked warehouses'],
		clueTrail: [{ clue: 'Two bakers repeat the same phrase.', delivery: 'rumor', truth: 'The phrase was planted.', visibility: 'subtle', evidenceRefs: [] }],
		pressureBeats: [{ title: 'Bread prices rise early', body: 'Bakers raise prices before public notice.', delayTurns: 2, urgency: 'emerging', visibility: 'player_known', actorEntityIds: [], targetEntityIds: [], locationIds: [], factionIds: [], memoryImpact: {} }],
		antiRailroadNotes: ['Do not force the player to visit the market.'],
	}],
} as unknown as StrategicWorldFrame;

describe('strategic frame prompt-card plot pressure', () => {
	it('shows narrator-safe plot cards without exposing hidden truths', () => {
		const block = buildStrategicNarratorBlock(frame);

		expect(block).toContain('Active plot pressure');
		expect(block).toContain('The Flour Ring');
		expect(block).toContain('identical invoices');
		expect(block).toContain('Agency guard: Do not force the player');
		expect(block).not.toContain('The phrase was planted');
	});

	it('feeds plot pressure beats to world simulation', () => {
		const block = buildStrategicWorldSimBlock(frame);

		expect(block).toContain('Plot pressure cards');
		expect(block).toContain('The Flour Ring');
		expect(block).toContain('Beat: Bread prices rise early');
		expect(block).toContain('clue: Two bakers repeat the same phrase.');
	});

	it('chooses the strongest linked canon antagonist for each active plot', () => {
		const block = buildStrategicNarratorBlock({
			...frame,
			plotCards: [{ ...frame.plotCards[0], antagonistCandidateIds: ['invented', 'watch_captain', 'merchant_ring'] }],
			antagonistCandidates: [
				{ id: 'invented', name: 'The Paper Devil', role: 'primary_antagonist', actorEntityId: null, actorFactionId: null, motive: 'Be feared.', method: 'Threats.', escalationTrigger: '', hesitationTrigger: '', lineTheyWillNotCross: '', plausibilityScore: 100, dramaticScore: 100, agencyRisk: 0 },
				{ id: 'watch_captain', name: 'Captain Vey', role: 'rival', actorEntityId: 'npc_vey', actorFactionId: null, motive: 'Protect the watch.', method: 'Quiet arrests.', escalationTrigger: 'the warehouses are searched', hesitationTrigger: 'innocents would be harmed', lineTheyWillNotCross: 'hurting children', plausibilityScore: 75, dramaticScore: 70, agencyRisk: 10 },
				{ id: 'merchant_ring', name: 'The Flour Consortium', role: 'subplot_antagonist', actorEntityId: null, actorFactionId: 'faction_flour', motive: 'Keep its monopoly.', method: 'Engineered shortages.', escalationTrigger: 'a ledger is found', hesitationTrigger: 'the guild fractures', lineTheyWillNotCross: 'burning its own stores', plausibilityScore: 85, dramaticScore: 80, agencyRisk: 8 },
				{ id: 'unlinked', name: 'The Unlinked Prince', role: 'primary_antagonist', actorEntityId: 'npc_prince', actorFactionId: null, motive: 'Rule.', method: 'War.', escalationTrigger: '', hesitationTrigger: '', lineTheyWillNotCross: '', plausibilityScore: 100, dramaticScore: 100, agencyRisk: 0 },
			],
		} as unknown as StrategicWorldFrame);

		expect(block).toContain('Antagonist pressure: The Flour Consortium [subplot_antagonist; faction faction_flour]');
		expect(block).toContain('Motive: Keep its monopoly.');
		expect(block).toContain('Method: Engineered shortages.');
		expect(block).not.toContain('The Paper Devil');
		expect(block).not.toContain('The Unlinked Prince');
	});
});
