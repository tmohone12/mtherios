/**
 * ArcCondensationService — Mtherios
 *
 * Condenses multiple chapters into higher-level arc summaries.
 * Reduces context overhead for long-running stories by replacing
 * individual chapter summaries with condensed arc blocks.
 */

import { BaseAIService } from '../BaseAIService';
import { arcSummarySchema, type ArcSummary } from '../sdk/schemas/arc';
import { createLogger } from '../core/config';
import type { Chapter, Arc } from '$lib/types';

const log = createLogger('ArcCondensation');

/** Default: condense every 5 chapters into one arc */
export const ARC_DEFAULTS = {
	chaptersPerArc: 5,
	maxArcSummaryTokens: 400,
};

export class ArcCondensationService extends BaseAIService {
	constructor() {
		super('arcCondensation');
	}

	/**
	 * Check if chapters are ready for arc condensation.
	 * Returns chapters that can be grouped into a new arc.
	 */
	getCondensableChapters(chapters: Chapter[], existingArcCount: number): Chapter[] {
		const chaptersPerArc = ARC_DEFAULTS.chaptersPerArc;
		const alreadyCovered = existingArcCount * chaptersPerArc;
		const uncovered = chapters.filter(c => c.number > alreadyCovered);

		// Need at least chaptersPerArc uncovered chapters to form a new arc
		if (uncovered.length < chaptersPerArc) return [];

		// Return the next batch
		return uncovered.slice(0, chaptersPerArc);
	}

	/**
	 * Condense a group of chapters into an arc summary.
	 */
	async condense(
		chapters: Chapter[],
		arcNumber: number,
		mode = 'adventure',
		pov = 'second',
		tense = 'present',
		previousArcs?: Arc[],
	): Promise<ArcSummary> {
		log('condense', { chapters: chapters.length, arcNumber, priorArcs: previousArcs?.length ?? 0 });

		const chapterBlock = chapters.map(c => {
			let block = `--- Chapter ${c.number}: ${c.title ?? 'Untitled'} ---\n${c.summary}\n`;
			if (c.characters.length > 0) block += `Characters: ${c.characters.join(', ')}\n`;
			if (c.locations.length > 0) block += `Locations: ${c.locations.join(', ')}\n`;
			if (c.emotionalTone) block += `Tone: ${c.emotionalTone}\n`;
			return block;
		}).join('\n');

		// Build prior arc context for continuity
		let priorArcContext = '';
		if (previousArcs && previousArcs.length > 0) {
			const recentArcs = previousArcs.slice(-3); // Last 3 arcs for context
			priorArcContext = `═══ PRIOR ARC SUMMARIES ═══
(These arcs precede the chapters you're condensing. Carry forward unresolved threads and maintain consistency with established facts, agreements, and relationships.)

${recentArcs.map(a => {
	let block = `Arc ${a.arcNumber}: "${a.title}" (Ch.${a.chapterRange})\n${a.summary}`;
	if (a.unresolvedThreads?.length) block += `\nUnresolved threads: ${a.unresolvedThreads.join('; ')}`;
	if (a.characterArcs?.length) block += `\nCharacter arcs: ${a.characterArcs.map(ca => `${ca.name}: ${ca.development}`).join('; ')}`;
	return block;
}).join('\n\n')}

`;
		}

		const system = `You are a narrative arc summarizer for a ${mode} interactive fiction story (${pov} person, ${tense} tense).

You are condensing ${chapters.length} chapters into a single ARC SUMMARY. This arc summary replaces the individual chapter summaries in the narrator's memory, so it MUST preserve all critical continuity information.

${priorArcContext}

═══ WHAT TO PRESERVE ═══

1. PLOT PROGRESSION: The key events and turning points across all chapters, in order
2. CHARACTER ARCS: How each significant character changed — relationships, status, growth
3. UNRESOLVED THREADS: Plot threads, promises, or mysteries introduced but not yet resolved
4. WORLD CHANGES: Permanent changes to locations, factions, or the world state
5. EMOTIONAL ARC: How the story's emotional tone evolved across these chapters

═══ WHAT TO OMIT ═══

- Individual scene-by-scene details (keep only turning points)
- Repeated information across chapters
- Minor NPCs who appeared briefly and didn't affect the plot
- Descriptions of locations already established earlier

═══ STYLE ═══

- Write in third person, ${tense} tense (reference format, not narrative prose)
- Be comprehensive but concise: 200-400 words
- Focus on WHAT CHANGED and WHY IT MATTERS for future story continuity
- The title should capture the arc's thematic essence (2-6 words)

═══ OUTPUT FORMAT ═══

Respond with JSON:
{
  "title": string,
  "summary": string,
  "keyPlotPoints": string[],
  "characterArcs": [{ "name": string, "development": string }],
  "unresolvedThreads": string[],
  "emotionalProgression": string
}

- keyPlotPoints: 3-7 critical plot events in chronological order
- characterArcs: Development summary for each significant character
- unresolvedThreads: Open questions, unfulfilled promises, looming threats
- emotionalProgression: 1-2 sentence description of how emotional tone shifted`;

		return this.generateStructured(arcSummarySchema, system, `Arc ${arcNumber} — Chapters to condense:\n\n${chapterBlock}`);
	}

	/**
	 * Build a context block from arc summaries for injection into the system prompt.
	 */
	buildArcContextBlock(arcs: Array<{ arcNumber: number; summary: ArcSummary }>): string {
		if (arcs.length === 0) return '';
		let block = '\n\n[STORY ARCS]\n';
		for (const arc of arcs) {
			block += `\n--- Arc ${arc.arcNumber}: ${arc.summary.title} ---\n`;
			block += `${arc.summary.summary}\n`;
			if (arc.summary.unresolvedThreads.length > 0) {
				block += `Open threads: ${arc.summary.unresolvedThreads.join('; ')}\n`;
			}
		}
		return block;
	}
}
