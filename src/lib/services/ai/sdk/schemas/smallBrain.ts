import { z } from 'zod';

export const smallBrainModeSchema = z.enum(['context', 'canon', 'world']);

const stringArraySchema = z.array(z.string()).default([]);

export const smallBrainContextResultSchema = z.object({
	mode: z.literal('context'),
	brief: z.string().min(1),
	relevantEntryIds: stringArraySchema,
	relevantEntityIds: stringArraySchema,
	relevantFactionIds: stringArraySchema,
	promptNotes: stringArraySchema,
	uncertainties: stringArraySchema,
	evidence: z.array(z.object({
		statement: z.string().min(1),
		sourceIds: z.array(z.string().min(1)).min(1),
	}).strict()).default([]),
}).strict();

export const smallBrainCanonResultSchema = z.object({
	mode: z.literal('canon'),
	proposals: z.array(z.object({
		kind: z.enum(['fact', 'event', 'memory', 'relationship', 'contradiction']),
		summary: z.string().min(1),
		confidence: z.number().min(0).max(1),
		sourceEntryIds: stringArraySchema,
		affectedEntityIds: stringArraySchema,
		affectedFactionIds: stringArraySchema,
		reviewNote: z.string().optional(),
	}).strict()).default([]),
	rejected: z.array(z.object({
		summary: z.string().min(1),
		reason: z.string().min(1),
	}).strict()).default([]),
}).strict();

export const smallBrainWorldResultSchema = z.object({
	mode: z.literal('world'),
	npcIntents: z.array(z.object({
		entityId: z.string().optional(),
		name: z.string().min(1),
		intent: z.string().min(1),
		pressure: z.number().min(0).max(1),
		evidenceEntryIds: stringArraySchema,
	}).strict()).default([]),
	strategicPulse: z.array(z.object({
		factionId: z.string().optional(),
		label: z.string().min(1),
		pressure: z.number().min(0).max(1),
		recommendedAttention: z.string().min(1),
	}).strict()).default([]),
	wikiDrafts: z.array(z.object({
		title: z.string().min(1),
		body: z.string().min(1),
		sourceEntryIds: stringArraySchema,
	}).strict()).default([]),
}).strict();

export const smallBrainResultSchema = z.discriminatedUnion('mode', [
	smallBrainContextResultSchema,
	smallBrainCanonResultSchema,
	smallBrainWorldResultSchema,
]);

export type SmallBrainMode = z.infer<typeof smallBrainModeSchema>;
export type SmallBrainResult = z.infer<typeof smallBrainResultSchema>;
