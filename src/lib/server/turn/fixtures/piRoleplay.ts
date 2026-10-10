import type { Attempt } from '$lib/server/factions/intentions';

/** Synthetic accepted decision. No historic run artifact or provider request is needed. */
export function syntheticPiDecision(prior: Attempt): Attempt {
	return { ...structuredClone(prior), id: 'synthetic_relief_talk', reason: null,
		intention: prior.intention ? { ...structuredClone(prior.intention), id: 'league_relief_talk' } : null,
		decision: { model: 'synthetic-decision', confidence: 0.9, sourceIds: ['known_response'] } };
}
