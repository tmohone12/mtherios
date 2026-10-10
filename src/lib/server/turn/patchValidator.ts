import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { mergeCampaignState, readCampaignState } from '$lib/contracts/campaignState';
import { createHash } from 'node:crypto';
import { NPC_AGENCY_FIELDS, readNpcAgency } from '$lib/contracts/npcAgency';
import { AGREEMENT_ACTION_STATUS, agreementPartiesKey, isCurrentAgreement, resolveAgreementTarget } from '$lib/contracts/agreements';
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
	patchProposals,
	npcEventLinks,
	npcBeliefs,
	relationships,
	statePatches,
	stories,
	storyEntries,
	storyEvents,
} from '$lib/server/db/schema';
import { buildNpcEventLinksForEvent } from '$lib/server/events/timeline';
import { enqueueFactionCadenceJob, enqueueTurnProjectionJobs } from '$lib/server/jobs/outbox';
import { entityResolutionSummary, isCharacterTitleOnlyName, resolveEntityIdentity, shouldReuseResolvedEntity } from '$lib/server/memory/entityResolver';
import { worldStateUpdateSchema, worldStateTimelineEventSchema, type WorldStateTimelineEvent, type WorldStateUpdate } from '$lib/services/ai/tools/schemas';
import { isParallelPovEntry } from '$lib/services/ai/context/parallelPov';
import { durableCharacterEventMemoryList } from './characterEventMemory';
import { boundCharacterIdentity } from '$lib/server/engine/characterContinuity';

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

function locationReferencesMatch(value: string, locationId: string, locationName: string): boolean {
	const normalizedValue = normalizeName(value);
	const normalizedId = normalizeName(locationId);
	const normalizedName = normalizeName(locationName);
	return normalizedValue === normalizedId
		|| normalizedValue === normalizedName
		|| (normalizedName.length >= 4 && normalizedValue.includes(normalizedName))
		|| (normalizedValue.length >= 4 && normalizedName.includes(normalizedValue));
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
			.map((key) => [key, nonEmptyList(durableCharacterEventMemoryList(memory[key]))] as const)
			.filter(([, list]) => list && list.length > 0),
	) as Record<string, string[]>;
	return Object.keys(patch).length > 0 ? patch : undefined;
}

function buildCharacterStatePatch(character: WorldStateUpdate['characters'][number]): Record<string, unknown> {
	const eventMemory = characterEventMemoryPatch(character.eventMemory);
	const aliases = nonEmptyList(character.aliases);
	const isPresent = typeof character.present === 'boolean' ? character.present : undefined;
	const currentDisposition = stringValue(character.relationship);
	const motivations = nonEmptyList(character.goals);
	const bio = stringValue(character.background);
	return Object.fromEntries(Object.entries({
		...readNpcAgency(character),
		aliases,
		status: character.status,
		currentDisposition,
		traits: nonEmptyList(character.traits),
		isPresent,
		present: isPresent,
		pressures: nonEmptyList(character.pressures),
		factionTags: nonEmptyList(character.faction_tags),
		partyMember: typeof character.party_member === 'boolean' ? character.party_member : undefined,
		partyRole: character.party_member === false ? null : stringValue(character.party_role),
		affinityDelta: typeof character.affinity_delta === 'number' && Number.isFinite(character.affinity_delta) ? Math.trunc(character.affinity_delta) : undefined,
		affinityReason: stringValue(character.affinity_reason),
		currentLocation: stringValue(character.currentLocation ?? character.current_location),
		currentAction: stringValue(character.currentAction ?? character.current_action),
		emotionalState: stringValue(character.emotionalState ?? character.emotional_state),
		appearance: stringValue(character.appearance),
		presentation: stringValue(character.presentation),
		personality: stringValue(character.personality),
		rank: stringValue(character.rank),
		bio,
		background: bio,
		motivations,
		goals: motivations,
		speechStyle: stringValue(character.speechStyle ?? character.speech_style),
		eventMemory,
	}).filter(([, value]) => value !== undefined));
}

function supportedCharacterQuote(quote: string | undefined, name: string, narration: string): boolean {
	const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
	return Boolean(quote && clean(narration).includes(clean(quote))
		&& ` ${normalizeName(quote)} `.includes(` ${normalizeName(name)} `)
		&& normalizeName(quote).length >= normalizeName(name).length + 12);
}

function normalizedRelationshipStrength(value: number): number {
	return Math.max(-1, Math.min(1, value / 100));
}

function mergeEntityState(
	existing: Record<string, unknown>,
	patch: Record<string, unknown>,
	evidence: { sourceEntryId?: string; timestamp?: string } = {},
): Record<string, unknown> {
	const { affinityDelta: rawAffinityDelta, affinityReason: rawAffinityReason, ...rawDurablePatch } = patch;
	const durablePatch = Object.fromEntries(
		Object.entries(rawDurablePatch).filter(([, value]) => value !== undefined),
	);
	const next = { ...existing, ...durablePatch };
	// Turn extraction supplies new biography facts, not a replacement life story.
	const previousBio = stringValue(existing.bio) ?? stringValue(existing.background);
	const addedBio = stringValue(patch.bio);
	if (previousBio && addedBio) {
		const bio = previousBio.includes(addedBio) ? previousBio : addedBio.includes(previousBio) ? addedBio : `${previousBio}\n${addedBio}`;
		next.bio = bio;
		next.background = bio;
	}
	const currentDisposition = stringValue(patch.currentDisposition);
	const affinityDelta = typeof rawAffinityDelta === 'number' && Number.isFinite(rawAffinityDelta)
		? Math.max(-20, Math.min(20, Math.trunc(rawAffinityDelta)))
		: 0;
	const relationship = recordValue(existing.relationship);
	const playerSelf = existing.relationship === 'self'
		|| existing.isProtagonist === true
		|| relationship.status === 'self'
		|| relationship.status === 'player_character';
	if (currentDisposition || (affinityDelta !== 0 && !playerSelf)) {
		const previousLevel = typeof relationship.level === 'number' && Number.isFinite(relationship.level) ? relationship.level : null;
		const history = Array.isArray(relationship.history) ? relationship.history : [];
		const alreadyApplied = Boolean(evidence.sourceEntryId) && history.some((item) => recordValue(item).entryId === evidence.sourceEntryId);
		const applyAffinityDelta = affinityDelta !== 0 && !playerSelf && !alreadyApplied;
		const parsedTimestamp = evidence.timestamp ? Date.parse(evidence.timestamp) : Number.NaN;
		const affinityHistory = applyAffinityDelta
			? [...history, {
				description: `[${affinityDelta > 0 ? '+' : ''}${affinityDelta}] ${stringValue(rawAffinityReason) ?? 'Narrated relationship shift.'}`,
				delta: affinityDelta,
				...(evidence.sourceEntryId ? { entryId: evidence.sourceEntryId } : {}),
				...(Number.isFinite(parsedTimestamp) ? { timestamp: parsedTimestamp } : {}),
			}].slice(-12)
			: history;
		next.relationship = {
			...relationship,
			...(applyAffinityDelta
				? { level: Math.max(-100, Math.min(100, (previousLevel ?? 0) + affinityDelta)) }
				: previousLevel !== null ? { level: previousLevel } : {}),
			status: currentDisposition ?? relationship.status ?? 'neutral',
			history: affinityHistory,
		};
	}
	const eventMemory = characterEventMemoryPatch(patch.eventMemory);
	if (eventMemory) {
		const previous = recordValue(existing.eventMemory ?? existing.npcEventMemory);
		next.eventMemory = Object.fromEntries(
			['did', 'saw', 'knew', 'knows'].map((key) => [
				key,
				sourceIds(...stringList(previous[key]), ...stringList(eventMemory[key])).slice(-12),
			]),
		);
	}
	return next;
}

