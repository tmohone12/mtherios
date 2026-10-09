import { describe, expect, it } from 'vitest';
import { isParallelPovEntry, latestNarrationForPov, parseParallelPovCommand } from './parallelPov';

describe('persisted parallel POV scope', () => {
	it('splits natural language focus from the character and leaves GM research out of POV', () => {
		expect(parseParallelPovCommand('/pov Daenerys asks Su Lan how they met')).toEqual({ character: 'Daenerys', direction: 'asks Su Lan how they met' });
		expect(parseParallelPovCommand('/pov Mei Lin doing whatever')).toEqual({ character: 'Mei Lin', direction: 'doing whatever' });
		expect(parseParallelPovCommand('/pov Gm research the necklace')).toBeNull();
	});
	it('resumes the primary scene after a secondary cutaway even when the command is filtered from dialogue', () => {
		const primary = { id: 'primary', type: 'narration', content: 'Volantis courtyard', metadata: {} };
		const command = { id: 'command', type: 'user_action', content: '/pov Mira', metadata: {} };
		const cutaway = { id: 'secondary', type: 'narration', parentId: command.id, content: 'Yin hall', metadata: {} };
		const sources = [primary, command, cutaway];
		expect(latestNarrationForPov([primary, cutaway], null, sources)?.id).toBe('primary');
		expect(latestNarrationForPov([primary, cutaway], { character: 'Mira', direction: null }, sources)?.id).toBe('secondary');
	});
	it.each([
		{ metadata: { actionType: 'pov' } },
		{ metadata: { narrativeMode: 'parallel_pov' } },
		{ metadata: { parallelPov: { character: 'Mira' } } },
		{ type: 'player', content: '/pov Mira | Meet the envoy' },
		{ type: 'player', content: 'parallel write for this character: Mira' },
	])('recognizes supported source evidence %j', entry => expect(isParallelPovEntry(entry)).toBe(true));
	it.each([
		{ type: 'narration', content: '### Parallel POV — Mira' },
		{ type: 'player', content: 'Mira mentions a parallel POV.' },
		{ metadata: null },
		{ metadata: { actionType: 'free' } },
	])('does not infer a mode switch from scene text %j', entry => expect(isParallelPovEntry(entry)).toBe(false));
});
