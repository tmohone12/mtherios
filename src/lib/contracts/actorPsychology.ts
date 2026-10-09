import { z } from 'zod';

// A turn-scoped interpretation, never an applied relationship or canonical mood update.
export const actorPsychologySchema = z.object({
	judgment: z.enum(['threatened', 'insulted', 'amused', 'validated', 'indifferent', 'conflicted']).nullable(),
	emotionalIntensity: z.number().int().min(1).max(5).nullable(),
	relationshipDelta: z.number().int().min(-2).max(2).nullable(),
	actionTriage: z.enum(['fight', 'flight', 'freeze', 'fawn', 'controlled']).nullable(),
	confidence: z.number().min(0).max(1),
	advisory: z.literal(true),
	affinityApplied: z.literal(false),
}).strict();
export type ActorPsychology = z.infer<typeof actorPsychologySchema>;
