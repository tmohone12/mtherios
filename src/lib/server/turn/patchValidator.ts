import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import {
	agreements,
	entities,
	entityAliases,
	factions,
	factionGoals,
	factionMemberships,
	factionProjects,
	factionResources,
	facts,
	continuityWarnings,
	patchProposals,
	memoryNodes,
	npcEventLinks,
	npcBeliefs,
	relationships,
	sourceRefs,
	statePatches,
	stories,
	storyEvents,
} from '$lib/server/db/schema';
import { buildNpcEventLinksForEvent } from '$lib/server/events/timeline';
import { enqueueTurnProjectionJobs } from '$lib/server/jobs/outbox';
import { summarizeTurnContinuity } from '$lib/server/memory/continuity';
import { entityResolutionSummary, isCharacterTitleOnlyName, resolveEntityIdentity, shouldReuseResolvedEntity } from '$lib/server/memory/entityResolver';
import { worldStateUpdateSchema, type WorldStateTimelineEvent, type WorldStateUpdate } from '$lib/services/ai/tools/schemas';

type TurnPersistenceDb = Pick<ReturnType<typeof getDb>, 'delete' | 'insert' | 'select' | 'update'>;

const extractedUpdateSchema = z.object({
	update: worldStateUpdateSchema.default(() => worldStateUpdateSchema.parse({})),
});

function nowIso(): string {
	return new Date().toISOString();
}

function id(prefix: string): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function normalizeName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stableNameSegment(value: string): string {
	return normalizeName(value).replace(/\s+/g, '_') || 'unnamed';
}

