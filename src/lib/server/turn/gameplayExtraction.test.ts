import { describe, expect, it } from 'vitest';
import { buildGameplayStatePacket, buildStateExtractionPrompt, stateExtractionNarration } from './promptPacket';
import { parseStateExtractionResult, shouldExtractDurableState, unsettledStateNotice } from './orchestrator';
import { keepEffectOwnedState } from '$lib/server/memory/canonical';
import { isDatabaseError } from './gameplayEffects';
import { projectItemState } from '$lib/utils/itemProjection';

const mira = { id: 'entity_mira', name: 'Mira', state: { relationship: 'self', playerSheet: { hitPoints: { current: 11, max: 18 } },
	conditions: [{ id: 'cond_arm', name: 'broken left arm', severity: 'severe', detail: null, sourceEntryId: 'n1', updatedEntryId: 'n1' }] }, metadata: {} };
const bram = { id: 'entity_bram', name: 'Bram', state: {}, metadata: {} };

describe('gameplay extraction', () => {
	it('sends damage, healing and item use to the Classifier even when the prose says nothing changes', () => {
		expect(shouldExtractDurableState('I drink the potion.', 'Nothing changes around you.')).toBe(true);
		expect(shouldExtractDurableState('I wait.', 'The blade struck true. Nothing changes.')).toBe(true);
		expect(shouldExtractDurableState('I wait.', 'Nothing changes. {{dice:1d20|4|4|12|fail|Dexterity|dodge}}')).toBe(true);
		expect(shouldExtractDurableState('I wait.', 'Nothing changes; the night is quiet.')).toBe(false);
		// Ordinary dialogue words are not consequences ("don't", "lost in thought").
		expect(shouldExtractDurableState("I don't know.", "He is lost in thought; nothing changes.")).toBe(false);
		expect(shouldExtractDurableState('I wait.', 'She is donning her cloak. Nothing changes.')).toBe(true);
	});

	it('shows roll results to the Classifier as readable lines', () => {
		expect(stateExtractionNarration('The arrow flies.\n\n{{dice:1d20+3|14|17|15|pass|Dexterity|dodge the arrow}}\n\nShe ducks.'))
			.toBe('The arrow flies.\n\n[Roll: Dexterity check (dodge the arrow): 1d20+3 = 17 (natural 14) vs DC 15, success]\n\nShe ducks.');
		expect(stateExtractionNarration('{{dice:1d20|1|1|10|fail|Strength|lift|crit-failure}}')).toContain('failure, critical failure]');
	});

	it('gives the Classifier current HP, conditions, held items and campaign meters with ids', () => {
		const items = [
			{ id: 'item_potion', name: 'Healing Potion', state: { ownerId: 'entity_mira', quantity: 2 } },
			{ id: 'item_used', name: 'Old Torch', state: { ownerId: 'entity_mira', quantity: 0 } },
			{ id: 'item_idol', name: 'Jade Idol', state: { location: 'altar' } },
		];
		const packet = buildGameplayStatePacket([mira, bram], items, { meters: [{ name: 'Supplies', value: 4, max: 10 }] }, 'I look at Bram.', 'Bram eyes the Jade Idol on the altar.');
		const data = JSON.parse(packet.split('\n')[1]);
		expect(data.characters[0]).toEqual({ entityId: 'entity_mira', name: 'Mira', player: true, hp: '11/18',
			conditions: [{ conditionId: 'cond_arm', name: 'broken left arm', severity: 'severe' }],
			items: [{ itemId: 'item_potion', name: 'Healing Potion', quantity: 2, equipped: false }, { itemId: 'item_used', name: 'Old Torch', quantity: 0, equipped: false }] });
		expect(data.characters[1]).toMatchObject({ entityId: 'entity_bram', hp: 'not recorded', items: [] });
		expect(data.unheldItems).toEqual([{ itemId: 'item_idol', name: 'Jade Idol' }]);
		expect(data.campaignMeters).toEqual([{ name: 'Supplies', value: 4, max: 10, visible: true }]);
		const prompt = buildStateExtractionPrompt('I look at Bram.', 'Bram eyes the idol.', undefined, [mira, bram], [], [], [], undefined, [], items);
		expect(prompt).toContain('GAMEPLAY EFFECTS');
		expect(prompt).toContain('CURRENT GAMEPLAY STATE');
		expect(prompt).toContain('injuries are conditions in effects');
		expect(prompt).not.toContain('presentation contains current clothing, grooming, injuries');
	});

	it('keeps the parts of an answer that are valid and reports a nested HP value', () => {
		const parsed = parseStateExtractionResult(JSON.stringify({ update: { characters: [{ name: 'Mira', hp: 11, presentation: 'bloodied' }],
			effects: [{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -7, source: { quote: 'The arrow strikes Mira for 7 damage.' } }] }, dueEventFeedback: [] }));
		expect(parsed.update.characters[0]).not.toHaveProperty('hp');
		expect(parsed.update.effects).toHaveLength(1);
		expect(parsed.warnings).toEqual([expect.stringContaining('characters[0].hp')]);
		expect(parsed.operationCount).toBe(2);
	});

	it('tells the GM and player when an earlier turn\'s state is pending or failed', () => {
		expect(unsettledStateNotice([])).toBeNull();
		expect(unsettledStateNotice([{ status: 'failed', lastError: 'Provider returned 402' }, { status: 'queued', lastError: null }]))
			.toBe('State from 1 recent turn(s) could not be saved (Provider returned 402). State from 1 recent turn(s) is still being saved. HP, conditions and items may not include those turns yet.');
	});
});

