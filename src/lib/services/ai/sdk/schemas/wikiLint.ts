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

const nonEmptyText = (max = 1000) => z.string().trim().min(1).max(max);
const evidenceSchema = z.array(nonEmptyText(260)).min(1).max(8);
const confidenceSchema = z.number().min(0).max(1);
const entryIdSchema = nonEmptyText(160);

export const wikiContradictionSchema = z.object({
	entryId: entryIdSchema,
	entryName: nonEmptyText(160),
	issue: nonEmptyText(900),
	conflictingEntryId: entryIdSchema.nullable(),
	conflictsWith: nonEmptyText(500),
	severity: lintSeveritySchema,
	evidence: evidenceSchema,
	confidence: confidenceSchema,
}).strict();

export const wikiStaleClaimSchema = z.object({
	entryId: entryIdSchema,
	entryName: nonEmptyText(160),
	claim: nonEmptyText(700),
	supersededBy: nonEmptyText(700),
	severity: lintSeveritySchema,
	evidence: evidenceSchema,
	confidence: confidenceSchema,
}).strict();

export const wikiOrphanSchema = z.object({
	entryId: entryIdSchema,
	entryName: nonEmptyText(160),
	reason: nonEmptyText(700),
	evidence: evidenceSchema,
	confidence: confidenceSchema,
}).strict();

export const wikiMissingEntrySchema = z.object({
	suggestedName: nonEmptyText(160),
	suggestedType: lintEntryTypeSchema,
	mentionedIn: nonEmptyText(220),
	reason: nonEmptyText(700),
	evidence: evidenceSchema,
	confidence: confidenceSchema,
}).strict();

export const wikiGapSuggestionSchema = z.object({
	topic: nonEmptyText(220),
	suggestion: nonEmptyText(900),
	relatedEntryIds: z.array(entryIdSchema).max(12).default([]),
	severity: lintSeveritySchema,
	evidence: evidenceSchema,
	confidence: confidenceSchema,
}).strict();

export const wikiTextFixSchema = z.object({
	entryId: entryIdSchema,
	entryName: nonEmptyText(160),
	field: z.enum(['name', 'description', 'hiddenInfo']),
	originalText: nonEmptyText(1200),
	correctedText: nonEmptyText(1200),
	reason: nonEmptyText(700),
	evidence: evidenceSchema,
	confidence: confidenceSchema,
	safeToAutoApply: z.boolean(),
}).strict().refine((fix) => fix.originalText !== fix.correctedText, {
	message: 'correctedText must differ from originalText',
	path: ['correctedText'],
});

export const wikiLintCoverageSchema = z.object({
	entryCount: z.number().int().nonnegative(),
	relationshipCount: z.number().int().nonnegative(),
	chapterCount: z.number().int().nonnegative(),
	allEntriesIncluded: z.boolean(),
	notes: nonEmptyText(600),
}).strict();

export const wikiLintResultSchema = z.object({
	coverage: wikiLintCoverageSchema,
	contradictions: z.array(wikiContradictionSchema).max(40).default([]),
	staleClaims: z.array(wikiStaleClaimSchema).max(40).default([]),
	orphans: z.array(wikiOrphanSchema).max(80).default([]),
	missingEntries: z.array(wikiMissingEntrySchema).max(60).default([]),
	gapSuggestions: z.array(wikiGapSuggestionSchema).max(60).default([]),
	textFixes: z.array(wikiTextFixSchema).max(80).default([]),
	summary: nonEmptyText(1200),
}).strict();

export type WikiLintResult = z.infer<typeof wikiLintResultSchema>;
export type WikiMissingEntry = z.infer<typeof wikiMissingEntrySchema>;
export type WikiTextFix = z.infer<typeof wikiTextFixSchema>;
