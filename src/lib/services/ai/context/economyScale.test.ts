import { describe, expect, it } from 'vitest';
import { buildEconomyScaleBlock, buildWorldScaleBlock } from './economyScale';

describe('economy and world scale anchors', () => {
	it('keeps aristocratic wealth and eastern empire scale visible', () => {
		const block = buildEconomyScaleBlock();

		expect(block).toContain('great houses count wealth in millions of gold dragons');
		expect(block).toContain('Iron Bank');
		expect(block).toContain('83 million');
		expect(block).toContain('Volantis');
		expect(block).toContain('Forty Families');
		expect(block).toContain('Yi Ti');
	});

	it('keeps fleet and city scale above skirmish-sized numbers', () => {
		const block = buildWorldScaleBlock();

		expect(block).toContain('200+ ships');
		expect(block).toContain('Yi Ti');
		expect(block).toContain('dwarf Westerosi and Free City expectations');
	});
});
