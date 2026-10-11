import { describe, expect, it } from 'vitest';
import { extractMtheriosSummarySection, formatMtheriosMemorySummary, replaceMtheriosStoryNarrative, summarizeMtheriosMemoryForContext, summarizeMtheriosMemoryForRollup } from './mtheriosSummaryFormat';

describe('mtherios summary format', () => {
	it('renders the continuity memory summary contract with entity ids', () => {
		const summary = formatMtheriosMemorySummary({
			checkpoint: 'Chapter checkpoint covering the fountain scene.',
			sourceCoverage: ['Transcript positions 62-65.', '4 entries covered.', '2 source event records.'],
			currentScene: 'Day 3, Seventh Moon, 295 AC | 15:31 | The Black Walls, Fountain of the First Flame | Sweltering, 34 C.',
			recentStoryState: [
				'Aurion jokes about being Aelyx\'s younger, better-looking brother while Aerene teases him and Serala watches from the fountain.',
				'Serala explains that House Balaerys is still remembered for dragonlord blood and relics.',
			],
			characterStates: [
				{
					name: 'Aurion',
					entityId: 'pc_aurion',
					bullets: ['Bold enough to joke in public, but still testing how others read his bloodline.'],
				},
				{
					name: 'Serala',
					entityId: 'npc_serala',
					bullets: ['Present at the fountain and acting as the keeper of Balaerys memory.'],
				},
			],
			activeThreads: ['Aurion keeps testing what dragonlord blood still means inside House Balaerys.'],
			toneToContinue: 'Courtly teasing, family pressure, and old blood memory under sweltering heat.',
		});

		expect(summary).toContain('[CHECKPOINT = Chapter checkpoint covering the fountain scene.]');
		expect(summary).toContain('[SOURCE COVERAGE =');
		expect(summary).toContain('- Transcript positions 62-65.');
		expect(summary).toContain('[CURRENT SCENE = Day 3, Seventh Moon, 295 AC | 15:31 | The Black Walls, Fountain of the First Flame | Sweltering, 34 C.]');
		expect(summary).toContain('[RECENT STORY STATE =');
		expect(summary).toContain('Aurion jokes about being Aelyx\'s younger, better-looking brother');
		expect(summary).toContain('[CHARACTER STATE =');
		expect(summary).toContain('Aurion [pc_aurion]:');
		expect(summary).toContain('- Bold enough to joke in public');
		expect(summary).toContain('Serala [npc_serala]:');
		expect(summary).toContain('[ACTIVE THREADS =');
		expect(summary).toContain('[TONE TO CONTINUE = Courtly teasing, family pressure, and old blood memory under sweltering heat.]');
		expect(summary).not.toContain('[{{char}} =');
	});

	it('normalizes caller-provided bullet prefixes instead of nesting bullets', () => {
		const summary = formatMtheriosMemorySummary({
			recentStoryState: ['- Aurion leaves the fountain after testing Serala.', '  * Serala remains watchful.'],
			activeThreads: ['- The jade comb is still important.'],
		});

		expect(summary).toContain('- Aurion leaves the fountain after testing Serala.');
		expect(summary).toContain('- Serala remains watchful.');
		expect(summary).toContain('- The jade comb is still important.');
		expect(summary).not.toContain('- - Aurion');
		expect(summary).not.toContain('- * Serala');
	});

	it('rolls older bracketed summaries forward without source coverage noise', () => {
		const summary = [
			'[CHECKPOINT = The Morning Court.]',
			'[SOURCE COVERAGE = events event_a through event_b, transcript lines 611-630.]',
			'[CURRENT SCENE = Day 89 | Hall of Celestial Harmony.]',
			'[RECENT STORY STATE = The Golden Dragon outlined naval threats, Dragonstone sea caves, and voyage risks.] [CHARACTER STATE = Aurion [pc_aurion]: calm, strategic, and prepared.]',
			'[ACTIVE THREADS = The voyage must account for Volantis, the Arbor, and the Smoking Sea.]',
		].join('\n');

		const rollup = summarizeMtheriosMemoryForRollup(summary);

		expect(rollup).toContain('The Golden Dragon outlined naval threats');
		expect(rollup).toContain('Aurion [pc_aurion]');
		expect(rollup).toContain('The voyage must account for Volantis');
		expect(rollup).not.toContain('[SOURCE COVERAGE');
		expect(rollup).not.toContain('[CHARACTER STATE');
		expect(rollup).not.toContain('transcript lines');
	});

	it('preserves every checkpoint beat and the ends of long beats for rollup', () => {
		const beats = Array.from({ length: 20 }, (_, index) => `Beat ${index + 1} ${'detail '.repeat(80)}consequence ${index + 1}.`);
		const summary = formatMtheriosMemorySummary({ recentStoryState: beats });
		const rollup = summarizeMtheriosMemoryForRollup(summary);

		for (const beat of beats) expect(rollup).toContain(beat);
	});

	it('preserves all sentences of legacy one-paragraph chapters', () => {
		const summary = formatMtheriosMemorySummary({
			recentStoryState: [Array.from({ length: 9 }, (_, index) => `Sentence ${index + 1} records a distinct consequence.`).join(' ')],
		});
		const rollup = summarizeMtheriosMemoryForRollup(summary);

		for (let number = 1; number <= 9; number += 1) {
			expect(rollup).toContain(`Sentence ${number} records a distinct consequence.`);
		}
	});

	it('keeps legacy beginning and recent events beside the closing scene', () => {
		const summary = '[BEGINNING = Mira lost the charter.]\n[RECENT = She found it under the quay and returned it to Arlan.]\n[CURRENTLY = Arlan is carrying the charter home.]';
		const rollup = summarizeMtheriosMemoryForRollup(summary);
		expect(rollup).toContain('Mira lost the charter.');
		expect(rollup).toContain('She found it under the quay and returned it to Arlan.');
		expect(rollup).toContain('Arlan is carrying the charter home.');
	});

	it('retains all character facts and threads even when typed fields are absent', () => {
		const summary = formatMtheriosMemorySummary({
			recentStoryState: ['Arlan promised to open the gate.'],
			characterStates: Array.from({ length: 10 }, (_, index) => ({
				name: `Character ${index + 1}`,
				entityId: `character_${index + 1}`,
				bullets: [`${'pressure '.repeat(30)}${index + 1}`],
			})),
			activeThreads: ['The gate promise remains unresolved.'],
		});
		const context = summarizeMtheriosMemoryForContext(summary);

		expect(context).toContain('Characters: Character 1 [character_1]:');
		for (let number = 1; number <= 10; number += 1) {
			expect(context).toContain(`Character ${number} [character_${number}]: ${'pressure '.repeat(30)}${number}`);
		}
		expect(context).toContain('The gate promise remains unresolved.');
	});

	it('removes beat-prefixed OOC control lines while preserving chapter continuity', () => {
		const summary = formatMtheriosMemorySummary({
			recentStoryState: [
				'Opening: The fleet entered Asshai harbor under sail.',
				'Middle: OOC remember that the princess POV was a week later.',
				'Ending: OOC you are leaning too hard into the shadow play.',
				'Recent: > GM: reset to the emperor\'s offer.',
				'Current: Narrator: keep Leng separate from Yi Ti.',
				'I tell the GM of the merchant guild that the levy is late.',
				'Time passed in this chapter: about ten hours.',
			],
			characterStates: [{
				name: 'Aurion',
				entityId: 'pc_aurion',
				bullets: ['Supervising the harbor landing.'],
			}],
		});

		const context = summarizeMtheriosMemoryForContext(summary);

		expect(context).toContain('The fleet entered Asshai harbor under sail.');
		expect(context).toContain('Time passed in this chapter: about ten hours.');
		expect(context).toContain('Characters: Aurion [pc_aurion]:');
		expect(context).not.toMatch(/\bOOC\b/i);
		expect(context).not.toContain('princess POV');
		expect(context).not.toContain('shadow play');
		expect(context).not.toContain('reset to the emperor');
		expect(context).not.toContain('keep Leng separate');
		expect(context).toContain('I tell the GM of the merchant guild');
	});

	it('removes slash commands from checkpoint beats while preserving chapter continuity', () => {
		const summary = formatMtheriosMemorySummary({
			recentStoryState: [
				'Opening: A sealed passenger went east with the tide.',
				'Middle: /roll persuasion +5',
				'Ending: /pov Veiled daughter | listens to the discourse about the foreigner.',
				'Current: The fleet remained ready to sail.',
				'Time passed in this chapter: about fifty-one minutes.',
			],
		});

		const context = summarizeMtheriosMemoryForContext(summary);

		expect(context).toContain('A sealed passenger went east with the tide.');
		expect(context).toContain('The fleet remained ready to sail.');
		expect(context).toContain('Time passed in this chapter: about fifty-one minutes.');
		expect(context).not.toContain('/roll');
		expect(context).not.toContain('/pov');
		expect(context).not.toContain('Veiled daughter');
	});

	it('replaces only the reader-facing story section while preserving continuity state', () => {
		const original = formatMtheriosMemorySummary({
			checkpoint: 'Twenty completed turns.', currentScene: 'Dusk | harbor', recentStoryState: ['A dense turn log.'],
			characterStates: [{ name: 'Kae', entityId: 'npc_kae', bullets: ['Still waiting at the harbor.'] }], activeThreads: ['The treaty remains unsigned.'],
		});
		const rewritten = replaceMtheriosStoryNarrative(original, 'Kae arrives at dusk with the treaty, but the harbor captain refuses to sign until the missing seal is found. The dispute leaves both sides waiting by the water.');
		expect(extractMtheriosSummarySection(rewritten, 'RECENT STORY STATE')).toContain('Kae arrives at dusk');
		expect(rewritten).toContain('Kae [npc_kae]:');
		expect(rewritten).toContain('The treaty remains unsigned.');
	});
});
