import { z } from 'zod';

/**
 * Schema for AI-extracted procedural rules from chapters/arcs.
 * The reflector stage of the CASS-inspired pipeline.
 */

export const extractedRuleSchema = z.object({
	content: z.string().describe('The rule or pattern expressed as a clear, actionable statement'),
	category: z.enum([
		'character_behavior',
		'world_rule',
		'narrative_pattern',
		'player_preference',
		'anti_pattern',
		'lore_connection',
	]),
	type: z.enum(['rule', 'anti_pattern']),
	confidence: z.number().min(0).max(1).describe('How confident this rule is based on evidence (0-1)'),
	relatedEntities: z.array(z.string()).describe('Names of characters, locations, items, or lore entries this rule references'),
	tags: z.array(z.string()).describe('Searchable tags for retrieval'),
});

export const reflectionResultSchema = z.object({
	rules: z.array(extractedRuleSchema),
	summary: z.string().describe('Brief summary of what patterns were identified'),
});

export const ruleRelevanceSchema = z.object({
	ruleIds: z.array(z.string()),
	reason: z.string(),
});

export type ExtractedRule = z.infer<typeof extractedRuleSchema>;
export type ReflectionResult = z.infer<typeof reflectionResultSchema>;
export type RuleRelevance = z.infer<typeof ruleRelevanceSchema>;
