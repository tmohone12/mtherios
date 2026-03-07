import { z } from 'zod';

export const vaultQuerySchema = z.object({
	query: z.string(),
	entryTypes: z.array(z.string()).optional(),
	limit: z.number().optional(),
});

export const vaultActionSchema = z.object({
	action: z.enum(['create', 'update', 'delete', 'link', 'unlink']),
	entryId: z.string().optional(),
	name: z.string().optional(),
	type: z.string().optional(),
	description: z.string().optional(),
	keywords: z.array(z.string()).optional(),
	targetEntryId: z.string().optional(),
	reason: z.string(),
});

export const vaultResultSchema = z.object({
	actions: z.array(vaultActionSchema),
	reasoning: z.string().optional(),
});

export type VaultQuery = z.infer<typeof vaultQuerySchema>;
export type VaultAction = z.infer<typeof vaultActionSchema>;
export type VaultResult = z.infer<typeof vaultResultSchema>;
