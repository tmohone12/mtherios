type JsonRecord = Record<string, unknown>;
export const CHARACTER_IDENTITY_FIELDS = new Set([
	'bio', 'background', 'description', 'appearance', 'personality', 'rank',
	'speechStyle', 'nationality', 'origin', 'upbringing', 'occupation', 'role',
	'allegiance', 'secretAllegiance', 'hiddenInfo', 'traits', 'aliases', 'knownFacts',
	'voice', 'mannerisms', 'personalityDescriptors', 'visualDescriptors',
]);

export function retainAutomaticCharacterIdentity(current: JsonRecord, proposed: JsonRecord): JsonRecord {
	const next = { ...proposed };
	for (const key of CHARACTER_IDENTITY_FIELDS) {
		if (Object.hasOwn(current, key)) next[key] = current[key];
		else delete next[key];
	}
	return next;
}

/** Automatic clients send a delta and original source IDs, never a biography
 * snapshot. The backend decides which fields need human continuity review. */
export function automaticCharacterUpdate(current: JsonRecord, proposed: JsonRecord, sourceEntryIds: string[]): JsonRecord {
	const patch = Object.fromEntries(Object.entries(proposed).filter(([key, value]) => value !== undefined && JSON.stringify(value) !== JSON.stringify(current[key])));
	return {
		patch,
		expected: Object.fromEntries(Object.keys(patch).map(key => [key, current[key] ?? null])),
		sourceEntryIds: [...new Set(sourceEntryIds)],
	};
}
