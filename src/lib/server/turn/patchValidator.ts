import { and, eq } from 'drizzle-orm';
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
import { entityResolutionSummary, resolveEntityIdentity, shouldReuseResolvedEntity } from '$lib/server/memory/entityResolver';
import { worldStateUpdateSchema, type WorldStateUpdate } from '$lib/services/ai/tools/schemas';

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

function sourceIds(...values: Array<string | null | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
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
): Promise<string> {
	const aliases = Array.isArray(state.aliases)
		? state.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
		: [];
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
	const entityId = resolvedEntityId ?? id('entity');
	const [existing] = resolvedEntityId
		? await db.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, resolvedEntityId))).limit(1)
		: [];
	const canonicalName = existing && normalizeName(existing.name) !== normalizeName(name) && existing.name.length >= name.length
		? existing.name
		: name;
	const nextState = { ...(existing?.state as Record<string, unknown> | null ?? {}), ...state };
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

		if (!isSupplemental) {
			const turnEventId = id('event');
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
			await insertNpcLinksForEvent({
				eventId: turnEventId,
				visibility: 'player_known',
				sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
				sourcePatchIds: patchIds,
			});
			eventIds.push(turnEventId);
		}

		for (const character of input.update.characters) {
			const entityId = await upsertEntity(tx, input.storyId, 'character', character.name, character.description, {
				status: character.status,
				relationship: character.relationship,
				traits: character.traits,
				present: character.present,
				pressures: character.pressures,
			}, [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0);
			affectedEntityIds.push(entityId);
		}

		for (const location of input.update.locations) {
			const entityId = await upsertEntity(tx, input.storyId, 'location', location.name, location.description, {
				current: location.current,
				region: location.region,
				connections: location.connections,
			}, [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0);
			affectedEntityIds.push(entityId);
		}

		for (const item of input.update.items) {
			const entityId = await upsertEntity(tx, input.storyId, 'item', item.name, item.description, {
				quantity: item.quantity,
				equipped: item.equipped,
				location: item.location,
			}, [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0);
			affectedEntityIds.push(entityId);
		}

		for (const entry of input.update.lorebook_entries) {
			const entityId = await upsertEntity(tx, input.storyId, entry.type, entry.name, entry.description, {
				hiddenInfo: entry.hidden_info,
				aliases: entry.aliases,
				keywords: entry.keywords,
				...entry.state_overrides,
			}, [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0);
			affectedEntityIds.push(entityId);
			if (entry.type === 'faction') {
				const factionId = `faction_${entityId}`;
				await tx.insert(factions).values({
					id: factionId,
					storyId: input.storyId,
					entityId,
					name: entry.name,
					goals: entry.faction_goals.map((goal) => goal.description),
					resources: entry.faction_resources ?? {},
					memberEntityIds: entry.known_members,
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
						memberEntityIds: entry.known_members,
						territoryIds: entry.territory,
						metadata: { disposition: entry.faction_disposition, goals: entry.faction_goals },
						sourcePatchIds: patchIds,
						serverVersion: input.serverVersion,
						updatedAt: createdAt,
					},
				});
				for (const [idx, member] of entry.known_members.entries()) {
					await tx.insert(factionMemberships).values({
						id: `${factionId}_member_${idx}_${normalizeName(member).replace(/\s+/g, '_') || idx}`,
						storyId: input.storyId,
						factionId,
						entityId: null,
						role: idx === 0 ? 'leader-or-member' : 'member',
						rank: null,
						status: 'active',
						visibility: 'player_known',
						metadata: { memberNameOrId: member },
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
			for (const party of agreement.parties) {
				const entity = await findCharacterEntityByName(tx, input.storyId, party);
				if (entity) resolvedPartyIds.push(entity.id);
			}
			const uniqueResolvedPartyIds = sourceIds(...resolvedPartyIds);
			affectedEntityIds.push(...uniqueResolvedPartyIds);
			await tx.insert(storyEvents).values({
				id: eventId,
				storyId: input.storyId,
				type: 'agreement',
				title: `${agreement.action} agreement`,
				body: agreement.terms ?? agreement.reason ?? `${agreement.action} ${agreement.category ?? 'agreement'}`,
				...timelineDefaults({ currentTurn: timelineTurn, currentWorldTime: nextWorldTime }),
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
				actorNpcEntityIds: uniqueResolvedPartyIds.slice(0, 1),
				targetNpcEntityIds: uniqueResolvedPartyIds.slice(1),
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
