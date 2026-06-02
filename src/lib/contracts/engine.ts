import { z } from 'zod';
import { jsonObjectSchema } from './memory';

export const llmServiceSettingSchema = z.object({
	serviceId: z.string().min(1),
	providerType: z.string().min(1),
	baseUrl: z.string().nullable().default(null),
	model: z.string().nullable().default(null),
	temperature: z.number().min(0).max(2).default(1),
	maxTokens: z.number().int().min(128).max(65536).default(4096),
	topP: z.number().min(0).max(1).nullable().default(null),
	frequencyPenalty: z.number().min(-2).max(2).nullable().default(null),
	presencePenalty: z.number().min(-2).max(2).nullable().default(null),
	reasoningEffort: z.string().nullable().default(null),
	contextBudget: z.number().int().positive().nullable().default(null),
	enabled: z.boolean().default(true),
	systemPromptOverride: z.string().nullable().default(null),
	apiKeyRef: z.string().nullable().default(null),
	metadata: jsonObjectSchema.default({}),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

export const llmSecretRefSchema = z.object({
	ref: z.string().min(1),
	value: z.string().min(1),
});

export const llmSettingsPatchSchema = z.object({
	settings: z.array(llmServiceSettingSchema).default([]),
	secrets: z.array(llmSecretRefSchema).default([]),
});

export const recordPatchRequestSchema = z.object({
	updates: jsonObjectSchema,
	reason: z.string().default('Manual explorer edit.'),
});

export const worldRecordsQuerySchema = z.object({
	type: z.string().default('entities'),
	q: z.string().default(''),
	cursor: z.string().nullable().default(null),
	limit: z.number().int().min(1).max(200).default(50),
});

export const searchQuerySchema = z.object({
	q: z.string().default(''),
	type: z.string().nullable().default(null),
	limit: z.number().int().min(1).max(50).default(12),
	includeSemantic: z.boolean().default(true),
});

export const reindexStoryRequestSchema = z.object({
	storyId: z.string().min(1),
	runNow: z.boolean().default(false),
	recordTypes: z.array(z.string()).default([]),
	recreate: z.boolean().default(false),
	provider: z.string().nullable().default(null),
	model: z.string().nullable().default(null),
});

export const apiCallLogCreateSchema = z.object({
	storyId: z.string().min(1).nullable().optional(),
	serviceId: z.string().min(1).nullable().optional(),
	operation: z.string().min(1),
	providerType: z.string().nullable().optional(),
	providerName: z.string().nullable().optional(),
	profileId: z.string().nullable().optional(),
	model: z.string().nullable().optional(),
	endpoint: z.string().nullable().optional(),
	status: z.enum(['success', 'error']).default('success'),
	durationMs: z.number().int().nonnegative(),
	requestTokens: z.number().int().nonnegative().nullable().optional(),
	responseTokens: z.number().int().nonnegative().nullable().optional(),
	totalTokens: z.number().int().nonnegative().nullable().optional(),
	promptChars: z.number().int().nonnegative().nullable().optional(),
	responseChars: z.number().int().nonnegative().nullable().optional(),
	error: z.string().nullable().optional(),
	metadata: jsonObjectSchema.default({}),
});

export type LlmServiceSetting = z.infer<typeof llmServiceSettingSchema>;
export type RecordPatchRequest = z.infer<typeof recordPatchRequestSchema>;
export type ApiCallLogCreate = z.infer<typeof apiCallLogCreateSchema>;
