import { describe, expect, it } from 'vitest';
import { abilityModifier, normalizePlayerSheet, resolveAbilityCheckNotation } from '../playerSheet';

describe('player sheet', () => {
	it('keeps hit points within the saved maximum on every read', () => {
		expect(normalizePlayerSheet({ hitPoints: { current: 18, max: 7 } }).hitPoints).toEqual({ current: 7, max: 7 });
		expect(normalizePlayerSheet({ hitPoints: { max: 3 } }).hitPoints).toEqual({ current: 3, max: 3 });
	});

	it('applies canonical modifiers to qualified check labels', () => {
		const sheet = { abilities: { dex: 16, str: 14, cha: 8 } };
		expect(resolveAbilityCheckNotation('1d20+99', 'Dexterity (Stealth)', sheet)).toBe('1d20+3');
		expect(resolveAbilityCheckNotation('1d20+99', 'Strength saving throw', sheet)).toBe('1d20+2');
		expect(resolveAbilityCheckNotation('1d20+99', 'Strength (Intimidation)', sheet)).toBe('1d20+2');
	});
	it('normalizes the stored sheet and applies D&D baselines for missing values', () => {
		expect(normalizePlayerSheet({ abilities: { str: 16 }, hitPoints: { current: 7, max: 12 }, armorClass: 15 })).toMatchObject({
			abilities: { str: 16, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
			hitPoints: { current: 7, max: 12 },
			armorClass: 15,
		});
		expect(abilityModifier(16)).toBe(3);
		expect(abilityModifier(9)).toBe(-1);
	});

	it('uses the saved ability modifier for ability and skill checks', () => {
		const sheet = { abilities: { dex: 16, cha: 8 } };
		expect(resolveAbilityCheckNotation('1d20+99', 'Stealth', sheet)).toBe('1d20+3');
		expect(resolveAbilityCheckNotation('1d20 advantage', 'CHA', sheet)).toBe('1d20-1 advantage');
		expect(resolveAbilityCheckNotation('2d6+4', 'DEX', sheet)).toBe('2d6+4');
	});
});
