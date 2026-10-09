import { z } from 'zod';

export const locationKindSchema = z.enum(['region', 'city', 'district', 'site', 'building', 'room', 'wilderness', 'other']);
export const locationLoreSchema = z.object({
	version: z.literal(1),
	category: z.enum(['identity', 'geography', 'governance', 'law', 'access', 'custom', 'economy', 'religion', 'history']),
	scope: z.enum(['self', 'descendants']),
	origin: z.enum(['foundation', 'campaign']),
	salience: z.enum(['core', 'situational']),
	exceptionToFactIds: z.array(z.string().trim().min(1)).max(20).default([]),
}).strict();
export type LocationLore = z.infer<typeof locationLoreSchema>;

export const locationWorkspaceArgsSchema = z.object({
	locationId: z.string().min(1),
	atTurn: z.number().int().nonnegative().optional(),
	cursor: z.string().optional(),
}).strict();
export const locationSaveArgsSchema = z.object({
	locationId: z.string().min(1),
	expectedVersion: z.number().int().nonnegative(),
	parentLocationId: z.string().min(1).nullable().optional(),
	locationKind: locationKindSchema.optional(),
	lore: z.object({
		id: z.string().min(1).optional(),
		title: z.string().trim().min(1).max(240),
		statement: z.string().trim().min(1).max(12000),
		locationLore: locationLoreSchema,
		validFromTurn: z.number().int().nonnegative().optional(),
		validToTurn: z.number().int().nonnegative().nullable().optional(),
	}).strict().optional(),
	reason: z.string().trim().min(1).max(2000).default('Manual location lore edit.'),
}).strict().refine(value => value.parentLocationId !== undefined || value.locationKind !== undefined || value.lore !== undefined, 'Supply a location or lore change.');

export interface LocationContextPlace {
	id: string;
	name: string;
	kind: z.infer<typeof locationKindSchema> | null;
	description: string | null;
	state: Record<string, unknown>;
	sourceEntryIds: string[];
}

export interface LocationContextFact {
	id: string;
	ownerId: string;
	title: string;
	statement: string;
	lore: LocationLore;
	inherited: boolean;
	sourceEntryIds: string[];
	sourceEventIds: string[];
	sourcePatchIds: string[];
}

export interface LocationLoreContext {
	locationId: string | null;
	atTurn: number;
	/** Root to leaf. A private or malformed edge ends traversal without disclosing the other endpoint. */
	chain: LocationContextPlace[];
	facts: LocationContextFact[];
	relationshipIds: string[];
	supersededFactIds: string[];
	exceptedFactIds: string[];
	warnings: string[];
	incomplete: boolean;
}
