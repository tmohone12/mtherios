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

async function runCanonCommand<T>(storyId: string, command: string, args: JsonRecord): Promise<T> {
	const response = await sendEngineCommand({ storyId, command, args });
	if (response.status !== 'succeeded') {
		throw new Error(response.error ?? `Engine command failed: ${command}`);
	}
	return response.result as T;
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

export async function createEntityThroughResolver(storyId: string, entry: JsonRecord) {
	return await runCanonCommand<JsonRecord>(storyId, 'entity.create', { entry });
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
