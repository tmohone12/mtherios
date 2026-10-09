import { randomInt } from 'node:crypto';

export type SystemDiceGroup = {
  kind: 'dice' | 'modifier';
  notation: string;
  label: string | null;
  sign: 1 | -1;
  rolls: number[];
  kept: boolean[];
  subtotal: number;
};

const TERM = /([+-]?)\s*(?:(\d*)d(\d+|F)(?:(kh|kl)(\d+))?|(\d+))(?:\[([A-Za-z0-9 _-]{1,40})\])?\s*/iy;
const MAX_DICE = 100;
const MAX_TERMS = 20;
const MAX_SIDES = 100_000;

export function parseSystemDice(expression: string) {
  const input = expression.trim();
  if (!input || input.length > 200) throw new Error('Dice expression must be 1–200 characters.');
  const terms: Array<{ kind: 'dice' | 'modifier'; notation: string; label: string | null; sign: 1 | -1; count: number; sides: number | 'F'; keep: { mode: 'kh' | 'kl'; count: number } | null; value: number }> = [];
  let position = 0;
  let diceCount = 0;
  while (position < input.length) {
    TERM.lastIndex = position;
    const match = TERM.exec(input);
    if (!match || (terms.length > 0 && !match[1])) throw new Error('Invalid dice expression.');
    const sign = match[1] === '-' ? -1 : 1;
    const label = match[7]?.trim() || null;
    const dice = match[3] !== undefined;
    const count = dice ? Number(match[2] || 1) : 0;
    const sides = dice ? (match[3].toUpperCase() === 'F' ? 'F' : Number(match[3])) : 0;
    const value = dice ? 0 : Number(match[6]);
    const keepCount = match[5] === undefined ? null : Number(match[5]);
    if (dice && (!Number.isSafeInteger(count) || count < 1 || count > MAX_DICE || (sides !== 'F' && (!Number.isSafeInteger(sides) || sides < 1 || sides > MAX_SIDES))
      || (keepCount !== null && (!Number.isSafeInteger(keepCount) || keepCount < 1 || keepCount > count)))) throw new Error('Dice count, sides, or keep count is out of range.');
    if (!dice && (!Number.isSafeInteger(value) || value > 1_000_000_000)) throw new Error('Dice modifier is out of range.');
    diceCount += count;
    if (diceCount > MAX_DICE || terms.length >= MAX_TERMS) throw new Error('Dice expression exceeds the roll limit.');
    terms.push({ kind: dice ? 'dice' : 'modifier', notation: match[0].trim(), label, sign, count, sides, keep: keepCount === null ? null : { mode: match[4].toLowerCase() as 'kh' | 'kl', count: keepCount }, value });
    position = TERM.lastIndex;
  }
  if (!terms.some(term => term.kind === 'dice')) throw new Error('Dice expression must include a die.');
  return terms;
}

/** Server-owned roll. The caller records this result in the tool ledger before it can be reused. */
export function rollSystemDice(expression: string, draw = randomInt) {
  const terms = parseSystemDice(expression);
  const groups: SystemDiceGroup[] = terms.map(term => {
    if (term.kind === 'modifier') return { kind: term.kind, notation: term.notation, label: term.label, sign: term.sign, rolls: [], kept: [], subtotal: term.sign * term.value };
    const rolls = Array.from({ length: term.count }, () => term.sides === 'F' ? draw(0, 3) - 1 : draw(1, term.sides + 1));
    const kept = Array(term.count).fill(true) as boolean[];
    if (term.keep) {
      kept.fill(false);
      const indexes = rolls.map((value, index) => ({ value, index })).sort((a, b) => (term.keep!.mode === 'kh' ? b.value - a.value : a.value - b.value) || a.index - b.index);
      for (const item of indexes.slice(0, term.keep.count)) kept[item.index] = true;
    }
    return { kind: term.kind, notation: term.notation, label: term.label, sign: term.sign, rolls, kept, subtotal: term.sign * rolls.reduce((sum, value, index) => sum + (kept[index] ? value : 0), 0) };
  });
  return { diceExpression: expression.trim(), groups, total: groups.reduce((sum, group) => sum + group.subtotal, 0) };
}