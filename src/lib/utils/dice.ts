/**
 * Dice Rolling Utility — Mtherios
 *
 * Full D&D dice notation parser and roller.
 * Supports: NdS+M, advantage/disadvantage, DC checks, critical hits.
 */

export interface DiceNotation {
	count: number;
	sides: number;
	modifier: number;
	advantage: boolean;
	disadvantage: boolean;
}

export interface DiceResult {
	notation: string;
	rolls: number[];
	natural: number;
	total: number;
	modifier: number;
	sides: number;
	advantage: boolean;
	disadvantage: boolean;
	discardedRoll?: number;
}

export interface RollCheckResult extends DiceResult {
	dc: number;
	success: boolean;
	ability: string;
	description: string;
	critical: 'success' | 'failure' | null;
}

/**
 * Parse dice notation string into structured form.
 * Supports: 1d20, 2d6+3, 1d20-2, 1d20 advantage, 1d20+5 dis
 */
export function parseDice(notation: string): DiceNotation {
	const cleaned = notation.trim().toLowerCase();
	const advMatch = cleaned.match(/\b(advantage|adv|disadvantage|dis)\b/);
	const diceStr = cleaned.replace(/\b(advantage|adv|disadvantage|dis)\b/, '').trim();

	const match = diceStr.match(/^(\d+)?d(\d+)([+-]\d+)?$/);
	if (!match) throw new Error(`Invalid dice notation: ${notation}`);

	return {
		count: parseInt(match[1] || '1'),
		sides: parseInt(match[2]),
		modifier: parseInt(match[3] || '0'),
		advantage: advMatch?.[1] === 'advantage' || advMatch?.[1] === 'adv',
		disadvantage: advMatch?.[1] === 'disadvantage' || advMatch?.[1] === 'dis',
	};
}

/**
 * Roll dice and return the result.
 */
export function rollDice(notation: string | DiceNotation): DiceResult {
	const dice = typeof notation === 'string' ? parseDice(notation) : notation;
	const notationStr = typeof notation === 'string'
		? notation.trim()
		: `${dice.count}d${dice.sides}${dice.modifier ? (dice.modifier > 0 ? '+' : '') + dice.modifier : ''}`;

	if (dice.advantage || dice.disadvantage) {
		const roll1 = Math.floor(Math.random() * dice.sides) + 1;
		const roll2 = Math.floor(Math.random() * dice.sides) + 1;
		const natural = dice.advantage ? Math.max(roll1, roll2) : Math.min(roll1, roll2);
		const discarded = dice.advantage ? Math.min(roll1, roll2) : Math.max(roll1, roll2);

		return {
			notation: notationStr,
			rolls: [roll1, roll2],
			natural,
			total: natural + dice.modifier,
			modifier: dice.modifier,
			sides: dice.sides,
			advantage: dice.advantage,
			disadvantage: dice.disadvantage,
			discardedRoll: discarded,
		};
	}

	const rolls = Array.from({ length: dice.count }, () =>
		Math.floor(Math.random() * dice.sides) + 1
	);
	const natural = rolls.reduce((a, b) => a + b, 0);

	return {
		notation: notationStr,
		rolls,
		natural,
		total: natural + dice.modifier,
		modifier: dice.modifier,
		sides: dice.sides,
		advantage: false,
		disadvantage: false,
	};
}

/**
 * Roll a check against a DC.
 */
export function rollCheck(notation: string, dc: number, ability = '', description = ''): RollCheckResult {
	const result = rollDice(notation);
	const critical = result.sides === 20
		? (result.natural === 20 ? 'success' : result.natural === 1 ? 'failure' : null)
		: null;

	return {
		...result,
		dc,
		success: critical === 'success' ? true : critical === 'failure' ? false : result.total >= dc,
		ability,
		description,
		critical,
	};
}

/**
 * Format a roll result as a human-readable string (for system entries / context).
 */
export function formatRollText(result: DiceResult): string {
	let str = `${result.notation} = ${result.total}`;
	if (result.modifier !== 0) {
		str += ` (${result.natural}${result.modifier > 0 ? '+' : ''}${result.modifier})`;
	}
	if (result.advantage) str += ' [ADV]';
	if (result.disadvantage) str += ' [DIS]';
	return str;
}

/**
 * Encode a check result as an inline marker for narrative embedding.
 * Format: {{dice:notation|natural|total|dc|success|ability|description|crit}}
 */
export function encodeDiceMarker(result: RollCheckResult): string {
	const crit = result.critical ? `|crit-${result.critical}` : '';
	return `{{dice:${result.notation}|${result.natural}|${result.total}|${result.dc}|${result.success ? 'pass' : 'fail'}|${result.ability}|${result.description}${crit}}}`;
}

/**
 * Parse AI roll request markers from narrative text.
 * AI format: {{roll:DICE:DC:ABILITY:DESCRIPTION}}
 * Returns the first marker found, splitting the text around it.
 */
export function parseRollMarker(text: string): {
	preText: string;
	marker: { notation: string; dc: number; ability: string; description: string } | null;
	postText: string;
} {
	const match = text.match(/\{\{roll:([^:]+):(\d+):([^:]*):([^}]*)\}\}/);
	if (!match) return { preText: text, marker: null, postText: '' };

	const idx = match.index!;
	return {
		preText: text.slice(0, idx).trimEnd(),
		marker: {
			notation: match[1].trim(),
			dc: parseInt(match[2]),
			ability: match[3].trim(),
			description: match[4].trim(),
		},
		postText: text.slice(idx + match[0].length).trimStart(),
	};
}

/**
 * Parse a player /roll command.
 * Supports: /roll 1d20, /roll 2d6+3, /roll 1d20 advantage
 */
export function parseRollCommand(input: string): DiceNotation | null {
	const match = input.match(/^\/roll\s+(.+)$/i);
	if (!match) return null;
	try {
		return parseDice(match[1]);
	} catch {
		return null;
	}
}
