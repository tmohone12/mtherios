import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import {
	continuityWarnings,
	entities,
	entityAliases,
	facts,
	factions,
	factionMemberships,
	factionProjects,
	factionResources,
	memoryNodes,
	npcBeliefs,
	npcEventLinks,
	patchProposals,
	relationships,
	sourceRefs,
	stories,
	storyEntries,
	storyEvents,
	storyThreads,
} from '$lib/server/db/schema';
import { enqueueBackendJob, enqueueStoryVaultSyncJob } from '$lib/server/jobs/outbox';
import { auditDueFactionProjects, dueFactionProjectFingerprint, evaluateProjectCosts } from '$lib/server/factions/projects';
import { isCharacterTitleOnlyName, resolveEntityIdentity, entityResolutionSummary, type EntityIdentityCandidate } from '$lib/server/memory/entityResolver';
import { characterDraftSourceSnapshot } from './characterDrafts';
import { boundCharacterIdentity } from './characterContinuity';
import { appendCharacterDevelopments, foldAuthoredTextIntoDevelopments, readCharacterDevelopments } from '$lib/contracts/automaticCharacterUpdate';
import { validateLocationParent } from './locationRecords';
import { isEffectiveContainment } from '$lib/server/memory/locationLore';

type JsonRecord = Record<string, unknown>;
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type ProposalApplication = {
	appliedCount: number;
	appliedOperations: JsonRecord[];
	affectedEntityIds: string[];
	metadata?: JsonRecord;
};

function nowIso(): string {
	return new Date().toISOString();
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function unique(values: Array<string | null | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())) )];
}