describe('effect-owned state and the browser', () => {
	const current = { mechanicsRevision: 3, conditions: [{ id: 'cond_arm', name: 'broken left arm' }],
		playerSheet: { abilities: { str: 12 }, hitPoints: { current: 11, max: 18 } } };

	it('a save from an older projection keeps newer HP and conditions but the player\'s other edits', () => {
		const saved = keepEffectOwnedState(current, { mechanicsRevision: 2, bio: 'New bio.', playerSheet: { abilities: { str: 14 }, hitPoints: { current: 18, max: 18 } } });
		expect(saved).toMatchObject({ bio: 'New bio.', mechanicsRevision: 3, conditions: current.conditions,
			playerSheet: { abilities: { str: 14 }, hitPoints: { current: 11, max: 18 } } });
	});

	it('a save from the current projection that changes HP is an explicit edit and a new revision', () => {
		const saved = keepEffectOwnedState(current, { mechanicsRevision: 3, playerSheet: { abilities: { str: 12 }, hitPoints: { current: 15, max: 18 } } });
		expect(saved).toMatchObject({ mechanicsRevision: 4, playerSheet: { hitPoints: { current: 15, max: 18 } } });
		expect(keepEffectOwnedState({ bio: 'x' }, { bio: 'y' })).toEqual({ bio: 'y' });
	});

	it('shows 0 as none left, unknown amounts as unknown and carried items as not equipped', () => {
		expect(projectItemState({ ownerId: 'mira', quantity: 0 })).toMatchObject({ quantity: 0, quantityKnown: true, location: 'inventory' });
		expect(projectItemState({ ownerId: 'mira', quantity: null })).toMatchObject({ quantityKnown: false });
		expect(projectItemState({ inInventory: true })).toMatchObject({ equipped: false, location: 'inventory', quantity: 1 });
		expect(projectItemState({ location: 'altar' })).toMatchObject({ location: 'altar', ownerId: null });
	});
});

describe('effect application errors', () => {
	it('recognizes database errors, directly or wrapped', () => {
		expect(isDatabaseError(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(true);
		expect(isDatabaseError(new Error('Failed query', { cause: Object.assign(new Error('aborted'), { name: 'PostgresError', code: '25P02' }) }))).toBe(true);
		expect(isDatabaseError(new Error('Unexpected effect shape'))).toBe(false);
	});
});
