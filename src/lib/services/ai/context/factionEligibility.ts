type WorldSimFaction = {
	id: string;
	status?: string | null;
	metadata?: unknown;
};

type WorldSimFactionEntity = {
	status?: string | null;
	state?: unknown;
	metadata?: unknown;
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metadataWithOriginal(value: unknown): Record<string, unknown> {
	const metadata = record(value);
	return { ...record(metadata.originalMetadata), ...metadata };
}

function inactiveEraValue(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	const key = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	return ['dead', 'deceased', 'historical', 'inactive', 'archived', 'merged', 'superseded'].includes(key);
}

export function canonicalFactionIdentity(
	faction: WorldSimFaction,
	linkedEntity?: WorldSimFactionEntity | null,
): string {
	const factionMetadata = metadataWithOriginal(faction.metadata);
	const entityMetadata = metadataWithOriginal(linkedEntity?.metadata);
	const entityState = record(linkedEntity?.state);
	for (const value of [
		factionMetadata.mergedInto,
		factionMetadata.canonicalFactionId,
		factionMetadata.linkedFactionId,
		entityState.canonicalFactionId,
		entityState.linkedFactionId,
		entityMetadata.canonicalFactionId,
		entityMetadata.linkedFactionId,
	]) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return faction.id;
}

export function isWorldSimEligibleFaction(
	faction: WorldSimFaction,
	linkedEntity?: WorldSimFactionEntity | null,
): boolean {
	const factionMetadata = metadataWithOriginal(faction.metadata);
	const entityMetadata = metadataWithOriginal(linkedEntity?.metadata);
	const entityState = record(linkedEntity?.state);
	if (inactiveEraValue(faction.status)
		|| (typeof factionMetadata.mergedInto === 'string' && Boolean(factionMetadata.mergedInto.trim()))) return false;
	if (inactiveEraValue(linkedEntity?.status)) return false;
	if (factionMetadata.activeEra === false || entityState.activeEra === false || entityMetadata.activeEra === false) return false;
	if ([factionMetadata.lifeStatus, entityState.lifeStatus, entityMetadata.lifeStatus].some(inactiveEraValue)) return false;

	const scratch = factionMetadata.scratchSeed === true
		|| entityMetadata.scratchSeed === true
		|| faction.id.startsWith('veil_scratch_');
	const generatedTag = factionMetadata.sourceType === 'character_faction_tag' || faction.id.startsWith('faction_tag_');
	if (!scratch && !generatedTag) return factionMetadata.worldSimEnabled !== false;

	return factionMetadata.worldSimPromoted === true
		&& factionMetadata.worldSimEnabled === true
		&& factionMetadata.currentStoryEvidence === true;
}