function sourceIds(...values: Array<string | null | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
		.map(item => item.trim());
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function nonEmptyList(value: unknown): string[] | undefined {
	const list = stringList(value);
	return list.length > 0 ? list : undefined;
}

function characterEventMemoryPatch(value: unknown): Record<string, string[]> | undefined {
	const memory = recordValue(value);
	const patch = Object.fromEntries(
		['did', 'saw', 'knew', 'knows']
			.map((key) => [key, nonEmptyList(memory[key])] as const)
			.filter(([, list]) => list && list.length > 0),
	) as Record<string, string[]>;
	return Object.keys(patch).length > 0 ? patch : undefined;
}

function buildCharacterStatePatch(character: WorldStateUpdate['characters'][number]): Record<string, unknown> {
	const eventMemory = characterEventMemoryPatch(character.eventMemory);
	return Object.fromEntries(Object.entries({
		aliases: nonEmptyList(character.aliases),
		status: character.status,
		relationship: stringValue(character.relationship),
		traits: nonEmptyList(character.traits),
		present: typeof character.present === 'boolean' ? character.present : undefined,
		pressures: nonEmptyList(character.pressures),
		factionTags: nonEmptyList(character.faction_tags),
		currentLocation: stringValue(character.currentLocation ?? character.current_location),
		currentAction: stringValue(character.currentAction ?? character.current_action),
		emotionalState: stringValue(character.emotionalState ?? character.emotional_state),
		appearance: stringValue(character.appearance),
		background: stringValue(character.background),
		goals: nonEmptyList(character.goals),
		speechStyle: stringValue(character.speechStyle ?? character.speech_style),
		eventMemory,
	}).filter(([, value]) => value !== undefined));
}

function mergeEntityState(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const next = { ...existing, ...patch };
	const eventMemory = characterEventMemoryPatch(patch.eventMemory);
	if (!eventMemory) return next;
	const previous = recordValue(existing.eventMemory ?? existing.npcEventMemory);
	next.eventMemory = Object.fromEntries(
		['did', 'saw', 'knew', 'knows'].map((key) => [
			key,
			sourceIds(...stringList(previous[key]), ...stringList(eventMemory[key])).slice(-12),
		]),
	);
	return next;
}

type TurnContinuityProposalRow = typeof patchProposals.$inferInsert;
type TurnSourceRefRow = typeof sourceRefs.$inferInsert;

interface TurnContinuityLedgerBundle {
	patchProposals: Array<TurnContinuityProposalRow>;
	sourceRefs: Array<TurnSourceRefRow>;
}

function queueTurnContinuityProposal(
	ledger: TurnContinuityLedgerBundle,
	input: {
		storyId: string;
		proposalType: string;
		targetTable: string;
		targetRecordId: string;
		operations: Array<Record<string, unknown>>;
		reason: string;
		suggestion: string;
		affectedEntityIds: string[];
		confidence: number;
		sourceEntryIds: string[];
		sourceEventIds?: string[];
		sourcePatchIds?: string[];
		sourceField: string;
		sourceRecordField?: string | null;
		requiresReview?: boolean;
		serverVersion: number;
		now: string;
		metadata: Record<string, unknown>;
	},
) {
	const proposalId = id('proposal_turn');
	const sourceEntryIds = sourceIds(...input.sourceEntryIds);
	const sourceEventIds = sourceIds(...(input.sourceEventIds ?? []));
	const sourcePatchIds = sourceIds(...(input.sourcePatchIds ?? []));
	const proposal: TurnContinuityProposalRow = {
		id: proposalId,
		storyId: input.storyId,
		proposalType: input.proposalType,
		targetTable: input.targetTable,
		targetRecordId: input.targetRecordId,
		proposedBy: 'narration',
		operations: input.operations,
		reason: input.reason,
		suggestion: input.suggestion,
		status: input.requiresReview ? 'needs_review' : 'pending',
		decision: null,
		validatedBy: null,
		affectedEntityIds: sourceIds(...input.affectedEntityIds),
		confidence: input.confidence,
		sourceEntryIds,
		sourceEventIds,
		sourcePatchIds,
		metadata: input.metadata,
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	};

	ledger.patchProposals.push(proposal);
	ledger.sourceRefs.push(...buildSourceRefRows({
		storyId: input.storyId,
		targetTable: 'patch_proposals',
		targetRecordId: proposalId,
		targetRecordField: input.sourceRecordField ?? null,
		sourceField: input.sourceField,
		sourceEntryIds,
		sourceEventIds,
		sourcePatchIds,
		confidence: input.confidence,
		rationale: input.reason,
		notes: input.suggestion,
		serverVersion: input.serverVersion,
		now: input.now,
	}));
}

function queueUnresolvedEntityReference(
	ledger: TurnContinuityLedgerBundle,
	input: {
		storyId: string;
		type: string;
		name: string;
		description: string | null;
		state?: Record<string, unknown>;
		sourceEntryIds: string[];
		sourceEventIds?: string[];
		sourcePatchIds?: string[];
		sourceField: string;
		sourceRecordField?: string | null;
		serverVersion: number;
		now: string;
		metadata?: Record<string, unknown>;
	},
): void {
	const name = input.name.trim();
	if (!name) return;
	const proposalType = input.type === 'character' ? 'character_reference_review' : 'entity_reference_review';
	const targetRecordId = `unresolved_${input.type}_${stableNameSegment(name)}`;
	const sourceEntryIds = sourceIds(...input.sourceEntryIds);
	const sourceEventIds = sourceIds(...(input.sourceEventIds ?? []));
	const sourcePatchIds = sourceIds(...(input.sourcePatchIds ?? []));
	const reason = `Turn referenced unresolved ${input.type} ${name}.`;
	const suggestion = `Review this ${input.type} reference before creating a new canonical record.`;
	const existingProposal = ledger.patchProposals.find((proposal) =>
		proposal.proposalType === proposalType
		&& proposal.targetTable === 'entities'
		&& proposal.targetRecordId === targetRecordId
	);
	if (existingProposal) {
		const existingMetadata = existingProposal.metadata as Record<string, unknown> | null ?? {};
		existingProposal.sourceEntryIds = sourceIds(...stringList(existingProposal.sourceEntryIds), ...sourceEntryIds);
		existingProposal.sourceEventIds = sourceIds(...stringList(existingProposal.sourceEventIds), ...sourceEventIds);
		existingProposal.sourcePatchIds = sourceIds(...stringList(existingProposal.sourcePatchIds), ...sourcePatchIds);
		existingProposal.metadata = {
			...existingMetadata,
			sourceFields: sourceIds(...stringList(existingMetadata.sourceFields), input.sourceField),
		};
		existingProposal.updatedAt = input.now;
		appendUniqueSourceRefs(ledger, buildSourceRefRows({
			storyId: input.storyId,
			targetTable: 'patch_proposals',
			targetRecordId: existingProposal.id,
			targetRecordField: input.sourceRecordField ?? 'state',
			sourceField: input.sourceField,
			sourceEntryIds,
			sourceEventIds,
			sourcePatchIds,
			confidence: 0.52,
			rationale: reason,
			notes: suggestion,
			serverVersion: input.serverVersion,
			now: input.now,
		}));
		return;
	}
	queueTurnContinuityProposal(ledger, {
		storyId: input.storyId,
		proposalType,
		targetTable: 'entities',
		targetRecordId,
		operations: [{
			op: 'review',
			path: `/entities/${input.type}`,
			value: {
				storyId: input.storyId,
				type: input.type,
				name,
				description: input.description ?? null,
				status: String(input.state?.status ?? 'active'),
				visibility: 'player_known',
				state: input.state ?? {},
			},
		}],
		reason,
		suggestion,
		affectedEntityIds: [],
		confidence: 0.52,
		sourceEntryIds,
		sourceEventIds,
		sourcePatchIds,
		sourceField: input.sourceField,
		sourceRecordField: input.sourceRecordField ?? 'state',
		requiresReview: true,
		serverVersion: input.serverVersion,
		now: input.now,
		metadata: {
			sourceType: `unresolved_${input.type}_reference`,
			sourceName: name,
			...(input.metadata ?? {}),
			sourceFields: [input.sourceField],
		},
	});
}

function unresolvedCharacterWarning(name: string): string {
	return `Character reference "${name}" was not created as canon; review the proposal if this should become a character.`;
}

function relationshipEndpointLooksCharacter(
	rel: WorldStateUpdate['relationships'][number],
	role: 'source' | 'target',
	otherEntity: typeof entities.$inferSelect | null,
): boolean {
	if (otherEntity?.type === 'character') return true;
	if (role === 'source') {
		return ['member-of', 'leader-of', 'serves', 'related-to', 'knows-about'].includes(rel.type);
	}
	return ['allied-with', 'enemy-of', 'related-to', 'knows-about'].includes(rel.type);
}

function agreementPartyLooksCharacter(
	agreement: WorldStateUpdate['agreements'][number],
	name: string,
): boolean {
	const normalized = normalizeName(name);
	if (!normalized) return false;
	if (/\b(house|guild|order|company|council|watch|guard|empire|kingdom|republic|league|court|army|fleet|temple|cult|clan|tribe|faction)\b/.test(normalized)) {
		return false;
	}
	if (/\b(lord|lady|ser|sir|envoy|witness|agent|captain|duke|duchess|prince|princess|king|queen|heir|magister)\b/.test(normalized)) {
		return true;
	}
	if (['marriage', 'bond', 'oath', 'debt', 'promise', 'contract', 'vassalage', 'bargain-with-entity'].includes(agreement.category ?? '')) {
		return true;
	}
	return normalized.split(/\s+/).length >= 2;
}

function buildSourceRefRows(input: {
	storyId: string;
	targetTable: string;
	targetRecordId: string;
	targetRecordField?: string | null;
	sourceField?: string | null;
	sourceEntryIds?: string[];
	sourceEventIds?: string[];
	sourcePatchIds?: string[];
	confidence?: number;
	rationale?: string | null;
	notes?: string | null;
	serverVersion: number;
	now: string;
}) {
	const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
		? Math.max(0, Math.min(1, input.confidence))
		: 1;
	const buildRows = (sourceType: string, ids: string[]) => ids.map((sourceId) => ({
		id: id('sourceref'),
		storyId: input.storyId,
		sourceType,
		sourceId,
		targetTable: input.targetTable,
		targetRecordId: input.targetRecordId,
		targetRecordField: input.targetRecordField ?? null,
		sourceField: input.sourceField ?? null,
		confidence,
		rationale: input.rationale ?? null,
		notes: input.notes ?? null,
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	}));

	return [
		...buildRows('story_entry', sourceIds(...(input.sourceEntryIds ?? []))),
		...buildRows('story_event', sourceIds(...(input.sourceEventIds ?? []))),
		...buildRows('state_patch', sourceIds(...(input.sourcePatchIds ?? []))),
	];
}

function sourceRefKey(ref: TurnSourceRefRow): string {
	return [
		ref.targetTable,
		ref.targetRecordId,
		ref.targetRecordField ?? '',
		ref.sourceType,
		ref.sourceId,
		ref.sourceField ?? '',
	].join('\u001f');
}

function appendUniqueSourceRefs(ledger: TurnContinuityLedgerBundle, refs: TurnSourceRefRow[]): void {
	const existingKeys = new Set(ledger.sourceRefs.map(sourceRefKey));
	for (const ref of refs) {
		const key = sourceRefKey(ref);
		if (existingKeys.has(key)) continue;
		existingKeys.add(key);
		ledger.sourceRefs.push(ref);
	}
}

function recordValue(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function unresolvedReferenceProposalKey(proposal: {
	proposalType: string;
	targetTable: string;
	targetRecordId: string;
}): string | null {
	if (!['character_reference_review', 'entity_reference_review'].includes(proposal.proposalType)) return null;
	if (proposal.targetTable !== 'entities') return null;
	if (!proposal.targetRecordId.startsWith('unresolved_')) return null;
	return [proposal.proposalType, proposal.targetTable, proposal.targetRecordId].join('\u001f');
}

function uniqueSourceRefs(refs: TurnSourceRefRow[]): TurnSourceRefRow[] {
	const seen = new Set<string>();
	const unique: TurnSourceRefRow[] = [];
	for (const ref of refs) {
		const key = sourceRefKey(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(ref);
	}
	return unique;
}

async function mergeExistingUnresolvedReferenceProposals(
	db: TurnPersistenceDb,
	input: {
		storyId: string;
		bundle: TurnContinuityLedgerBundle;
		serverVersion: number;
		now: string;
	},
): Promise<void> {
	const wantedKeys = new Set(input.bundle.patchProposals
		.map(unresolvedReferenceProposalKey)
		.filter((key): key is string => Boolean(key)));
	if (wantedKeys.size === 0) return;

	const existingRows = await db
		.select()
		.from(patchProposals)
		.where(and(eq(patchProposals.storyId, input.storyId), inArray(patchProposals.status, ['pending', 'needs_review'])))
		.limit(Math.max(500, wantedKeys.size * 4));
	const existingByKey = new Map<string, typeof patchProposals.$inferSelect>();
	for (const existing of existingRows) {
		const key = unresolvedReferenceProposalKey(existing);
		if (key && wantedKeys.has(key) && !existingByKey.has(key)) existingByKey.set(key, existing);
	}
	if (existingByKey.size === 0) return;

	const keptProposals: TurnContinuityProposalRow[] = [];
	for (const proposal of input.bundle.patchProposals) {
		const key = unresolvedReferenceProposalKey(proposal);
		const existing = key ? existingByKey.get(key) : null;
		if (!existing || existing.id === proposal.id) {
			keptProposals.push(proposal);
			continue;
		}

		const existingMetadata = recordValue(existing.metadata);
		const proposalMetadata = recordValue(proposal.metadata);
		const metadata = {
			...existingMetadata,
			sourceType: existingMetadata.sourceType ?? proposalMetadata.sourceType,
			sourceName: existingMetadata.sourceName ?? proposalMetadata.sourceName,
			sourceFields: sourceIds(
				...stringList(existingMetadata.sourceFields),
				...stringList(proposalMetadata.sourceFields),
			),
		};
		const sourceEntryIds = sourceIds(...stringList(existing.sourceEntryIds), ...stringList(proposal.sourceEntryIds));
		const sourceEventIds = sourceIds(...stringList(existing.sourceEventIds), ...stringList(proposal.sourceEventIds));
		const sourcePatchIds = sourceIds(...stringList(existing.sourcePatchIds), ...stringList(proposal.sourcePatchIds));
		await db.update(patchProposals).set({
			sourceEntryIds,
			sourceEventIds,
			sourcePatchIds,
			metadata,
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		}).where(eq(patchProposals.id, existing.id));

		for (const ref of input.bundle.sourceRefs) {
			if (ref.targetTable !== 'patch_proposals' || ref.targetRecordId !== proposal.id) continue;
			ref.targetRecordId = existing.id;
			ref.serverVersion = input.serverVersion;
			ref.updatedAt = input.now;
		}
	}

	input.bundle.patchProposals.splice(0, input.bundle.patchProposals.length, ...keptProposals);
	const refs = uniqueSourceRefs(input.bundle.sourceRefs);
	input.bundle.sourceRefs.splice(0, input.bundle.sourceRefs.length, ...refs);
}

async function insertSourceRefs(db: TurnPersistenceDb, input: Parameters<typeof buildSourceRefRows>[0]): Promise<void> {
	const rows = buildSourceRefRows(input);
	if (rows.length === 0) return;
	await db.insert(sourceRefs).values(rows).onConflictDoNothing();
}

export function parseTurnUpdate(input: unknown): { update: WorldStateUpdate; warnings: string[] } {
	const parsed = extractedUpdateSchema.safeParse(input);
	if (parsed.success) return { update: parsed.data.update, warnings: [] };
	const direct = worldStateUpdateSchema.safeParse(input);
	if (direct.success) return { update: direct.data, warnings: [] };
	return {
		update: worldStateUpdateSchema.parse({}),
		warnings: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
	};
}

async function findEntityByName(db: TurnPersistenceDb, storyId: string, name: string, type?: string): Promise<typeof entities.$inferSelect | null> {
	const rows = await db
		.select()
		.from(entities)
		.where(and(eq(entities.storyId, storyId), eq(entities.name, name)))
		.limit(20);
	const normalized = normalizeName(name);
	return rows.find((row) => normalizeName(row.name) === normalized && (!type || row.type === type))
		?? rows.find((row) => normalizeName(row.name) === normalized)
		?? null;
}

async function findCharacterEntityByName(db: TurnPersistenceDb, storyId: string, name: string): Promise<typeof entities.$inferSelect | null> {
	const rows = await db
		.select()
		.from(entities)
		.where(and(eq(entities.storyId, storyId), eq(entities.name, name)))
		.limit(20);
	const normalized = normalizeName(name);
	return rows.find((row) => normalizeName(row.name) === normalized && row.type === 'character') ?? null;
}

async function findFactionByName(db: TurnPersistenceDb, storyId: string, name: string): Promise<typeof factions.$inferSelect | null> {
	const rows = await db
		.select()
		.from(factions)
		.where(and(eq(factions.storyId, storyId), eq(factions.name, name)))
		.limit(20);
	const normalized = normalizeName(name);
	return rows.find((row) => normalizeName(row.name) === normalized) ?? null;
}

async function upsertEntity(
	db: TurnPersistenceDb,
	storyId: string,
	type: string,
	name: string,
	description: string | null | undefined,
	state: Record<string, unknown>,
	sourceEntryIds: string[],
	sourceEventIds: string[],
	sourcePatchIds: string[],
	serverVersion: number,
	createdAt: string,
	continuityLedger: TurnContinuityLedgerBundle,
	requiresReview: boolean,
	options: {
		allowCreate?: boolean;
		sourceField?: string;
	} = {},
): Promise<string | null> {
	const aliases = Array.isArray(state.aliases)
		? state.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
		: [];
	if (type === 'character' && isCharacterTitleOnlyName(name)) return null;
	const resolution = await resolveEntityIdentity({
		storyId,
		db,
		includeSemantic: false,
		candidate: {
			type,
			name,
			aliases,
			description,
			sourceEntryIds,
			sourceEventIds,
			sourcePatchIds,
		},
	});
	const resolvedEntityId = shouldReuseResolvedEntity(resolution) ? resolution.entityId : null;
	if (!resolvedEntityId && options.allowCreate === false) {
		queueUnresolvedEntityReference(continuityLedger, {
			storyId,
			type,
			name,
			description: description ?? null,
			state,
			sourceEntryIds,
			sourceEventIds,
			sourcePatchIds,
			sourceField: options.sourceField ?? 'structured_update',
			serverVersion,
			now: createdAt,
			metadata: {
				entityResolver: entityResolutionSummary(resolution),
			},
		});
		return null;
	}
	const entityId = resolvedEntityId ?? id('entity');
	const [existing] = resolvedEntityId
		? await db.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, resolvedEntityId))).limit(1)
		: [];
	const canonicalName = existing && normalizeName(existing.name) !== normalizeName(name) && existing.name.length >= name.length
		? existing.name
		: name;
	const nextState = mergeEntityState(existing?.state as Record<string, unknown> | null ?? {}, state);
	const metadata = {
		...(existing?.metadata as Record<string, unknown> | null ?? {}),
		entityResolver: entityResolutionSummary(resolution),
	};
	const isUpdate = Boolean(existing);
	await db.insert(entities).values({
		id: entityId,
		storyId,
		type,
		name: canonicalName,
		description: description ?? existing?.description ?? null,
		status: String(state.status ?? existing?.status ?? 'active'),
		visibility: 'player_known',
		state: nextState,
		metadata,
		sourceEntryIds: sourceIds(...(existing?.sourceEntryIds ?? []), ...sourceEntryIds),
		sourceEventIds: sourceIds(...(existing?.sourceEventIds ?? []), ...sourceEventIds),
		sourcePatchIds: sourceIds(...(existing?.sourcePatchIds ?? []), ...sourcePatchIds),
		serverVersion,
		createdAt: existing?.createdAt ?? createdAt,
		updatedAt: createdAt,
	}).onConflictDoUpdate({
		target: entities.id,
		set: {
			description: description ?? existing?.description ?? null,
			status: String(state.status ?? existing?.status ?? 'active'),
			state: nextState,
			metadata,
			sourceEntryIds: sourceIds(...(existing?.sourceEntryIds ?? []), ...sourceEntryIds),
			sourceEventIds: sourceIds(...(existing?.sourceEventIds ?? []), ...sourceEventIds),
			sourcePatchIds: sourceIds(...(existing?.sourcePatchIds ?? []), ...sourcePatchIds),
			serverVersion,
			updatedAt: createdAt,
		},
	});
	await insertSourceRefs(db, {
		storyId,
		targetTable: 'entities',
		targetRecordId: entityId,
		targetRecordField: 'state',
		sourceField: 'structured_update',
		sourceEntryIds,
		sourceEventIds,
		sourcePatchIds,
		confidence: 0.9,
		rationale: 'Structured turn update upserted this canonical entity.',
		serverVersion,
		now: createdAt,
	});
	await db.delete(entityAliases).where(and(eq(entityAliases.storyId, storyId), eq(entityAliases.entityId, entityId)));
	const matchedAliases = resolution.candidates.find((candidate) => candidate.entityId === entityId)?.aliases ?? [];
	for (const alias of [...new Set([canonicalName, name, ...matchedAliases, ...aliases])]) {
		const normalizedAlias = normalizeName(alias);
		if (!normalizedAlias) continue;
		await db.insert(entityAliases).values({
			id: id('alias'),
			storyId,
			entityId,
			alias,
			normalizedAlias,
			sourceEntryIds,
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		}).onConflictDoNothing();
	}

	queueTurnContinuityProposal(continuityLedger, {
		storyId,
		proposalType: isUpdate ? 'entity_update' : 'entity_create',
		targetTable: 'entities',
		targetRecordId: entityId,
		operations: [{
			op: isUpdate ? 'replace' : 'add',
			path: `/entities/${entityId}`,
			value: {
				id: entityId,
				storyId,
				type,
				name: canonicalName,
				description: description ?? existing?.description ?? null,
				status: String(state.status ?? existing?.status ?? 'active'),
				visibility: 'player_known',
				state: nextState,
			},
		}],
		reason: `Turn extracted ${type} ${canonicalName}.`,
		suggestion: `Review the proposed ${type} ${canonicalName} update before merging it into canon.`,
		affectedEntityIds: [entityId],
		confidence: 0.88,
		sourceEntryIds,
		sourceEventIds,
		sourcePatchIds,
		sourceField: 'structured_update',
		sourceRecordField: 'state',
		requiresReview,
		serverVersion,
		now: createdAt,
		metadata: {
			sourceType: isUpdate ? 'entity_update' : 'entity_create',
			sourceName: name,
			resolutionMode: existing ? 'resolved' : 'new',
		},
	});
	return entityId;
}

