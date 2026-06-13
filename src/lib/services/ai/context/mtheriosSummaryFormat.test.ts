import { describe, expect, it } from 'vitest';
import { buildMtheriosSummaryInstruction, formatMtheriosMemorySummary } from './mtheriosSummaryFormat';

describe('mtherios summary format', () => {
	it('renders the bracketed memory summary contract', () => {
		const summary = formatMtheriosMemorySummary({
			beginning: 'A succession dispute opens inside the Black Walls.',
			recent: ['Saera names the marriage debt.', 'The harbor envoy waits for an answer.'],
			charAppearance: 'Jade gown, ringed hands, no visible wounds.',
			charDemeanor: 'Controlled and watchful.',
			userAppearance: 'Court clothes, ash on one sleeve.',
			sideCharacters: ['Saera is present.', 'The harbor envoy is relevant but absent.'],
			importantStrings: ['The ring-gift debt remains unpaid.'],
			currently: '15th day, 8th moon | dusk | Crimson Spire | humid, 29°C',
		});

		expect(summary).toContain('[BEGINNING= A succession dispute opens inside the Black Walls.]');
		expect(summary).toContain('[RECENT=');
		expect(summary).toContain('[{{char}} =');
		expect(summary).toContain('[{{user}} =');
		expect(summary).toContain('[IMPORTANT STRINGS=');
		expect(summary).toContain('[CURRENTLY — 15th day, 8th moon | dusk | Crimson Spire | humid, 29°C]');
	});

	it('normalizes caller-provided bullet prefixes instead of nesting bullets', () => {
		const summary = formatMtheriosMemorySummary({
			recent: ['- Aurion leaves the fountain after testing Serala.', '  * Serala remains watchful.'],
			importantStrings: ['- The jade comb is still important.'],
		});

		expect(summary).toContain('- Aurion leaves the fountain after testing Serala.');
		expect(summary).toContain('- Serala remains watchful.');
		expect(summary).toContain('- The jade comb is still important.');
		expect(summary).not.toContain('- - Aurion');
		expect(summary).not.toContain('- * Serala');
	});

	it('tells LLM summarizers to use the same summary string shape', () => {
		const instruction = buildMtheriosSummaryInstruction('chapter');

		expect(instruction).toContain('MTHERIOS CHAPTER SUMMARY FORMAT');
		expect(instruction).toContain('[BEGINNING=');
		expect(instruction).toContain('[RECENT=');
		expect(instruction).toContain('[CURRENTLY — day, date | time | location | weather, temp°C]');
		expect(instruction).toContain('Preserve an existing BEGINNING block unchanged');
	});
});
