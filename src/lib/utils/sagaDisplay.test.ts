import { describe, expect, it } from 'vitest';
import { sagaBlocks, sagaSpan, splitSagaConsequence } from './sagaDisplay';

describe('saga display', () => {
	it('splits a stored saga into headed sections, lists and plain paragraphs', () => {
		const summary = ['Period: 296 AC', 'The Journey East\nAurion sailed east with twenty ships.', 'Saga consequence: The fleet was lost.',
			'Continuity:\n- The red egg is not one of the three.\n- Paenymion and Panimion are one officer.'].join('\n\n');
		expect(sagaBlocks(summary)).toEqual([
			{ heading: null, lines: ['Period: 296 AC'] },
			{ heading: 'The Journey East', lines: ['Aurion sailed east with twenty ships.'] },
			{ heading: null, lines: ['Saga consequence: The fleet was lost.'] },
			{ heading: 'Continuity:', lines: ['- The red egg is not one of the three.', '- Paenymion and Panimion are one officer.'] },
		]);
		const { consequence, rest } = splitSagaConsequence(sagaBlocks(summary));
		expect(consequence).toBe('The fleet was lost.');
		expect(rest.map(block => block.heading ?? block.lines[0])).toEqual(['Period: 296 AC', 'The Journey East', 'Continuity:']);
	});

	it('names the arcs and chapters a saga covers', () => {
		const arcs = [{ id: 'a2', arcNumber: 2, chapterIds: ['c3', 'c4'] }, { id: 'a1', arcNumber: 1, chapterIds: ['c1', 'c2'] }];
		const chapters = [1, 2, 3, 4].map(number => ({ id: `c${number}`, number }));
		expect(sagaSpan({ arcIds: ['a1', 'a2'], arcRange: '' }, arcs, chapters)).toBe('Arcs 1–2 · Chapters 1–4');
		expect(sagaSpan({ arcIds: ['missing'], arcRange: 'Arcs 1-2' }, arcs, chapters)).toBe('Arcs 1-2');
	});
});
