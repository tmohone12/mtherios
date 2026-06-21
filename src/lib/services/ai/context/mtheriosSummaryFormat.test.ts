import { describe, expect, it } from 'vitest';
import { buildMtheriosSummaryInstruction, formatMtheriosMemorySummary, summarizeMtheriosMemoryForRollup } from './mtheriosSummaryFormat';

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

	it('tells LLM summarizers to use the same summary string shape', () => {
		const instruction = buildMtheriosSummaryInstruction('chapter');

		expect(instruction).toContain('MTHERIOS CHAPTER SUMMARY FORMAT');
		expect(instruction).toContain('[CHECKPOINT =');
		expect(instruction).toContain('[RECENT STORY STATE =');
		expect(instruction).toContain('[CHARACTER STATE =');
		expect(instruction).toContain('Character Name [entity_id]');
		expect(instruction).toContain('Preserve entity ids');
		expect(instruction).toContain('Time passed in this chapter:');
		expect(instruction).toContain('chapter synopsis');
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
		expect(rollup).not.toContain('[SOURCE COVERAGE');
		expect(rollup).not.toContain('[CHARACTER STATE');
		expect(rollup).not.toContain('transcript lines');
	});
});
