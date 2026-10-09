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
import { buildMtheriosSummaryInstruction } from '$lib/services/ai/context/mtheriosSummaryFormat';
import { CHAPTERS_PER_ARC } from '$lib/services/chapterCadence';

const log = createLogger('ArcCondensation');

/** One arc records ten complete consecutive chapters. */
export const ARC_DEFAULTS = {
	chaptersPerArc: CHAPTERS_PER_ARC,
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
		const uncovered = chapters.filter(c => c.number > alreadyCovered).sort((a, b) => a.number - b.number);

		// Need at least chaptersPerArc uncovered chapters to form a new arc
		if (uncovered.length < chaptersPerArc) return [];

		// Return the next batch
		const batch = uncovered.slice(0, chaptersPerArc);
		return batch.every((chapter, index) => chapter.number === alreadyCovered + index + 1) ? batch : [];
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

		const system = `Write factual arc memory for a ${mode} interactive story (${pov} person, ${tense} tense).

Read all ${chapters.length} complete chapter summaries in order. Write a coherent chronological account of what happened across them. Every chapter must contribute its events and consequences, including quiet decisions and exchanges, discoveries, agreements and their exact terms, failures, journeys, relationship changes, and resolutions. Do not reduce the arc to an opening, midpoint, ending, theme, or list of dramatic highlights.

Explain causes and consequences only when the chapter source establishes them. Keep completed events distinct from intended plans, accepted canon from beliefs, and each character's knowledge from parallel-POV or narrator-only knowledge. Update earlier mysteries, promises, and threats when later chapters answer, fulfill, or resolve them. Preserve those resolutions in the history and remove them from unresolvedThreads.

Earlier arcs are context only; do not import their events into this arc:
${priorArcContext}

Use plain third-person past tense. Remove repeated wording and decorative description. Let the events determine the length; there is no word target, character cap, or fixed number of plot points. Before returning, verify that each supplied chapter's meaningful events remain represented, including the middle chapters and the final situation.

${buildMtheriosSummaryInstruction('arc')}

Return JSON with title, summary (the required bracketed format), keyPlotPoints (all distinct meaningful events in order), characterArcs (name and factual development), unresolvedThreads (only matters still open at the end), and emotionalProgression. Do not invent thematic analysis, future payoffs, character motives, or escalation.`;

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
