import { z } from 'zod';

const notes = z.array(z.string().trim().min(1).max(300)).max(12);

export const playerCapabilitiesSchema = z.object({
	abilities: notes.default([]),
	buffs: notes.default([]),
}).strict();

export const playerCapabilitiesUpdateSchema = z.object({
	abilities: notes.optional(),
	buffs: notes.optional(),
}).strict().refine(value => value.abilities !== undefined || value.buffs !== undefined, 'Supply abilities or buffs; an empty list clears that field.');

export type PlayerCapabilities = z.infer<typeof playerCapabilitiesSchema>;

export function readPlayerCapabilities(value: unknown): PlayerCapabilities {
	const result = playerCapabilitiesSchema.safeParse(value ?? {});
	return result.success ? result.data : { abilities: [], buffs: [] };
}
