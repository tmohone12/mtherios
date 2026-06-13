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

You are condensing ${chapters.length} chapters into a single ARC SUMMARY. This arc summary replaces the individual chapter summaries in the narrator's memory, so it MUST preserve all critical continuity information. A weak arc summary will cause the narrator to forget stakes, repeat beats, or flatten characters.

${priorArcContext}

═══ WHAT TO PRESERVE ═══

1. PLOT PROGRESSION: The key events and turning points across all chapters, in order. Do not skip steps — causality must be traceable.
2. CHARACTER ARCS: How each significant character changed — relationships, status, growth. Track the MECHANISM of change (what event caused the shift).
3. UNRESOLVED THREADS: Plot threads, promises, or mysteries introduced but not yet resolved. Include significance level for each.
4. WORLD CHANGES: Permanent changes to locations, factions, or the world state. What is now different from before these chapters began?
5. EMOTIONAL ARC: How the story's emotional tone evolved across these chapters. Map the emotional journey beat by beat.

═══ THEMATIC THROUGH-LINE ANALYSIS ═══

- What theme emerged or deepened across these chapters? (power, loyalty, sacrifice, identity, corruption, redemption, etc.)
- How did the theme manifest differently for the protagonist vs. the antagonists vs. the world at large?
- What thematic question is now posed but unanswered?
- What thematic inversion or subversion occurred?

═══ STAKES ESCALATION TIMELINE ═══

- Map the stakes at the START of the arc → MIDPOINT → END
- What changed to make the consequences bigger?
- What is now IRREVERSIBLE?
- What was lost that can never be regained?
- How did the PROTAGONIST'S PERSONAL STAKES scale (self → loved ones → community → world)?

═══ SUBPLOT INTERWEAVING ═══

- List each subplot (romantic, political, personal, mystery, factional)
- Note where subplots COLLIDED or REINFORCED each other
- Identify subplot threads that were introduced but NOT resolved (carry forward explicitly)
- Note any subplot that was DROPPED or ABANDONED (warn if this was unintentional)

═══ CHARACTER TRANSFORMATION DOSSIER ═══

For each major character, note:
- BEFORE state: who they were at the arc's start
- TRANSFORMING EVENT: the specific moment or choice that changed them
- AFTER state: who they are now
- TRANSFORMATION SPEED: gradual erosion vs. sudden break vs. false recovery
- SETUP FOR FUTURE: any character positioned for a future transformation that hasn't turned yet

═══ WORLD-STATE DELTA ═══

- What permanent changes occurred to the world?
- What institutions were weakened, strengthened, or created?
- What geographic or political boundaries shifted?
- What is now POSSIBLE that was impossible at the arc's start?
- What RESOURCES or CAPABILITIES were gained or lost by key factions?

═══ NARRATIVE DEBT REGISTER ═══

- What promises did the story make to the reader that remain UNPAID?
- What Chekhov's guns were placed on the table? (objects, skills, prophecies, relationships)
- What emotional beats were SET UP but not RESOLVED?
- What MYSTERIES were posed but not answered?
- For each debt: estimate PAYOFF DISTANCE (next arc / mid-story / finale)

═══ INFORMATION ASYMMETRY CARRY-FORWARD ═══

- What secrets does each major faction/character now hold?
- What lies are still believed?
- What truths are about to come out?
- Who is closest to a devastating revelation?

═══ WHAT TO OMIT ═══

- Individual scene-by-scene details (keep only turning points)
- Repeated information across chapters
- Minor NPCs who appeared briefly and didn't affect the plot
- Descriptions of locations already established earlier
- Combat choreography (outcomes and consequences only)

═══ STYLE ═══

- Write in third person, ${tense} tense (reference format, not narrative prose)
- Be comprehensive: 300-500 words. This replaces multiple chapter summaries, so it must be dense with continuity-critical information.
- Focus on WHAT CHANGED and WHY IT MATTERS for future story continuity
- The title should capture the arc's thematic essence (2-6 words)
- Use strong verbs and precise nouns. Avoid hedging language.

═══ OUTPUT FORMAT ═══

${buildMtheriosSummaryInstruction('arc')}

Respond with JSON:
{
  "title": string,
  "summary": "Mtherios bracketed summary string using the required format",
  "keyPlotPoints": string[],
  "characterArcs": [{ "name": string, "development": string }],
  "unresolvedThreads": string[],
  "emotionalProgression": string
}

- keyPlotPoints: 5-10 critical plot events in chronological order. Each should include causality ("X happened BECAUSE Y").
- characterArcs: Development summary for each significant character. Focus on transformation, not description.
- unresolvedThreads: Open questions, unfulfilled promises, looming threats. Tag each with significance if known.
- emotionalProgression: 2-3 sentence description of how emotional tone shifted across the arc. Map the journey.`;

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
