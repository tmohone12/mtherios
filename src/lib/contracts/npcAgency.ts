import { z } from 'zod';

export const NPC_AGENCY_FIELDS = [
	{ key: 'currentGoal', label: 'Current goal' },
	{ key: 'currentPlan', label: 'Current plan' },
	{ key: 'lastIndependentAction', label: 'Last independent action' },
	{ key: 'nextOpportunity', label: 'Next opportunity to act' },
	{ key: 'constraint', label: 'Constraint' },
] as const;

const agencyText = z.string().trim().min(1).max(600).nullable().optional();
export const npcAgencySchema = z.object({
	currentGoal: agencyText,
	currentPlan: agencyText,
	lastIndependentAction: agencyText,
	nextOpportunity: agencyText,
	constraint: agencyText,
}).strict();

/** Explicit nulls clear current intent; old metadata must not resurrect it. */
export function readNpcAgency(state: Record<string, unknown>, metadata: Record<string, unknown> = {}): z.infer<typeof npcAgencySchema> {
	const result: z.infer<typeof npcAgencySchema> = {};
	for (const { key } of NPC_AGENCY_FIELDS) {
		const value = Object.hasOwn(state, key) ? state[key] : metadata[key];
		if (value === null) result[key] = null;
		else if (typeof value === 'string' && value.trim()) result[key] = value.trim();
	}
	return result;
}

export const NPC_AGENCY_EXTRACTION_INSTRUCTION = 'NPC agency: update currentGoal, currentPlan, nextOpportunity and constraint only when established or changed; omit unknown/unchanged fields and use null when an intent is completed, abandoned or corrected. Plans and opportunities are intentions, never completed facts. For a consequential independent move actually completed in this narration, set lastIndependentAction to an exact excerpt of independentActionEvidence, and copy independentActionEvidence verbatim from narration including the acting NPC. Do not record a promise, hypothetical, attempted future move or recap as a newly completed action. Set independentActionVisibility to public, player_known or secret according to who can know it. The backend retains this move as a source-linked campaign event; do not duplicate it in timeline_events.';