function normalizeAlias(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeIdentityName(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

function containedNameMatch(left: string, right: string): boolean {
	const a = normalizeIdentityName(left);
	const b = normalizeIdentityName(right);
	if (!a || !b || a === b) return false;
	if (isCharacterTitleOnlyName(a) || isCharacterTitleOnlyName(b)) return false;
	if (a.length < 5 || b.length < 5) return false;
	return a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

function replaceInArray(values: string[] = [], from: string, to: string): string[] {
	return unique(values.map((value) => value === from ? to : value));
}

function arrayChanged(left: string[] = [], right: string[] = []): boolean {
	if (left.length !== right.length) return true;
	return left.some((value, index) => value !== right[index]);
}

function mergeArrayValues(existing: unknown, patch: unknown[], max = 24): unknown[] {
	const byKey = new Map<string, unknown>();
	for (const item of [...(Array.isArray(existing) ? existing : []), ...patch]) {
		const key = typeof item === 'string' ? item : JSON.stringify(item) ?? String(item);
		byKey.set(key, item);
	}
	return [...byKey.values()].slice(-max);
}

export function mergeRecords(base: JsonRecord, patch: JsonRecord): JsonRecord {
	return { ...base, ...patch };
}

export function mergeCharacterReferenceState(existing: JsonRecord, patch: JsonRecord): JsonRecord {
	const merged = { ...existing };
	for (const [key, value] of Object.entries(patch)) {
		if (value == null || (typeof value === 'string' && !value.trim())) continue;
		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			merged[key] = mergeArrayValues(merged[key], value);
			continue;
		}
		if (key === 'relationship' && typeof value === 'object') {
			const current = typeof merged[key] === 'string' ? { status: merged[key] } : asRecord(merged[key]);
			const patchRelationship = asRecord(value);
			merged[key] = {
				...current,
				...patchRelationship,
				...(Array.isArray(patchRelationship.history)
					? { history: mergeArrayValues(current.history, patchRelationship.history) } : {}),
			};
			continue;
		}
		if (key === 'eventMemory' && typeof value === 'object' && !Array.isArray(value)) {
			const current = asRecord(merged[key]);
			const next: JsonRecord = { ...current };
			for (const [memoryKey, memoryValue] of Object.entries(asRecord(value))) {
				if (Array.isArray(memoryValue)) next[memoryKey] = unique([...asStringArray(current[memoryKey]), ...asStringArray(memoryValue)]).slice(-16);
				else if (memoryValue != null && memoryValue !== '') next[memoryKey] = memoryValue;
			}
			merged[key] = next;
			continue;
		}
		merged[key] = value;
	}
	return merged;
}

export function stripMergedIntoMetadata(metadata: JsonRecord): JsonRecord {
	const { mergedInto: _mergedInto, ...rest } = metadata;
	return rest;
}

function mergedFromEntries(metadata: JsonRecord): JsonRecord[] {
	const existing = metadata.mergedFrom;
	if (Array.isArray(existing)) return existing.map(asRecord).filter((entry) => Object.keys(entry).length > 0);
	const record = asRecord(existing);
	if (Object.keys(record).length > 0) return [record];
	if (typeof existing === 'string' && existing.trim()) return [{ entityId: existing.trim() }];
	return [];
}

export function mergeMergedFromHistory(sourceMetadata: JsonRecord, keepMetadata: JsonRecord, source: JsonRecord): JsonRecord[] {
	const byKey = new Map<string, JsonRecord>();
	const add = (entry: JsonRecord) => {
		const key = typeof entry.entityId === 'string' && entry.entityId.trim()
			? entry.entityId.trim()
			: JSON.stringify(entry);
		if (!byKey.has(key)) byKey.set(key, entry);
	};
	for (const entry of mergedFromEntries(sourceMetadata)) add(entry);
	for (const entry of mergedFromEntries(keepMetadata)) add(entry);
	add(source);
	return Array.from(byKey.values());
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asNullableString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

export function isInvalidSourceRefForRepair(row: Pick<typeof sourceRefs.$inferSelect, 'sourceType' | 'sourceId' | 'targetTable' | 'targetRecordId'>): boolean {
	return !row.sourceType.trim() || !row.sourceId.trim() || !row.targetTable.trim() || !row.targetRecordId.trim();
}

export function canonDriftSourceRefKey(row: Pick<typeof sourceRefs.$inferSelect, 'sourceType' | 'sourceId' | 'targetTable' | 'targetRecordId' | 'targetRecordField' | 'sourceField'>): string {
	return [
		row.sourceType,
		row.sourceId,
		row.targetTable,
		row.targetRecordId,
		row.targetRecordField ?? '',
		row.sourceField ?? '',
	].join('\u001f');
}

export function isUnsafeMemoryNodeForRepair(row: Pick<typeof memoryNodes.$inferSelect, 'title' | 'summary' | 'content'>): boolean {
	return /transcript context removed|poisoned context|deleted a poisoned context|do not treat (this|that) as canon|i overreached/i
		.test(`${row.title}\n${row.summary ?? ''}\n${row.content}`);
}

function asInteger(value: unknown, fallback: number): number {
	if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === 'string') {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function stableIdSegment(value: string): string {
	const ascii = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);
	if (ascii && !/[^\x00-\x7f]/.test(value)) return ascii;
	const hash = createHash('sha256').update(value.normalize('NFKC')).digest('hex').slice(0, 12);
	return `${(ascii || 'record').slice(0, 83)}_${hash}`;
}

function emptyProposalApplication(): ProposalApplication {
	return { appliedCount: 0, appliedOperations: [], affectedEntityIds: [] };
}

function isDueFactionProjectProposal(proposal: typeof patchProposals.$inferSelect): boolean {
	const metadata = asRecord(proposal.metadata);
	return proposal.proposedBy === 'faction_project_auditor'
		|| metadata.sourceType === 'due_faction_project_audit'
		|| proposal.proposalType === 'faction_project_due_resolution'
		|| proposal.proposalType === 'faction_project_blocked_resolution';
}

async function applyDueFactionProjectProposal(tx: Tx, input: {
	storyId: string;
	proposal: typeof patchProposals.$inferSelect;
	serverVersion: number;
	now: string;
}): Promise<ProposalApplication> {
	const operations = Array.isArray(input.proposal.operations) ? input.proposal.operations : [];
	const metadata = asRecord(input.proposal.metadata);
	const appliedOperations: JsonRecord[] = [];
	const currentTurn = asInteger(metadata.currentTurn, 0);
	const [project] = await tx.select().from(factionProjects).where(and(
		eq(factionProjects.storyId, input.storyId), eq(factionProjects.id, input.proposal.targetRecordId),
	)).for('update');
	if (!project || !['planned', 'active'].includes(project.status)) {
		throw new Error('Faction project changed or is no longer active. Run the due project audit again.');
	}
	const resources = await tx.select().from(factionResources).where(and(
		eq(factionResources.storyId, input.storyId), eq(factionResources.factionId, project.factionId),
	)).orderBy(factionResources.id).for('update');
	if (typeof metadata.auditFingerprint !== 'string'
		|| metadata.auditFingerprint !== dueFactionProjectFingerprint(project, resources)) {
		throw new Error('Faction project or resources changed since review. Run the due project audit again.');
	}
	const costCheck = evaluateProjectCosts(project, resources);
	const expectedStatus = !costCheck.ok ? 'blocked' : project.progress >= 1 ? 'completed' : 'active';

	for (const rawOperation of operations) {
		const operation = asRecord(rawOperation);
		const op = asString(operation.op);
		const path = asString(operation.path);

		const projectStatusMatch = path.match(/^\/faction_projects\/([^/]+)\/status$/);
		if (op === 'replace' && projectStatusMatch) {
			const projectId = projectStatusMatch[1];
			if (projectId !== input.proposal.targetRecordId) continue;
			const status = asString(operation.value);
			if (status !== expectedStatus) throw new Error('Faction project resolution changed. Run the due project audit again.');
			const [updated] = await tx.update(factionProjects).set({
				status,
				sourcePatchIds: unique([...project.sourcePatchIds, ...(input.proposal.sourcePatchIds ?? []), input.proposal.id]),
				serverVersion: input.serverVersion,
				updatedAt: input.now,
			}).where(and(
				eq(factionProjects.storyId, input.storyId),
				eq(factionProjects.id, projectId),
			)).returning({ id: factionProjects.id, status: factionProjects.status });
			if (updated) {
				appliedOperations.push({
					op,
					path,
					table: 'faction_projects',
					recordId: updated.id,
					status: updated.status,
				});
			}
			continue;
		}

		if (op === 'add' && path === '/story_events') {
			const value = asRecord(operation.value);
			const proposedMetadata = asRecord(value.metadata);
			const eventId = `event_${stableIdSegment(input.proposal.id)}`;
			const requestedStatus = asString(value.status, 'committed');
			const status = requestedStatus === 'proposed' ? 'committed' : requestedStatus;
			await tx.insert(storyEvents).values({
				id: eventId,
				storyId: input.storyId,
				type: asString(value.type, 'faction_move'),
				status,
				title: asString(value.title, input.proposal.reason || 'Faction project resolved'),
				body: asString(value.body, input.proposal.suggestion || input.proposal.reason || 'Faction project consequence applied.'),
				actorEntityIds: asStringArray(value.actorEntityIds),
				targetEntityIds: asStringArray(value.targetEntityIds),
				locationId: asNullableString(value.locationId),
				locationIds: asStringArray(value.locationIds),
				factionIds: asStringArray(value.factionIds),
				threadIds: asStringArray(value.threadIds),
				visibility: asString(value.visibility, 'player_known'),
				createdTurn: asInteger(value.createdTurn, currentTurn),
				occurredTurn: status === 'committed' ? asInteger(value.occurredTurn, asInteger(value.createdTurn, currentTurn)) : null,
				scheduledTurn: null,
				worldTime: asNullableString(value.worldTime),
				memoryImpact: asRecord(value.memoryImpact),
				sourceEntryIds: input.proposal.sourceEntryIds ?? [],
				sourcePatchIds: unique([...(input.proposal.sourcePatchIds ?? []), input.proposal.id]),
				metadata: {
					...proposedMetadata,
					sourceType: 'patch_proposal_application',
					auditSourceType: asString(proposedMetadata.sourceType) || null,
					proposalId: input.proposal.id,
					projectId: input.proposal.targetRecordId,
				},
				serverVersion: input.serverVersion,
				createdAt: input.now,
				updatedAt: input.now,
			}).onConflictDoNothing();
			appliedOperations.push({
				op,
				path,
				table: 'story_events',
				recordId: eventId,
				status,
			});
		}
	}

	return {
		appliedCount: appliedOperations.length,
		appliedOperations,
		affectedEntityIds: [],
	};
}

function characterContextUpdateState(proposal: typeof patchProposals.$inferSelect): JsonRecord | null {
	if (proposal.proposalType !== 'character_context_update') return null;
	if (proposal.targetTable !== 'entities') return null;
	const operations = Array.isArray(proposal.operations) ? proposal.operations : [];
	for (const rawOperation of operations) {
		const operation = asRecord(rawOperation);
		const op = asString(operation.op);
		const path = asString(operation.path);
		const match = path.match(/^\/(?:characters|entities)\/([^/]+)\/state$/);
		if (op !== 'replace' || !match || match[1] !== proposal.targetRecordId) continue;
		const state = asRecord(operation.value);
		if (Object.keys(state).length > 0) return state;
	}
	return null;
}

async function applyCharacterContextUpdateProposal(tx: Tx, input: {
	storyId: string;
	proposal: typeof patchProposals.$inferSelect;
	serverVersion: number;
	now: string;
	automatic?: boolean;
	notes?: string | null;
}): Promise<ProposalApplication> {
	let proposedState = characterContextUpdateState(input.proposal);
	if (!proposedState) return emptyProposalApplication();
	if (input.proposal.proposedBy === 'chapter_scribe') {
		// Older pending chapter proposals contain full snapshots. Never replay their transient state or stats.
		const continuityKeys = new Set(['bio', 'appearance', 'presentation', 'speechStyle', 'personality', 'rank', 'currentDisposition', 'relationship', 'motivations', 'factionTags', 'knownFacts', 'eventMemory', 'developments']);
		proposedState = Object.fromEntries(Object.entries(proposedState).filter(([key]) => continuityKeys.has(key)));
		if (!Object.keys(proposedState).length) return emptyProposalApplication();
	}

	const [entity] = await tx.select().from(entities).where(and(
		eq(entities.storyId, input.storyId),
		eq(entities.id, input.proposal.targetRecordId),
		eq(entities.type, 'character'),
	)).for('update');
	if (!entity) return emptyProposalApplication();
	const metadata = asRecord(input.proposal.metadata);
	if (!input.automatic && typeof metadata.characterUpdateBaseVersion === 'number' && entity.serverVersion !== metadata.characterUpdateBaseVersion) {
		throw new Error('The character changed after this draft. Rebuild it before approving identity changes.');
	}
	if (!input.automatic && !/^retcon:\s*\S/i.test(input.notes?.trim() ?? '')) {
		// Evidence for a new detail does not authorize deleting the established life story. The
		// author's bio, personality, appearance and voice stay as written; what the proposal adds
		// becomes a story development. Only notes beginning with "retcon:" replace authored text.
		proposedState = foldAuthoredTextIntoDevelopments(asRecord(entity.state), proposedState, entity.description);
	} else if (!input.automatic && Array.isArray(proposedState.developments)) {
		proposedState = { ...proposedState, developments: appendCharacterDevelopments(asRecord(entity.state), readCharacterDevelopments(proposedState), entity.description) };
	}
	let identityConflicts: unknown[] = [];
	let identitySourceHashes: unknown[] = [];
	if (input.automatic) {
		const sourceRows = input.proposal.sourceEntryIds.length ? await tx.select().from(storyEntries)
			.where(and(eq(storyEntries.storyId, input.storyId), inArray(storyEntries.id, input.proposal.sourceEntryIds))).for('share') : [];
		if (!sourceRows.length || sourceRows.length !== new Set(input.proposal.sourceEntryIds).size || sourceRows.some(row => ['user_action', 'system', 'ooc', 'chapter_summary'].includes(row.type) || asRecord(row.metadata).nonCanon || asRecord(row.metadata).non_canon || asRecord(row.metadata).superseded)) {
			return { ...emptyProposalApplication(), metadata: { forceStatus: 'needs_review', characterUpdateBaseVersion: entity.serverVersion, identityConflicts: Object.entries(proposedState).map(([field, proposed]) => ({ field, previous: asRecord(entity.state)[field] ?? null, proposed, reason: 'Original canonical story evidence is missing or excluded.', sources: [] })) } };
		}
		const bounded = boundCharacterIdentity({ storyId: input.storyId, entityId: entity.id,
			names: [entity.name, ...asStringArray(asRecord(entity.state).aliases)], current: asRecord(entity.state), patch: proposedState,
			sources: sourceRows.map(row => ({ id: row.id, storyId: row.storyId, content: row.content,
				narrative: !['user_action', 'system', 'ooc'].includes(row.type) && !asRecord(row.metadata).nonCanon && !asRecord(row.metadata).non_canon && !asRecord(row.metadata).superseded })) });
		proposedState = bounded.patch;
		identityConflicts = bounded.conflicts;
		identitySourceHashes = sourceRows.map(row => ({ id: row.id, type: row.type, sha256: createHash('sha256').update(row.content).digest('hex') }));
	}
	if (!Object.keys(proposedState).length) return { ...emptyProposalApplication(), metadata: identityConflicts.length ? { forceStatus: 'needs_review', identityConflicts, identitySourceHashes, characterUpdateBaseVersion: entity.serverVersion } : {} };

	const statePatch = { ...proposedState };
	delete statePatch.description;
	const state = mergeCharacterReferenceState(asRecord(entity.state), statePatch);
	// A folded development list is already the complete list (earlier developments plus new ones).
	if (Array.isArray(statePatch.developments)) state.developments = statePatch.developments;
	if (typeof proposedState.bio === 'string' && proposedState.bio.trim()) state.background = proposedState.bio.trim();
	if (input.automatic && isDeepStrictEqual(state, asRecord(entity.state))) return { ...emptyProposalApplication(), metadata: identityConflicts.length ? { forceStatus: 'needs_review', identityConflicts, identitySourceHashes, characterUpdateBaseVersion: entity.serverVersion } : {} };
	const sourceEntryIds = unique([...(entity.sourceEntryIds ?? []), ...(input.proposal.sourceEntryIds ?? [])]);
	const sourceEventIds = unique([...(entity.sourceEventIds ?? []), ...(input.proposal.sourceEventIds ?? [])]);
	const sourcePatchIds = unique([...(entity.sourcePatchIds ?? []), ...(input.proposal.sourcePatchIds ?? []), input.proposal.id]);
	await tx.update(entities).set({
		state,
		...(typeof proposedState.bio === 'string' && proposedState.bio.trim() ? { description: proposedState.bio.trim() } : {}),
		...(typeof proposedState.description === 'string' && proposedState.description.trim() ? { description: proposedState.description.trim() } : {}),
		metadata: {
			...asRecord(entity.metadata),
			updatedFromProposal: input.proposal.id,
			updatedFromProposalType: input.proposal.proposalType,
		},
		sourceEntryIds,
		sourceEventIds,
		sourcePatchIds,
		serverVersion: input.serverVersion,
		updatedAt: input.now,
	}).where(and(
		eq(entities.storyId, input.storyId),
		eq(entities.id, entity.id),
	));

	await tx.insert(sourceRefs).values({
		id: `source_ref_${stableIdSegment(`${input.proposal.id}_${entity.id}`)}`,
		storyId: input.storyId,
		sourceType: 'patch_proposal',
		sourceId: input.proposal.id,
		targetTable: 'entities',
		targetRecordId: entity.id,
		targetRecordField: 'state',
		sourceField: 'character_context_update',
		confidence: input.proposal.confidence,
		rationale: input.proposal.reason,
		notes: 'Approved context draft into canonical character state.',
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	}).onConflictDoNothing();

	return {
		appliedCount: 1,
		appliedOperations: [{
			op: 'update',
			path: `/characters/${entity.id}/state`,
			table: 'entities',
			recordId: entity.id,
			field: 'state',
		}],
		affectedEntityIds: [entity.id],
		metadata: { appliedEntityId: entity.id, ...(identityConflicts.length ? { forceStatus: 'needs_review', identityConflicts, identitySourceHashes, characterUpdateBaseVersion: input.serverVersion } : {}) },
	};
}

function characterReferencePayload(proposal: typeof patchProposals.$inferSelect): {
	name: string;
	description: string | null;
	status: string;
	visibility: string;
	state: JsonRecord;
	aliases: string[];
} | null {
	if (proposal.proposalType !== 'character_reference_review') return null;
	const metadata = asRecord(proposal.metadata);
	const operations = (Array.isArray(proposal.operations) ? proposal.operations : []).map(asRecord);
	const isGmDraft = proposal.proposedBy === 'gm_character_draft' || ['evidence_only', 'manual_review'].includes(asString(asRecord(metadata.sourceDraft).mode));
	const operation = operations.find((value) => {
		const operationValue = asRecord(value.value);
		if (typeof operationValue.name !== 'string' || !operationValue.name.trim()) return false;
		return !isGmDraft || (asString(value.op) === 'review' && asString(value.path) === '/entities/character');
	});
	const operationValue = operation ? asRecord(operation.value) : null;
	if (isGmDraft) {
		if (!operationValue || proposal.targetTable !== 'entities') return null;
		if (asString(operationValue.storyId) !== proposal.storyId || asString(operationValue.type) !== 'character') return null;
		if (!operationValue.state || typeof operationValue.state !== 'object' || Array.isArray(operationValue.state)) return null;
	}
	const name = isGmDraft
		? asString(operationValue?.name)
		: asString(metadata.sourceName, asString(operationValue?.name));
	if (!name) return null;
	return {
		name,
		description: asNullableString(operationValue?.description),
		status: asString(operationValue?.status, 'active'),
		visibility: asString(operationValue?.visibility, 'player_known'),
		state: asRecord(operationValue?.state),
		aliases: asStringArray(operationValue?.aliases),
	};
}

function hasPopulatedCharacterCandidate(proposal: typeof patchProposals.$inferSelect): boolean {
	if (proposal.proposedBy === 'gm_character_draft' || proposal.targetTable !== 'entities' || !(proposal.sourceEntryIds?.length || proposal.sourceEventIds?.length)) return false;
	const operation = (proposal.operations ?? []).map(asRecord).find((item) => item.op === 'review' && item.path === '/entities/character');
	const payload = characterReferencePayload(proposal);
	const description = payload?.description?.trim() ?? '';
	return Boolean(operation && payload && description.length >= 24 && !/\bis important in this chapter checkpoint\.?$/i.test(description));
}

async function applyCharacterReferenceProposal(tx: Tx, input: {
	storyId: string;
	proposal: typeof patchProposals.$inferSelect;
	serverVersion: number;
	now: string;
}): Promise<ProposalApplication> {
	const payload = characterReferencePayload(input.proposal);
	if (!payload) {
		if (input.proposal.proposedBy === 'gm_character_draft' || asRecord(asRecord(input.proposal.metadata).sourceDraft).mode === 'evidence_only') {
			return {
				appliedCount: 0,
				appliedOperations: [],
				affectedEntityIds: [],
				metadata: {
					forceStatus: 'rejected',
					rejectionReason: 'Malformed GM character draft payload cannot become canon.',
				},
			};
		}
		return emptyProposalApplication();
	}
	if (isCharacterTitleOnlyName(payload.name)) {
		return {
			appliedCount: 0,
			appliedOperations: [],
			affectedEntityIds: [],
			metadata: {
				forceStatus: 'rejected',
				rejectionReason: `Title-only character reference "${payload.name}" cannot become canon.`,
			},
		};
	}

	const candidateIdentity = input.proposal.proposedBy === 'gm_character_draft'
		? `${input.storyId}_${input.proposal.id}`
		: `${input.storyId}_${payload.name}`;
	const candidateEntityId = `entity_${stableIdSegment(candidateIdentity)}`;
	const existingRows = await tx.select().from(entities)
		.where(and(eq(entities.storyId, input.storyId), eq(entities.type, 'character')));
	const existingAliasMap = await loadEntityAliases(tx, input.storyId, existingRows.map((row) => row.id));
	const normalizedPayloadName = normalizeIdentityName(payload.name);
	const exactMatches = normalizedPayloadName ? existingRows.filter((row) => {
		if (normalizeIdentityName(row.name) === normalizedPayloadName) return true;
		return (existingAliasMap.get(row.id) ?? []).some((alias) => normalizeIdentityName(alias) === normalizedPayloadName);
	}) : [];
	if (exactMatches.length > 1) return { ...emptyProposalApplication(), metadata: { forceStatus: 'rejected', rejectionReason: `Multiple canonical characters match "${payload.name}". Resolve the identity before applying this candidate.` } };
	const exactExisting = exactMatches[0];
	const sourceDraft = asRecord(asRecord(input.proposal.metadata).sourceDraft);
	const sourceOnly = sourceDraft.mode === 'evidence_only' || sourceDraft.mode === 'manual_review';
	if (sourceOnly && sourceDraft.targetEntityId) {
		if (exactExisting?.id !== sourceDraft.targetEntityId || exactExisting.serverVersion !== sourceDraft.targetServerVersion) throw new Error('The exact character target changed. Rebuild this source draft before approving it.');
	} else if (sourceOnly && exactExisting) {
		throw new Error('A matching character now exists. Rebuild this source draft to review an update to that exact character.');
	}
	const containedMatches = exactExisting || sourceOnly ? [] : existingRows.filter((row) => {
		if (containedNameMatch(row.name, payload.name)) return true;
		return (existingAliasMap.get(row.id) ?? []).some((alias) => containedNameMatch(alias, payload.name));
	});
	const existing = exactExisting ?? (containedMatches.length === 1 ? containedMatches[0] : null);
	const entityId = existing?.id ?? candidateEntityId;
	const sourceEntryIds = unique([...(existing?.sourceEntryIds ?? []), ...(input.proposal.sourceEntryIds ?? [])]);
	const sourceEventIds = unique([...(existing?.sourceEventIds ?? []), ...(input.proposal.sourceEventIds ?? [])]);
	const sourcePatchIds = unique([...(existing?.sourcePatchIds ?? []), ...(input.proposal.sourcePatchIds ?? []), input.proposal.id]);
	const chapterState = hasPopulatedCharacterCandidate(input.proposal) && !asString(payload.state.bio).trim()
		? { ...payload.state, bio: payload.description ?? '' }
		: payload.state;
	const state = existing ? mergeCharacterReferenceState(asRecord(existing.state), chapterState) : chapterState;
	const metadata = {
		...asRecord(existing?.metadata),
		createdFrom: existing ? asRecord(existing?.metadata).createdFrom : 'character_reference_review',
		approvedFromProposal: input.proposal.id,
		approvedAt: input.now,
	};

	if (existing) {
		await tx.update(entities).set({
			description: sourceOnly ? payload.description ?? existing.description : existing.description ?? payload.description,
			status: existing.status === 'inactive' ? 'active' : existing.status,
			visibility: existing.visibility,
			state,
			metadata,
			sourceEntryIds,
			sourceEventIds,
			sourcePatchIds,
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		}).where(and(eq(entities.storyId, input.storyId), eq(entities.id, existing.id)));
	} else {
		await tx.insert(entities).values({
			id: entityId,
			storyId: input.storyId,
			type: 'character',
			name: payload.name,
			description: payload.description,
			status: payload.status,
			visibility: payload.visibility,
			state,
			metadata,
			sourceEntryIds,
			sourceEventIds,
			sourcePatchIds,
			serverVersion: input.serverVersion,
			createdAt: input.now,
			updatedAt: input.now,
		}).onConflictDoNothing();
	}

	if (payload.aliases.length > 0) {
		await saveCanonicalAliases(tx, {
			storyId: input.storyId,
			entityId,
			aliases: [...(existingAliasMap.get(entityId) ?? []), payload.name, ...payload.aliases],
			sourceEntryIds,
			serverVersion: input.serverVersion,
			now: input.now,
		});
	}

	await tx.insert(sourceRefs).values({
		id: `source_ref_${stableIdSegment(`${input.proposal.id}_${entityId}`)}`,
		storyId: input.storyId,
		sourceType: 'patch_proposal',
		sourceId: input.proposal.id,
		targetTable: 'entities',
		targetRecordId: entityId,
		targetRecordField: 'state',
		sourceField: 'character_reference_review',
		confidence: input.proposal.confidence,
		rationale: input.proposal.reason,
		notes: 'Approved unresolved character reference into canonical character evidence.',
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	}).onConflictDoNothing();

	const operation = {
		op: existing ? 'update' : 'create',
		path: '/entities/character',
		table: 'entities',
		recordId: entityId,
		name: payload.name,
	};
	return {
		appliedCount: 1,
		appliedOperations: [operation],
		affectedEntityIds: [entityId],
		metadata: {
			appliedEntityId: entityId,
			appliedEntityName: payload.name,
		},
	};
}

async function bumpStoryVersionTx(tx: Tx, storyId: string): Promise<number> {
	const [row] = await tx.update(stories).set({
		serverVersion: sql`${stories.serverVersion} + 1`,
		updatedAt: nowIso(),
	}).where(eq(stories.id, storyId)).returning({ serverVersion: stories.serverVersion });
	if (!row) throw new Error(`Story not found: ${storyId}`);
	return row.serverVersion;
}

async function loadEntityAliases(tx: Tx, storyId: string, entityIds: string[]): Promise<Map<string, string[]>> {
	if (entityIds.length === 0) return new Map();
	const rows = await tx.select().from(entityAliases).where(
		and(eq(entityAliases.storyId, storyId), inArray(entityAliases.entityId, entityIds)),
	);
	const byEntity = new Map<string, string[]>();
	for (const row of rows) {
		const list = byEntity.get(row.entityId) ?? [];
		list.push(row.alias);
		byEntity.set(row.entityId, list);
	}
	return byEntity;
}

async function saveCanonicalAliases(tx: Tx, input: {
	storyId: string;
	entityId: string;
	aliases: string[];
	sourceEntryIds: string[];
	serverVersion: number;
	now: string;
}): Promise<void> {
	await tx.delete(entityAliases).where(and(
		eq(entityAliases.storyId, input.storyId),
		eq(entityAliases.entityId, input.entityId),
	));
	for (const alias of unique(input.aliases)) {
		const normalizedAlias = normalizeAlias(alias);
		if (!normalizedAlias) continue;
		await tx.insert(entityAliases).values({
			id: `alias_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`,
			storyId: input.storyId,
			entityId: input.entityId,
			alias,
			normalizedAlias,
			sourceEntryIds: input.sourceEntryIds,
			serverVersion: input.serverVersion,
			createdAt: input.now,
			updatedAt: input.now,
		}).onConflictDoNothing();
	}
}

async function queueCanonRepairRefresh(storyId: string, serverVersion: number, affectedEntityIds: string[] = []): Promise<void> {
	const entityIds = unique(affectedEntityIds).filter(Boolean);
	await Promise.all([
		// The vault's embedding index follows the wiki auto-index setting; a canon repair (each
		// reviewed proposal) must not force a full re-embedding of the whole vault.
		enqueueStoryVaultSyncJob({
			storyId,
			serverVersion,
			reason: 'canon-repair',
			payload: { source: 'canon_repair' },
		}),
		...(entityIds.length
			? entityIds.map((entityId) => enqueueBackendJob({
				storyId,
				type: 'index_canonical_records',
				dedupeKey: `canon-repair-index-${storyId}-${serverVersion}-${entityId}`,
				payload: { recordTypes: ['entities'], recordId: entityId, reason: 'canon_repair', serverVersion },
				maxAttempts: 3,
			}))
			: [enqueueBackendJob({
				storyId,
				type: 'index_canonical_records',
				dedupeKey: `canon-repair-index-${storyId}-${serverVersion}`,
				payload: { reason: 'canon_repair', serverVersion },
				maxAttempts: 3,
			})]),
	]);
}

export async function previewEntityResolution(input: {
	storyId: string;
	candidate: EntityIdentityCandidate;
	includeSemantic?: boolean;
	maxCandidates?: number;
}): Promise<JsonRecord> {
	const resolution = await resolveEntityIdentity({
		storyId: input.storyId,
		candidate: input.candidate,
		includeSemantic: input.includeSemantic,
		maxCandidates: input.maxCandidates,
	});
	return {
		storyId: input.storyId,
		candidate: input.candidate,
		resolution: entityResolutionSummary(resolution),
		candidates: resolution.candidates,
	};
}

export async function addEntityAlias(input: {
	storyId: string;
	entityId: string;
	alias: string;
	sourceEntryIds?: string[];
	sourceEventIds?: string[];
	sourcePatchIds?: string[];
}): Promise<JsonRecord> {
	const alias = input.alias.trim();
	if (!alias) throw new Error('Alias is required.');
	const normalizedAlias = normalizeAlias(alias);
	if (!normalizedAlias) throw new Error('Alias is required.');
	const db = getDb();
	const now = nowIso();
	const result = await db.transaction(async (tx) => {
		const [entity] = await tx.select().from(entities).where(and(eq(entities.storyId, input.storyId), eq(entities.id, input.entityId))).limit(1);
		if (!entity) throw new Error(`Entity not found: ${input.entityId}`);
		const serverVersion = await bumpStoryVersionTx(tx, input.storyId);
		await tx.insert(entityAliases).values({
			id: `alias_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`,
			storyId: input.storyId,
			entityId: input.entityId,
			alias,
			normalizedAlias,
			sourceEntryIds: unique(input.sourceEntryIds ?? []),
			serverVersion,
			createdAt: now,
			updatedAt: now,
		}).onConflictDoNothing();
		await tx.update(entities).set({
			serverVersion,
			updatedAt: now,
		}).where(and(eq(entities.storyId, input.storyId), eq(entities.id, input.entityId)));
		const aliases = await loadEntityAliases(tx, input.storyId, [input.entityId]);
		return {
			serverVersion,
			entityId: input.entityId,
			alias,
			normalizedAlias,
			aliases: unique([
				entity.name,
				...(aliases.get(input.entityId) ?? []),
			]),
		};
	});
	await queueCanonRepairRefresh(input.storyId, result.serverVersion, [result.entityId]);
	return {
		storyId: input.storyId,
		...result,
	};
}

/** Rewrite typed location pointers only; names, prose and source history remain intact. */
export function remapLocationState(state: JsonRecord, from: string, to: string): JsonRecord {
	const next = { ...state };
	for (const key of ['currentLocationId', 'locationId']) if (next[key] === from) next[key] = to;
	if (Array.isArray(next.connections)) next.connections = next.connections.map(value => {
		const connection = asRecord(value);
		return connection.targetLocationId === from ? { ...connection, targetLocationId: to } : value;
	});
	return next;
}

export async function mergeEntities(input: {
	storyId: string;
	keepEntityId: string;
	mergeEntityId: string;
	expectedVersion?: number;
	reason?: string | null;
}): Promise<JsonRecord> {
	if (input.keepEntityId === input.mergeEntityId) throw new Error('Cannot merge an entity into itself.');
	const db = getDb();
	const now = nowIso();
	const result = await db.transaction(async (tx) => {
		const [story] = await tx.select().from(stories).where(eq(stories.id, input.storyId)).for('update').limit(1);
		if (!story) throw new Error('Story not found.');
		if (input.expectedVersion !== undefined && story.serverVersion !== input.expectedVersion) throw new Error('The story changed before this merge. Reload and review the records.');
		const [keep] = await tx.select().from(entities).where(and(eq(entities.storyId, input.storyId), eq(entities.id, input.keepEntityId))).limit(1);
		const [source] = await tx.select().from(entities).where(and(eq(entities.storyId, input.storyId), eq(entities.id, input.mergeEntityId))).limit(1);
		if (!keep) throw new Error(`Keep entity not found: ${input.keepEntityId}`);
		if (!source) throw new Error(`Merge entity not found: ${input.mergeEntityId}`);
		if (keep.type !== source.type) throw new Error('Only entities of the same type can be merged.');
		if (asRecord(source.metadata).mergedInto === keep.id) return { serverVersion: story.serverVersion, keepEntityId: keep.id, mergeEntityId: source.id, alreadyMerged: true };
		if (keep.status !== 'active' || source.status !== 'active') throw new Error('Merge targets must be active canonical entities.');
		if (keep.type === 'location') {
			const places = await tx.select().from(entities).where(and(eq(entities.storyId, input.storyId), eq(entities.type, 'location')));
			const edges = (await tx.select().from(relationships).where(and(eq(relationships.storyId, input.storyId), eq(relationships.type, 'part-of'))))
				.filter(edge => isEffectiveContainment(edge, story.currentTurn))
				.map(edge => ({ ...edge, sourceEntityId: edge.sourceEntityId === source.id ? keep.id : edge.sourceEntityId, targetEntityId: edge.targetEntityId === source.id ? keep.id : edge.targetEntityId }));
			for (const edge of edges.filter(edge => edge.sourceEntityId === keep.id || edge.targetEntityId === keep.id)) {
				if (edges.filter(parent => parent.sourceEntityId === edge.sourceEntityId).length > 1) throw new Error('Reconcile the location parents before merging these records.');
				validateLocationParent({ storyId: input.storyId, childId: edge.sourceEntityId, parentId: edge.targetEntityId, turn: story.currentTurn, places: places.filter(place => place.id !== source.id), relationships: edges });
			}
		}

		const serverVersion = await bumpStoryVersionTx(tx, input.storyId);
		const aliasMap = await loadEntityAliases(tx, input.storyId, [keep.id, source.id]);
		const mergedAliases = unique([
			keep.name,
			source.name,
			...(aliasMap.get(keep.id) ?? []),
			...(aliasMap.get(source.id) ?? []),
		]);
		const mergedState = mergeRecords(asRecord(source.state), asRecord(keep.state));
		const sourceMetadata = asRecord(source.metadata);
		const keepMetadata = asRecord(keep.metadata);
		const mergedMetadata = {
			...stripMergedIntoMetadata(mergeRecords(sourceMetadata, keepMetadata)),
			mergedFrom: mergeMergedFromHistory(sourceMetadata, keepMetadata, {
				entityId: source.id,
				name: source.name,
				status: source.status,
			}),
			mergedAt: now,
			mergeReason: input.reason ?? null,
		};
		const mergedSourceEntryIds = unique([...(keep.sourceEntryIds ?? []), ...(source.sourceEntryIds ?? [])]);
		const mergedSourceEventIds = unique([...(keep.sourceEventIds ?? []), ...(source.sourceEventIds ?? [])]);
		const mergedSourcePatchIds = unique([...(keep.sourcePatchIds ?? []), ...(source.sourcePatchIds ?? [])]);

		await tx.update(entities).set({
			description: keep.description ?? source.description,
			status: keep.status ?? 'active',
			visibility: keep.visibility,
			state: mergedState,
			metadata: mergedMetadata,
			sourceEntryIds: mergedSourceEntryIds,
			sourceEventIds: mergedSourceEventIds,
			sourcePatchIds: mergedSourcePatchIds,
			serverVersion,
			updatedAt: now,
		}).where(and(eq(entities.storyId, input.storyId), eq(entities.id, keep.id)));
		await tx.update(entities).set({
			status: 'inactive',
			metadata: mergeRecords(asRecord(source.metadata), {
				...asRecord(source.metadata),
				mergedInto: keep.id,
				mergedAt: now,
				mergeReason: input.reason ?? null,
			}),
			serverVersion,
			updatedAt: now,
		}).where(and(eq(entities.storyId, input.storyId), eq(entities.id, source.id)));

		await saveCanonicalAliases(tx, {
			storyId: input.storyId,
			entityId: keep.id,
			aliases: mergedAliases,
			sourceEntryIds: mergedSourceEntryIds,
			serverVersion,
			now,
		});
		if (keep.type === 'location') {
			if (story.currentLocationId === source.id) await tx.update(stories).set({ currentLocationId: keep.id }).where(eq(stories.id, input.storyId));
			const locatedEntities = await tx.select().from(entities).where(eq(entities.storyId, input.storyId));
			for (const row of locatedEntities) {
				if (row.id === source.id) continue; // Retain the retired record as historical evidence.
				const state = row.id === keep.id ? mergedState : asRecord(row.state);
				const remapped = remapLocationState(state, source.id, keep.id);
				if (!isDeepStrictEqual(state, remapped)) await tx.update(entities).set({ state: remapped, serverVersion, updatedAt: now }).where(eq(entities.id, row.id));
			}
			await tx.update(factionResources).set({ locationId: keep.id, serverVersion, updatedAt: now }).where(and(eq(factionResources.storyId, input.storyId), eq(factionResources.locationId, source.id)));
		}

		const directEntityUpdates = [
			{
				table: relationships,
				rows: await tx.select().from(relationships).where(eq(relationships.storyId, input.storyId)),
				apply: async (row: typeof relationships.$inferSelect) => {
					const nextSource = row.sourceEntityId === source.id ? keep.id : row.sourceEntityId;
					const nextTarget = row.targetEntityId === source.id ? keep.id : row.targetEntityId;
					if (nextSource === nextTarget) {
						await tx.delete(relationships).where(eq(relationships.id, row.id));
						return;
					}
					if (nextSource === row.sourceEntityId && nextTarget === row.targetEntityId) return;
					await tx.update(relationships).set({
						sourceEntityId: nextSource,
						targetEntityId: nextTarget,
						serverVersion,
						updatedAt: now,
					}).where(eq(relationships.id, row.id));
				},
			},
			{
				table: factions,
				rows: await tx.select().from(factions).where(eq(factions.storyId, input.storyId)),
				apply: async (row: typeof factions.$inferSelect) => {
					const nextMembers = replaceInArray(row.memberEntityIds, source.id, keep.id);
					const nextTerritories = replaceInArray(row.territoryIds, source.id, keep.id);
					if (row.entityId !== source.id && !arrayChanged(row.memberEntityIds, nextMembers) && !arrayChanged(row.territoryIds, nextTerritories)) return;
					await tx.update(factions).set({
						entityId: row.entityId === source.id ? keep.id : row.entityId,
						memberEntityIds: nextMembers,
						territoryIds: nextTerritories,
						serverVersion,
						updatedAt: now,
					}).where(eq(factions.id, row.id));
				},
			},
			{
				table: factionMemberships,
				rows: await tx.select().from(factionMemberships).where(eq(factionMemberships.storyId, input.storyId)),
				apply: async (row: typeof factionMemberships.$inferSelect) => {
					if (row.entityId !== source.id) return;
					await tx.update(factionMemberships).set({
						entityId: keep.id,
						serverVersion,
						updatedAt: now,
					}).where(eq(factionMemberships.id, row.id));
				},
			},
			{
				table: npcBeliefs,
				rows: await tx.select().from(npcBeliefs).where(eq(npcBeliefs.storyId, input.storyId)),
				apply: async (row: typeof npcBeliefs.$inferSelect) => {
					const subject = row.subjectEntityId === source.id ? keep.id : row.subjectEntityId;
					const believer = row.believerEntityId === source.id ? keep.id : row.believerEntityId;
					if (subject === row.subjectEntityId && believer === row.believerEntityId) return;
					await tx.update(npcBeliefs).set({
						subjectEntityId: subject,
						believerEntityId: believer,
						serverVersion,
						updatedAt: now,
					}).where(eq(npcBeliefs.id, row.id));
				},
			},
			{
				table: storyThreads,
				rows: await tx.select().from(storyThreads).where(eq(storyThreads.storyId, input.storyId)),
				apply: async (row: typeof storyThreads.$inferSelect) => {
					const nextRelated = replaceInArray(row.relatedEntityIds, source.id, keep.id);
					if (!arrayChanged(row.relatedEntityIds, nextRelated)) return;
					await tx.update(storyThreads).set({
						relatedEntityIds: nextRelated,
						serverVersion,
						updatedAt: now,
					}).where(eq(storyThreads.id, row.id));
				},
			},
			{
				table: storyEvents,
				rows: await tx.select().from(storyEvents).where(eq(storyEvents.storyId, input.storyId)),
				apply: async (row: typeof storyEvents.$inferSelect) => {
					const nextActors = replaceInArray(row.actorEntityIds, source.id, keep.id);
					const nextTargets = replaceInArray(row.targetEntityIds, source.id, keep.id);
					const nextLocations = replaceInArray(row.locationIds, source.id, keep.id);
					const nextLocation = row.locationId === source.id ? keep.id : row.locationId;
					if (!arrayChanged(row.actorEntityIds, nextActors) && !arrayChanged(row.targetEntityIds, nextTargets) && !arrayChanged(row.locationIds, nextLocations) && nextLocation === row.locationId) return;
					await tx.update(storyEvents).set({
						actorEntityIds: nextActors,
						targetEntityIds: nextTargets,
						locationId: nextLocation,
						locationIds: nextLocations,
						serverVersion,
						updatedAt: now,
					}).where(eq(storyEvents.id, row.id));
				},
			},
			{
				table: npcEventLinks,
				rows: await tx.select().from(npcEventLinks).where(eq(npcEventLinks.storyId, input.storyId)),
				apply: async (row: typeof npcEventLinks.$inferSelect) => {
					if (row.npcEntityId !== source.id) return;
					await tx.update(npcEventLinks).set({
						npcEntityId: keep.id,
						serverVersion,
						updatedAt: now,
					}).where(eq(npcEventLinks.id, row.id));
				},
			},
			{
				table: continuityWarnings,
				rows: await tx.select().from(continuityWarnings).where(eq(continuityWarnings.storyId, input.storyId)),
				apply: async (row: typeof continuityWarnings.$inferSelect) => {
					const nextEntities = replaceInArray(row.entityIds, source.id, keep.id);
					const nextActors = replaceInArray(row.actorIds, source.id, keep.id);
					if (!arrayChanged(row.entityIds, nextEntities) && !arrayChanged(row.actorIds, nextActors)) return;
					await tx.update(continuityWarnings).set({
						entityIds: nextEntities,
						actorIds: nextActors,
						serverVersion,
						updatedAt: now,
					}).where(eq(continuityWarnings.id, row.id));
				},
			},
			{
				table: memoryNodes,
				rows: await tx.select().from(memoryNodes).where(eq(memoryNodes.storyId, input.storyId)),
				apply: async (row: typeof memoryNodes.$inferSelect) => {
					const nextEntities = replaceInArray(row.entityIds, source.id, keep.id);
					const nextLocation = row.locationId === source.id ? keep.id : row.locationId;
					if (!arrayChanged(row.entityIds, nextEntities) && nextLocation === row.locationId) return;
					await tx.update(memoryNodes).set({
						entityIds: nextEntities,
						locationId: nextLocation,
						serverVersion,
						updatedAt: now,
					}).where(eq(memoryNodes.id, row.id));
				},
			},
			{
				table: facts,
				rows: await tx.select().from(facts).where(eq(facts.storyId, input.storyId)),
				apply: async (row: typeof facts.$inferSelect) => {
					const nextSubject = row.subjectEntityId === source.id ? keep.id : row.subjectEntityId;
					const nextTarget = row.targetEntityId === source.id ? keep.id : row.targetEntityId;
					if (nextSubject === row.subjectEntityId && nextTarget === row.targetEntityId) return;
					await tx.update(facts).set({
						subjectEntityId: nextSubject,
						targetEntityId: nextTarget,
						serverVersion,
						updatedAt: now,
					}).where(eq(facts.id, row.id));
				},
			},
			{
				table: patchProposals,
				rows: await tx.select().from(patchProposals).where(eq(patchProposals.storyId, input.storyId)),
				apply: async (row: typeof patchProposals.$inferSelect) => {
					const nextAffected = replaceInArray(row.affectedEntityIds, source.id, keep.id);
					const nextTargetRecordId = row.targetTable === 'entities' && row.targetRecordId === source.id ? keep.id : row.targetRecordId;
					if (!arrayChanged(row.affectedEntityIds, nextAffected) && nextTargetRecordId === row.targetRecordId) return;
					await tx.update(patchProposals).set({
						affectedEntityIds: nextAffected,
						targetRecordId: nextTargetRecordId,
						serverVersion,
						updatedAt: now,
					}).where(eq(patchProposals.id, row.id));
				},
			},
			{
				table: sourceRefs,
				rows: await tx.select().from(sourceRefs).where(eq(sourceRefs.storyId, input.storyId)),
				apply: async (row: typeof sourceRefs.$inferSelect) => {
					if (row.targetTable !== 'entities' || row.targetRecordId !== source.id) return;
					await tx.update(sourceRefs).set({
						targetRecordId: keep.id,
						serverVersion,
						updatedAt: now,
					}).where(eq(sourceRefs.id, row.id));
				},
			},
		] as const;

		for (const batch of directEntityUpdates) {
			for (const row of batch.rows) {
				await batch.apply(row as never);
			}
		}

		return {
			serverVersion,
			keepEntityId: keep.id,
			mergeEntityId: source.id,
			mergedAliases,
			keepEntity: {
				...keep,
				state: mergedState,
				metadata: mergedMetadata,
				sourceEntryIds: mergedSourceEntryIds,
				sourceEventIds: mergedSourceEventIds,
				sourcePatchIds: mergedSourcePatchIds,
				serverVersion,
				updatedAt: now,
			},
			sourceEntity: {
				...source,
				status: 'inactive',
				metadata: mergeRecords(asRecord(source.metadata), {
					mergedInto: keep.id,
					mergedAt: now,
					mergeReason: input.reason ?? null,
				}),
				serverVersion,
				updatedAt: now,
			},
		};
	});
	await queueCanonRepairRefresh(input.storyId, result.serverVersion);
	return {
		storyId: input.storyId,
		...result,
	};
}

async function lockCharacterDraftSources(tx: Tx, proposal: typeof patchProposals.$inferSelect): Promise<void> {
	const sourceDraft = asRecord(asRecord(proposal.metadata).sourceDraft);
	if (proposal.proposedBy !== 'gm_character_draft' && sourceDraft.mode !== 'evidence_only' && sourceDraft.mode !== 'manual_review' && !hasPopulatedCharacterCandidate(proposal)) throw new Error('Add a biography or build this character from story sources before approving it. The candidate is only a placeholder.');
	if (proposal.proposedBy !== 'gm_character_draft' && sourceDraft.mode === 'manual_review') {
		const payload = characterReferencePayload(proposal);
		if (!payload || (!sourceDraft.targetEntityId && (!asString(payload.state.bio).trim() || asString(payload.state.bio).trim().toLowerCase() === payload.name.trim().toLowerCase()))) throw new Error('A manually reviewed candidate needs a substantive biography before it can become canon.');
	}
	if (sourceDraft.mode !== 'evidence_only') return;
	const payload = characterReferencePayload(proposal);
	const quotedFields = Array.isArray(sourceDraft.evidence) ? sourceDraft.evidence.map(asRecord) : [];
	if (proposal.proposedBy !== 'gm_character_draft' && !sourceDraft.targetEntityId && (!payload || !asString(payload.state.bio).trim() || asString(payload.state.bio).trim().toLowerCase() === payload.name.trim().toLowerCase())) {
		throw new Error('This source draft needs a substantive biography before creating a character. Edit and save one, or rebuild from story sources.');
	}
	if (!payload || !quotedFields.some((fact) => {
		const value = fact.field === 'description' ? payload.description : payload.state[asString(fact.field)];
		return typeof value === 'string' ? Boolean(value.trim()) : Array.isArray(value) && value.some((item) => typeof item === 'string' && item.trim());
	})) throw new Error('This source candidate has no extracted character details. Build it from story sources before approving.');
	const snapshot = asRecord(sourceDraft.sourceSnapshot);
	if (!Array.isArray(snapshot.entries) || !Array.isArray(snapshot.events)) throw new Error('This source draft has no current evidence snapshot. Rebuild it before approving.');
	const entryIds = snapshot.entries.map((row) => asString(asRecord(row).id)).filter(Boolean);
	const eventIds = snapshot.events.map((row) => asString(asRecord(row).id)).filter(Boolean);
	const entryRows = entryIds.length ? await tx.select().from(storyEntries).where(and(eq(storyEntries.storyId, proposal.storyId), inArray(storyEntries.id, entryIds))).orderBy(asc(storyEntries.id)).for('share') : [];
	const eventRows = eventIds.length ? await tx.select().from(storyEvents).where(and(eq(storyEvents.storyId, proposal.storyId), inArray(storyEvents.id, eventIds))).orderBy(asc(storyEvents.id)).for('share') : [];
	if (!isDeepStrictEqual(snapshot, characterDraftSourceSnapshot(entryRows, eventRows))) throw new Error('The quoted story sources changed. Rebuild this draft before approving it.');
	if (typeof sourceDraft.targetEntityId === 'string') {
		const [target] = await tx.select().from(entities).where(and(eq(entities.storyId, proposal.storyId), eq(entities.id, sourceDraft.targetEntityId))).for('share');
		if (!target || target.serverVersion !== sourceDraft.targetServerVersion) throw new Error('The exact character target changed. Rebuild this source draft before approving it.');
	}
}

export async function reviewPatchProposal(input: {
	storyId: string;
	proposalId: string;
	decision: 'approved' | 'rejected';
	reviewer?: string | null;
	notes?: string | null;
	expectedProposalVersion?: number;
}): Promise<JsonRecord> {
	const db = getDb();
	const now = nowIso();
	const result = await db.transaction(async (tx) => {
		const [proposal] = await tx.select().from(patchProposals).where(and(
			eq(patchProposals.storyId, input.storyId),
			eq(patchProposals.id, input.proposalId),
			inArray(patchProposals.status, ['pending', 'needs_review']),
		)).for('update');
		if (!proposal) throw new Error(`Patch proposal is missing or no longer pending: ${input.proposalId}`);
		if (input.expectedProposalVersion !== undefined && proposal.serverVersion !== input.expectedProposalVersion) throw new Error('This proposal changed. Reload it before reviewing.');
		if (input.decision === 'approved' && proposal.proposalType === 'character_context_update') {
			const metadata = asRecord(proposal.metadata);
			const hashes = Array.isArray(metadata.identitySourceHashes) ? metadata.identitySourceHashes.map(asRecord) : [];
			if (hashes.length) {
				const rows = await tx.select().from(storyEntries).where(and(eq(storyEntries.storyId, input.storyId), inArray(storyEntries.id, hashes.map(row => asString(row.id))))).for('share');
				if (hashes.some(hash => !rows.some(row => row.id === hash.id && createHash('sha256').update(row.content).digest('hex') === hash.sha256
					&& (!hash.type || row.type === hash.type) && !['user_action', 'system', 'ooc', 'chapter_summary'].includes(row.type)
					&& !asRecord(row.metadata).nonCanon && !asRecord(row.metadata).non_canon && !asRecord(row.metadata).superseded))) throw new Error('Identity evidence changed or disappeared. Rebuild this draft before approving it.');
			}
			const conflicts = Array.isArray(metadata.identityConflicts) ? metadata.identityConflicts.map(asRecord) : [];
			if (conflicts.some(conflict => !Array.isArray(conflict.sources) || !conflict.sources.length) && !/^retcon:\s*\S/i.test(input.notes?.trim() ?? '')) {
				throw new Error('This identity change has no actor-specific source support. Supply explicit author retcon notes beginning with "retcon:" or rebuild from original evidence.');
			}
		}
		if (input.decision === 'approved' && proposal.proposalType === 'character_reference_review') await lockCharacterDraftSources(tx, proposal);
		const serverVersion = await bumpStoryVersionTx(tx, input.storyId);
		let application = emptyProposalApplication();
		if (input.decision === 'approved' && isDueFactionProjectProposal(proposal)) {
			application = await applyDueFactionProjectProposal(tx, {
				storyId: input.storyId,
				proposal,
				serverVersion,
				now,
			});
		}
		if (input.decision === 'approved' && proposal.proposalType === 'character_reference_review') {
			application = await applyCharacterReferenceProposal(tx, {
				storyId: input.storyId,
				proposal,
				serverVersion,
				now,
			});
		}
		if (input.decision === 'approved' && proposal.proposalType === 'character_context_update') {
			application = await applyCharacterContextUpdateProposal(tx, {
				storyId: input.storyId,
				proposal,
				serverVersion,
				now,
				notes: input.notes,
			});
		}

		let factUpdate: JsonRecord | null = null;
		if (proposal.targetTable === 'facts') {
			const [fact] = await tx.select().from(facts).where(and(eq(facts.storyId, input.storyId), eq(facts.id, proposal.targetRecordId))).limit(1);
			if (fact) {
				const factStatus = input.decision === 'approved' ? 'active' : 'rejected';
				await tx.update(facts).set({
					status: factStatus,
					serverVersion,
					updatedAt: now,
				}).where(eq(facts.id, fact.id));
				factUpdate = { factId: fact.id, status: factStatus };
			}
		}

		const applicationMetadata = asRecord(application.metadata);
		const forcedStatus = asString(applicationMetadata.forceStatus);
		const nextStatus = forcedStatus || (input.decision === 'approved'
			? (application.appliedCount > 0 || factUpdate ? 'applied' : 'approved')
			: 'rejected');
		const nextDecision = forcedStatus === 'rejected'
			? 'rejected'
			: input.decision;
		const affectedEntityIds = unique([...(proposal.affectedEntityIds ?? []), ...application.affectedEntityIds]);
		const reviewedMetadata = {
			...asRecord(proposal.metadata),
			reviewNotes: input.notes ?? null,
			reviewedAt: now,
			reviewedBy: input.reviewer ?? 'human',
			appliedOperations: application.appliedOperations,
			...applicationMetadata,
		};
		await tx.update(patchProposals).set({
			status: nextStatus,
			decision: nextDecision,
			validatedBy: input.reviewer ?? 'human',
			affectedEntityIds,
			metadata: reviewedMetadata,
			serverVersion,
			updatedAt: now,
		}).where(eq(patchProposals.id, proposal.id));

		return {
			serverVersion,
			proposalId: proposal.id,
			status: nextStatus,
			decision: nextDecision,
			proposal: {
				...proposal,
				status: nextStatus,
				decision: nextDecision,
				validatedBy: input.reviewer ?? 'human',
				metadata: reviewedMetadata,
				serverVersion,
				updatedAt: now,
			},
			factUpdate,
			application,
		};
	});
	await queueCanonRepairRefresh(input.storyId, result.serverVersion, result.application.affectedEntityIds);
	return {
		storyId: input.storyId,
		...result,
	};
}

export async function applyChapterScribeCharacterContextProposals(input: {
	storyId: string;
	proposalIds: string[];
	reviewer?: string | null;
	notes?: string | null;
}): Promise<JsonRecord> {
	const proposalIds = unique(input.proposalIds.map((id) => id.trim()));
	if (proposalIds.length === 0) {
		return { storyId: input.storyId, serverVersion: null, proposalIds: [], appliedCount: 0, affectedEntityIds: [] };
	}

	const db = getDb();
	const now = nowIso();
	const reviewer = input.reviewer?.trim() || 'chapter_scribe';
	const result = await db.transaction(async (tx) => {
		const rows = await tx.select().from(patchProposals).where(and(
			eq(patchProposals.storyId, input.storyId),
			inArray(patchProposals.id, proposalIds),
			eq(patchProposals.proposalType, 'character_context_update'),
			eq(patchProposals.proposedBy, 'chapter_scribe'),
			inArray(patchProposals.status, ['pending', 'needs_review']),
		)).for('update');
		const proposals = rows.filter((proposal) => (
			proposal.storyId === input.storyId
			&& proposalIds.includes(proposal.id)
			&& proposal.proposalType === 'character_context_update'
			&& proposal.proposedBy === 'chapter_scribe'
			&& (proposal.status === 'pending' || proposal.status === 'needs_review')
			&& asRecord(proposal.metadata).sourceType === 'chapter_character_context'
		));
		if (proposals.length === 0) {
			return { serverVersion: null, proposalIds: [], applications: [], appliedCount: 0, affectedEntityIds: [] };
		}

		const serverVersion = await bumpStoryVersionTx(tx, input.storyId);
		const applications: JsonRecord[] = [];
		const affectedEntityIds: string[] = [];
		let appliedCount = 0;
		// Prefer the newest chapter when recovery has multiple drafts for an actor.
		for (const proposal of proposals.sort((a, b) => Number(asRecord(b.metadata).chapterNumber ?? 0) - Number(asRecord(a.metadata).chapterNumber ?? 0))) {
			const baseVersion = asRecord(proposal.metadata).characterUpdateBaseVersion;
			if (typeof baseVersion === 'number') {
				const [current] = await tx.select({ serverVersion: entities.serverVersion }).from(entities)
					.where(and(eq(entities.storyId, input.storyId), eq(entities.id, proposal.targetRecordId))).for('update');
				if (!current || current.serverVersion !== baseVersion) {
					await tx.update(patchProposals).set({
						status: 'needs_review',
						metadata: { ...asRecord(proposal.metadata), staleReason: 'Character changed after refresh preparation; regenerate from current state.' },
						updatedAt: now,
					}).where(and(eq(patchProposals.storyId, input.storyId), eq(patchProposals.id, proposal.id)));
					applications.push({ proposalId: proposal.id, status: 'needs_review', reason: 'stale_character_snapshot' });
					continue;
				}
			}
			const application = await applyCharacterContextUpdateProposal(tx, {
				storyId: input.storyId,
				proposal,
				serverVersion,
				now,
				notes: input.notes,
				automatic: true,
			});
			const nextStatus = asRecord(application.metadata).forceStatus === 'needs_review' ? 'needs_review' : application.appliedCount > 0 ? 'applied' : 'approved';
			const proposalAffectedEntityIds = unique([...(proposal.affectedEntityIds ?? []), ...application.affectedEntityIds]);
			const metadata = {
				...asRecord(proposal.metadata),
				reviewNotes: input.notes ?? null,
				reviewedAt: now,
				reviewedBy: reviewer,
				appliedOperations: application.appliedOperations,
				...asRecord(application.metadata),
			};
			await tx.update(patchProposals).set({
				status: nextStatus,
				decision: nextStatus === 'needs_review' ? null : 'approved',
				validatedBy: reviewer,
				affectedEntityIds: proposalAffectedEntityIds,
				metadata,
				serverVersion,
				updatedAt: now,
			}).where(and(
				eq(patchProposals.storyId, input.storyId),
				eq(patchProposals.id, proposal.id),
				inArray(patchProposals.status, ['pending', 'needs_review']),
			));
			appliedCount += application.appliedCount;
			affectedEntityIds.push(...application.affectedEntityIds);
			applications.push({
				proposalId: proposal.id,
				status: nextStatus,
				decision: nextStatus === 'needs_review' ? null : 'approved',
				application,
			});
		}

		return {
			serverVersion,
			proposalIds: proposals.map((proposal) => proposal.id),
			applications,
			appliedCount,
			affectedEntityIds: unique(affectedEntityIds),
		};
	});
	if (result.serverVersion != null && result.affectedEntityIds.length > 0) {
		await queueCanonRepairRefresh(input.storyId, result.serverVersion, result.affectedEntityIds);
	}
	return { storyId: input.storyId, ...result };
}

async function deleteSourceRefIds(tx: Tx, storyId: string, ids: string[]): Promise<void> {
	for (let index = 0; index < ids.length; index += 500) {
		const batch = ids.slice(index, index + 500);
		if (batch.length === 0) continue;
		await tx.delete(sourceRefs).where(and(eq(sourceRefs.storyId, storyId), inArray(sourceRefs.id, batch)));
	}
}

async function deleteMemoryNodeIds(tx: Tx, storyId: string, ids: string[]): Promise<void> {
	for (let index = 0; index < ids.length; index += 500) {
		const batch = ids.slice(index, index + 500);
		if (batch.length === 0) continue;
		await tx.delete(memoryNodes).where(and(eq(memoryNodes.storyId, storyId), inArray(memoryNodes.id, batch)));
	}
}

export async function cleanupCanonDrift(input: {
	storyId: string;
	dryRun?: boolean;
}): Promise<JsonRecord> {
	const db = getDb();
	const sourceRows = await db.select().from(sourceRefs).where(eq(sourceRefs.storyId, input.storyId));
	const invalidSourceRefIds = sourceRows.filter(isInvalidSourceRefForRepair).map((row) => row.id);
	const invalidSet = new Set(invalidSourceRefIds);
	const seenRefs = new Set<string>();
	const duplicateSourceRefIds: string[] = [];
	for (const row of sourceRows) {
		if (invalidSet.has(row.id)) continue;
		const key = canonDriftSourceRefKey(row);
		if (seenRefs.has(key)) duplicateSourceRefIds.push(row.id);
		else seenRefs.add(key);
	}

	const unsafeRows = await db.select().from(memoryNodes).where(and(
		eq(memoryNodes.storyId, input.storyId),
		or(
			ilike(memoryNodes.title, '%Transcript context removed%'),
			ilike(memoryNodes.summary, '%poisoned context%'),
			ilike(memoryNodes.content, '%poisoned context%'),
			ilike(memoryNodes.summary, '%deleted a poisoned context%'),
			ilike(memoryNodes.content, '%deleted a poisoned context%'),
		),
	));
	const unsafeMemoryNodeIds = unsafeRows.filter(isUnsafeMemoryNodeForRepair).map((row) => row.id);
	const sourceRefIds = unique([...invalidSourceRefIds, ...duplicateSourceRefIds]);
	const deleteCount = sourceRefIds.length + unsafeMemoryNodeIds.length;
	let serverVersion: number | null = null;

	if (!input.dryRun && deleteCount > 0) {
		serverVersion = await db.transaction(async (tx) => {
			const version = await bumpStoryVersionTx(tx, input.storyId);
			await deleteSourceRefIds(tx, input.storyId, sourceRefIds);
			await deleteMemoryNodeIds(tx, input.storyId, unsafeMemoryNodeIds);
			return version;
		});
		await queueCanonRepairRefresh(input.storyId, serverVersion);
	}

	return {
		storyId: input.storyId,
		dryRun: input.dryRun === true,
		serverVersion,
		deleted: input.dryRun ? false : deleteCount > 0,
		invalidSourceRefs: invalidSourceRefIds.length,
		duplicateSourceRefs: duplicateSourceRefIds.length,
		unsafeMemoryNodes: unsafeMemoryNodeIds.length,
		deleteCount,
	};
}

export async function continuityAudit(input: {
	storyId: string;
	limit?: number;
}): Promise<JsonRecord> {
	const db = getDb();
	const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 10)));
	const factionProjects = await auditDueFactionProjects({
		storyId: input.storyId,
		limit,
		db,
	});
	const [openWarnings, pendingProposals, inactiveEntities] = await Promise.all([
		db.select().from(continuityWarnings).where(and(eq(continuityWarnings.storyId, input.storyId), eq(continuityWarnings.status, 'open'))).limit(limit),
		db.select().from(patchProposals).where(and(eq(patchProposals.storyId, input.storyId), inArray(patchProposals.status, ['pending', 'needs_review']))).limit(limit),
		db.select().from(entities).where(and(eq(entities.storyId, input.storyId), eq(entities.status, 'inactive'))).limit(limit),
	]);
	return {
		storyId: input.storyId,
		generatedAt: nowIso(),
		summary: {
			openWarnings: openWarnings.length,
			pendingProposals: pendingProposals.length,
			inactiveEntities: inactiveEntities.length,
			dueFactionProjects: factionProjects.dueProjectCount,
			factionProjectProposals: factionProjects.proposalCount,
			factionProjectWarnings: factionProjects.warningCount,
		},
		factionProjects,
		openWarnings,
		pendingProposals,
		inactiveEntities,
	};
}
