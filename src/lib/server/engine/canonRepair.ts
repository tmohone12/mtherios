import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import {
	continuityWarnings,
	entities,
	entityAliases,
	facts,
	factions,
	factionMemberships,
	factionProjects,
	memoryNodes,
	npcBeliefs,
	npcEventLinks,
	patchProposals,
	relationships,
	sourceRefs,
	stories,
	storyEvents,
	storyThreads,
} from '$lib/server/db/schema';
import { enqueueBackendJob, enqueueStoryVaultSyncJob } from '$lib/server/jobs/outbox';
import { auditDueFactionProjects } from '$lib/server/factions/projects';
import { isCharacterTitleOnlyName, resolveEntityIdentity, entityResolutionSummary, type EntityIdentityCandidate } from '$lib/server/memory/entityResolver';

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

function containedNameMatch(left: string, right: string): boolean {
	const a = normalizeAlias(left);
	const b = normalizeAlias(right);
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
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96) || 'record';
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

	for (const rawOperation of operations) {
		const operation = asRecord(rawOperation);
		const op = asString(operation.op);
		const path = asString(operation.path);

		const projectStatusMatch = path.match(/^\/faction_projects\/([^/]+)\/status$/);
		if (op === 'replace' && projectStatusMatch) {
			const projectId = projectStatusMatch[1];
			if (projectId !== input.proposal.targetRecordId) continue;
			const status = asString(operation.value);
			if (!status) continue;
			const [updated] = await tx.update(factionProjects).set({
				status,
				sourcePatchIds: unique([...(input.proposal.sourcePatchIds ?? []), input.proposal.id]),
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
}): Promise<ProposalApplication> {
	const proposedState = characterContextUpdateState(input.proposal);
	if (!proposedState) return emptyProposalApplication();

	const [entity] = await tx.select().from(entities).where(and(
		eq(entities.storyId, input.storyId),
		eq(entities.id, input.proposal.targetRecordId),
		eq(entities.type, 'character'),
	)).limit(1);
	if (!entity) return emptyProposalApplication();

	const state = mergeCharacterReferenceState(asRecord(entity.state), proposedState);
	const sourceEntryIds = unique([...(entity.sourceEntryIds ?? []), ...(input.proposal.sourceEntryIds ?? [])]);
	const sourceEventIds = unique([...(entity.sourceEventIds ?? []), ...(input.proposal.sourceEventIds ?? [])]);
	const sourcePatchIds = unique([...(entity.sourcePatchIds ?? []), ...(input.proposal.sourcePatchIds ?? []), input.proposal.id]);
	await tx.update(entities).set({
		state,
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
		metadata: { appliedEntityId: entity.id },
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
	const operationValue = (Array.isArray(proposal.operations) ? proposal.operations : [])
		.map((operation) => asRecord(asRecord(operation).value))
		.find((value) => typeof value.name === 'string' && value.name.trim().length > 0);
	const name = asString(metadata.sourceName, asString(operationValue?.name));
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

async function applyCharacterReferenceProposal(tx: Tx, input: {
	storyId: string;
	proposal: typeof patchProposals.$inferSelect;
	serverVersion: number;
	now: string;
}): Promise<ProposalApplication> {
	const payload = characterReferencePayload(input.proposal);
	if (!payload) return emptyProposalApplication();
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

	const candidateEntityId = `entity_${stableIdSegment(payload.name)}`;
	const existingRows = await tx.select().from(entities)
		.where(and(eq(entities.storyId, input.storyId), eq(entities.type, 'character')))
		.limit(240);
	const existingAliasMap = await loadEntityAliases(tx, input.storyId, existingRows.map((row) => row.id));
	const normalizedPayloadName = normalizeAlias(payload.name);
	const exactExisting = existingRows.find((row) => {
		if (normalizeAlias(row.name) === normalizedPayloadName) return true;
		return (existingAliasMap.get(row.id) ?? []).some((alias) => normalizeAlias(alias) === normalizedPayloadName);
	});
	const containedMatches = exactExisting ? [] : existingRows.filter((row) => {
		if (containedNameMatch(row.name, payload.name)) return true;
		return (existingAliasMap.get(row.id) ?? []).some((alias) => containedNameMatch(alias, payload.name));
	});
	const existing = exactExisting ?? (containedMatches.length === 1 ? containedMatches[0] : null);
	const entityId = existing?.id ?? candidateEntityId;
	const sourceEntryIds = unique([...(existing?.sourceEntryIds ?? []), ...(input.proposal.sourceEntryIds ?? [])]);
	const sourceEventIds = unique([...(existing?.sourceEventIds ?? []), ...(input.proposal.sourceEventIds ?? [])]);
	const sourcePatchIds = unique([...(existing?.sourcePatchIds ?? []), ...(input.proposal.sourcePatchIds ?? []), input.proposal.id]);
	const state = existing ? mergeCharacterReferenceState(asRecord(existing.state), payload.state) : payload.state;
	const metadata = {
		...asRecord(existing?.metadata),
		createdFrom: existing ? asRecord(existing?.metadata).createdFrom : 'character_reference_review',
		approvedFromProposal: input.proposal.id,
		approvedAt: input.now,
	};

	if (existing) {
		await tx.update(entities).set({
			description: existing.description ?? payload.description,
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
			aliases: [payload.name, ...payload.aliases],
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
		enqueueStoryVaultSyncJob({
			storyId,
			serverVersion,
			reason: 'canon-repair',
			payload: { source: 'canon_repair', index: true },
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

export async function mergeEntities(input: {
	storyId: string;
	keepEntityId: string;
	mergeEntityId: string;
	reason?: string | null;
}): Promise<JsonRecord> {
	if (input.keepEntityId === input.mergeEntityId) throw new Error('Cannot merge an entity into itself.');
	const db = getDb();
	const now = nowIso();
	const result = await db.transaction(async (tx) => {
		const [keep] = await tx.select().from(entities).where(and(eq(entities.storyId, input.storyId), eq(entities.id, input.keepEntityId))).limit(1);
		const [source] = await tx.select().from(entities).where(and(eq(entities.storyId, input.storyId), eq(entities.id, input.mergeEntityId))).limit(1);
		if (!keep) throw new Error(`Keep entity not found: ${input.keepEntityId}`);
		if (!source) throw new Error(`Merge entity not found: ${input.mergeEntityId}`);

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
			status: source.status === 'inactive' ? source.status : 'inactive',
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
					if (row.entityId !== source.id && !arrayChanged(row.memberEntityIds, nextMembers)) return;
					await tx.update(factions).set({
						entityId: row.entityId === source.id ? keep.id : row.entityId,
						memberEntityIds: nextMembers,
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
					if (!arrayChanged(row.actorEntityIds, nextActors) && !arrayChanged(row.targetEntityIds, nextTargets)) return;
					await tx.update(storyEvents).set({
						actorEntityIds: nextActors,
						targetEntityIds: nextTargets,
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
					if (!arrayChanged(row.entityIds, nextEntities)) return;
					await tx.update(memoryNodes).set({
						entityIds: nextEntities,
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
				status: source.status === 'inactive' ? source.status : 'inactive',
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

export async function reviewPatchProposal(input: {
	storyId: string;
	proposalId: string;
	decision: 'approved' | 'rejected';
	reviewer?: string | null;
	notes?: string | null;
}): Promise<JsonRecord> {
	const db = getDb();
	const now = nowIso();
	const result = await db.transaction(async (tx) => {
		const [proposal] = await tx.select().from(patchProposals).where(and(eq(patchProposals.storyId, input.storyId), eq(patchProposals.id, input.proposalId))).limit(1);
		if (!proposal) throw new Error(`Patch proposal not found: ${input.proposalId}`);
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
		for (const proposal of proposals) {
			const application = await applyCharacterContextUpdateProposal(tx, {
				storyId: input.storyId,
				proposal,
				serverVersion,
				now,
			});
			const nextStatus = application.appliedCount > 0 ? 'applied' : 'approved';
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
				decision: 'approved',
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
				decision: 'approved',
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
