import { z } from 'zod';

/**
 * Schema for a single faction's reactive micro-simulation.
 * Lightweight: ~100 tokens out. Triggered by classifier faction signals.
 */

export const microFactionReactionSchema = z.object({
	action: z.string().describe('1-2 sentence description of what the faction does in response'),
	actionType: z.enum(['military', 'diplomatic', 'economic', 'intelligence', 'internal', 'none']),
	visible: z.boolean().describe('Would the player or nearby NPCs notice this action?'),
	rumor: z.string().nullable().describe('How this action might reach the player as gossip — null if invisible'),
	consequence: z.string().nullable().describe('1 sentence: what changes in the world because of this action'),
});

export const microFactionResultSchema = z.object({
	factionName: z.string(),
	reaction: microFactionReactionSchema,
});

export type MicroFactionReaction = z.infer<typeof microFactionReactionSchema>;
export type MicroFactionResult = z.infer<typeof microFactionResultSchema>;
