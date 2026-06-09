import { sendEngineCommand } from './serverStories';

type JsonRecord = Record<string, unknown>;

export interface CanonRepairCandidate {
	id?: string | null;
	type: string;
	name: string;
	aliases?: string[];
	description?: string | null;
	sourceEntryIds?: string[];
	sourceEventIds?: string[];
	sourcePatchIds?: string[];
	relatedEntityIds?: string[];
}

type ResolverDecision = 'update' | 'ask' | 'create' | 'merge';

export interface ResolverApplyResult {
	operation: 'created' | 'updated' | 'merged' | 'review-required';
	resolution: JsonRecord;
	result: JsonRecord;
	mergeResult?: JsonRecord;
}

async function runCanonCommand<T>(storyId: string, command: string, args: JsonRecord): Promise<T> {
	const response = await sendEngineCommand({ storyId, command, args });
	if (response.status !== 'succeeded') {
		throw new Error(response.error ?? `Engine command failed: ${command}`);
	}
	return response.result as T;
}

function normalizeResolverEntry(entry: CanonRepairCandidate): JsonRecord {
	const aliases = (entry.aliases ?? []).map((value) => value.trim()).filter(Boolean);
	const sourceEntryIds = (entry.sourceEntryIds ?? []).map((value) => value.trim()).filter(Boolean);
	const sourceEventIds = (entry.sourceEventIds ?? []).map((value) => value.trim()).filter(Boolean);
	const sourcePatchIds = (entry.sourcePatchIds ?? []).map((value) => value.trim()).filter(Boolean);
	return {
		type: entry.type,
		name: entry.name,
		description: entry.description ?? null,
		aliases,
		sourceEntryIds,
		sourceEventIds,
		sourcePatchIds,
		...(entry.id ? { id: entry.id } : {}),
	};
}

function resolutionDecision(resolution: JsonRecord): ResolverDecision {
	const value = resolution.decision;
	if (value === 'update' || value === 'ask' || value === 'create' || value === 'merge') return value;
	return 'ask';
}

function matchedEntityIdFromResolution(resolution: JsonRecord): string | null {
	if (typeof resolution.matchedEntityId === 'string' && resolution.matchedEntityId.trim()) {
		return resolution.matchedEntityId.trim();
	}
	return null;
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export async function searchCanonPages(storyId: string, query: string, limit = 12) {
	return await runCanonCommand<JsonRecord>(storyId, 'wiki.search', {
		storyId,
		q: query,
		limit,
	});
}

export async function readCanonPage(storyId: string, page: string) {
	return await runCanonCommand<JsonRecord>(storyId, 'wiki.page', {
		storyId,
		page,
	});
}

export async function lintCanonWiki(storyId: string) {
	return await runCanonCommand<JsonRecord>(storyId, 'wiki.lint', {
		storyId,
	});
}

export async function previewEntityResolution(storyId: string, candidate: CanonRepairCandidate, includeSemantic = true) {
	return await runCanonCommand<JsonRecord>(storyId, 'entity.resolve', {
		candidate,
		includeSemantic,
	});
}

export async function createEntityThroughResolver(storyId: string, candidate: CanonRepairCandidate): Promise<ResolverApplyResult> {
	const preview = await previewEntityResolution(storyId, candidate);
	const previewRecord = asRecord(preview);
	const resolution = previewRecord.resolution && typeof previewRecord.resolution === 'object'
		? (previewRecord.resolution as JsonRecord)
		: {};
	const decision = resolutionDecision(resolution);
	const matchedEntityId = matchedEntityIdFromResolution(resolution);

	if (decision === 'ask') {
		return {
			operation: 'review-required',
			resolution: asRecord(preview),
			result: asRecord(preview),
		};
	}

	if (decision === 'create') {
		const result = await runCanonCommand<JsonRecord>(storyId, 'entity.upsert', {
			entry: normalizeResolverEntry(candidate),
		});
		return {
			operation: 'created',
			resolution: asRecord(preview),
			result,
		};
	}

	if (decision === 'update') {
		if (!matchedEntityId) throw new Error('Resolver returned update without a matched entity id.');
		const result = await runCanonCommand<JsonRecord>(storyId, 'entity.upsert', {
			entry: {
				...normalizeResolverEntry(candidate),
				id: matchedEntityId,
			},
		});
		return {
			operation: 'updated',
			resolution: asRecord(preview),
			result,
		};
	}

	// decision === 'merge'
	if (!candidate.id?.trim()) {
		throw new Error('Resolver requested merge, but no duplicate entity id was provided.');
	}
	if (!matchedEntityId) {
		throw new Error('Resolver requested merge, but no target entity id was returned.');
	}

	const sourceEntityId = candidate.id.trim();
	const mergeResult = sourceEntityId === matchedEntityId
		? null
		: await mergeEntities(storyId, matchedEntityId, sourceEntityId, `Merged via resolver in repair cockpit: ${String(resolution.reason ?? 'merge requested').slice(0, 180)}`);

	const result = await runCanonCommand<JsonRecord>(storyId, 'entity.upsert', {
		entry: {
			...normalizeResolverEntry(candidate),
			id: matchedEntityId,
		},
	});

	return {
		operation: 'merged',
		resolution: asRecord(preview),
		result,
		...(mergeResult ? { mergeResult } : {}),
	};
}

export async function addEntityAlias(
	storyId: string,
	entityId: string,
	alias: string,
	sourceEntryIds: string[] = [],
	sourceEventIds: string[] = [],
	sourcePatchIds: string[] = [],
) {
	return await runCanonCommand<JsonRecord>(storyId, 'entity.alias.add', {
		entityId,
		alias,
		sourceEntryIds,
		sourceEventIds,
		sourcePatchIds,
	});
}

export async function mergeEntities(
	storyId: string,
	keepEntityId: string,
	mergeEntityId: string,
	reason = 'Manual entity merge.',
) {
	return await runCanonCommand<JsonRecord>(storyId, 'entity.merge', {
		keepEntityId,
		mergeEntityId,
		reason,
	});
}

export async function reviewPatchProposal(
	storyId: string,
	proposalId: string,
	decision: 'approved' | 'rejected',
	reviewer = 'human',
	notes = '',
) {
	return await runCanonCommand<JsonRecord>(storyId, 'patchProposal.review', {
		proposalId,
		decision,
		reviewer,
		notes,
	});
}

export async function runContinuityAudit(storyId: string, limit = 10) {
	return await runCanonCommand<JsonRecord>(storyId, 'continuity.audit', {
		limit,
	});
}
