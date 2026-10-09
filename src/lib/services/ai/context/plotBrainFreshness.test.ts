import { describe, expect, it } from 'vitest';
import { isPlotBrainFrameFresh } from './plotBrainFreshness';

describe('Plot Director frame freshness', () => {
	it('keeps an applied frame usable while refresh is due, until retirement or hard staleness', () => {
		expect(isPlotBrainFrameFresh({ active: true, lastFrameTurn: 18, needsDevelopment: true }, 30)).toBe(true);
		expect(isPlotBrainFrameFresh({ active: true, lastFrameTurn: 17 }, 30)).toBe(false);
		expect(isPlotBrainFrameFresh({ active: false, lastFrameTurn: 29 }, 30)).toBe(false);
		expect(isPlotBrainFrameFresh({}, 30)).toBe(false);
	});
});