function makeOperations(update: WorldStateUpdate): Array<Record<string, unknown>> {
	const operations: Array<Record<string, unknown>> = [];
	if (update.player_reputation) operations.push({ op: 'replace', path: '/stories/playerReputation', value: update.player_reputation });
	for (const character of update.characters) operations.push({ op: 'upsert', path: '/entities/character', value: character });
	for (const location of update.locations) operations.push({ op: 'upsert', path: '/entities/location', value: location });
	for (const item of update.items) operations.push({ op: 'upsert', path: '/entities/item', value: item });
	for (const entry of update.lorebook_entries) operations.push({ op: 'upsert', path: `/entities/${entry.type}`, value: entry });
	for (const relationship of update.relationships) operations.push({ op: 'upsert', path: '/relationships', value: relationship });
	for (const agreement of update.agreements) operations.push({ op: agreement.action, path: '/agreements', value: agreement });
	for (const conversation of update.conversations) operations.push({ op: 'upsert', path: '/npc_beliefs', value: conversation });
	for (const beat of update.story_beats) operations.push({ op: 'add', path: '/story_events', value: beat });
	for (const event of update.timeline_events) operations.push({ op: event.status === 'committed' ? 'add' : 'upsert', path: '/story_events/timeline', value: event });
	for (const meter of update.meter_changes) operations.push({ op: 'replace', path: '/stories/meters', value: meter });
	if (update.time_delta) operations.push({ op: 'replace', path: '/stories/time', value: update.time_delta });
	return operations;
}

const PLAYER_REPUTATION_UPDATE_TURN_CADENCE = 5;

