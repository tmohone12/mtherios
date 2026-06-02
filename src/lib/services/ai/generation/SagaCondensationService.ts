/**
 * SagaCondensationService — Mtherios
 *
 * Condenses multiple arcs into higher-level "Saga" summaries.
 * This provides a long-term memory layer above arcs so the world simulation
 * and lore system can operate with compact, high-signal context instead of
 * re-reading every arc.
 *
 * Recommended cadence: every 10 arcs.
 */

import { BaseAIService } from '../BaseAIService';
import { sagaSummarySchema, type SagaSummary } from '../sdk/schemas/saga';
import { createLogger } from '../core/config';
import type { Arc } from '$lib/types';

const log = createLogger('SagaCondensation');

/** Default: condense every 10 arcs into one saga */
export const SAGA_DEFAULTS = {
	arcsPerSaga: 10,
	maxSagaSummaryTokens: 600,
};

export class SagaCondensationService extends BaseAIService {
	constructor() {
		super('sagaCondensation');
	}

	/**
	 * Check if arcs are ready for saga condensation.
	 */
	getCondensableArcs(arcs: Arc[], existingSagaCount: number): Arc[] {
		const arcsPerSaga = SAGA_DEFAULTS.arcsPerSaga;
		const alreadyCovered = existingSagaCount * arcsPerSaga;
		const uncovered = arcs.filter(a => a.arcNumber > alreadyCovered);

		if (uncovered.length < arcsPerSaga) return [];

		return uncovered.slice(0, arcsPerSaga);
	}

	/**
	 * Condense a group of arcs into a saga summary.
	 */
	async condense(
		arcs: Arc[],
		sagaNumber: number,
		mode = 'grimdark',
		pov = 'second',
		tense = 'present',
	): Promise<SagaSummary> {
		log('condense', { arcs: arcs.length, sagaNumber });

		const arcBlock = arcs
			.map(a => {
				const range = a.chapterRange ?? `${a.arcNumber}`;
				let block = `--- Arc ${a.arcNumber} (${range}): ${a.title ?? 'Untitled'} ---\n${a.summary}\n`;
				if (a.unresolvedThreads?.length) {
					block += `Open Threads: ${a.unresolvedThreads.slice(0, 4).join(' | ')}\n`;
				}
				if (a.characterArcs?.length) {
					block += `Character Movement: ${a.characterArcs.slice(0, 3).map(ca => `${ca.name}: ${ca.development}`).join('; ')}\n`;
				}
				return block;
			})
			.join('\n');

		const firstArc = arcs[0]?.arcNumber ?? sagaNumber;
		const lastArc = arcs[arcs.length - 1]?.arcNumber ?? sagaNumber;
		const arcRange = `Arcs ${firstArc}-${lastArc}`;

		const systemPrompt = `You are a long-memory chronicler for a ${mode} interactive fiction story (${pov} person, ${tense} tense).

You are condensing 10 arcs into one SAGA SUMMARY. The saga is a high-level memory layer above arcs. Keep it compact, slow-burn, and grounded in the supplied arc evidence.

Preserve only durable consequences:
- faction power shifts, betrayals, alliances, resource losses, and pressure changes
- major world-state changes that later chapters must remember
- unresolved obligations, rumors, mysteries, and threats that should keep breathing
- the emotional and political tone of the saga

Avoid scene detail, combat choreography, and sudden off-screen character rewrites. NPC and faction changes should feel gradual unless the arcs explicitly justify a break.

Respond with JSON:
{
  "title": string,
  "summary": string,
  "arcRange": string,
  "keyFactionShifts": string[],
  "majorPowerChanges": string[],
  "lingeringThreads": string[],
  "overallTone": string
}

The arcRange must be "${arcRange}".`;

		const userPrompt = `Saga ${sagaNumber} (${arcRange})\n\n${arcBlock}\n\nCreate the saga summary now.`;

		return this.generateStructured(sagaSummarySchema, systemPrompt, userPrompt);
	}
}