type TurnContinuityProposalRow = typeof patchProposals.$inferInsert;

interface TurnContinuityLedgerBundle {
	patchProposals: Array<TurnContinuityProposalRow>;
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
	// Keep review for unresolved places and explicit automatic character creation attempts.
	if (input.metadata.sourceType !== 'unresolved_location_reference' && input.metadata.automaticCharacterCreation !== true && input.metadata.sourceType !== 'character_identity_conflict') return;
	ledger.patchProposals.push({
		id: id('proposal'), storyId: input.storyId, proposalType: input.proposalType,
		targetTable: input.targetTable, targetRecordId: input.targetRecordId,
		operations: input.operations, reason: input.reason, suggestion: input.suggestion, status: 'needs_review',
		confidence: input.confidence, sourceEntryIds: input.sourceEntryIds,
		sourceEventIds: input.sourceEventIds ?? [], sourcePatchIds: input.sourcePatchIds ?? [],
		metadata: { ...input.metadata, suggestion: input.suggestion },
		serverVersion: input.serverVersion, createdAt: input.now, updatedAt: input.now,
	});
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
	return `Character reference "${name}" was not created as canon; add it manually if this should become a character.`;
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
	agreement: { category?: string },
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

	}

	input.bundle.patchProposals.splice(0, input.bundle.patchProposals.length, ...keptProposals);
}

async function insertSourceRefs(db: TurnPersistenceDb, input: unknown): Promise<void> {
	void db;
	void input;
	// ponytail: normal turns keep the state patch as evidence; per-field source refs are repair-tool work.
}

export function parseTurnUpdate(input: unknown): { update: WorldStateUpdate; warnings: string[] } {
	const parsed = extractedUpdateSchema.safeParse('update' in recordValue(input) ? input : { update: input });
	if (parsed.success) return { update: parsed.data.update, warnings: [] };
	return {
		update: worldStateUpdateSchema.parse({}),
		warnings: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
	};
}