function shouldApplyPlayerReputationUpdate(metadata: Record<string, unknown>, currentTurn: number): boolean {
	const previous = typeof metadata.playerReputation === 'string' ? metadata.playerReputation.trim() : '';
	if (!previous) return true;
	const lastTurn = typeof metadata.playerReputationUpdatedTurn === 'number'
		? Math.trunc(metadata.playerReputationUpdatedTurn)
		: null;
	if (lastTurn === null) return true;
	return currentTurn - lastTurn >= PLAYER_REPUTATION_UPDATE_TURN_CADENCE;
}

export function turnUpdateOperationCount(update: WorldStateUpdate): number {
	return makeOperations(update).length;
}

function advanceWorldTime(currentWorldTime: string | null, timeDelta: string | null | undefined): string | null {
	const delta = typeof timeDelta === 'string' ? timeDelta.trim() : '';
	if (!delta) return currentWorldTime;
	if (!currentWorldTime) return delta;
	if (currentWorldTime === delta) return currentWorldTime;
	return `${currentWorldTime}; ${delta}`;
}

function timelineDefaults(input: {
	currentTurn: number;
	currentWorldTime: string | null;
	status?: string;
	scheduledTurn?: number | null;
}) {
	const status = input.status ?? 'committed';
	return {
		status,
		createdTurn: input.currentTurn,
		occurredTurn: status === 'committed' ? input.currentTurn : null,
		scheduledTurn: input.scheduledTurn ?? null,
		worldTime: input.currentWorldTime,
		locationIds: [],
		factionIds: [],
		memoryImpact: {},
	};
}

function scheduledTurnForTimelineEvent(event: WorldStateTimelineEvent, timelineTurn: number): number | null {
	if (typeof event.due_turn === 'number' && Number.isFinite(event.due_turn)) {
		return Math.max(0, Math.trunc(event.due_turn));
	}
	if (typeof event.delay_turns === 'number' && Number.isFinite(event.delay_turns)) {
		return timelineTurn + Math.max(0, Math.trunc(event.delay_turns));
	}
	return event.status === 'scheduled' ? timelineTurn + 1 : null;
}

export interface ApplyTurnUpdateInput {
	storyId: string;
	playerEntryId: string;
	assistantEntryId: string;
	narration: string;
	update: WorldStateUpdate;
	parseWarnings: string[];
	retrievedMemoryIds: string[];
	serverVersion: number;
	mode?: 'turn' | 'supplemental';
	timelineTurn?: number | null;
	memorySettings?: {
		chapterThreshold?: number;
		postChapterBuffer?: number;
		chaptersPerArc?: number;
	};
}

export interface ApplyTurnUpdateResult {
	eventIds: string[];
	patchIds: string[];
	memoryNodeIds: string[];
	warnings: string[];
}

