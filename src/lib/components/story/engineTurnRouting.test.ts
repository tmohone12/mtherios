import { describe, expect, it } from 'vitest';
import { shouldUseTerminalEngineTurn } from './engineTurnRouting';

describe('engine turn routing', () => {
	it('uses the terminal engine for any story bound to a server story id', () => {
		expect(shouldUseTerminalEngineTurn({ serverStoryId: 'story_alpha' })).toBe(true);
	});

	it('keeps browser generation limited to local-only stories', () => {
		expect(shouldUseTerminalEngineTurn({ serverStoryId: null })).toBe(false);
		expect(shouldUseTerminalEngineTurn({})).toBe(false);
		expect(shouldUseTerminalEngineTurn(null)).toBe(false);
	});
});
