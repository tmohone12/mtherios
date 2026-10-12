import { describe, expect, it } from 'vitest';
import {
	characterResourceKey,
	gameplayEffectSchema,
	quoteInSource,
	readCampaignMeters,
	readCharacterResource,
	readCharacterSheet,
	readItemHolding,
	removeMisplacedMechanics,
	summarizeGameplayEffect,
	type GameplayEffectReceipt,
} from './gameplayEffects';
import { worldStateUpdateSchema } from '$lib/services/ai/tools/schemas';

const source = { quote: 'The arrow strikes Mira for 7 damage.' };

describe('gameplay effect contract', () => {
	it('parses each operation with evidence and defaults modality to occurred', () => {
		const effects = [
			{ op: 'resource_delta', entityId: 'entity_mira', resource: 'hp', delta: -7, source, mechanics: { roll: '1d8+2 = 7' } },
			{ op: 'resource_set', target: 'Mira', resource: 'hp', toMax: true, source },
			{ op: 'condition_add', target: 'Mira', condition: 'broken left arm', severity: 'severe', source },
			{ op: 'condition_update', target: 'Mira', conditionId: 'cond_1', detail: 'splinted', source },
			{ op: 'condition_remove', target: 'Mira', condition: 'poisoned', source },
			{ op: 'item_acquire', target: 'Mira', item: 'Healing Potion', quantity: 2, source },
			{ op: 'item_consume', target: 'Mira', item: 'Healing Potion', source },
			{ op: 'item_transfer', target: 'Mira', item: 'Rope', to: 'Bram', quantity: 1, source },
			{ op: 'item_equip', target: 'Mira', item: 'Shield', source },
			{ op: 'item_unequip', target: 'Mira', itemId: 'entity_item_1', item: 'Shield', source },
		];
		const parsed = effects.map(effect => gameplayEffectSchema.parse(effect));
		expect(parsed.every(effect => effect.modality === 'occurred')).toBe(true);
		expect(parsed[6]).toMatchObject({ quantity: 1, how: 'consumed' });
		expect(worldStateUpdateSchema.parse({ effects }).effects).toHaveLength(10);
	});

	it('rejects unknown keys, missing evidence, zero deltas and empty sets', () => {
		expect(gameplayEffectSchema.safeParse({ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -7, source, newTotal: 11 }).success).toBe(false);
		expect(gameplayEffectSchema.safeParse({ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -7 }).success).toBe(false);
		expect(gameplayEffectSchema.safeParse({ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: 0, source }).success).toBe(false);
		expect(gameplayEffectSchema.safeParse({ op: 'resource_set', target: 'Mira', resource: 'hp', source }).success).toBe(false);
		expect(gameplayEffectSchema.safeParse({ op: 'item_transfer', target: 'Mira', item: 'Rope', source }).success).toBe(false);
		expect(gameplayEffectSchema.safeParse({ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -3, modality: 'dreamed', source }).success).toBe(false);
	});

	it('reports mechanical values placed in characters, items, state_overrides or a Health meter', () => {
		const update = {
			characters: [{ name: 'Mira', hp: 11, injuries: ['arrow wound'], presentation: 'bloodied' }],
			items: [{ name: 'Rope', owner: 'Bram', quantity: 2 }],
			lorebook_entries: [{ name: 'Bram', type: 'character', description: 'A smith.', state_overrides: { health: 'wounded', mood: 'grim' } }],
			meter_changes: [{ name: 'Health', delta: -5 }, { name: 'Suspicion', delta: 2 }],
		};
		const [warning] = removeMisplacedMechanics(update);
		expect(warning).toContain('characters[0].hp');
		expect(warning).toContain('characters[0].injuries');
		expect(warning).toContain('items[0].owner');
		expect(warning).toContain('lorebook_entries[0].state_overrides.health');
		expect(warning).toContain('meter_changes[0] (Health)');
		expect(update.characters[0]).toEqual({ name: 'Mira', presentation: 'bloodied' });
		expect(update.items[0]).toEqual({ name: 'Rope', quantity: 2 });
		expect(update.lorebook_entries[0].state_overrides).toEqual({ mood: 'grim' });
		expect(update.meter_changes).toEqual([{ name: 'Suspicion', delta: 2 }]);
		expect(removeMisplacedMechanics({ characters: [{ name: 'Mira' }] })).toEqual([]);
	});

	it('matches quotes across whitespace, curly quotes and dashes, but not paraphrase', () => {
		const prose = 'Mira’s arm snaps — she\n  cries out.';
		expect(quoteInSource("Mira's arm snaps - she cries out.", prose)).toBe(true);
		expect(quoteInSource('Mira breaks her arm.', prose)).toBe(false);
		expect(quoteInSource('arm', prose)).toBe(false);
	});

	it('reads stored baselines without inventing them', () => {
		expect(characterResourceKey('Hit Points')).toBe('hp');
		expect(characterResourceKey('Spell Slots')).toBe('spell_slots');
		const sheet = readCharacterSheet({}, { originalMetadata: { playerSheet: { hitPoints: { current: 9, max: 12 } } } });
		expect(readCharacterResource(sheet, 'hp')).toEqual({ current: 9, max: 12 });
		expect(readCharacterResource(sheet, 'mana')).toBeNull();
		expect(readCharacterResource(null, 'hp')).toBeNull();
		expect(readCampaignMeters({ meters: [{ name: 'Supplies', value: 4, max: 10 }, { name: 'Broken', value: 'x', max: 5 }] }))
			.toEqual([{ name: 'Supplies', value: 4, max: 10, visible: true }]);
	});

	it('reads item holdings, treating a carried legacy record as the player\'s single item', () => {
		expect(readItemHolding({ inInventory: true, equipped: true }, 'mira')).toEqual({ ownerId: 'mira', quantity: 1, equipped: true });
		expect(readItemHolding({ inInventory: true }, null)).toEqual({ ownerId: null, quantity: null, equipped: false });
		expect(readItemHolding({ ownerId: 'bram', quantity: null }, 'mira')).toEqual({ ownerId: 'bram', quantity: null, equipped: false });
		expect(readItemHolding({ ownerId: 'mira', quantity: 0 }, 'mira')).toEqual({ ownerId: 'mira', quantity: 0, equipped: false });
	});

	it('summarizes receipts for the turn view', () => {
		const base: GameplayEffectReceipt = { effectId: 'e', effectKey: 'k', op: 'resource_delta', status: 'applied', targetKind: 'character', targetId: 'mira',
			targetName: 'Mira', subject: 'resource:hp', before: { current: 18, max: 18 }, after: { current: 11, max: 18 }, revision: 1, reason: null };
		expect(summarizeGameplayEffect(base).summary).toBe('Mira HP 18/18 → 11/18');
		expect(summarizeGameplayEffect({ ...base, op: 'item_consume', targetKind: 'item', targetName: 'Healing Potion', subject: 'item', before: { quantity: 1 }, after: { quantity: 0 } }).summary)
			.toBe('Healing Potion ×1 → ×0');
		expect(summarizeGameplayEffect({ ...base, status: 'unresolved', reason: 'Bram has no recorded HP.' }).summary).toBe('resource delta (Mira): Bram has no recorded HP.');
	});
});