export async function applyValidatedTurnUpdate(input: ApplyTurnUpdateInput): Promise<ApplyTurnUpdateResult> {
	const db = getDb();
	const createdAt = nowIso();
	const eventIds: string[] = [];
	const memoryNodeIds: string[] = [];
	const affectedEntityIds: string[] = [];
	const warnings = [...input.parseWarnings];
	const operations = makeOperations(input.update);
	const continuityLedger: TurnContinuityLedgerBundle = { patchProposals: [], sourceRefs: [] };
	const isSupplemental = input.mode === 'supplemental';
	const shouldPersistPatch = !isSupplemental || operations.length > 0 || input.parseWarnings.length > 0;
	const patchId = shouldPersistPatch ? id('patch') : null;
	const patchIds = patchId ? [patchId] : [];

	await db.transaction(async (tx) => {
		const [story] = await tx
			.select()
			.from(stories)
			.where(eq(stories.id, input.storyId))
			.for('update')
			.limit(1);
		if (!story) throw new Error(`Story not found: ${input.storyId}`);

		const currentTurn = story.currentTurn ?? 0;
		const currentWorldTime = story.currentWorldTime ?? null;
		const nextWorldTime = advanceWorldTime(currentWorldTime, input.update.time_delta);
		const timelineTurn = Number.isFinite(input.timelineTurn ?? NaN)
			? Math.max(0, Math.trunc(input.timelineTurn as number))
			: currentTurn;
		const insertNpcLinksForEvent = async (event: {
			eventId: string;
			actorNpcEntityIds?: string[];
			targetNpcEntityIds?: string[];
			visibility: string;
			sourceEntryIds: string[];
			sourcePatchIds: string[];
		}) => {
			const links = buildNpcEventLinksForEvent({
				storyId: input.storyId,
				eventId: event.eventId,
				actorNpcEntityIds: event.actorNpcEntityIds,
				targetNpcEntityIds: event.targetNpcEntityIds,
				visibility: event.visibility,
				sourceEntryIds: event.sourceEntryIds,
				sourcePatchIds: event.sourcePatchIds,
				serverVersion: input.serverVersion,
				now: createdAt,
			});
			if (links.length > 0) {
				await tx.insert(npcEventLinks).values(links).onConflictDoNothing();
			}
		};

		if (!shouldPersistPatch && isSupplemental) return;

		if (patchId) {
			await tx.insert(statePatches).values({
				id: patchId,
				storyId: input.storyId,
				operations,
				reason: isSupplemental ? 'Deferred turn state extraction.' : 'Server turn structured update.',
				status: input.parseWarnings.length > 0 ? 'needs_repair' : 'applied',
				validationWarnings: input.parseWarnings,
				sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
				sourceEventIds: [],
				serverVersion: input.serverVersion,
				createdAt,
				updatedAt: createdAt,
			});
		}

		if (input.update.player_reputation) {
			const metadata = story?.metadata && typeof story.metadata === 'object' ? story.metadata as Record<string, unknown> : {};
			if (shouldApplyPlayerReputationUpdate(metadata, currentTurn)) {
				await tx.update(stories).set({
					metadata: {
						...metadata,
						playerReputation: input.update.player_reputation,
						playerReputationUpdatedTurn: currentTurn,
						playerReputationUpdatedAt: createdAt,
					},
					serverVersion: input.serverVersion,
					updatedAt: createdAt,
				}).where(eq(stories.id, input.storyId));
			} else {
				warnings.push(`Player reputation update skipped: reputation was updated less than ${PLAYER_REPUTATION_UPDATE_TURN_CADENCE} turns ago.`);
			}
		}

		let turnEventId: string | null = null;
		if (!isSupplemental) {
			turnEventId = id('event');
			await tx.insert(storyEvents).values({
				id: turnEventId,
				storyId: input.storyId,
				type: 'scene_transition',
				title: 'Turn resolved',
				body: input.narration.replace(/\s+/g, ' ').slice(0, 2000),
				...timelineDefaults({ currentTurn, currentWorldTime: nextWorldTime }),
				visibility: 'player_known',
				sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
				sourcePatchIds: patchIds,
				metadata: {},
				serverVersion: input.serverVersion,
				createdAt,
				updatedAt: createdAt,
			});
			await insertSourceRefs(tx, {
				storyId: input.storyId,
				targetTable: 'story_events',
				targetRecordId: turnEventId,
				targetRecordField: 'body',
				sourceField: 'narration',
				sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
				sourcePatchIds: patchIds,
				confidence: 0.98,
				rationale: 'Narration generated the canonical turn event.',
				serverVersion: input.serverVersion,
				now: createdAt,
			});
			queueTurnContinuityProposal(continuityLedger, {
				storyId: input.storyId,
				proposalType: 'turn_event_upsert',
				targetTable: 'story_events',
				targetRecordId: turnEventId,
				operations: [{
					op: 'add',
					path: '/story_events',
					value: {
						id: turnEventId,
						storyId: input.storyId,
						type: 'scene_transition',
						title: 'Turn resolved',
						body: input.narration.replace(/\s+/g, ' ').slice(0, 2000),
					},
				}],
				reason: 'Narration generated a scene-transition turn event.',
				suggestion: 'Review the turn event proposal before applying to long-term canon.',
				affectedEntityIds: [...new Set(affectedEntityIds)],
				confidence: 0.9,
				sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
				sourcePatchIds: patchIds,
				sourceField: 'narration',
				sourceRecordField: 'body',
				requiresReview: warnings.length > 0,
				serverVersion: input.serverVersion,
				now: createdAt,
				metadata: {
					sourceType: 'turn_event',
					isSupplemental,
				},
			});
			eventIds.push(turnEventId);
		}

		const turnCharacterEntityIds: string[] = [];
		for (const character of input.update.characters) {
			const entityId = await upsertEntity(tx, input.storyId, 'character', character.name, character.description, buildCharacterStatePatch(character), [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0, {
				allowCreate: false,
				sourceField: 'characters',
			});
			if (entityId) {
				affectedEntityIds.push(entityId);
				turnCharacterEntityIds.push(entityId);
			} else {
				warnings.push(unresolvedCharacterWarning(character.name));
			}
		}
		const uniqueTurnCharacterEntityIds = sourceIds(...turnCharacterEntityIds);
		if (turnEventId && uniqueTurnCharacterEntityIds.length > 0) {
			await tx.update(storyEvents).set({
				actorEntityIds: uniqueTurnCharacterEntityIds,
				serverVersion: input.serverVersion,
				updatedAt: createdAt,
			}).where(and(eq(storyEvents.storyId, input.storyId), eq(storyEvents.id, turnEventId)));
			await insertNpcLinksForEvent({
				eventId: turnEventId,
				actorNpcEntityIds: uniqueTurnCharacterEntityIds,
				visibility: 'player_known',
				sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
				sourcePatchIds: patchIds,
			});
		}

		for (const location of input.update.locations) {
			const entityId = await upsertEntity(tx, input.storyId, 'location', location.name, location.description, {
				current: location.current,
				region: location.region,
				connections: location.connections,
			}, [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0);
			if (entityId) affectedEntityIds.push(entityId);
		}

		for (const item of input.update.items) {
			const entityId = await upsertEntity(tx, input.storyId, 'item', item.name, item.description, {
				quantity: item.quantity,
				equipped: item.equipped,
				location: item.location,
			}, [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0);
			if (entityId) affectedEntityIds.push(entityId);
		}

		for (const entry of input.update.lorebook_entries) {
			const entityId = await upsertEntity(tx, input.storyId, entry.type, entry.name, entry.description, {
				hiddenInfo: entry.hidden_info,
				aliases: entry.aliases,
				keywords: entry.keywords,
				...entry.state_overrides,
			}, [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0, {
				allowCreate: entry.type !== 'character',
				sourceField: 'lorebook_entries',
			});
			if (!entityId) {
				warnings.push(unresolvedCharacterWarning(entry.name));
				continue;
			}
			affectedEntityIds.push(entityId);
			if (entry.type === 'faction') {
				const factionId = `faction_${entityId}`;
				const knownMemberRefs: Array<{ name: string; entityId: string | null; role: string }> = [];
				for (const [idx, member] of entry.known_members.entries()) {
					const memberName = member.trim();
					if (!memberName) continue;
					const role = idx === 0 ? 'leader-or-member' : 'member';
					const memberEntity = await findCharacterEntityByName(tx, input.storyId, memberName);
					if (memberEntity) {
						knownMemberRefs.push({ name: memberName, entityId: memberEntity.id, role });
						affectedEntityIds.push(memberEntity.id);
						continue;
					}
					knownMemberRefs.push({ name: memberName, entityId: null, role });
					queueUnresolvedEntityReference(continuityLedger, {
						storyId: input.storyId,
						type: 'character',
						name: memberName,
						description: `Faction member named in "${entry.name}".`,
						state: {
							referenceContext: 'faction_member',
							factionName: entry.name,
							factionEntityId: entityId,
							role,
							status: 'active',
						},
						sourceEntryIds: [input.assistantEntryId],
						sourcePatchIds: patchIds,
						sourceField: 'lorebook_entries',
						sourceRecordField: 'known_members',
						serverVersion: input.serverVersion,
						now: createdAt,
						metadata: {
							referenceContext: 'faction_member',
							factionName: entry.name,
							factionEntityId: entityId,
						},
					});
					warnings.push(unresolvedCharacterWarning(memberName));
				}
				const knownMemberEntityIds = sourceIds(...knownMemberRefs.map((member) => member.entityId ?? undefined));
				await tx.insert(factions).values({
					id: factionId,
					storyId: input.storyId,
					entityId,
					name: entry.name,
					goals: entry.faction_goals.map((goal) => goal.description),
					resources: entry.faction_resources ?? {},
					memberEntityIds: knownMemberEntityIds,
					territoryIds: entry.territory,
					allies: [],
					enemies: [],
					pressure: 0,
					metadata: { disposition: entry.faction_disposition, goals: entry.faction_goals },
					sourceEntryIds: [input.assistantEntryId],
					sourceEventIds: [],
					sourcePatchIds: patchIds,
					serverVersion: input.serverVersion,
					createdAt,
					updatedAt: createdAt,
				}).onConflictDoUpdate({
					target: factions.id,
					set: {
						goals: entry.faction_goals.map((goal) => goal.description),
						resources: entry.faction_resources ?? {},
						memberEntityIds: knownMemberEntityIds,
						territoryIds: entry.territory,
						metadata: { disposition: entry.faction_disposition, goals: entry.faction_goals },
						sourcePatchIds: patchIds,
						serverVersion: input.serverVersion,
						updatedAt: createdAt,
					},
				});
				for (const [idx, member] of knownMemberRefs.entries()) {
					await tx.insert(factionMemberships).values({
						id: `${factionId}_member_${idx}_${normalizeName(member.name).replace(/\s+/g, '_') || idx}`,
						storyId: input.storyId,
						factionId,
						entityId: member.entityId,
						role: member.role,
						rank: null,
						status: 'active',
						visibility: 'player_known',
						metadata: member.entityId
							? { memberNameOrId: member.name }
							: { memberNameOrId: member.name, unresolvedCharacterReference: true },
						sourceEntryIds: [input.assistantEntryId],
						sourceEventIds: [],
						sourcePatchIds: patchIds,
						serverVersion: input.serverVersion,
						createdAt,
						updatedAt: createdAt,
					}).onConflictDoUpdate({
						target: factionMemberships.id,
						set: { status: 'active', sourcePatchIds: patchIds, serverVersion: input.serverVersion, updatedAt: createdAt },
					});
				}
				if (entry.faction_resources) {
					for (const [kind, amount] of Object.entries(entry.faction_resources)) {
						await tx.insert(factionResources).values({
							id: `${factionId}_resource_${kind}`,
							storyId: input.storyId,
							factionId,
							kind,
							name: kind,
							amount: typeof amount === 'number' ? amount : null,
							status: 'available',
							locationId: null,
							visibility: 'player_known',
							metadata: {},
							sourceEntryIds: [input.assistantEntryId],
							sourceEventIds: [],
							sourcePatchIds: patchIds,
							serverVersion: input.serverVersion,
							createdAt,
							updatedAt: createdAt,
						}).onConflictDoUpdate({
							target: factionResources.id,
							set: { amount: typeof amount === 'number' ? amount : null, sourcePatchIds: patchIds, serverVersion: input.serverVersion, updatedAt: createdAt },
						});
					}
				}
				for (const [idx, goal] of entry.faction_goals.entries()) {
					await tx.insert(factionGoals).values({
						id: `${factionId}_goal_${idx}_${normalizeName(goal.description).slice(0, 24).replace(/\s+/g, '_') || idx}`,
						storyId: input.storyId,
						factionId,
						goal: goal.description,
						status: 'active',
						priority: goal.priority,
						secrecy: 'player_known',
						metadata: goal,
						sourceEntryIds: [input.assistantEntryId],
						sourceEventIds: [],
						sourcePatchIds: patchIds,
						serverVersion: input.serverVersion,
						createdAt,
						updatedAt: createdAt,
					}).onConflictDoUpdate({
						target: factionGoals.id,
						set: { goal: goal.description, priority: goal.priority, metadata: goal, sourcePatchIds: patchIds, serverVersion: input.serverVersion, updatedAt: createdAt },
					});
				}
				for (const [idx, project] of entry.faction_projects.entries()) {
					await tx.insert(factionProjects).values({
						id: `${factionId}_project_${idx}_${normalizeName(project.project).slice(0, 24).replace(/\s+/g, '_') || idx}`,
						storyId: input.storyId,
						factionId,
						project: project.project,
						status: project.status,
						progress: project.progress / 100,
						priority: project.priority,
						dueTurn: project.due_turn,
						worldTime: project.world_time,
						costs: project.costs,
						gains: project.gains,
						risks: project.risks,
						visibility: 'player_known',
						metadata: project,
						sourceEntryIds: [input.assistantEntryId],
						sourceEventIds: [],
						sourcePatchIds: patchIds,
						serverVersion: input.serverVersion,
						createdAt,
						updatedAt: createdAt,
					}).onConflictDoUpdate({
						target: factionProjects.id,
						set: {
							project: project.project,
							status: project.status,
							progress: project.progress / 100,
							priority: project.priority,
							dueTurn: project.due_turn,
							worldTime: project.world_time,
							costs: project.costs,
							gains: project.gains,
							risks: project.risks,
							metadata: project,
							sourcePatchIds: patchIds,
							serverVersion: input.serverVersion,
							updatedAt: createdAt,
						},
					});
				}
			}
		}

		for (const rel of input.update.relationships) {
			const source = await findEntityByName(tx, input.storyId, rel.sourceName);
			const target = await findEntityByName(tx, input.storyId, rel.targetName);
			if (!source || !target) {
				if (!source && relationshipEndpointLooksCharacter(rel, 'source', target)) {
					queueUnresolvedEntityReference(continuityLedger, {
						storyId: input.storyId,
						type: 'character',
						name: rel.sourceName,
						description: `Relationship source in ${rel.type} link to ${rel.targetName}.`,
						state: {
							referenceContext: 'relationship_source',
							relationshipType: rel.type,
							relationshipLabel: rel.label,
							targetName: rel.targetName,
						},
						sourceEntryIds: [input.assistantEntryId],
						sourcePatchIds: patchIds,
						sourceField: 'relationships',
						sourceRecordField: 'sourceName',
						serverVersion: input.serverVersion,
						now: createdAt,
						metadata: {
							referenceContext: 'relationship_source',
							relationshipType: rel.type,
							targetName: rel.targetName,
						},
					});
					warnings.push(unresolvedCharacterWarning(rel.sourceName));
				}
				if (!target && relationshipEndpointLooksCharacter(rel, 'target', source)) {
					queueUnresolvedEntityReference(continuityLedger, {
						storyId: input.storyId,
						type: 'character',
						name: rel.targetName,
						description: `Relationship target in ${rel.type} link from ${rel.sourceName}.`,
						state: {
							referenceContext: 'relationship_target',
							relationshipType: rel.type,
							relationshipLabel: rel.label,
							sourceName: rel.sourceName,
						},
						sourceEntryIds: [input.assistantEntryId],
						sourcePatchIds: patchIds,
						sourceField: 'relationships',
						sourceRecordField: 'targetName',
						serverVersion: input.serverVersion,
						now: createdAt,
						metadata: {
							referenceContext: 'relationship_target',
							relationshipType: rel.type,
							sourceName: rel.sourceName,
						},
					});
					warnings.push(unresolvedCharacterWarning(rel.targetName));
				}
				warnings.push(`Skipped relationship ${rel.sourceName} -> ${rel.targetName}: missing entity.`);
				continue;
			}
			affectedEntityIds.push(source.id, target.id);
			const relId = id('rel');
			await tx.insert(relationships).values({
				id: relId,
				storyId: input.storyId,
				sourceEntityId: source.id,
				targetEntityId: target.id,
				type: rel.type,
				label: rel.label,
				strength: rel.strength,
				bidirectional: rel.bidirectional,
				metadata: {},
				sourceEntryIds: [input.assistantEntryId],
				sourceEventIds: [],
				sourcePatchIds: patchIds,
				serverVersion: input.serverVersion,
				createdAt,
				updatedAt: createdAt,
			}).onConflictDoNothing();
			await insertSourceRefs(tx, {
				storyId: input.storyId,
				targetTable: 'relationships',
				targetRecordId: relId,
				targetRecordField: 'type',
				sourceField: 'relationships',
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				confidence: 0.88,
				rationale: 'Structured turn update created this relationship record.',
				serverVersion: input.serverVersion,
				now: createdAt,
			});
			queueTurnContinuityProposal(continuityLedger, {
				storyId: input.storyId,
				proposalType: 'relationship_upsert',
				targetTable: 'relationships',
				targetRecordId: relId,
				operations: [{
					op: 'add',
					path: '/relationships',
					value: {
						id: relId,
						sourceEntityId: source.id,
						targetEntityId: target.id,
						type: rel.type,
						label: rel.label,
						strength: rel.strength,
						bidirectional: rel.bidirectional,
					},
				}],
				reason: `Narration extracted relationship ${rel.sourceName} -> ${rel.targetName} (${rel.type}).`,
				suggestion: 'Review relationship proposal before applying to long-term canon.',
				affectedEntityIds: [source.id, target.id],
				confidence: 0.88,
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				sourceField: 'relationships',
				sourceRecordField: 'type',
				requiresReview: warnings.length > 0,
				serverVersion: input.serverVersion,
				now: createdAt,
				metadata: {
					sourceType: 'turn_relationship',
					relationshipType: rel.type,
					relationshipLabel: rel.label,
				},
			});
		}

		for (const conversation of input.update.conversations) {
			const believer = await findEntityByName(tx, input.storyId, conversation.npcName, 'character');
			if (!believer) {
				queueUnresolvedEntityReference(continuityLedger, {
					storyId: input.storyId,
					type: 'character',
					name: conversation.npcName,
					description: `NPC belief/conversation subject: ${conversation.topicSummary}`,
					state: {
						referenceContext: 'conversation_npc',
						topicSummary: conversation.topicSummary,
						playerRevealed: conversation.playerRevealed,
						npcLearned: conversation.npcLearned,
						emotionalShift: conversation.emotionalShift,
					},
					sourceEntryIds: [input.assistantEntryId],
					sourcePatchIds: patchIds,
					sourceField: 'conversations',
					sourceRecordField: 'npcName',
					serverVersion: input.serverVersion,
					now: createdAt,
					metadata: {
						referenceContext: 'conversation_npc',
						topicSummary: conversation.topicSummary,
					},
				});
				warnings.push(unresolvedCharacterWarning(conversation.npcName));
				warnings.push(`Skipped NPC belief for ${conversation.npcName}: missing character entity.`);
				continue;
			}
			affectedEntityIds.push(believer.id);
			const beliefText = [
				conversation.topicSummary,
				conversation.playerRevealed.length ? `Player revealed: ${conversation.playerRevealed.join('; ')}` : '',
				conversation.npcLearned.length ? `NPC learned: ${conversation.npcLearned.join('; ')}` : '',
				conversation.emotionalShift ? `Emotional shift: ${conversation.emotionalShift}` : '',
			].filter(Boolean).join('\n');
			const beliefId = id('belief');
			await tx.insert(npcBeliefs).values({
				id: beliefId,
				storyId: input.storyId,
				believerEntityId: believer.id,
				subjectEntityId: null,
				belief: beliefText,
				confidence: 0.75,
				visibility: 'secret',
				evidenceEventIds: [],
				sourceEntryIds: [input.assistantEntryId],
				sourceEventIds: [],
				sourcePatchIds: patchIds,
				serverVersion: input.serverVersion,
				createdAt,
				updatedAt: createdAt,
			});
			await insertSourceRefs(tx, {
				storyId: input.storyId,
				targetTable: 'npc_beliefs',
				targetRecordId: beliefId,
				targetRecordField: 'belief',
				sourceField: 'conversations',
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				confidence: 0.82,
				rationale: 'Structured turn update recorded this NPC belief.',
				serverVersion: input.serverVersion,
				now: createdAt,
			});
			queueTurnContinuityProposal(continuityLedger, {
				storyId: input.storyId,
				proposalType: 'npc_belief_upsert',
				targetTable: 'npc_beliefs',
				targetRecordId: beliefId,
				operations: [{
					op: 'add',
					path: '/npc_beliefs',
					value: {
						id: beliefId,
						believerEntityId: believer.id,
						subjectEntityId: null,
						belief: beliefText,
					},
				}],
				reason: `Narration extracted NPC belief update for ${conversation.npcName}.`,
				suggestion: 'Review the NPC belief proposal before applying to long-term canon.',
				affectedEntityIds: [believer.id],
				confidence: 0.82,
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				sourceField: 'conversations',
				sourceRecordField: 'belief',
				requiresReview: warnings.length > 0,
				serverVersion: input.serverVersion,
				now: createdAt,
				metadata: {
					sourceType: 'turn_npc_belief',
					npcName: conversation.npcName,
				},
			});
		}

		for (const agreement of input.update.agreements) {
			const eventId = id('event');
			const visibility = agreement.secrecy === 'secret' ? 'secret' : 'player_known';
			const resolvedPartyIds: string[] = [];
			const resolvedFactionIds: string[] = [];
			for (const party of agreement.parties) {
				const entity = await findEntityByName(tx, input.storyId, party);
				if (entity?.type === 'character') {
					resolvedPartyIds.push(entity.id);
					continue;
				}
				if (entity?.type === 'faction') {
					const faction = await findFactionByName(tx, input.storyId, party);
					resolvedFactionIds.push(faction?.id ?? `faction_${entity.id}`);
					continue;
				}
				if (!entity && agreementPartyLooksCharacter(agreement, party)) {
					queueUnresolvedEntityReference(continuityLedger, {
						storyId: input.storyId,
						type: 'character',
						name: party,
						description: `Agreement party in ${agreement.category ?? 'agreement'}: ${agreement.terms ?? agreement.reason ?? agreement.action}.`,
						state: {
							referenceContext: 'agreement_party',
							agreementAction: agreement.action,
							agreementCategory: agreement.category,
							secrecy: agreement.secrecy,
							terms: agreement.terms,
						},
						sourceEntryIds: [input.assistantEntryId],
						sourcePatchIds: patchIds,
						sourceField: 'agreements',
						sourceRecordField: 'parties',
						serverVersion: input.serverVersion,
						now: createdAt,
						metadata: {
							referenceContext: 'agreement_party',
							agreementAction: agreement.action,
							agreementCategory: agreement.category,
						},
					});
					warnings.push(unresolvedCharacterWarning(party));
				}
			}
			const uniqueResolvedPartyIds = sourceIds(...resolvedPartyIds);
			const uniqueResolvedFactionIds = sourceIds(...resolvedFactionIds);
			const actorPartyIds = uniqueResolvedPartyIds.slice(0, 1);
			const targetPartyIds = uniqueResolvedPartyIds.slice(1);
			affectedEntityIds.push(...uniqueResolvedPartyIds);
			await tx.insert(storyEvents).values({
				id: eventId,
				storyId: input.storyId,
				type: 'agreement',
				title: `${agreement.action} agreement`,
				body: agreement.terms ?? agreement.reason ?? `${agreement.action} ${agreement.category ?? 'agreement'}`,
				...timelineDefaults({ currentTurn: timelineTurn, currentWorldTime: nextWorldTime }),
				actorEntityIds: actorPartyIds,
				targetEntityIds: targetPartyIds,
				factionIds: uniqueResolvedFactionIds,
				visibility,
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				metadata: { agreement },
				serverVersion: input.serverVersion,
				createdAt,
				updatedAt: createdAt,
			});
			await insertSourceRefs(tx, {
				storyId: input.storyId,
				targetTable: 'story_events',
				targetRecordId: eventId,
				targetRecordField: 'metadata',
				sourceField: 'agreements',
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				confidence: 0.9,
				rationale: 'Structured turn update recorded this agreement event.',
				serverVersion: input.serverVersion,
				now: createdAt,
			});
			queueTurnContinuityProposal(continuityLedger, {
				storyId: input.storyId,
				proposalType: 'story_event_upsert',
				targetTable: 'story_events',
				targetRecordId: eventId,
				operations: [{
					op: 'add',
					path: '/story_events',
					value: {
						id: eventId,
						storyId: input.storyId,
						type: 'agreement',
						title: `${agreement.action} agreement`,
						body: agreement.terms ?? agreement.reason ?? `${agreement.action} ${agreement.category ?? 'agreement'}`,
						actorEntityIds: actorPartyIds,
						targetEntityIds: targetPartyIds,
						factionIds: uniqueResolvedFactionIds,
					},
				}],
				reason: `Narration extracted agreement event for ${agreement.action} (${agreement.category ?? 'agreement'}).`,
				suggestion: 'Review the agreement event proposal before applying to long-term canon.',
				affectedEntityIds: uniqueResolvedPartyIds,
				confidence: 0.9,
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				sourceField: 'agreements',
				sourceRecordField: 'metadata',
				requiresReview: warnings.length > 0,
				serverVersion: input.serverVersion,
				now: createdAt,
				metadata: {
					sourceType: 'turn_agreement_event',
					action: agreement.action,
				},
			});
			await insertNpcLinksForEvent({
				eventId,
				actorNpcEntityIds: actorPartyIds,
				targetNpcEntityIds: targetPartyIds,
				visibility,
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
			});
			eventIds.push(eventId);
			if (agreement.action === 'create' && agreement.category && agreement.terms && agreement.parties.length > 0) {
				const agreementId = id('agreement');
				await tx.insert(agreements).values({
					id: agreementId,
					storyId: input.storyId,
					parties: agreement.parties,
					category: agreement.category,
					terms: agreement.terms,
					status: 'active',
					secrecy: agreement.secrecy,
					consequences: agreement.consequences,
					sourceEntryIds: [input.assistantEntryId],
					sourceEventIds: [eventId],
					sourcePatchIds: patchIds,
					serverVersion: input.serverVersion,
					createdAt,
					updatedAt: createdAt,
				});
				queueTurnContinuityProposal(continuityLedger, {
					storyId: input.storyId,
					proposalType: 'agreement_upsert',
					targetTable: 'agreements',
					targetRecordId: agreementId,
					operations: [{
						op: 'add',
						path: '/agreements',
						value: {
							id: agreementId,
							storyId: input.storyId,
							parties: agreement.parties,
							category: agreement.category,
							terms: agreement.terms,
							status: 'active',
							secrecy: agreement.secrecy,
							consequences: agreement.consequences,
						},
					}],
					reason: `Narration extracted agreement record for ${agreement.category}.`,
					suggestion: 'Review the agreement proposal before applying to long-term canon.',
					affectedEntityIds: uniqueResolvedPartyIds,
					confidence: 0.9,
					sourceEntryIds: [input.assistantEntryId],
					sourcePatchIds: patchIds,
					sourceField: 'agreements',
					sourceRecordField: 'terms',
					requiresReview: warnings.length > 0,
					serverVersion: input.serverVersion,
					now: createdAt,
					metadata: {
						sourceType: 'turn_agreement_record',
						action: agreement.action,
					},
				});
				await insertSourceRefs(tx, {
					storyId: input.storyId,
					targetTable: 'agreements',
					targetRecordId: agreementId,
					targetRecordField: 'terms',
					sourceField: 'agreements',
					sourceEntryIds: [input.assistantEntryId],
					sourcePatchIds: patchIds,
					confidence: 0.9,
					rationale: 'Structured turn update created this agreement record.',
					serverVersion: input.serverVersion,
					now: createdAt,
				});
			}
		}

		for (const timelineEvent of input.update.timeline_events) {
			const eventId = id('event');
			const status = timelineEvent.status;
			const scheduledTurn = scheduledTurnForTimelineEvent(timelineEvent, timelineTurn);
			if (status === 'scheduled' && timelineEvent.due_turn === null && timelineEvent.delay_turns === null) {
				warnings.push(`Scheduled timeline event "${timelineEvent.title}" defaulted to next turn because no due_turn or delay_turns was provided.`);
			}

			const actorEntityIds: string[] = [];
			for (const name of timelineEvent.actor_names) {
				const entity = await findEntityByName(tx, input.storyId, name);
				if (entity) {
					actorEntityIds.push(entity.id);
				} else {
					queueUnresolvedEntityReference(continuityLedger, {
						storyId: input.storyId,
						type: 'character',
						name,
						description: `Timeline event actor in "${timelineEvent.title}".`,
						state: {
							referenceContext: 'timeline_actor',
							timelineTitle: timelineEvent.title,
							timelineType: timelineEvent.type,
							timelineStatus: timelineEvent.status,
							visibility: timelineEvent.visibility,
						},
						sourceEntryIds: [input.assistantEntryId],
						sourcePatchIds: patchIds,
						sourceField: 'timeline_events',
						sourceRecordField: 'actor_names',
						serverVersion: input.serverVersion,
						now: createdAt,
						metadata: {
							referenceContext: 'timeline_actor',
							timelineTitle: timelineEvent.title,
							timelineType: timelineEvent.type,
						},
					});
					warnings.push(unresolvedCharacterWarning(name));
				}
			}
			const targetEntityIds: string[] = [];
			for (const name of timelineEvent.target_names) {
				const entity = await findEntityByName(tx, input.storyId, name);
				if (entity) {
					targetEntityIds.push(entity.id);
				} else {
					queueUnresolvedEntityReference(continuityLedger, {
						storyId: input.storyId,
						type: 'character',
						name,
						description: `Timeline event target in "${timelineEvent.title}".`,
						state: {
							referenceContext: 'timeline_target',
							timelineTitle: timelineEvent.title,
							timelineType: timelineEvent.type,
							timelineStatus: timelineEvent.status,
							visibility: timelineEvent.visibility,
						},
						sourceEntryIds: [input.assistantEntryId],
						sourcePatchIds: patchIds,
						sourceField: 'timeline_events',
						sourceRecordField: 'target_names',
						serverVersion: input.serverVersion,
						now: createdAt,
						metadata: {
							referenceContext: 'timeline_target',
							timelineTitle: timelineEvent.title,
							timelineType: timelineEvent.type,
						},
					});
					warnings.push(unresolvedCharacterWarning(name));
				}
			}
			const factionIds: string[] = [];
			for (const name of timelineEvent.faction_names) {
				const faction = await findFactionByName(tx, input.storyId, name);
				if (faction) factionIds.push(faction.id);
			}
			const location = timelineEvent.location_name
				? await findEntityByName(tx, input.storyId, timelineEvent.location_name, 'location')
				: null;
			const uniqueActorIds = sourceIds(...actorEntityIds);
			const uniqueTargetIds = sourceIds(...targetEntityIds);
			const uniqueFactionIds = sourceIds(...factionIds);
			const affectedIds = sourceIds(...uniqueActorIds, ...uniqueTargetIds);
			affectedEntityIds.push(...affectedIds);

			const occurredTurn = status === 'committed' ? timelineTurn : null;
			await tx.insert(storyEvents).values({
				id: eventId,
				storyId: input.storyId,
				type: timelineEvent.type,
				status,
				title: timelineEvent.title,
				body: timelineEvent.description || timelineEvent.reason || timelineEvent.title,
				actorEntityIds: uniqueActorIds,
				targetEntityIds: uniqueTargetIds,
				locationId: location?.id ?? null,
				locationIds: location?.id ? [location.id] : [],
				factionIds: uniqueFactionIds,
				threadIds: [],
				visibility: timelineEvent.visibility,
				createdTurn: timelineTurn,
				occurredTurn,
				scheduledTurn: status === 'scheduled' || status === 'due' ? scheduledTurn : null,
				worldTime: timelineEvent.world_time ?? nextWorldTime,
				memoryImpact: timelineEvent.memory_impact,
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				metadata: {
					reason: timelineEvent.reason,
					sourceType: 'turn_timeline_event',
					actorNames: timelineEvent.actor_names,
					targetNames: timelineEvent.target_names,
					factionNames: timelineEvent.faction_names,
					locationName: timelineEvent.location_name,
					delayTurns: timelineEvent.delay_turns,
				},
				serverVersion: input.serverVersion,
				createdAt,
				updatedAt: createdAt,
			});
			await insertSourceRefs(tx, {
				storyId: input.storyId,
				targetTable: 'story_events',
				targetRecordId: eventId,
				targetRecordField: 'metadata',
				sourceField: 'timeline_events',
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				confidence: status === 'proposed' ? 0.65 : 0.86,
				rationale: timelineEvent.reason ?? 'Structured turn update recorded this timeline event.',
				serverVersion: input.serverVersion,
				now: createdAt,
			});
			queueTurnContinuityProposal(continuityLedger, {
				storyId: input.storyId,
				proposalType: status === 'scheduled' ? 'scheduled_event_upsert' : 'story_event_upsert',
				targetTable: 'story_events',
				targetRecordId: eventId,
				operations: [{
					op: status === 'committed' ? 'add' : 'upsert',
					path: '/story_events',
					value: {
						id: eventId,
						storyId: input.storyId,
						type: timelineEvent.type,
						status,
						title: timelineEvent.title,
						body: timelineEvent.description || timelineEvent.reason || timelineEvent.title,
						actorEntityIds: uniqueActorIds,
						targetEntityIds: uniqueTargetIds,
						factionIds: uniqueFactionIds,
						locationId: location?.id ?? null,
						visibility: timelineEvent.visibility,
						createdTurn: timelineTurn,
						occurredTurn,
						scheduledTurn: status === 'scheduled' || status === 'due' ? scheduledTurn : null,
						worldTime: timelineEvent.world_time ?? nextWorldTime,
					},
				}],
				reason: timelineEvent.reason ?? `Narration extracted timeline event "${timelineEvent.title}".`,
				suggestion: 'Review the timeline event proposal before treating delayed consequences as settled canon.',
				affectedEntityIds: affectedIds,
				confidence: status === 'proposed' ? 0.65 : 0.86,
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				sourceField: 'timeline_events',
				sourceRecordField: 'metadata',
				requiresReview: status === 'proposed' || warnings.length > 0,
				serverVersion: input.serverVersion,
				now: createdAt,
				metadata: {
					sourceType: 'turn_timeline_event',
					eventStatus: status,
					delayTurns: timelineEvent.delay_turns,
				},
			});
			await insertNpcLinksForEvent({
				eventId,
				actorNpcEntityIds: uniqueActorIds,
				targetNpcEntityIds: uniqueTargetIds,
				visibility: timelineEvent.visibility,
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
			});
			eventIds.push(eventId);
		}

		for (const beat of input.update.story_beats) {
			const eventId = id('event');
			await tx.insert(storyEvents).values({
				id: eventId,
				storyId: input.storyId,
				type: 'reveal',
				title: beat.title,
				body: beat.description,
				...timelineDefaults({ currentTurn: timelineTurn, currentWorldTime: nextWorldTime }),
				visibility: 'player_known',
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				metadata: { significance: beat.significance },
				serverVersion: input.serverVersion,
				createdAt,
				updatedAt: createdAt,
			});
			await insertSourceRefs(tx, {
				storyId: input.storyId,
				targetTable: 'story_events',
				targetRecordId: eventId,
				targetRecordField: 'body',
				sourceField: 'story_beats',
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				confidence: 0.9,
				rationale: 'Structured turn update recorded this story beat.',
				serverVersion: input.serverVersion,
				now: createdAt,
			});
			queueTurnContinuityProposal(continuityLedger, {
				storyId: input.storyId,
				proposalType: 'story_event_upsert',
				targetTable: 'story_events',
				targetRecordId: eventId,
				operations: [{
					op: 'add',
					path: '/story_events',
					value: {
						id: eventId,
						storyId: input.storyId,
						type: 'reveal',
						title: beat.title,
						body: beat.description,
					},
				}],
				reason: `Narration extracted story beat "${beat.title}".`,
				suggestion: 'Review this story beat proposal before applying to long-term canon.',
				affectedEntityIds: [...new Set(affectedEntityIds)],
				confidence: 0.9,
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				sourceField: 'story_beats',
				sourceRecordField: 'body',
				requiresReview: warnings.length > 0,
				serverVersion: input.serverVersion,
				now: createdAt,
				metadata: {
					sourceType: 'story_beat',
					significance: beat.significance,
				},
			});
			eventIds.push(eventId);
		}

		const continuityBundle = summarizeTurnContinuity({
			storyId: input.storyId,
			assistantEntryId: input.assistantEntryId,
			playerEntryId: input.playerEntryId,
			narration: input.narration,
			update: input.update,
			affectedEntityIds,
			sourceEventIds: eventIds,
			sourcePatchIds: patchIds,
			parseWarnings: warnings,
			serverVersion: input.serverVersion,
			now: createdAt,
		});
		const continuityBundleCombined = {
			facts: continuityBundle.facts,
			patchProposals: [...continuityBundle.patchProposals, ...continuityLedger.patchProposals],
			continuityWarnings: continuityBundle.continuityWarnings,
			sourceRefs: [...continuityBundle.sourceRefs, ...continuityLedger.sourceRefs],
		};
		await mergeExistingUnresolvedReferenceProposals(tx, {
			storyId: input.storyId,
			bundle: continuityBundleCombined,
			serverVersion: input.serverVersion,
			now: createdAt,
		});

		if (continuityBundleCombined.facts.length > 0) {
			await tx.insert(facts).values(continuityBundleCombined.facts).onConflictDoNothing();
		}
		if (continuityBundleCombined.patchProposals.length > 0) {
			await tx.insert(patchProposals).values(continuityBundleCombined.patchProposals).onConflictDoNothing();
		}
		if (continuityBundleCombined.continuityWarnings.length > 0) {
			await tx.insert(continuityWarnings).values(continuityBundleCombined.continuityWarnings).onConflictDoNothing();
		}
		if (continuityBundleCombined.sourceRefs.length > 0) {
			await tx.insert(sourceRefs).values(continuityBundleCombined.sourceRefs).onConflictDoNothing();
		}

		if (!isSupplemental) {
			const memoryId = id('mem');
			await tx.insert(memoryNodes).values({
				id: memoryId,
				storyId: input.storyId,
				type: 'episodic',
				title: 'Recent turn',
				content: input.narration,
				summary: input.narration.replace(/\s+/g, ' ').slice(0, 1200),
				keywords: [],
				entityIds: [],
				factionIds: [],
				threadIds: [],
				locationId: null,
				visibility: 'player_known',
				importance: 0.55,
				sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
				sourceEventIds: eventIds,
				sourcePatchIds: patchIds,
				metadata: { retrievedMemoryIds: input.retrievedMemoryIds },
				serverVersion: input.serverVersion,
				createdAt,
				updatedAt: createdAt,
			});
			memoryNodeIds.push(memoryId);

			await tx.update(stories).set({
				currentTurn: currentTurn + 1,
				currentWorldTime: nextWorldTime,
				serverVersion: input.serverVersion,
				updatedAt: createdAt,
			}).where(eq(stories.id, input.storyId));
		} else if (input.update.time_delta) {
			await tx.update(stories).set({
				currentWorldTime: nextWorldTime,
				serverVersion: input.serverVersion,
				updatedAt: createdAt,
			}).where(eq(stories.id, input.storyId));
		}
	});

	if (eventIds.length === 0 && memoryNodeIds.length === 0 && patchIds.length === 0) {
		return { eventIds, patchIds, memoryNodeIds, warnings };
	}

	try {
		await enqueueTurnProjectionJobs({
			storyId: input.storyId,
			eventIds,
			memoryNodeIds,
			patchIds,
			serverVersion: input.serverVersion,
			memorySettings: input.memorySettings,
		});
	} catch (error) {
		warnings.push(`Queued projection jobs failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { eventIds, patchIds, memoryNodeIds, warnings };
}
