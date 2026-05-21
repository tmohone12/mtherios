/**
 * Wiki Lint result schema.
 *
 * Output of WikiLintService — a structured health check over the
 * lorebook. Contradictions, stale claims, orphans, missing entries,
 * gap suggestions.
 */

import { z } from 'zod';

export const lintSeveritySchema = z.enum(['minor', 'moderate', 'major']);
export type LintSeverity = z.infer<typeof lintSeveritySchema>;

export const lintEntryTypeSchema = z.enum([
	'character', 'location', 'item', 'faction', 'concept', 'event',
]);

export const wikiContradictionSchema = z.object({
	entryName: z.string(),
	issue: z.string(),
	conflictsWith: z.string().nullable().optional().default(null),
	severity: lintSeveritySchema.default('moderate'),
});

export const wikiStaleClaimSchema = z.object({
	entryName: z.string(),
	claim: z.string(),
	supersededBy: z.string(),
});

export const wikiOrphanSchema = z.object({
	entryName: z.string(),
	reason: z.string(),
});

export const wikiMissingEntrySchema = z.object({
	suggestedName: z.string(),
	suggestedType: lintEntryTypeSchema,
	mentionedIn: z.string(),
	reason: z.string(),
});

export const wikiGapSuggestionSchema = z.object({
	topic: z.string(),
	suggestion: z.string(),
});

export const wikiTextFixSchema = z.object({
	entryName: z.string(),
	field: z.enum(['name', 'description', 'hiddenInfo']),
	originalText: z.string(),
	correctedText: z.string(),
	reason: z.string(),
});

export const wikiLintResultSchema = z.object({
	contradictions: z.array(wikiContradictionSchema).optional().default([]),
	staleClaims: z.array(wikiStaleClaimSchema).optional().default([]),
	orphans: z.array(wikiOrphanSchema).optional().default([]),
	missingEntries: z.array(wikiMissingEntrySchema).optional().default([]),
	gapSuggestions: z.array(wikiGapSuggestionSchema).optional().default([]),
	textFixes: z.array(wikiTextFixSchema).optional().default([]),
	summary: z.string(),
});

export type WikiLintResult = z.infer<typeof wikiLintResultSchema>;
export type WikiMissingEntry = z.infer<typeof wikiMissingEntrySchema>;
export type WikiTextFix = z.infer<typeof wikiTextFixSchema>;
