import { describe, expect, it } from 'vitest';
import { parseSystemDice, rollSystemDice } from './systemDice';

const sequence = (...faces: number[]) => () => {
  const face = faces.shift();
  if (face === undefined) throw new Error('Unexpected random draw.');
  return face;
};

describe('system-neutral server dice', () => {
  it('parses the documented dice, keep, label, Fate, and subtract forms', () => {
    for (const expression of ['2d6+3', '4d6kh3', '2d20kl1', '6d6[Pool]', '1d6[Action]+2d10[Challenge]+3[Wits]', '4dF+2', '1d20-1d6']) {
      expect(parseSystemDice(expression).length).toBeGreaterThan(0);
    }
    expect(rollSystemDice('4d6kh3', sequence(1, 6, 4, 2))).toMatchObject({ total: 12, groups: [{ rolls: [1, 6, 4, 2], kept: [false, true, true, true] }] });
    expect(rollSystemDice('2d20kl1', sequence(17, 4)).total).toBe(4);
    expect(rollSystemDice('4dF+2', sequence(0, 1, 2, 0)).total).toBe(1);
  });

  it('returns labeled groups and signed totals without interpreting success', () => {
    expect(rollSystemDice('1d6[Action]+2d10[Challenge]+3[Wits]', sequence(4, 8, 8))).toMatchObject({
      total: 23,
      groups: [
        { label: 'Action', subtotal: 4, rolls: [4] },
        { label: 'Challenge', subtotal: 16, rolls: [8, 8] },
        { label: 'Wits', subtotal: 3, rolls: [] },
      ],
    });
    expect(rollSystemDice('1d6-1d6', sequence(2, 5)).total).toBe(-3);
    expect(rollSystemDice('1d6-1d6', sequence(5, 5)).total).toBe(0);
  });

  it.each(['', '1d0', '101d6', '2d6kh3', '1d6+', '1d6 1d6', '1d999999', '1d6[bad!]'])('rejects invalid or unbounded expression %s', expression => {
    expect(() => parseSystemDice(expression)).toThrow();
  });
});