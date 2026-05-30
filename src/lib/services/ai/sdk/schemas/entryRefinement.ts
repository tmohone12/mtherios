import { z } from 'zod';

const factionGoalRefinementSchema = z.object({
	description: z.string(),
	priority: z.number().min(1).max(10).optional().default(5),
	progress: z.number().min(0).max(100).optional().default(0),
	type: z.enum(['military', 'diplomatic', 'economic', 'intelligence', 'survival', 'expansion']).optional().default('diplomatic'),
	deadline: z.string().nullable().optional(),
});

const factionResourcesRefinementSchema = z.object({
	military: z.number().min(0).max(100).optional().default(50),
	wealth: z.number().min(0).max(100).optional().default(50),
	influence: z.number().min(0).max(100).optional().default(50),
	information: z.number().min(0).max(100).optional().default(50),
	morale: z.number().min(0).max(100).optional().default(50),
});

export const entryRefinementResultSchema = z.object({
	description: z.string().nullable().optional(),
	keywords: z.array(z.string()).nullable().optional(),
	aliases: z.array(z.string()).nullable().optional(),
	hiddenInfo: z.string().nullable().optional(),
	// Character-only state enrichment. Omit/null for other entry types.
	bio: z.string().nullable().optional(),
	motivations: z.array(z.string()).nullable().optional(),
	personality: z.string().nullable().optional(),
	currentDisposition: z.string().nullable().optional(),
	personalOpinion: z.string().nullable().optional(),
	pressures: z.array(z.string()).nullable().optional(),
	factionTags: z.array(z.string()).nullable().optional(),
	knownFacts: z.array(z.string()).nullable().optional(),
	revealedSecrets: z.array(z.string()).nullable().optional(),
	relationshipLevel: z.number().min(-100).max(100).nullable().optional(),
	relationshipStatus: z.string().nullable().optional(),
	// Faction-only operational state. Omit/null for other entry types.
	playerStanding: z.number().min(-100).max(100).nullable().optional(),
	factionStatus: z.enum(['allied', 'neutral', 'hostile', 'unknown']).nullable().optional(),
	knownMembers: z.array(z.string()).nullable().optional(),
	goals: z.array(factionGoalRefinementSchema).nullable().optional(),
	resources: factionResourcesRefinementSchema.nullable().optional(),
	disposition: z.enum(['aggressive', 'defensive', 'scheming', 'neutral', 'desperate']).nullable().optional(),
	territory: z.array(z.string()).nullable().optional(),
	reasoning: z.string(),
});

export type EntryRefinementResult = z.infer<typeof entryRefinementResultSchema>;
