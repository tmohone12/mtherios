import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import {
	continuityWarnings,
	entities,
	entityAliases,
	facts,
	factions,
	factionMemberships,
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
import { resolveEntityIdentity, entityResolutionSummary, type EntityIdentityCandidate } from '$lib/server/memory/entityResolver';

type JsonRecord = Record<string, unknown>;
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

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

function replaceInArray(values: string[] = [], from: string, to: string): string[] {
	return unique(values.map((value) => value === from ? to : value));
}

function arrayChanged(left: string[] = [], right: string[] = []): boolean {
	if (left.length !== right.length) return true;
	return left.some((value, index) => value !== right[index]);
}

function mergeRecords(base: JsonRecord, patch: JsonRecord): JsonRecord {
	return { ...patch, ...base };
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

async function queueCanonRepairRefresh(storyId: string, serverVersion: number): Promise<void> {
	await Promise.all([
		enqueueStoryVaultSyncJob({
			storyId,
			serverVersion,
			reason: 'canon-repair',
			payload: { source: 'canon_repair' },
		}),
		enqueueBackendJob({
			storyId,
			type: 'index_canonical_records',
			dedupeKey: `canon-repair-index-${storyId}-${serverVersion}`,
			payload: { reason: 'canon_repair', serverVersion },
			maxAttempts: 3,
		}),
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
	await queueCanonRepairRefresh(input.storyId, result.serverVersion);
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
		const mergedMetadata = mergeRecords(asRecord(source.metadata), {
			...asRecord(keep.metadata),
			mergedFrom: {
				entityId: source.id,
				name: source.name,
				status: source.status,
			},
			mergedInto: keep.id,
			mergedAt: now,
			mergeReason: input.reason ?? null,
		});
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
		const nextStatus = input.decision === 'approved' ? 'approved' : 'rejected';
		await tx.update(patchProposals).set({
			status: nextStatus,
			decision: input.decision,
			validatedBy: input.reviewer ?? 'human',
			metadata: mergeRecords(asRecord(proposal.metadata), {
				reviewNotes: input.notes ?? null,
				reviewedAt: now,
				reviewedBy: input.reviewer ?? 'human',
			}),
			serverVersion,
			updatedAt: now,
		}).where(eq(patchProposals.id, proposal.id));

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

		return {
			serverVersion,
			proposalId: proposal.id,
			status: nextStatus,
			decision: input.decision,
			proposal: {
				...proposal,
				status: nextStatus,
				decision: input.decision,
				validatedBy: input.reviewer ?? 'human',
				metadata: mergeRecords(asRecord(proposal.metadata), {
					reviewNotes: input.notes ?? null,
					reviewedAt: now,
					reviewedBy: input.reviewer ?? 'human',
				}),
				serverVersion,
				updatedAt: now,
			},
			factUpdate,
		};
	});
	await queueCanonRepairRefresh(input.storyId, result.serverVersion);
	return {
		storyId: input.storyId,
		...result,
	};
}

export async function continuityAudit(input: {
	storyId: string;
	limit?: number;
}): Promise<JsonRecord> {
	const db = getDb();
	const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 10)));
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
		},
		openWarnings,
		pendingProposals,
		inactiveEntities,
	};
}
