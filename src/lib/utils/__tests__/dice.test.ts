import { describe, it, expect } from 'vitest';
import { parseDice, rollDice, rollCheck, formatRollText, parseRollMarker, parseRollCommand, encodeDiceMarker } from '../dice';

describe('parseDice', () => {
	it('parses simple notation', () => {
		const d = parseDice('1d20');
		expect(d).toEqual({ count: 1, sides: 20, modifier: 0, advantage: false, disadvantage: false });
	});

	it('parses count and modifier', () => {
		const d = parseDice('2d6+3');
		expect(d.count).toBe(2);
		expect(d.sides).toBe(6);
		expect(d.modifier).toBe(3);
	});

	it('parses negative modifier', () => {
		const d = parseDice('1d20-2');
		expect(d.modifier).toBe(-2);
	});

	it('parses advantage keyword', () => {
		expect(parseDice('1d20 advantage').advantage).toBe(true);
		expect(parseDice('1d20 adv').advantage).toBe(true);
	});

	it('parses disadvantage keyword', () => {
		expect(parseDice('1d20 disadvantage').disadvantage).toBe(true);
		expect(parseDice('1d20 dis').disadvantage).toBe(true);
	});

	it('defaults count to 1 when omitted', () => {
		const d = parseDice('d6');
		expect(d.count).toBe(1);
	});

	it('throws on invalid notation', () => {
		expect(() => parseDice('abc')).toThrow('Invalid dice notation');
		expect(() => parseDice('')).toThrow();
	});
});

describe('rollDice', () => {
	it('produces result within valid range', () => {
		for (let i = 0; i < 50; i++) {
			const r = rollDice('1d6');
			expect(r.natural).toBeGreaterThanOrEqual(1);
			expect(r.natural).toBeLessThanOrEqual(6);
			expect(r.total).toBe(r.natural + r.modifier);
		}
	});

	it('applies modifier to total', () => {
		for (let i = 0; i < 20; i++) {
			const r = rollDice('1d20+5');
			expect(r.total).toBe(r.natural + 5);
			expect(r.modifier).toBe(5);
		}
	});

	it('rolls correct number of dice', () => {
		const r = rollDice('3d6');
		expect(r.rolls).toHaveLength(3);
		expect(r.natural).toBe(r.rolls.reduce((a, b) => a + b, 0));
	});

	it('handles advantage (two rolls, keeps higher)', () => {
		for (let i = 0; i < 20; i++) {
			const r = rollDice('1d20 adv');
			expect(r.rolls).toHaveLength(2);
			expect(r.natural).toBe(Math.max(r.rolls[0], r.rolls[1]));
			expect(r.discardedRoll).toBe(Math.min(r.rolls[0], r.rolls[1]));
			expect(r.advantage).toBe(true);
		}
	});

	it('handles disadvantage (two rolls, keeps lower)', () => {
		for (let i = 0; i < 20; i++) {
			const r = rollDice('1d20 dis');
			expect(r.rolls).toHaveLength(2);
			expect(r.natural).toBe(Math.min(r.rolls[0], r.rolls[1]));
			expect(r.disadvantage).toBe(true);
		}
	});

	it('accepts DiceNotation object', () => {
		const r = rollDice({ count: 2, sides: 8, modifier: 1, advantage: false, disadvantage: false });
		expect(r.rolls).toHaveLength(2);
		expect(r.modifier).toBe(1);
	});
});

