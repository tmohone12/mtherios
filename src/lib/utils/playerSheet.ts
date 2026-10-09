import { parseDice } from './dice';

export const DND_ABILITIES = [
	{ id: 'str', label: 'STR', name: 'Strength' },
	{ id: 'dex', label: 'DEX', name: 'Dexterity' },
	{ id: 'con', label: 'CON', name: 'Constitution' },
	{ id: 'int', label: 'INT', name: 'Intelligence' },
	{ id: 'wis', label: 'WIS', name: 'Wisdom' },
	{ id: 'cha', label: 'CHA', name: 'Charisma' },
] as const;

export type DndAbility = typeof DND_ABILITIES[number]['id'];

export interface PlayerSheet {
	abilities: Record<DndAbility, number>;
	armorClass: number;
	hitPoints: { current: number; max: number };
	speed: number;
	proficiencyBonus: number;
}

const DEFAULT_PLAYER_SHEET: PlayerSheet = {
	abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
	armorClass: 10,
	hitPoints: { current: 10, max: 10 },
	speed: 30,
	proficiencyBonus: 2,
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

export function normalizePlayerSheet(value: unknown): PlayerSheet {
	const source = record(value);
	const abilities = record(source.abilities);
	const hitPoints = record(source.hitPoints);
	const maxHitPoints = number(hitPoints.max, DEFAULT_PLAYER_SHEET.hitPoints.max, 1, 999);
	return {
		abilities: Object.fromEntries(DND_ABILITIES.map(({ id }) => [id, number(abilities[id], DEFAULT_PLAYER_SHEET.abilities[id], 1, 30)])) as PlayerSheet['abilities'],
		armorClass: number(source.armorClass, DEFAULT_PLAYER_SHEET.armorClass, 0, 99),
		hitPoints: {
			current: Math.min(maxHitPoints, number(hitPoints.current, DEFAULT_PLAYER_SHEET.hitPoints.current, 0, 999)),
			max: maxHitPoints,
		},
		speed: number(source.speed, DEFAULT_PLAYER_SHEET.speed, 0, 300),
		proficiencyBonus: number(source.proficiencyBonus, DEFAULT_PLAYER_SHEET.proficiencyBonus, 0, 20),
	};
}

export function abilityModifier(score: number): number {
	return Math.floor((score - 10) / 2);
}

const CHECK_ABILITY_ALIASES: Record<DndAbility, string[]> = {
	str: ['str', 'strength', 'athletics'],
	dex: ['dex', 'dexterity', 'acrobatics', 'sleight of hand', 'stealth'],
	con: ['con', 'constitution'],
	int: ['int', 'intelligence', 'arcana', 'history', 'investigation', 'nature', 'religion'],
	wis: ['wis', 'wisdom', 'animal handling', 'insight', 'medicine', 'perception', 'survival'],
	cha: ['cha', 'charisma', 'deception', 'intimidation', 'performance', 'persuasion'],
};

export function abilityForCheck(label: string): DndAbility | null {
	const normalized = label.trim().toLowerCase().replace(/[^a-z]+/g, ' ').trim();
	if (!normalized) return null;
	// Explicit abilities take precedence in labels such as "Strength (Intimidation)".
	const words = normalized.split(' ');
	const explicit = DND_ABILITIES.find(({ id, name }) => words.includes(id) || words.includes(name.toLowerCase()));
	if (explicit) return explicit.id;
	const skill = normalized.replace(/\b(?:ability|skill|check|saving throw|save)\b/g, '').trim();
	return DND_ABILITIES.find(({ id }) => CHECK_ABILITY_ALIASES[id].includes(skill))?.id ?? null;
}

/** Replace an AI-supplied d20 modifier with the protagonist's canonical ability modifier. */
export function resolveAbilityCheckNotation(notation: string, ability: string, playerSheet: unknown): string {
	const abilityId = abilityForCheck(ability);
	if (!abilityId) return notation;
	try {
		const dice = parseDice(notation);
		if (dice.count !== 1 || dice.sides !== 20) return notation;
		const modifier = abilityModifier(normalizePlayerSheet(playerSheet).abilities[abilityId]);
		const suffix = modifier === 0 ? '' : modifier > 0 ? `+${modifier}` : String(modifier);
		const mode = dice.advantage ? ' advantage' : dice.disadvantage ? ' disadvantage' : '';
		return `1d20${suffix}${mode}`;
	} catch {
		return notation;
	}
}
