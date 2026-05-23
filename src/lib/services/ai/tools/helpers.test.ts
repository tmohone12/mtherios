import { describe, it, expect } from 'vitest';
import {
	normalizeRelation, clamp,
	computeRelationEventTarget,
	ENTROPY_DRIFT_THRESHOLD, ENTROPY_DRIFT_STEP,
} from './helpers';

describe('clamp', () => {
	it('passes through in-range values', () => {
		expect(clamp(50, -100, 100)).toBe(50);
		expect(clamp(-50, -100, 100)).toBe(-50);
	});
	it('clamps to bounds', () => {
		expect(clamp(150, -100, 100)).toBe(100);
		expect(clamp(-150, -100, 100)).toBe(-100);
	});
});

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

describe('computeRelationEventTarget', () => {
	describe('alliance_formed', () => {
		it('snaps to +50 floor on first crossing from below', () => {
			expect(computeRelationEventTarget(-30, 'alliance_formed', 10)).toBe(50);
			expect(computeRelationEventTarget(0, 'alliance_formed', 0)).toBe(50);
		});
		it('preserves higher standings (no ratchet down)', () => {
			expect(computeRelationEventTarget(90, 'alliance_formed', 5)).toBe(95);
			expect(computeRelationEventTarget(80, 'alliance_formed', 0)).toBe(80);
		});
		it('honors large positive deltas above the floor', () => {
			expect(computeRelationEventTarget(20, 'alliance_formed', 50)).toBe(70);
		});
		it('ignores negative LLM delta when below floor (alliance must end ≥ +50)', () => {
			expect(computeRelationEventTarget(20, 'alliance_formed', -50)).toBe(50);
		});
		it('clamps result to +100', () => {
			expect(computeRelationEventTarget(95, 'alliance_formed', 50)).toBe(100);
		});
	});

	describe('alliance_broken', () => {
		it('snaps to -50 ceiling when crossing down from positive', () => {
			expect(computeRelationEventTarget(80, 'alliance_broken', -20)).toBe(-50);
		});
		it('honors delta when already past ceiling (drifts further down)', () => {
			expect(computeRelationEventTarget(-60, 'alliance_broken', -10)).toBe(-70);
		});
		it('ignores positive LLM delta (broken alliance must end ≤ -50)', () => {
			expect(computeRelationEventTarget(20, 'alliance_broken', 50)).toBe(-50);
		});
	});

	describe('betrayal', () => {
		it('snaps to -70 ceiling when crossing down from positive', () => {
			expect(computeRelationEventTarget(80, 'betrayal', -20)).toBe(-70);
		});
		it('honors delta when already past ceiling (drifts further down)', () => {
			expect(computeRelationEventTarget(-50, 'betrayal', -10)).toBe(-70);
		});
		it('clamps to -100', () => {
			expect(computeRelationEventTarget(-90, 'betrayal', -50)).toBe(-100);
		});
	});

	describe('non-finite deltas', () => {
		it('treats NaN delta as 0', () => {
			expect(computeRelationEventTarget(80, 'standing_shift', NaN)).toBe(80);
			expect(computeRelationEventTarget(0, 'alliance_formed', NaN)).toBe(50);
			expect(computeRelationEventTarget(80, 'betrayal', NaN)).toBe(-70);
		});
		it('treats Infinity delta as 0', () => {
			expect(computeRelationEventTarget(30, 'standing_shift', Infinity)).toBe(30);
			expect(computeRelationEventTarget(30, 'standing_shift', -Infinity)).toBe(30);
		});
	});

	describe('standing_shift', () => {
		it('applies a clean negative delta', () => {
			expect(computeRelationEventTarget(30, 'standing_shift', -15)).toBe(15);
		});
		it('applies a clean positive delta', () => {
			expect(computeRelationEventTarget(30, 'standing_shift', 15)).toBe(45);
		});
		it('clamps the per-call delta to ±50', () => {
			expect(computeRelationEventTarget(0, 'standing_shift', 999)).toBe(50);
			expect(computeRelationEventTarget(0, 'standing_shift', -999)).toBe(-50);
		});
		it('clamps the result to [-100, 100]', () => {
			expect(computeRelationEventTarget(80, 'standing_shift', 50)).toBe(100);
			expect(computeRelationEventTarget(-80, 'standing_shift', -50)).toBe(-100);
		});
		it('crosses zero cleanly (no floor or ceiling)', () => {
			expect(computeRelationEventTarget(-10, 'standing_shift', 30)).toBe(20);
			expect(computeRelationEventTarget(10, 'standing_shift', -30)).toBe(-20);
		});
	});
});

describe('entropy drift constants', () => {
	it('defines a sensible threshold and step', () => {
		expect(ENTROPY_DRIFT_THRESHOLD).toBeGreaterThanOrEqual(20);
		expect(ENTROPY_DRIFT_THRESHOLD).toBeLessThanOrEqual(50);
		expect(ENTROPY_DRIFT_STEP).toBeGreaterThan(0);
		expect(ENTROPY_DRIFT_STEP).toBeLessThan(ENTROPY_DRIFT_THRESHOLD);
	});

	it('drives a +80 rivalry toward 0 in roughly THRESHOLD/STEP ticks', () => {
		// Simulate the entropy drift loop deterministically.
		let standing = 80;
		let ticks = 0;
		while (Math.abs(standing) >= ENTROPY_DRIFT_THRESHOLD) {
			standing += standing > 0 ? -ENTROPY_DRIFT_STEP : ENTROPY_DRIFT_STEP;
			ticks++;
			if (ticks > 100) break; // safety
		}
		// 80 → 75 → ... → 30 → 25 (stops below threshold). 11 ticks.
		expect(ticks).toBe(11);
		expect(standing).toBe(25);
	});

	it('symmetric drift on -80', () => {
		let standing = -80;
		let ticks = 0;
		while (Math.abs(standing) >= ENTROPY_DRIFT_THRESHOLD) {
			standing += standing > 0 ? -ENTROPY_DRIFT_STEP : ENTROPY_DRIFT_STEP;
			ticks++;
			if (ticks > 100) break;
		}
		expect(ticks).toBe(11);
		expect(standing).toBe(-25);
	});
});
