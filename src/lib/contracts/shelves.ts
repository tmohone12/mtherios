import { z } from 'zod';
import { jsonObjectSchema } from './memory';

export const shelfIdParamSchema = z.object({
	shelfId: z.string().trim().min(1),
});

export const createShelfRequestSchema = z.object({
	name: z.string().trim().min(1),
	description: z.string().nullable().optional(),
	genre: z.string().nullable().optional(),
	tags: z.array(z.string().trim().min(1)).default([]),
	coverImageUrl: z.string().nullable().optional(),
	settings: jsonObjectSchema.optional().default({}),
});

export const updateShelfRequestSchema = createShelfRequestSchema.partial().extend({
	metadata: jsonObjectSchema.optional(),
});

export const shelfSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	description: z.string().nullable().default(null),
	genre: z.string().nullable().default(null),
	coverImageUrl: z.string().nullable().default(null),
	settings: jsonObjectSchema.default({}),
	metadata: jsonObjectSchema.default({}),
	storyCount: z.number().int().nonnegative().default(0),
	canonRecordCount: z.number().int().nonnegative().default(0),
	sourceCount: z.number().int().nonnegative().default(0),
	serverVersion: z.number().int().nonnegative().default(1),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const shelfListResponseSchema = z.object({
	shelves: z.array(shelfSummarySchema),
});

export const createShelfResponseSchema = z.object({
	shelfId: z.string(),
	shelf: shelfSummarySchema,
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
});

export type CreateShelfRequest = z.infer<typeof createShelfRequestSchema>;
export type UpdateShelfRequest = z.infer<typeof updateShelfRequestSchema>;
export type ShelfSummary = z.infer<typeof shelfSummarySchema>;
export type CreateShelfResponse = z.infer<typeof createShelfResponseSchema>;
