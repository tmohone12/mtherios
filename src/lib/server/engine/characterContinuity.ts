import { createHash } from 'node:crypto';
import { CHARACTER_IDENTITY_FIELDS } from '$lib/contracts/automaticCharacterUpdate';
export { CHARACTER_IDENTITY_FIELDS };

type RecordValue = Record<string, unknown>;
// These describe enduring identity. Scene state (location, action, disposition,
// clothing, goals, injuries, relationships) continues through its existing owners.

export interface CharacterContinuitySource {
	id: string;
	storyId: string;
	content: string;
	entityId?: string;
	narrative?: boolean;
}

export interface CharacterContinuityConflict {
	field: string;
	previous: unknown;
	proposed: unknown;
	reason: string;
	sources: Array<{ id: string; quote: string; sha256: string }>;
}

const textKey = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
const present = (value: unknown) => value !== undefined && value !== null
	&& (typeof value !== 'string' || value.trim().length > 0)
	&& (!Array.isArray(value) || value.length > 0)
	&& (typeof value !== 'object' || Object.keys(value as object).length > 0);

/** No semantic guess can authorize rewriting a life story. Changes to identity
 * are reviewable independently of a turn's current state, including explicit
 * revelations/retcons. Approval uses the ordinary narrow, versioned write path.
 * Evidence is kept outside the biography so an accusation cannot become origin. */
export function boundCharacterIdentity(input: {
	storyId: string;
	entityId: string;
	names: string[];
	current: RecordValue;
	patch: RecordValue;
	sources: CharacterContinuitySource[];
}): { patch: RecordValue; conflicts: CharacterContinuityConflict[] } {
	const patch = { ...input.patch };
	const conflicts: CharacterContinuityConflict[] = [];
	for (const [field, proposed] of Object.entries(patch)) {
		if (!CHARACTER_IDENTITY_FIELDS.has(field)) continue;
		delete patch[field];
		if (!present(proposed) || JSON.stringify(input.current[field]) === JSON.stringify(proposed)) continue;
		if (Array.isArray(proposed) && Array.isArray(input.current[field]) && proposed.every(value => (input.current[field] as unknown[]).some(previous => JSON.stringify(previous) === JSON.stringify(value)))) continue;
		// An existing statement repeated inside an extracted recap is unchanged.
		if (typeof proposed === 'string' && typeof input.current[field] === 'string'
			&& textKey(input.current[field] as string).includes(textKey(proposed))) continue;
		const values = typeof proposed === 'string' ? [proposed] : Array.isArray(proposed) ? proposed.filter((v): v is string => typeof v === 'string') : [];
		const sources = input.sources.filter(source => source.storyId === input.storyId
			&& source.narrative !== false && (!source.entityId || source.entityId === input.entityId))
			.flatMap(source => {
				const content = textKey(source.content);
				return values.filter(value => value.trim().length >= 12 && content.includes(textKey(value))
					&& input.names.some(name => {
						const escaped = textKey(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
						return escaped && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u').test(textKey(value));
					})).map(value => {
						const original = source.content.replace(/\s+/g, ' ').trim();
						const start = original.toLocaleLowerCase().indexOf(textKey(value));
						return { id: source.id, quote: original.slice(Math.max(0, start - 180), start + textKey(value).length + 180), sha256: createHash('sha256').update(source.content).digest('hex') };
					});
			});
		conflicts.push({ field, previous: input.current[field] ?? null, proposed,
			reason: sources.length ? 'Identity change requires review; source statements may describe belief, disguise, a namesake or a retcon.' : 'No exact actor-specific original passage supports this identity change.',
			sources: [...new Map(sources.map(source => [source.id + textKey(source.quote), source])).values()],
		});
	}
	return { patch, conflicts };
}

export function characterIdentityRevision(current: RecordValue): string {
	return createHash('sha256').update(JSON.stringify(Object.fromEntries(
		[...CHARACTER_IDENTITY_FIELDS].sort().map(key => [key, current[key] ?? null]),
	))).digest('hex');
}
