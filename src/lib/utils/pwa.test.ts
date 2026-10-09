import { describe, expect, it } from 'vitest';
import { isIosSafari, isStandalone } from './pwa';

describe('PWA environment detection', () => {
	it('recognizes display-mode and iOS standalone launches', () => {
		expect(isStandalone(true, false)).toBe(true);
		expect(isStandalone(false, true)).toBe(true);
		expect(isStandalone(false, false)).toBe(false);
	});

	it('shows the coach only for Safari on iOS-class devices', () => {
		expect(isIosSafari('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1')).toBe(true);
		expect(isIosSafari('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/120 Mobile Safari/604.1')).toBe(false);
		expect(isIosSafari('Mozilla/5.0 AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 'MacIntel', 5)).toBe(true);
	});
});
