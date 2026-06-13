import { describe, expect, it } from 'vitest';
import { sliceWellFormedText, toWellFormedText } from './wellFormedText';

function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				index++;
				continue;
			}
			return true;
		}
		if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

describe('well formed text helpers', () => {
	it('repairs lone surrogates left by unsafe truncation', () => {
		const unsafe = 'weather '.concat('🌤️'.slice(0, 1));

		const fixed = toWellFormedText(unsafe);

		expect(hasLoneSurrogate(fixed)).toBe(false);
		expect(fixed).toBe('weather �');
	});

	it('does not leave a lone surrogate when slicing through an emoji', () => {
		const fixed = sliceWellFormedText('Weather 🌤️ is hot', 'Weather '.length + 1);

		expect(hasLoneSurrogate(fixed)).toBe(false);
		expect(fixed).toBe('Weather �');
	});
});
