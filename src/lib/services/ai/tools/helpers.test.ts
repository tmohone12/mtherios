import { describe, it, expect } from 'vitest';
import { normalizeRelation } from './helpers';

describe('normalizeRelation', () => {
	it('returns zeroed defaults for null/undefined', () => {
		expect(normalizeRelation(null)).toEqual({ standing: 0, affinity: 0, history: [] });
		expect(normalizeRelation(undefined)).toEqual({ standing: 0, affinity: 0, history: [] });
	});

	it('treats numeric input as legacy standing-only with bounded affinity', () => {
		// Legacy +60 → standing +60, affinity capped at +50 (uncertain trust until events)
		expect(normalizeRelation(60)).toEqual({ standing: 60, affinity: 50, history: [] });
		// Legacy -90 → standing -90, affinity floored at -50 (legacy enmity isn't fully personal yet)
		expect(normalizeRelation(-90)).toEqual({ standing: -90, affinity: -50, history: [] });
		// Legacy 0 → both 0
		expect(normalizeRelation(0)).toEqual({ standing: 0, affinity: 0, history: [] });
	});

	it('passes object form through and trims history to last 5', () => {
		const long = Array.from({ length: 8 }, (_, i) => ({ event: `e${i}`, delta: i, chapter: i }));
		const r = normalizeRelation({ standing: 30, affinity: 20, history: long });
		expect(r.standing).toBe(30);
		expect(r.affinity).toBe(20);
		expect(r.history).toHaveLength(5);
		expect(r.history[0].event).toBe('e3'); // last 5: e3..e7
	});

	it('handles partial object input (missing affinity, missing history)', () => {
		const r = normalizeRelation({ standing: 40 });
		expect(r.standing).toBe(40);
		expect(r.affinity).toBe(0);
		expect(r.history).toEqual([]);
	});

	it('handles bogus input gracefully', () => {
		expect(normalizeRelation('not a relation')).toEqual({ standing: 0, affinity: 0, history: [] });
		expect(normalizeRelation(true)).toEqual({ standing: 0, affinity: 0, history: [] });
	});
});