describe('rollCheck', () => {
	it('succeeds when total >= DC (non-d20 avoids crit rules)', () => {
		// Use d100+100 to guarantee success without d20 crit-fail on nat 1
		const r = rollCheck('1d100+100', 10, 'STR', 'Break door');
		expect(r.success).toBe(true);
		expect(r.dc).toBe(10);
		expect(r.ability).toBe('STR');
		expect(r.description).toBe('Break door');
	});

	it('detects natural 20 as critical success on d20', () => {
		// Run many times — when natural === 20, critical should be 'success'
		let sawCrit = false;
		for (let i = 0; i < 500; i++) {
			const r = rollCheck('1d20', 25);
			if (r.natural === 20) {
				expect(r.critical).toBe('success');
				expect(r.success).toBe(true); // crit always succeeds
				sawCrit = true;
				break;
			}
		}
		// Statistically almost certain in 500 tries
		expect(sawCrit).toBe(true);
	});

	it('detects natural 1 as critical failure on d20', () => {
		let sawCrit = false;
		for (let i = 0; i < 500; i++) {
			const r = rollCheck('1d20+100', 5);
			if (r.natural === 1) {
				expect(r.critical).toBe('failure');
				expect(r.success).toBe(false); // crit always fails
				sawCrit = true;
				break;
			}
		}
		expect(sawCrit).toBe(true);
	});

	it('no critical on non-d20', () => {
		const r = rollCheck('1d6', 3);
		expect(r.critical).toBeNull();
	});
});

describe('formatRollText', () => {
	it('formats simple roll', () => {
		const text = formatRollText({
			notation: '1d20', rolls: [15], natural: 15, total: 15,
			modifier: 0, sides: 20, advantage: false, disadvantage: false,
		});
		expect(text).toBe('1d20 = 15');
	});

	it('includes modifier breakdown', () => {
		const text = formatRollText({
			notation: '1d20+3', rolls: [12], natural: 12, total: 15,
			modifier: 3, sides: 20, advantage: false, disadvantage: false,
		});
		expect(text).toContain('(12+3)');
	});

	it('shows advantage tag', () => {
		const text = formatRollText({
			notation: '1d20', rolls: [10, 15], natural: 15, total: 15,
			modifier: 0, sides: 20, advantage: true, disadvantage: false,
		});
		expect(text).toContain('[ADV]');
	});
});

describe('parseRollMarker', () => {
	it('parses AI roll marker from text', () => {
		const text = 'You try to break the door. {{roll:1d20:15:STR:Break door}} The wood creaks.';
		const result = parseRollMarker(text);
		expect(result.marker).toEqual({
			notation: '1d20', dc: 15, ability: 'STR', description: 'Break door',
		});
		expect(result.preText).toBe('You try to break the door.');
		expect(result.postText).toBe('The wood creaks.');
	});

	it('returns null marker for text without markers', () => {
		const result = parseRollMarker('No markers here.');
		expect(result.marker).toBeNull();
		expect(result.preText).toBe('No markers here.');
	});
});

describe('encodeDiceMarker', () => {
	it('encodes check result as marker', () => {
		const marker = encodeDiceMarker({
			notation: '1d20', rolls: [15], natural: 15, total: 15,
			modifier: 0, sides: 20, advantage: false, disadvantage: false,
			dc: 12, success: true, ability: 'DEX', description: 'Dodge', critical: null,
		});
		expect(marker).toBe('{{dice:1d20|15|15|12|pass|DEX|Dodge}}');
	});

	it('includes critical info', () => {
		const marker = encodeDiceMarker({
			notation: '1d20', rolls: [20], natural: 20, total: 20,
			modifier: 0, sides: 20, advantage: false, disadvantage: false,
			dc: 15, success: true, ability: 'STR', description: 'Lift', critical: 'success',
		});
		expect(marker).toContain('|crit-success');
	});
});

describe('parseRollCommand', () => {
	it('parses /roll command', () => {
		const result = parseRollCommand('/roll 2d6+3');
		expect(result).toEqual({ count: 2, sides: 6, modifier: 3, advantage: false, disadvantage: false });
	});

	it('returns null for non-roll input', () => {
		expect(parseRollCommand('hello')).toBeNull();
		expect(parseRollCommand('/attack')).toBeNull();
	});

	it('returns null for invalid dice notation', () => {
		expect(parseRollCommand('/roll abc')).toBeNull();
	});
});