async function findEntityByName(db: TurnPersistenceDb, storyId: string, name: string, type?: string): Promise<typeof entities.$inferSelect | null> {
	const rows = await db
		.select()
		.from(entities)
		.where(and(eq(entities.storyId, storyId), or(eq(entities.id, name), sql`lower(${entities.name}) = lower(${name})`)))
		.limit(20);
	const normalized = normalizeName(name);
	const exact = rows.filter(row => (row.id === name || normalizeName(row.name) === normalized) && (!type || row.type === type));
	if (exact.length) return exact.length === 1 ? exact[0] : null;
	// Reuse canonical aliases; fuzzy/semantic similarity cannot grant an identity or knowledge.
	const resolved = await resolveEntityIdentity({ storyId, candidate: { id: name, name, type: type ?? 'character' }, db, includeSemantic: false });
	const matches = resolved.candidates.filter(row => (!type || row.type === type) && row.signals.some(signal => ['exact:id', 'exact:name', 'exact:alias'].includes(signal)));
	if (matches.length !== 1) return null;
	const [entity] = await db.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, matches[0].entityId))).limit(1);
	return entity?.id === matches[0].entityId ? entity : null;
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
		entityId?: string;
		primaryScene?: boolean;
		creationEvidence?: string;
		narration?: string;
		originalNarration?: string;
	} = {},
): Promise<string | null> {
	if (options.primaryScene === false) {
		state = { ...state };
		if (type === 'location') {
			delete state.current;
			delete state.isCurrentLocation;
		} else if (type === 'character') {
			delete state.present;
			delete state.isPresent;
		}
	}
	let aliases = Array.isArray(state.aliases)
		? state.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
		: [];
	if (type === 'character' && isCharacterTitleOnlyName(name)) return null;
	const resolution = await resolveEntityIdentity({
		storyId,
		db,
		includeSemantic: false,
		candidate: {
			id: options.entityId,
			type,
			name,
			aliases,
			description,
			sourceEntryIds,
			sourceEventIds,
			sourcePatchIds,
		},
	});
	const best = resolution.candidates.find(candidate => candidate.entityId === resolution.entityId);
	const ambiguousCharacter = type === 'character' && !options.entityId && best && resolution.candidates.some(candidate => candidate.entityId !== best.entityId && best.score - candidate.score < 0.08);
	const invalidExplicitId = options.entityId && (resolution.entityId !== options.entityId || !best?.signals.some(signal => signal === 'exact:name' || signal === 'exact:alias'));
	const resolvedEntityId = !ambiguousCharacter && !invalidExplicitId && shouldReuseResolvedEntity(resolution) ? resolution.entityId : null;
	const unresolvedLocation = type === 'location' && (resolution.decision !== 'create' || Boolean(options.entityId));
	const unresolvedCharacter = type === 'character' && (resolution.decision !== 'create' || Boolean(options.entityId));
	if (!resolvedEntityId && (options.allowCreate === false || unresolvedLocation || unresolvedCharacter)) {
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
				...(options.creationEvidence ? { automaticCharacterCreation: true, creationEvidence: options.creationEvidence } : {}),
			},
		});
		return null;
	}
	const entityId = resolvedEntityId ?? id('entity');
	const existingRows = resolvedEntityId
		? await db.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, resolvedEntityId))).for('update').limit(1)
		: [];
	const existing = existingRows.find(row => row.id === resolvedEntityId && row.storyId === storyId && row.type === type);
	const canonicalName = existing && (type === 'character' || normalizeName(existing.name) !== normalizeName(name) && existing.name.length >= name.length)
		? existing.name
		: name;
	if (existing && type === 'character') {
		const bounded = boundCharacterIdentity({ storyId, entityId, names: [existing.name, name, ...stringList(recordValue(existing.state).aliases)],
			current: { ...recordValue(existing.state), description: existing.description }, patch: { ...state, ...(description ? { description } : {}) },
			sources: sourceEntryIds.map(id => ({ id, storyId, content: options.narration ?? '' })),
		});
		const proposed = Object.fromEntries(bounded.conflicts.map(conflict => [conflict.field, conflict.proposed]));
		if (Object.keys(proposed).length) queueTurnContinuityProposal(continuityLedger, {
			storyId, proposalType: 'character_context_update', targetTable: 'entities', targetRecordId: entityId,
			operations: [{ op: 'replace', path: `/characters/${entityId}/state`, value: proposed }],
			reason: 'Extracted identity changes need source and namesake review.', suggestion: 'Preserve authored identity; review each original passage before accepting a revelation or retcon.',
			affectedEntityIds: [entityId], confidence: 0, sourceEntryIds, sourcePatchIds, sourceField: 'characters', serverVersion, now: createdAt,
			metadata: { sourceType: 'character_identity_conflict', identityConflicts: bounded.conflicts, characterUpdateBaseVersion: serverVersion,
				identitySourceHashes: sourceEntryIds.map(id => ({ id, sha256: createHash('sha256').update(options.originalNarration ?? options.narration ?? '').digest('hex') })) },
		});
		state = bounded.patch;
		delete state.description;
		description = existing.description;
		aliases = stringList(recordValue(existing.state).aliases);
	}
	const nextState = mergeEntityState(existing?.state as Record<string, unknown> | null ?? {}, state, {
		sourceEntryId: sourceEntryIds[0],
		timestamp: createdAt,
	});
	const metadata = {
		...(existing?.metadata as Record<string, unknown> | null ?? {}),
		entityResolver: entityResolutionSummary(resolution),
		...(!existing && options.creationEvidence ? { sourceType: 'gm_auto_character', creationEvidence: options.creationEvidence } : {}),
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

async function applyCharacterAffiliations(db: TurnPersistenceDb, input: {
	storyId: string;
	updates: Array<{ entityId: string; character: WorldStateUpdate['characters'][number] }>;
	narration: string;
	entryId: string;
	patchIds: string[];
	serverVersion: number;
	now: string;
	warnings: string[];
}): Promise<void> {
	if (!input.updates.length) return;
	const factionRows = await db.select().from(factions).where(eq(factions.storyId, input.storyId)).limit(1000);
	const aliases = await db.select().from(entityAliases).where(eq(entityAliases.storyId, input.storyId)).limit(3000);
	const factionNames = (faction: typeof factions.$inferSelect) => [faction.name, ...aliases.filter(alias => alias.entityId === faction.entityId).map(alias => alias.alias)];
	const membershipRows = await db.select().from(factionMemberships).where(eq(factionMemberships.storyId, input.storyId)).limit(3000);
	for (const { entityId, character } of input.updates) {
		const rows = await db.select().from(entities).where(and(eq(entities.storyId, input.storyId), eq(entities.id, entityId))).limit(1);
		const entity = rows.find(row => row.id === entityId);
		if (!entity) continue;
		const tags = stringList(recordValue(entity.state).factionTags);
		for (const evidence of character.faction_evidence ?? []) {
			const key = normalizeName(evidence.faction);
			const matches = factionRows.filter(faction => {
				const metadata = recordValue(faction.metadata);
				return (factionNames(faction).some(name => normalizeName(name) === key) || faction.id === evidence.faction)
					&& !metadata.mergedInto && !metadata.archived && metadata.activeEra !== false
					&& !['archived', 'inactive', 'historical', 'retired'].includes(String(metadata.status ?? ''));
			});
			const faction = matches.length === 1 ? matches[0] : null;
			if (!faction || !supportedCharacterQuote(evidence.quote, character.name, input.narration)
				|| !factionNames(faction).some(name => ` ${normalizeName(evidence.quote)} `.includes(` ${normalizeName(name)} `))) {
				input.warnings.push(`Faction affiliation for ${character.name} / ${evidence.faction} was not saved: source evidence or faction identity is unresolved.`);
				continue;
			}
			const existing = membershipRows.find(row => row.factionId === faction.id && (row.entityId === entityId
				|| (!row.entityId && normalizeName(String(recordValue(row.metadata).memberNameOrId ?? '')) === normalizeName(character.name))));
			if (existing && existing.status !== 'active') {
				input.warnings.push(`Faction affiliation for ${character.name} / ${faction.name} needs review: an inactive membership already exists.`);
				continue;
			}
			const membershipId = existing?.id ?? `${faction.id}_member_${entityId}`;
			const membership = {
				id: membershipId, storyId: input.storyId, factionId: faction.id, entityId,
				role: existing?.role ?? 'member', rank: existing?.rank ?? character.rank ?? null,
				status: 'active', visibility: existing?.visibility ?? entity.visibility,
				metadata: { ...recordValue(existing?.metadata), memberNameOrId: entity.name, unresolvedCharacterReference: false, affiliationEvidence: evidence.quote },
				sourceEntryIds: sourceIds(...(existing?.sourceEntryIds ?? []), input.entryId),
				sourceEventIds: existing?.sourceEventIds ?? [], sourcePatchIds: sourceIds(...(existing?.sourcePatchIds ?? []), ...input.patchIds),
				serverVersion: input.serverVersion, createdAt: existing?.createdAt ?? input.now, updatedAt: input.now,
			};
			await db.insert(factionMemberships).values(membership).onConflictDoUpdate({ target: factionMemberships.id, set: membership });
			if (existing) Object.assign(existing, membership);
			else membershipRows.push(membership);
			faction.memberEntityIds = sourceIds(...(faction.memberEntityIds ?? []), entityId);
			await db.update(factions).set({ memberEntityIds: faction.memberEntityIds, serverVersion: input.serverVersion, updatedAt: input.now })
				.where(and(eq(factions.storyId, input.storyId), eq(factions.id, faction.id)));
			if (!tags.some(tag => normalizeName(tag) === normalizeName(faction.name))) tags.push(faction.name);
		}
		if (tags.length) await db.update(entities).set({ state: { ...recordValue(entity.state), factionTags: tags }, serverVersion: input.serverVersion, updatedAt: input.now })
			.where(and(eq(entities.storyId, input.storyId), eq(entities.id, entityId)));
	}
}

function makeOperations(update: WorldStateUpdate): Array<Record<string, unknown>> {
	const operations: Array<Record<string, unknown>> = [];
	for (const fact of update.campaign_state ?? []) operations.push({ op: 'upsert', path: '/stories/metadata/campaignState', value: fact });
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

function parseNarrationSceneAnchor(narration: string): { currentWorldTime: string | null; location: string | null } | null {
	const firstLine = narration.split(/\r?\n/).map(line => line.trim()).find(Boolean);
	if (!firstLine?.startsWith('[')) return null;
	const closingBracket = firstLine.lastIndexOf(']');
	if (closingBracket < 0) return null;
	const fields = firstLine.slice(1, closingBracket).split('|');
	if (fields.length < 3) return null;
	const rawField = (matcher: RegExp, fallbackIndex: number) => fields.find(part => matcher.test(part)) ?? fields[fallbackIndex] ?? '';
	const cleanMarker = (value: string) => value
		.trim()
		.replace(/^[^\p{L}\p{N}]+/u, '')
		.replace(/^\s*[-,:]?\s*/, '')
		.trim();
	const timeField = rawField(/(?:🕰️|\bTime\b)/iu, 0);
	const dayField = rawField(/(?:🗓️|\b(?:Day|Date)\b)/iu, 1);
	const locationField = rawField(/(?:📍|\bLocation\b)/iu, 2);
	const time = cleanMarker(/\bTime\b/i.test(timeField) ? timeField.replace(/^[\s\S]*?\bTime\b\s*/i, '') : timeField);
	const day = cleanMarker(/\b(?:Day|Date)\b/i.test(dayField) ? dayField.replace(/^[\s\S]*?\b(?:Day|Date)\b\s*/i, '') : dayField);
	const rawLocation = cleanMarker(/\bLocation\b/i.test(locationField) ? locationField.replace(/^[\s\S]*?\bLocation\b\s*/i, '') : locationField);
	const unknown = new Set([
		'unknown', 'time unknown', 'unknown time', 'day unknown', 'unknown day',
		'date unknown', 'unknown date', 'location unknown', 'unknown location',
		'n a', 'none', 'not established',
	]);
	const usable = (value: string) => value.length > 0
		&& !unknown.has(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
	const currentWorldTime = usable(time) && usable(day)
		? `Day ${day.replace(/^Day\s+/i, '')} | ${time}`
		: null;
	const location = usable(rawLocation) ? rawLocation : null;
	return currentWorldTime || location ? { currentWorldTime, location } : null;
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
	suppressCurrentNpcAgency?: boolean;
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

export interface ApplyTurnUpdateOptions {
	transaction?: TurnPersistenceDb;
	enqueueProjectionJobs?: boolean;
}

export async function applyValidatedTurnUpdate(
	input: ApplyTurnUpdateInput,
	options: ApplyTurnUpdateOptions = {},
): Promise<ApplyTurnUpdateResult> {
	const narrationAnchor = parseNarrationSceneAnchor(input.narration);
	const createdAt = nowIso();
	const eventIds: string[] = [];
	const memoryNodeIds: string[] = [];
	const affectedEntityIds: string[] = [];
	const warnings = [...input.parseWarnings];
	const operations = makeOperations(input.update);
	const continuityLedger: TurnContinuityLedgerBundle = { patchProposals: [] };
	const isSupplemental = input.mode === 'supplemental';
	const shouldPersistPatch = operations.length > 0 || input.parseWarnings.length > 0;
	const patchId = shouldPersistPatch ? id('patch') : null;
	const patchIds = patchId ? [patchId] : [];

	const apply = async (tx: TurnPersistenceDb) => {
		const [story] = await tx
			.select()
			.from(stories)
			.where(eq(stories.id, input.storyId))
			.for('update')
			.limit(1);
		if (!story) throw new Error(`Story not found: ${input.storyId}`);
		// Read persisted source scope here so deferred extraction cannot bypass the guard.
		const sourceEntries = await tx.select({ id: storyEntries.id, type: storyEntries.type, content: storyEntries.content, metadata: storyEntries.metadata, position: storyEntries.position })
			.from(storyEntries)
			.where(and(eq(storyEntries.storyId, input.storyId), inArray(storyEntries.id, [input.playerEntryId, input.assistantEntryId])))
			.limit(2);
		const primaryScene = !sourceEntries.some(isParallelPovEntry);
		const narrationSource = sourceEntries.find(entry => entry.id === input.assistantEntryId && entry.type === 'narration');
		const canonicalNarration = narrationSource && !sourceEntries.some(entry => recordValue(entry.metadata).nonCanon === true || recordValue(entry.metadata).actionType === 'ooc')
			? narrationSource.content : '';
		const knownAudience = async (names: string[] | undefined, evidence: string | undefined) => {
			if (!names?.length) return [] as string[];
			if (!evidence || !canonicalNarration.includes(evidence)) { warnings.push('Skipped knowledge delta: missing exact canonical narration quote.'); return [] as string[]; }
			const audience: string[] = [];
			const quoted = ` ${normalizeName(evidence)} `;
			for (const name of names) {
				const entity = await findEntityByName(tx, input.storyId, name);
				if (!entity || !['character', 'faction'].includes(entity.type) || ![name, entity.name].some(reference => quoted.includes(` ${normalizeName(reference)} `))) {
					warnings.push(`Skipped knowledge audience ${name}: identity is unresolved/ambiguous or absent from its quote.`); continue;
				}
				audience.push(entity.id);
			}
			return sourceIds(...audience);
		};
		const learnedClaims = async (claims: WorldStateTimelineEvent['actor_claims']) => {
			const projected: Array<{ text: string; knownBy: string[]; kind: string; evidence: string; sourceEntryIds: string[] }> = [];
			for (const claim of claims ?? []) {
				if (!claim.evidence.includes(claim.text)) { warnings.push('Skipped knowledge claim: text is not a span of its evidence.'); continue; }
				const knownBy = await knownAudience(claim.known_by, claim.evidence);
				if (knownBy.length) projected.push({ text: claim.text, knownBy, kind: claim.kind, evidence: claim.evidence, sourceEntryIds: [input.assistantEntryId] });
			}
			return projected;
		};
		const insertKnowledgeLinks = async (eventId: string, knownBy: string[], visibility: string) => {
			if (!knownBy.length) return;
			await tx.insert(npcEventLinks).values(knownBy.map(npcEntityId => ({ id: `npc_event_${eventId}_${npcEntityId}`, storyId: input.storyId,
				eventId, npcEntityId, role: 'knower', visibility, evidenceStrength: 1, sourceEntryIds: [input.assistantEntryId], sourcePatchIds: patchIds,
				serverVersion: input.serverVersion, createdAt, updatedAt: createdAt }))).onConflictDoNothing();
		};

		const currentTurn = story.currentTurn ?? 0;
		const currentWorldTime = story.currentWorldTime ?? null;
		const nextWorldTime = narrationAnchor?.currentWorldTime
			?? currentWorldTime
			?? stringValue(input.update.time_delta)?.slice(0, 240)
			?? null;
		const currentLocationId = story.currentLocationId ?? null;
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

		if (!shouldPersistPatch && isSupplemental && !narrationAnchor) return;

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

		if (primaryScene && input.update.player_reputation) {
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
				metadata: primaryScene ? {} : { narrativeMode: 'parallel_pov' },
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
		const timelineEvents: Array<{ event: WorldStateTimelineEvent; npcActionEntityId?: string }> = input.update.timeline_events.map(event => ({ event }));
		const affiliationUpdates: Array<{ entityId: string; character: WorldStateUpdate['characters'][number] }> = [];
		const explicitlyPresentEntityIds = new Set<string>();
		for (const character of input.update.characters) {
			const allowCreate = supportedCharacterQuote(character.creation_evidence, character.name, canonicalNarration)
				&& Boolean(character.description?.trim() || character.background?.trim());
			const state = buildCharacterStatePatch(character);
			const normalizeQuote = (value: string) => value.replace(/\s+/g, ' ').trim();
			const independentMove = character.lastIndependentAction
				&& character.independentActionEvidence
				&& [character.name, ...character.aliases].some(name => supportedCharacterQuote(character.independentActionEvidence, name, canonicalNarration))
				&& normalizeQuote(character.independentActionEvidence).includes(normalizeQuote(character.lastIndependentAction));
			if (character.lastIndependentAction && !independentMove) {
				delete state.lastIndependentAction;
				warnings.push(`Independent move for ${character.name} was not saved: its actor and exact action must be supported by canonical narration evidence.`);
			}
			if (input.suppressCurrentNpcAgency) {
				for (const { key } of NPC_AGENCY_FIELDS) delete state[key];
			} else if (character.nextOpportunity !== undefined) {
				state.nextOpportunityRecordedAt = character.nextOpportunity === null ? null : nextWorldTime;
			}
			// Newly proposed affiliations enter canon only after their quotes and faction identity resolve below.
			if (character.creation_evidence || character.faction_evidence) delete state.factionTags;
			const entityId = await upsertEntity(tx, input.storyId, 'character', character.name, character.description, state, [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0, {
				allowCreate,
				creationEvidence: character.creation_evidence,
				narration: canonicalNarration,
				originalNarration: narrationSource?.content ?? input.narration,
				sourceField: 'characters',
				entityId: character.entityId,
				primaryScene,
			});
			if (entityId) {
				if (independentMove) {
					timelineEvents.push({ npcActionEntityId: entityId, event: worldStateTimelineEventSchema.parse({
						title: `${character.name}: ${character.lastIndependentAction!.slice(0, 100)}`,
						description: character.lastIndependentAction,
						type: 'scheme',
						status: 'committed',
						actor_names: [character.name],
						visibility: character.independentActionVisibility ?? 'player_known',
						world_time: parseNarrationSceneAnchor(canonicalNarration)?.currentWorldTime ?? nextWorldTime,
						memory_impact: { independentNpcAction: true, evidence: character.independentActionEvidence },
						reason: 'Consequential independent NPC move established by narration.',
					}) });
				}
				if (character.faction_evidence?.length) affiliationUpdates.push({ entityId, character });
				affectedEntityIds.push(entityId);
				turnCharacterEntityIds.push(entityId);
				if (primaryScene && character.present === true) explicitlyPresentEntityIds.add(entityId);
			} else {
				warnings.push(character.creation_evidence && !isCharacterTitleOnlyName(character.name)
					? `Character "${character.name}" needs review: creation evidence or identity could not be validated. See NPC Candidates.`
					: unresolvedCharacterWarning(character.name));
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

		let currentLocationIndex = -1;
		let extractedCurrentLocationCount = 0;
		for (const [index, location] of input.update.locations.entries()) {
			if (location.current && location.name.trim()) {
				currentLocationIndex = index;
				extractedCurrentLocationCount += 1;
			}
		}
		if (extractedCurrentLocationCount > 1) {
			warnings.push(`Multiple current locations extracted; kept the last one (${input.update.locations[currentLocationIndex]?.name}).`);
		}
		if (currentLocationIndex < 0 && narrationAnchor?.location) {
			for (const [index, location] of input.update.locations.entries()) {
				if (normalizeName(location.name) === normalizeName(narrationAnchor.location)) currentLocationIndex = index;
			}
		}

		const hasSelectedLocation = currentLocationIndex >= 0 || Boolean(narrationAnchor?.location);
		let nextCurrentLocationId = currentLocationId;
		let sceneLocationId: string | null = null;
		for (const [index, location] of input.update.locations.entries()) {
			const locationState = {
				...(primaryScene && hasSelectedLocation && index === currentLocationIndex ? { current: true } : {}),
				region: location.region,
				connections: location.connections,
			};
			const entityId = await upsertEntity(tx, input.storyId, 'location', location.name, location.description, {
				...locationState,
			}, [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0, {
				entityId: location.entityId,
				sourceField: 'locations',
				primaryScene,
			});
			if (entityId) {
				affectedEntityIds.push(entityId);
				if (index === currentLocationIndex) sceneLocationId = entityId;
			} else {
				warnings.push(`Location reference "${location.name}" needs identity review; the primary scene anchor was preserved.`);
			}
		}
		if (currentLocationIndex < 0 && narrationAnchor?.location) {
			const entityId = await upsertEntity(tx, input.storyId, 'location', narrationAnchor.location, null, {
				...(primaryScene ? { current: true } : {}),
			}, [input.assistantEntryId], [], patchIds, input.serverVersion, createdAt, continuityLedger, warnings.length > 0, { primaryScene, sourceField: 'narration_header' });
			if (entityId) {
				affectedEntityIds.push(entityId);
				sceneLocationId = entityId;
			} else {
				warnings.push('Narration location needs identity review; the primary scene anchor was preserved.');
			}
		}
		if (turnEventId && sceneLocationId) {
			await tx.update(storyEvents).set({ locationId: sceneLocationId, locationIds: [sceneLocationId], serverVersion: input.serverVersion, updatedAt: createdAt })
				.where(and(eq(storyEvents.storyId, input.storyId), eq(storyEvents.id, turnEventId)));
		}
		if (primaryScene && sceneLocationId) nextCurrentLocationId = sceneLocationId;
		if (primaryScene && sceneLocationId) {
			const locationRows = await tx.select().from(entities)
				.where(and(eq(entities.storyId, input.storyId), eq(entities.type, 'location')))
				.limit(1000);
			// ponytail: 1000 locations is a practical story ceiling; remove the limit if a campaign reaches it.
			for (const row of locationRows) {
				const state = recordValue(row.state);
				const selected = row.id === nextCurrentLocationId;
				if (selected ? state.current === true && state.isCurrentLocation === true : state.current !== true && state.isCurrentLocation !== true) continue;
				await tx.update(entities).set({
					state: { ...state, current: selected, isCurrentLocation: selected },
					serverVersion: input.serverVersion,
					updatedAt: createdAt,
				}).where(and(eq(entities.storyId, input.storyId), eq(entities.id, row.id)));
			}
		}
		if (explicitlyPresentEntityIds.size > 0 && nextCurrentLocationId) {
			const sceneLocationRows = await tx.select().from(entities)
				.where(and(eq(entities.storyId, input.storyId), eq(entities.id, nextCurrentLocationId)))
				.limit(20);
			const sceneLocation = sceneLocationRows.find((row) => row.id === nextCurrentLocationId);
			if (sceneLocation?.type === 'location') {
				const characterRows = await tx.select().from(entities)
					.where(and(eq(entities.storyId, input.storyId), eq(entities.type, 'character')))
					.limit(1000);
				for (const row of characterRows) {
					if (explicitlyPresentEntityIds.has(row.id)) continue;
					const state = recordValue(row.state);
					const currentLocation = stringValue(state.currentLocation ?? state.current_location ?? state.location);
					if ((state.present !== true && state.isPresent !== true)
						|| !currentLocation
						|| locationReferencesMatch(currentLocation, sceneLocation.id, sceneLocation.name)) continue;
					await tx.update(entities).set({
						state: { ...state, present: false, isPresent: false },
						serverVersion: input.serverVersion,
						updatedAt: createdAt,
					}).where(and(eq(entities.storyId, input.storyId), eq(entities.id, row.id)));
				}
			}
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
				primaryScene,
			});
			if (!entityId) {
				warnings.push(unresolvedCharacterWarning(entry.name));
				continue;
			}
			affectedEntityIds.push(entityId);
			if (entry.type === 'faction') {
				const factionId = `faction_${entityId}`;
				const [existingFaction] = await tx.select().from(factions).where(and(
					eq(factions.storyId, input.storyId),
					eq(factions.id, factionId),
				)).limit(1);
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
				const incomingGoals = entry.faction_goals.map((goal) => goal.description);
				const incomingResources = entry.faction_resources ?? {};
				const incomingTerritory = entry.territory;
				const mergedMetadata = {
					...recordValue(existingFaction?.metadata),
					...(entry.faction_disposition ? { disposition: entry.faction_disposition } : {}),
					...(entry.faction_goals.length > 0 ? { goals: entry.faction_goals } : {}),
				};
				await tx.insert(factions).values({
					id: factionId,
					storyId: input.storyId,
					entityId,
					name: entry.name,
					goals: incomingGoals,
					resources: incomingResources,
					memberEntityIds: knownMemberEntityIds,
					territoryIds: incomingTerritory,
					allies: [],
					enemies: [],
					pressure: 0,
					metadata: mergedMetadata,
					sourceEntryIds: [input.assistantEntryId],
					sourceEventIds: [],
					sourcePatchIds: patchIds,
					serverVersion: input.serverVersion,
					createdAt,
					updatedAt: createdAt,
				}).onConflictDoUpdate({
					target: factions.id,
					set: {
						name: entry.name,
						entityId,
						goals: incomingGoals.length > 0 ? incomingGoals : existingFaction?.goals ?? [],
						resources: Object.keys(incomingResources).length > 0 ? incomingResources : existingFaction?.resources ?? {},
						memberEntityIds: knownMemberEntityIds.length > 0 ? knownMemberEntityIds : existingFaction?.memberEntityIds ?? [],
						territoryIds: incomingTerritory.length > 0 ? incomingTerritory : existingFaction?.territoryIds ?? [],
						metadata: mergedMetadata,
						sourceEntryIds: sourceIds(...(existingFaction?.sourceEntryIds ?? []), input.assistantEntryId),
						sourcePatchIds: sourceIds(...(existingFaction?.sourcePatchIds ?? []), ...patchIds),
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
			const [existingRelationship] = await tx.select().from(relationships).where(and(
				eq(relationships.storyId, input.storyId),
				eq(relationships.type, rel.type),
				rel.bidirectional
					? or(
						and(eq(relationships.sourceEntityId, source.id), eq(relationships.targetEntityId, target.id)),
						and(eq(relationships.sourceEntityId, target.id), eq(relationships.targetEntityId, source.id)),
					)
					: and(eq(relationships.sourceEntityId, source.id), eq(relationships.targetEntityId, target.id)),
			)).limit(1);
			const relId = existingRelationship?.id ?? id('rel');
			if (rel.type === 'part-of' && (source.type === 'location' || target.type === 'location')) {
				if (existingRelationship && !existingRelationship.bidirectional && source.type === 'location' && target.type === 'location') continue;
				queueUnresolvedEntityReference(continuityLedger, {
					storyId: input.storyId, type: 'location', name: source.name, description: source.description,
					state: { proposedParentLocationId: target.id }, sourceEntryIds: [input.assistantEntryId], sourcePatchIds: patchIds,
					sourceField: 'relationships', serverVersion: input.serverVersion, now: createdAt,
					metadata: { referenceContext: 'location_containment', childLocationId: source.id, proposedParentLocationId: target.id },
				});
				warnings.push(`Proposed containment for "${source.name}" needs review in the location workspace.`);
				continue;
			}
			const strength = normalizedRelationshipStrength(rel.strength);
			const relationshipAudience = await knownAudience(rel.known_by, rel.evidence);
			const relationshipMetadata = { ...recordValue(existingRelationship?.metadata), knownBy: relationshipAudience, knownByActor: false, knowledgeEvidence: relationshipAudience.length ? rel.evidence : null };
			if (existingRelationship) {
				await tx.update(relationships).set({
					metadata: relationshipMetadata,
					label: rel.label ?? existingRelationship.label,
					strength,
					bidirectional: rel.bidirectional,
					sourceEntryIds: sourceIds(...existingRelationship.sourceEntryIds, input.assistantEntryId),
					sourcePatchIds: sourceIds(...existingRelationship.sourcePatchIds, ...patchIds),
					serverVersion: input.serverVersion,
					updatedAt: createdAt,
				}).where(and(eq(relationships.storyId, input.storyId), eq(relationships.id, relId)));
			} else {
				await tx.insert(relationships).values({
					id: relId,
					storyId: input.storyId,
					sourceEntityId: source.id,
					targetEntityId: target.id,
					type: rel.type,
					label: rel.label,
					strength,
					bidirectional: rel.bidirectional,
					metadata: relationshipMetadata,
					sourceEntryIds: [input.assistantEntryId],
					sourceEventIds: [],
					sourcePatchIds: patchIds,
					serverVersion: input.serverVersion,
					createdAt,
					updatedAt: createdAt,
				}).onConflictDoNothing();
			}
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
					op: existingRelationship ? 'replace' : 'add',
					path: '/relationships',
					value: {
						id: relId,
						sourceEntityId: source.id,
						targetEntityId: target.id,
						type: rel.type,
						label: rel.label,
						strength,
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
			const [beliefSource] = await tx.select({ position: storyEntries.position })
				.from(storyEntries)
				.where(and(eq(storyEntries.storyId, input.storyId), eq(storyEntries.id, input.assistantEntryId)))
				.limit(1);
			const existingBeliefs = await tx.select({ belief: npcBeliefs.belief, sourceEntryIds: npcBeliefs.sourceEntryIds })
				.from(npcBeliefs)
				.where(and(eq(npcBeliefs.storyId, input.storyId), eq(npcBeliefs.believerEntityId, believer.id)));
			const topicKey = normalizeName(conversation.topicSummary);
			const sameTopicBeliefs = existingBeliefs.filter((row) => normalizeName(row.belief.split('\n', 1)[0] ?? '') === topicKey);
			if (sameTopicBeliefs.some((row) => row.sourceEntryIds.includes(input.assistantEntryId))) {
				warnings.push(`Skipped repeated NPC belief for ${conversation.npcName}: this source was already applied.`);
				continue;
			}
			const previousSourceIds = sourceIds(...sameTopicBeliefs.flatMap((row) => row.sourceEntryIds));
			if (beliefSource && previousSourceIds.length > 0) {
				const priorSources = await tx.select({ position: storyEntries.position })
					.from(storyEntries)
					.where(and(eq(storyEntries.storyId, input.storyId), inArray(storyEntries.id, previousSourceIds)));
				const latestPriorPosition = priorSources.reduce((max, row) => Math.max(max, row.position), -1);
				if (latestPriorPosition >= beliefSource.position) {
					warnings.push(`Skipped older NPC belief for ${conversation.npcName}: a newer source already records this topic.`);
					continue;
				}
			}
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

		for (const proposedAgreement of input.update.agreements) {
			let previous: typeof agreements.$inferSelect | undefined;
			if (proposedAgreement.action === 'create' && proposedAgreement.category && proposedAgreement.terms) {
				const rows = await tx.select().from(agreements).where(and(eq(agreements.storyId, input.storyId),
					eq(agreements.category, proposedAgreement.category), eq(agreements.terms, proposedAgreement.terms))).limit(201);
				const matches = rows.filter(row => row.storyId === input.storyId && row.category === proposedAgreement.category
					&& row.terms === proposedAgreement.terms && agreementPartiesKey(row.parties) === agreementPartiesKey(proposedAgreement.parties));
				if (rows.length > 200 || matches.some(row => row.status === 'deleted' || isCurrentAgreement(row) || row.sourceEntryIds.includes(input.assistantEntryId))) {
					warnings.push('Skipped duplicate or ambiguous agreement creation; use the existing agreement id.');
					continue;
				}
				const oldSourceIds = sourceIds(...matches.flatMap(row => row.sourceEntryIds));
				if (oldSourceIds.length) {
					const [source] = await tx.select({ position: storyEntries.position }).from(storyEntries)
						.where(and(eq(storyEntries.storyId, input.storyId), eq(storyEntries.id, input.assistantEntryId))).limit(1);
					const [latest] = await tx.select({ position: storyEntries.position }).from(storyEntries)
						.where(and(eq(storyEntries.storyId, input.storyId), inArray(storyEntries.id, oldSourceIds))).orderBy(desc(storyEntries.position)).limit(1);
					if (!source || (latest && source.position <= latest.position)) {
						warnings.push('Skipped older agreement creation: a later source has already resolved this commitment.');
						continue;
					}
				}
			}
			if (proposedAgreement.action !== 'create') {
				const candidates = await tx.select().from(agreements).where(and(
					eq(agreements.storyId, input.storyId),
					proposedAgreement.id ? eq(agreements.id, proposedAgreement.id) : proposedAgreement.category
						? eq(agreements.category, proposedAgreement.category) : undefined,
				)).limit(201);
				previous = candidates.length <= 200 ? resolveAgreementTarget(candidates, input.storyId, proposedAgreement) : undefined;
				if (!previous || !isCurrentAgreement(previous)) {
					warnings.push(`Skipped agreement ${proposedAgreement.action}: target is missing, ambiguous, or already resolved. Supply the exact current agreement id.`);
					continue;
				}
				const [source] = await tx.select({ position: storyEntries.position }).from(storyEntries)
					.where(and(eq(storyEntries.storyId, input.storyId), eq(storyEntries.id, input.assistantEntryId))).limit(1);
				const [latest] = previous.sourceEntryIds.length ? await tx.select({ position: storyEntries.position }).from(storyEntries)
					.where(and(eq(storyEntries.storyId, input.storyId), inArray(storyEntries.id, previous.sourceEntryIds)))
					.orderBy(desc(storyEntries.position)).limit(1) : [];
				if (!source || previous.sourceEntryIds.includes(input.assistantEntryId) || (latest && source.position <= latest.position)) {
					warnings.push(`Skipped agreement ${previous.id}: missing, repeated, or older source cannot overwrite its current state.`);
					continue;
				}
			}
			const resolving = proposedAgreement.action !== 'create' && proposedAgreement.action !== 'update';
			const agreement = {
				...proposedAgreement,
				parties: resolving ? previous!.parties : proposedAgreement.parties.length ? proposedAgreement.parties : previous?.parties ?? [],
				category: resolving ? previous!.category : proposedAgreement.category ?? previous?.category,
				terms: resolving ? previous!.terms : proposedAgreement.terms ?? previous?.terms,
				// Omission must never publish a secret commitment; resolution retains its visibility.
				secrecy: proposedAgreement.action === 'update' || proposedAgreement.action === 'create'
					? proposedAgreement.secrecy ?? previous?.secrecy ?? 'public' : previous?.secrecy ?? 'public',
			};
			if (!agreement.category || !agreement.terms?.trim() || !agreement.parties.length) {
				warnings.push(`Skipped agreement ${agreement.action}: category, terms, and parties are required.`);
				continue;
			}
			const eventId = id('event');
			const agreementId = previous?.id ?? id('agreement');
			const nextStatus = agreement.action === 'create' ? 'active' : agreement.action === 'update'
				? previous!.status : AGREEMENT_ACTION_STATUS[agreement.action];
			const agreementValue = {
				parties: agreement.parties, category: agreement.category, terms: agreement.terms,
				status: nextStatus, secrecy: agreement.secrecy,
				consequences: sourceIds(...(previous?.consequences ?? []), ...agreement.consequences),
				sourceEntryIds: sourceIds(...(previous?.sourceEntryIds ?? []), input.assistantEntryId),
				sourceEventIds: sourceIds(...(previous?.sourceEventIds ?? []), eventId),
				sourcePatchIds: sourceIds(...(previous?.sourcePatchIds ?? []), ...patchIds),
				serverVersion: input.serverVersion, updatedAt: createdAt,
			};
			const visibility = agreement.secrecy === 'secret' || previous?.secrecy === 'secret' ? 'secret' : 'player_known';
			const eventBody = [
				previous && previous.terms !== agreement.terms ? `Previous terms: ${previous.terms}` : '',
				`${agreement.action}: ${agreement.terms}`,
				agreement.reason,
			].filter(Boolean).join('\n');
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
			const agreementAudience = await knownAudience(proposedAgreement.known_by, proposedAgreement.evidence);
			const actorPartyIds = uniqueResolvedPartyIds.slice(0, 1);
			const targetPartyIds = uniqueResolvedPartyIds.slice(1);
			affectedEntityIds.push(...uniqueResolvedPartyIds);
			await tx.insert(storyEvents).values({
				id: eventId,
				storyId: input.storyId,
				type: 'agreement',
				title: `${agreement.action} agreement`,
				body: eventBody,
				...timelineDefaults({ currentTurn: timelineTurn, currentWorldTime: nextWorldTime }),
				actorEntityIds: actorPartyIds,
				targetEntityIds: targetPartyIds,
				factionIds: uniqueResolvedFactionIds,
				visibility,
				sourceEntryIds: [input.assistantEntryId],
				sourcePatchIds: patchIds,
				metadata: {
					agreement: proposedAgreement, agreementId, agreementStatus: nextStatus,
					actorClaims: agreementAudience.length ? [{ text: proposedAgreement.evidence, knownBy: agreementAudience, kind: 'learned', sourceEntryIds: [input.assistantEntryId] }] : [],
					previousAgreement: previous ?? null,
					currentAgreement: { id: agreementId, ...agreementValue },
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
			await insertKnowledgeLinks(eventId, agreementAudience, visibility);
			eventIds.push(eventId);
			if (previous) {
				await tx.update(agreements).set(agreementValue).where(and(eq(agreements.storyId, input.storyId), eq(agreements.id, agreementId)));
			} else {
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

		for (const { event: timelineEvent, npcActionEntityId } of timelineEvents) {
			const eventId = npcActionEntityId
				? `event_npc_action_${createHash('sha256').update(JSON.stringify([input.storyId, input.assistantEntryId, npcActionEntityId])).digest('hex').slice(0, 32)}`
				: `event_timeline_${createHash('sha256').update(JSON.stringify([input.storyId, input.assistantEntryId, timelineEvent.type, timelineEvent.title, timelineEvent.description, timelineEvent.status])).digest('hex').slice(0, 32)}`;
			const status = timelineEvent.status;
			const actorClaims = status === 'committed' ? await learnedClaims(timelineEvent.actor_claims) : [];
			const scheduledTurn = scheduledTurnForTimelineEvent(timelineEvent, timelineTurn);
			if (status === 'scheduled' && timelineEvent.due_turn === null && timelineEvent.delay_turns === null) {
				warnings.push(`Scheduled timeline event "${timelineEvent.title}" defaulted to next turn because no due_turn or delay_turns was provided.`);
			}

			const actorEntityIds: string[] = npcActionEntityId ? [npcActionEntityId] : [];
			for (const name of npcActionEntityId ? [] : timelineEvent.actor_names) {
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
					actorClaims,
					sourceType: npcActionEntityId ? 'npc_independent_action' : 'turn_timeline_event',
					actorNames: timelineEvent.actor_names,
					targetNames: timelineEvent.target_names,
					factionNames: timelineEvent.faction_names,
					locationName: timelineEvent.location_name,
					delayTurns: timelineEvent.delay_turns,
				},
				serverVersion: input.serverVersion,
				createdAt,
				updatedAt: createdAt,
			}).onConflictDoNothing();
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
			await insertKnowledgeLinks(eventId, sourceIds(...actorClaims.flatMap(claim => claim.knownBy)), timelineEvent.visibility);
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

		if (input.update.campaign_state?.length) {
			if (!primaryScene || !canonicalNarration || !narrationSource) {
				warnings.push('Campaign state skipped: requires canonical primary-POV narration.');
			} else {
				const merged = mergeCampaignState(readCampaignState(story.metadata), input.update.campaign_state, {
					id: narrationSource.id, position: narrationSource.position, content: canonicalNarration,
				});
				warnings.push(...merged.warnings);
				if (merged.accepted.length) {
					await tx.update(stories).set({
						metadata: sql`jsonb_set(coalesce(${stories.metadata}, '{}'::jsonb), '{campaignState}', ${JSON.stringify(merged.facts)}::jsonb)`,
						serverVersion: input.serverVersion, updatedAt: createdAt,
					}).where(eq(stories.id, input.storyId));
				}
			}
		}

		// Factions introduced in this same turn now exist, so memberships can be saved atomically.
		await applyCharacterAffiliations(tx, { storyId: input.storyId, updates: affiliationUpdates, narration: canonicalNarration,
			entryId: input.assistantEntryId, patchIds, serverVersion: input.serverVersion, now: createdAt, warnings });
		const continuityBundleCombined = {
			patchProposals: continuityLedger.patchProposals,
		};
		await mergeExistingUnresolvedReferenceProposals(tx, {
			storyId: input.storyId,
			bundle: continuityBundleCombined,
			serverVersion: input.serverVersion,
			now: createdAt,
		});

		if (continuityBundleCombined.patchProposals.length > 0) {
			await tx.insert(patchProposals).values(continuityBundleCombined.patchProposals).onConflictDoNothing();
		}

		if (!isSupplemental) {
			await tx.update(stories).set({
				currentTurn: currentTurn + 1,
				currentWorldTime: primaryScene ? nextWorldTime : currentWorldTime,
				currentLocationId: nextCurrentLocationId,
				serverVersion: input.serverVersion,
				updatedAt: createdAt,
			}).where(eq(stories.id, input.storyId));
		} else if (primaryScene && (nextWorldTime !== currentWorldTime || nextCurrentLocationId !== currentLocationId)) {
			await tx.update(stories).set({
				currentWorldTime: nextWorldTime,
				currentLocationId: nextCurrentLocationId,
				serverVersion: input.serverVersion,
				updatedAt: createdAt,
			}).where(eq(stories.id, input.storyId));
		}
		// Commit the independent faction wake with its clock/turn change. A crash
		// after this transaction cannot strand the fifth turn; deferred extraction
		// can also supply elapsed world time after the interactive turn has ended.
		const worldTimeJump = primaryScene && nextWorldTime !== currentWorldTime;
		if (!isSupplemental || worldTimeJump) {
			await enqueueFactionCadenceJob({ storyId: input.storyId,
				currentTurn: currentTurn + (isSupplemental ? 0 : 1), worldTimeJump,
				worldTime: primaryScene ? nextWorldTime : currentWorldTime }, tx);
		}
	};
	if (options.transaction) {
		await apply(options.transaction);
	} else {
		await getDb().transaction(apply);
	}

	if (eventIds.length === 0 && memoryNodeIds.length === 0 && patchIds.length === 0) {
		return { eventIds, patchIds, memoryNodeIds, warnings };
	}

	if (options.enqueueProjectionJobs === false) {
		return { eventIds, patchIds, memoryNodeIds, warnings };
	}

	try {
		await enqueueTurnProjectionJobs({
			storyId: input.storyId,
			eventIds,
			memoryNodeIds,
			patchIds,
			serverVersion: input.serverVersion,
			chapterDedupeKey: `chapter-summary-${input.assistantEntryId}`,
			memorySettings: input.memorySettings,
		});
	} catch (error) {
		warnings.push(`Queued projection jobs failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { eventIds, patchIds, memoryNodeIds, warnings };
}
