import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { readPlayerCapabilities } from '$lib/contracts/playerCapabilities';
import { readNpcAgency } from '$lib/contracts/npcAgency';
import { getDb } from '$lib/server/db/client';
import { loadLocationLore } from '$lib/server/memory/locationLore';
import { isNarrativeTimelineEvent } from '$lib/server/events/timeline';
import { appliedStrategicFrameForStory } from '$lib/services/ai/context/strategicFramePromptCard';
import {
	agreements,
	entities,
	entityAliases,
	factionGoals,
	factionMemberships,
	factionProjects,
	factionResources,
	factions,
	npcBeliefs,
	relationships,
	stories,
	storyEvents,
	storyThreads,
} from '$lib/server/db/schema';

type JsonRecord = Record<string, unknown>;
type EntityRow = typeof entities.$inferSelect;
type FactionRow = typeof factions.$inferSelect;

export interface EvidenceReceipt<T> {
	data: T;
	sourceIds: string[];
	warnings: string[];
	unresolved: string[];
	truncated: boolean;
}

export const actorBriefArgsSchema = z.object({
	actorId: z.string().min(1).optional(),
	name: z.string().min(1).optional(),
	currentTurn: z.number().int().nonnegative().optional(),
	eventLimit: z.number().int().min(1).max(30).default(8),
}).refine((value) => Boolean(value.actorId || value.name), 'actorId or name is required.');

/**
 * A deliberately narrower read than `actorBriefArgsSchema`. Actor-decision
 * workers must receive only this actor's beliefs, commitments, and witnessed
 * evidence; `buildActorBrief` is a GM-trusted diagnostic surface.
 */
export const actorDecisionViewArgsSchema = z.object({
	actorId: z.string().min(1),
	eventLimit: z.number().int().min(1).max(12).default(6),
});

export const sceneCheckArgsSchema = z.object({
	locationId: z.string().min(1).optional(),
	locationName: z.string().min(1).optional(),
	actorIds: z.array(z.string().min(1)).max(20).default([]),
	actorNames: z.array(z.string().min(1)).max(20).default([]),
	proposedTime: z.string().min(1).optional(),
	proposedAction: z.string().max(1200).optional(),
	availableMinutes: z.number().int().nonnegative().optional(),
});

export const relationshipWebArgsSchema = z.object({
	actorIds: z.array(z.string().min(1)).max(10).default([]),
	actorNames: z.array(z.string().min(1)).max(10).default([]),
	depth: z.union([z.literal(1), z.literal(2)]).default(1),
}).refine((value) => value.actorIds.length + value.actorNames.length > 0, 'At least one actor is required.');

export const affinityReadArgsSchema = z.object({
	actorIds: z.array(z.string().min(1)).max(20).default([]),
	actorNames: z.array(z.string().min(1)).max(20).default([]),
	historyLimit: z.number().int().min(0).max(12).default(5),
}).refine((value) => value.actorIds.length + value.actorNames.length > 0, 'At least one actor is required.');

export const threadBoardArgsSchema = z.object({
	query: z.string().max(600).optional(),
	actorIds: z.array(z.string().min(1)).max(20).default([]),
	factionIds: z.array(z.string().min(1)).max(20).default([]),
	locationId: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(20).default(12),
});

export type ActorBriefArgs = z.infer<typeof actorBriefArgsSchema>;
export type ActorDecisionViewArgs = z.infer<typeof actorDecisionViewArgsSchema>;
export type SceneCheckArgs = z.infer<typeof sceneCheckArgsSchema>;
export type RelationshipWebArgs = z.infer<typeof relationshipWebArgsSchema>;
export type AffinityReadArgs = z.infer<typeof affinityReadArgsSchema>;
export type ThreadBoardArgs = z.infer<typeof threadBoardArgsSchema>;

export interface GmToolData {
	story: typeof stories.$inferSelect;
	entities: EntityRow[];
	aliases: Array<typeof entityAliases.$inferSelect>;
	relationships: Array<typeof relationships.$inferSelect>;
	factions: FactionRow[];
	memberships: Array<typeof factionMemberships.$inferSelect>;
	resources: Array<typeof factionResources.$inferSelect>;
	goals: Array<typeof factionGoals.$inferSelect>;
	projects: Array<typeof factionProjects.$inferSelect>;
	beliefs: Array<typeof npcBeliefs.$inferSelect>;
	agreements: Array<typeof agreements.$inferSelect>;
	threads: Array<typeof storyThreads.$inferSelect>;
	events: Array<typeof storyEvents.$inferSelect>;
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function strings(value: unknown, limit = 20): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(-limit)
		: [];
}

function text(value: unknown, max = 800): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const clean = value.replace(/\s+/g, ' ').trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 3).trimEnd()}...`;
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function unique(values: Array<string | null | undefined>, limit = 200): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))].slice(0, limit);
}

function sources(...rows: Array<Record<string, unknown> | null | undefined>): string[] {
	return unique(rows.flatMap((row) => row ? [
		...strings(row.sourceEntryIds),
		...strings(row.sourceEventIds),
		...strings(row.sourcePatchIds),
		...(typeof row.id === 'string' && ('body' in row || 'belief' in row) ? [row.id] : []),
	] : []));
}

function pickedState(row: EntityRow): JsonRecord {
	const state = asRecord(row.state);
	const metadata = asRecord(row.metadata);
	const result: JsonRecord = readNpcAgency(state, metadata);
	const capabilities = state.playerCapabilities ?? metadata.playerCapabilities ?? asRecord(metadata.originalMetadata).playerCapabilities;
	if (capabilities !== undefined) result.playerCapabilities = readPlayerCapabilities(capabilities);
	for (const key of ['bio', 'appearance', 'personality', 'rank', 'currentLocation', 'currentLocationId', 'currentAction', 'emotionalState', 'currentDisposition', 'status', 'partyRole', 'nextOpportunityRecordedAt']) {
		const value = state[key] ?? metadata[key];
		const clean = text(value);
		if (clean) result[key] = clean;
	}
	for (const key of ['goals', 'motivations', 'knownFacts', 'pressures', 'traits', 'factionTags', 'injuries', 'wounds']) {
		const value = strings(state[key] ?? metadata[key], 12);
		if (value.length) result[key] = value;
	}
	for (const key of ['present', 'isPresent', 'partyMember', 'imprisoned', 'held']) {
		const value = state[key] ?? metadata[key];
		if (typeof value === 'boolean') result[key] = value;
	}
	const relationship = asRecord(state.relationship ?? metadata.relationship);
	if (Object.keys(relationship).length) result.relationship = relationship;
	return result;
}

function aliasMap(data: GmToolData): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (const row of data.aliases) result.set(row.entityId, [...(result.get(row.entityId) ?? []), row.alias]);
	return result;
}

type ResolvedActor = { kind: 'entity'; entity: EntityRow } | { kind: 'faction'; faction: FactionRow };

function resolveActor(data: GmToolData, idValue?: string, nameValue?: string): ResolvedActor | null {
	if (idValue) {
		const entity = data.entities.find((row) => row.id === idValue);
		if (entity) return { kind: 'entity', entity };
		const faction = data.factions.find((row) => row.id === idValue || row.entityId === idValue);
		if (faction) return { kind: 'faction', faction };
	}
	const wanted = normalize(nameValue ?? idValue ?? '');
	if (!wanted) return null;
	const aliases = aliasMap(data);
	const entity = data.entities.find((row) => normalize(row.name) === wanted
		|| (aliases.get(row.id) ?? []).some((alias) => normalize(alias) === wanted));
	if (entity) return { kind: 'entity', entity };
	const faction = data.factions.find((row) => normalize(row.name) === wanted);
	return faction ? { kind: 'faction', faction } : null;
}

function actorId(actor: ResolvedActor): string {
	return actor.kind === 'entity' ? actor.entity.id : actor.faction.id;
}

function actorName(actor: ResolvedActor): string {
	return actor.kind === 'entity' ? actor.entity.name : actor.faction.name;
}

function protagonistEntity(data: GmToolData): EntityRow | null {
	const settings = asRecord(data.story.settings);
	const metadata = asRecord(data.story.metadata);
	const configuredId = text(settings.playerEntityId ?? metadata.playerEntityId, 240);
	if (configuredId) {
		const configured = data.entities.find((row) => row.id === configuredId);
		if (configured) return configured;
	}
	return data.entities.find((row) => {
		if (row.type !== 'character') return false;
		const state = asRecord(row.state);
		const relationship = asRecord(state.relationship ?? asRecord(row.metadata).relationship);
		return state.relationship === 'self'
			|| relationship.status === 'self'
			|| relationship.status === 'player_character'
			|| state.isProtagonist === true;
	}) ?? null;
}

function affinityState(row: EntityRow, historyLimit: number): JsonRecord {
	const state = asRecord(row.state);
	const metadata = asRecord(row.metadata);
	const relationship = asRecord(state.relationship ?? metadata.relationship);
	const rawLevel = relationship.level;
	const level = typeof rawLevel === 'number' && Number.isFinite(rawLevel)
		? Math.max(-100, Math.min(100, rawLevel))
		: null;
	const historyValue = relationship.history;
	const rawHistory = Array.isArray(historyValue) ? historyValue : [];
	const history = (historyLimit === 0 ? [] : rawHistory.slice(-historyLimit)).map((item) => {
		const record = asRecord(item);
		return Object.fromEntries(Object.entries({
			description: text(record.description ?? record.event ?? record.reason, 500),
			delta: typeof record.delta === 'number' && Number.isFinite(record.delta) ? record.delta : null,
			entryId: text(record.entryId ?? record.entry_id, 240),
			turn: typeof record.turn === 'number' && Number.isFinite(record.turn) ? record.turn : null,
			timestamp: typeof record.timestamp === 'number' || typeof record.timestamp === 'string' ? record.timestamp : null,
		}).filter(([, value]) => value !== null));
	});
	return {
		level,
		status: text(relationship.status, 160),
		currentDisposition: text(state.currentDisposition ?? metadata.currentDisposition, 240),
		history,
		levelOutOfRange: typeof rawLevel === 'number' && Number.isFinite(rawLevel) && (rawLevel < -100 || rawLevel > 100),
		historyMalformed: (historyValue != null && !Array.isArray(historyValue))
			|| rawHistory.some((item) => Object.keys(asRecord(item)).length === 0),
	};
}

export function buildAffinityRead(data: GmToolData, rawArgs: AffinityReadArgs): EvidenceReceipt<JsonRecord> {
	const args = affinityReadArgsSchema.parse(rawArgs);
	const player = protagonistEntity(data);
	const unresolved: string[] = [];
	const warnings: string[] = [];
	const requested = [
		...args.actorIds.map((value) => ({ value, actor: resolveActor(data, value, undefined) })),
		...args.actorNames.map((value) => ({ value, actor: resolveActor(data, undefined, value) })),
	];
	const seen = new Set<string>();
	const actors = requested.flatMap(({ value, actor }) => {
		if (!actor) {
			unresolved.push(value);
			return [];
		}
		if (actor.kind !== 'entity' || actor.entity.type !== 'character') {
			warnings.push(`${actorName(actor)} is not a character; NPC affinity is unavailable.`);
			return [];
		}
		if (seen.has(actor.entity.id)) return [];
		seen.add(actor.entity.id);
			const affinity = affinityState(actor.entity, args.historyLimit);
			if (affinity.level === null) warnings.push(`${actor.entity.name} has no established numeric affinity; do not infer zero.`);
			if (affinity.levelOutOfRange === true) warnings.push(`${actor.entity.name}'s stored affinity is outside -100..100 and was clamped for this read; repair the canonical value.`);
			if (affinity.historyMalformed === true) warnings.push(`${actor.entity.name} has malformed affinity history entries.`);
		if (affinity.status && affinity.currentDisposition && normalize(String(affinity.status)) !== normalize(String(affinity.currentDisposition))) {
			warnings.push(`${actor.entity.name}'s relationship status and current disposition disagree; prefer the current disposition for portrayal and treat the score as numeric affinity only.`);
		}
			const { historyMalformed: _historyMalformed, levelOutOfRange: _levelOutOfRange, ...publicAffinity } = affinity;
		return [{
			actorId: actor.entity.id,
			actorName: actor.entity.name,
			...publicAffinity,
			sourceEntryIds: strings(actor.entity.sourceEntryIds),
		}];
	});
	if (!player) warnings.push('The player character could not be resolved; affinity remains actor-to-player by convention, but the target identity is unknown.');
	return {
		data: {
			player: player ? { id: player.id, name: player.name } : null,
			affinities: actors,
			scale: '-100 entrenched hostility, 0 neutral, +100 profound trust or attachment. An unestablished score is null, never zero.',
		},
		sourceIds: sources(player, ...requested.flatMap(({ actor }) => actor?.kind === 'entity' ? [actor.entity] : [])),
		warnings,
		unresolved: unique(unresolved),
		truncated: false,
	};
}

function factionForActor(data: GmToolData, actor: ResolvedActor): FactionRow[] {
	if (actor.kind === 'faction') return [actor.faction];
	const ids = data.memberships.filter((row) => row.entityId === actor.entity.id && row.status === 'active').map((row) => row.factionId);
	return data.factions.filter((row) => ids.includes(row.id));
}

function eventTurn(row: typeof storyEvents.$inferSelect): number {
	return row.occurredTurn ?? row.scheduledTurn ?? row.createdTurn;
}

function relevantEvents(data: GmToolData, entityIds: string[], factionIds: string[], limit = 16): Array<typeof storyEvents.$inferSelect> {
	return data.events.filter((row) => isNarrativeTimelineEvent(row) && (
		row.actorEntityIds.some((id) => entityIds.includes(id))
		|| row.targetEntityIds.some((id) => entityIds.includes(id))
		|| row.factionIds.some((id) => factionIds.includes(id))),
	).sort((a, b) => eventTurn(b) - eventTurn(a)).slice(0, limit);
}

function isOpenFactionProject(row: typeof factionProjects.$inferSelect): boolean {
	return !['completed', 'cancelled', 'closed'].includes(row.status.toLowerCase());
}

function actorDecisionState(row: EntityRow): JsonRecord {
	const state = asRecord(row.state);
	const metadata = asRecord(row.metadata);
	const result: JsonRecord = readNpcAgency(state, metadata);
	for (const key of ['bio', 'background', 'appearance', 'personality', 'speechStyle', 'currentLocation', 'currentLocationId', 'currentAction', 'emotionalState', 'currentDisposition', 'status', 'rank', 'partyRole']) {
		const value = text(state[key] ?? metadata[key], 500);
		if (value) result[key] = value;
	}
	for (const key of ['goals', 'motivations', 'pressures', 'traits', 'injuries', 'wounds']) {
		const value = strings(state[key] ?? metadata[key], 10);
		if (value.length) result[key] = value;
	}
	return result;
}

function publicVisibility(value: unknown): boolean {
	return value === 'public' || value === 'player_known' || value === 'known';
}

/**
 * Builds the only evidence packet that may be sent to an actor-decision model.
 * It intentionally does not reuse `buildActorBrief`: that GM surface can see
 * unrelated hidden events and faction records. An actor may see its own
 * beliefs, commitments, and events in which it was explicitly involved, plus
 * public faction context. Missing knowledge is represented as an omission,
 * never filled from narrator truth.
 */
export function buildActorDecisionView(data: GmToolData, rawArgs: ActorDecisionViewArgs): EvidenceReceipt<JsonRecord> {
	const args = actorDecisionViewArgsSchema.parse(rawArgs);
	const actor = data.entities.find((row) => row.id === args.actorId && row.type === 'character');
	if (!actor) throw new Error(`Character actor not found: ${args.actorId}`);
	if (asRecord(data.story.settings).playerEntityId === actor.id || asRecord(actor.state).isProtagonist === true)
		throw new Error('Player character cannot be an actor-decision subject.');
	const warnings: string[] = [];
	const beliefs = data.beliefs.filter((row) => row.believerEntityId === actor.id).slice(0, 16);
	const knownEventIds = new Set(beliefs.flatMap((row) => row.evidenceEventIds));
	const witnessedEvents = data.events
		.filter((row) => isNarrativeTimelineEvent(row) && (
			knownEventIds.has(row.id)
			|| row.actorEntityIds.includes(actor.id)
			|| row.targetEntityIds.includes(actor.id)
		))
		.sort((a, b) => eventTurn(b) - eventTurn(a))
		.slice(0, args.eventLimit);
	const memberships = data.memberships.filter((row) => row.entityId === actor.id && row.status === 'active');
	const factionIds = memberships.map((row) => row.factionId);
	const publicGoals = data.goals.filter((row) => factionIds.includes(row.factionId) && row.status !== 'closed' && publicVisibility(row.secrecy));
	const publicProjects = data.projects.filter((row) => factionIds.includes(row.factionId) && isOpenFactionProject(row) && publicVisibility(row.visibility));
	const publicResources = data.resources.filter((row) => factionIds.includes(row.factionId) && row.status === 'available' && publicVisibility(row.visibility));
	const relations = data.relationships.filter((row) => row.sourceEntityId === actor.id || row.targetEntityId === actor.id).slice(0, 16);
	const ownPartyKeys = new Set([actor.id, normalize(actor.name), ...factionIds]);
	const agreementsForActor = data.agreements.filter((row) => (row.status === 'active' || row.status === 'contested') && row.parties.some((party) => ownPartyKeys.has(party) || ownPartyKeys.has(normalize(party)))).slice(0, 12);
	const entityNames = new Map(data.entities.map((row) => [row.id, row.name]));
	const factionNames = new Map(data.factions.map((row) => [row.id, row.name]));
	if (beliefs.length === 0) warnings.push('No actor-belief records exist; do not infer private knowledge from narrator truth.');
	if (witnessedEvents.length === 0) warnings.push('No witnessed or belief-linked event is available for this actor.');
	return {
		data: {
			actor: { id: actor.id, name: actor.name, description: text(actor.description, 900), state: actorDecisionState(actor) },
			beliefs: beliefs.map((row) => ({ id: row.id, belief: text(row.belief, 650), confidence: row.confidence, subjectId: row.subjectEntityId, evidenceEventIds: row.evidenceEventIds })),
			witnessedEvents: witnessedEvents.map((row) => ({ id: row.id, title: row.title, body: text(row.body, 650), turn: eventTurn(row), role: row.actorEntityIds.includes(actor.id) ? 'actor' : row.targetEntityIds.includes(actor.id) ? 'target' : 'belief_evidence' })),
			relationships: relations.map((row) => {
				const otherId = row.sourceEntityId === actor.id ? row.targetEntityId : row.sourceEntityId;
				return { id: row.id, otherId, otherName: entityNames.get(otherId) ?? otherId, type: row.type, label: row.label, strength: row.strength, direction: row.sourceEntityId === actor.id ? 'outgoing' : 'incoming' };
			}),
			commitments: agreementsForActor.map((row) => ({ id: row.id, category: row.category, terms: text(row.terms, 650), status: row.status, consequences: strings(row.consequences, 8) })),
			publicFactionContext: {
				memberships: memberships.map((row) => ({ factionId: row.factionId, factionName: factionNames.get(row.factionId) ?? row.factionId, role: row.role, rank: row.rank })),
				goals: publicGoals.slice(0, 8).map((row) => ({ id: row.id, goal: row.goal, priority: row.priority })),
				projects: publicProjects.slice(0, 8).map((row) => ({ id: row.id, project: row.project, progress: row.progress, dueTurn: row.dueTurn, risks: strings(row.risks, 6) })),
				resources: publicResources.slice(0, 10).map((row) => ({ id: row.id, kind: row.kind, name: row.name, amount: row.amount, locationId: row.locationId })),
			},
			knowledgeBoundary: 'Use only the beliefs, witnessed events, personal commitments, relationships, and public faction context in this packet. Absence is uncertainty, not permission to infer a secret or another actor\'s plan.',
		},
		sourceIds: sources(actor, ...beliefs, ...witnessedEvents, ...relations, ...memberships, ...publicGoals, ...publicProjects, ...publicResources, ...agreementsForActor),
		warnings,
		unresolved: beliefs.length === 0 && witnessedEvents.length === 0 ? ['No supported personal knowledge beyond the actor profile.'] : [],
		truncated: beliefs.length >= 16 || witnessedEvents.length >= args.eventLimit || relations.length >= 16 || agreementsForActor.length >= 12,
	};
}

export function buildActorBrief(data: GmToolData, rawArgs: ActorBriefArgs): EvidenceReceipt<JsonRecord> {
	const args = actorBriefArgsSchema.parse(rawArgs);
	const actor = resolveActor(data, args.actorId, args.name);
	if (!actor) throw new Error(`Actor not found: ${args.actorId ?? args.name}`);
	const warnings: string[] = [];
	const entityId = actor.kind === 'entity' ? actor.entity.id : actor.faction.entityId;
	const actorFactions = factionForActor(data, actor);
	const factionIds = actorFactions.map((row) => row.id);
	const relationRows = entityId ? data.relationships.filter((row) => row.sourceEntityId === entityId || row.targetEntityId === entityId) : [];
	const beliefRows = entityId ? data.beliefs.filter((row) => row.believerEntityId === entityId) : [];
	const agreementRows = data.agreements.filter((row) => (row.status === 'active' || row.status === 'contested') && row.parties.some((party) => {
		const key = normalize(party);
		return key === normalize(actorId(actor)) || key === normalize(actorName(actor)) || factionIds.some((id) => normalize(id) === key);
	}));
	const events = relevantEvents(data, entityId ? [entityId] : [], factionIds, args.eventLimit);
	const goals = data.goals.filter((row) => factionIds.includes(row.factionId) && row.status !== 'closed');
	const projects = data.projects.filter((row) => factionIds.includes(row.factionId) && isOpenFactionProject(row));
	const resources = data.resources.filter((row) => factionIds.includes(row.factionId) && row.status === 'available');
	const entityNames = new Map(data.entities.map((row) => [row.id, row.name]));
	const factionNames = new Map(data.factions.map((row) => [row.id, row.name]));
	if (actor.kind === 'entity' && beliefRows.length === 0) warnings.push('No explicit actor-belief records exist; do not promote narrator truth into this actor\'s knowledge.');

	const dataResult: JsonRecord = {
		actor: actor.kind === 'entity' ? {
			id: actor.entity.id,
			kind: actor.entity.type,
			name: actor.entity.name,
			description: text(actor.entity.description, 1200),
			status: actor.entity.status,
			visibility: actor.entity.visibility,
			state: pickedState(actor.entity),
		} : {
			id: actor.faction.id,
			kind: 'faction',
			name: actor.faction.name,
			pressure: actor.faction.pressure,
			goals: actor.faction.goals,
			resources: actor.faction.resources,
			territoryIds: actor.faction.territoryIds,
			allies: actor.faction.allies,
			enemies: actor.faction.enemies,
		},
		beliefs: beliefRows.slice(0, 16).map((row) => ({
			belief: text(row.belief, 700),
			confidence: row.confidence,
			subjectId: row.subjectEntityId,
			subjectName: row.subjectEntityId ? entityNames.get(row.subjectEntityId) ?? null : null,
			evidenceEventIds: row.evidenceEventIds,
		})),
		relationships: relationRows.slice(0, 20).map((row) => {
			const otherId = row.sourceEntityId === entityId ? row.targetEntityId : row.sourceEntityId;
			return {
				id: row.id,
				direction: row.sourceEntityId === entityId ? 'outgoing' : 'incoming',
				otherId,
				otherName: entityNames.get(otherId) ?? otherId,
				type: row.type,
				label: row.label,
				strength: row.strength,
				bidirectional: row.bidirectional,
			};
		}),
		factions: actorFactions.map((row) => ({
			id: row.id,
			name: row.name,
			pressure: row.pressure,
			membership: entityId ? data.memberships.find((membership) => membership.factionId === row.id && membership.entityId === entityId) ?? null : null,
		})),
		goals: goals.slice(0, 12).map((row) => ({ id: row.id, faction: factionNames.get(row.factionId), goal: row.goal, priority: row.priority, secrecy: row.secrecy })),
		projects: projects.slice(0, 12).map((row) => ({ id: row.id, faction: factionNames.get(row.factionId), project: row.project, status: row.status, progress: row.progress, dueTurn: row.dueTurn, risks: row.risks })),
		resources: resources.slice(0, 16).map((row) => ({ id: row.id, faction: factionNames.get(row.factionId), kind: row.kind, name: row.name, amount: row.amount, locationId: row.locationId })),
		agreements: agreementRows.slice(0, 12).map((row) => ({ id: row.id, category: row.category, parties: row.parties, terms: text(row.terms, 700), status: row.status, secrecy: row.secrecy, consequences: row.consequences })),
		recentEvents: events.map((row) => ({ id: row.id, type: row.type, status: row.status, title: row.title, body: text(row.body, 700), turn: eventTurn(row), visibility: row.visibility })),
		availableLevers: unique([
			...goals.map((row) => row.goal),
			...projects.map((row) => row.project),
			...resources.map((row) => row.name),
			...agreementRows.map((row) => `${row.category}: ${row.terms}`),
		], 24),
		knowledgeBoundary: 'Beliefs are actor knowledge. Events and other canon are narrator truth unless the actor perceived or learned them.',
	};
	return {
		data: dataResult,
		sourceIds: sources(
			actor.kind === 'entity' ? actor.entity : actor.faction,
			...beliefRows,
			...relationRows,
			...actorFactions,
			...goals,
			...projects,
			...resources,
			...agreementRows,
			...events,
		),
		warnings,
		unresolved: [],
		truncated: relationRows.length > 20 || beliefRows.length > 16 || events.length >= args.eventLimit,
	};
}

function resolveLocation(data: GmToolData, idValue?: string, nameValue?: string): EntityRow | null {
	const wanted = normalize(nameValue ?? idValue ?? '');
	return data.entities.find((row) => row.type === 'location' && (
		(idValue && row.id === idValue) || normalize(row.name) === wanted
	)) ?? null;
}

function currentLocationValue(data: GmToolData, row: EntityRow): string | null {
	const state = asRecord(row.state);
	const metadata = asRecord(row.metadata);
	const direct = text(state.currentLocationId ?? state.currentLocation ?? metadata.currentLocationId ?? metadata.currentLocation, 240);
	if (direct) return direct;
	const relationship = asRecord(state.relationship ?? metadata.relationship);
	return relationship.status === 'self' || relationship.status === 'player_character' ? data.story.currentLocationId : null;
}

function connectionRows(location: EntityRow): Array<{ target: string; travelTime: number; blocked: boolean; blockedReason: string | null }> {
	const raw = asRecord(location.state).connections;
	if (!Array.isArray(raw)) return [];
	return raw.map((value) => asRecord(value)).map((value) => ({
		target: text(value.targetLocationId ?? value.targetLocationName, 240) ?? '',
		travelTime: typeof value.travelTime === 'number' && value.travelTime >= 0 ? value.travelTime : 0,
		blocked: value.blocked === true,
		blockedReason: text(value.blockedReason, 300),
	})).filter((value) => value.target);
}

function travelPath(data: GmToolData, fromValue: string, target: EntityRow): { path: string[]; travelTime: number } | null {
	const start = resolveLocation(data, fromValue, fromValue);
	if (!start) return null;
	if (start.id === target.id) return { path: [start.name], travelTime: 0 };
	const queue = [{ location: start, path: [start.name], travelTime: 0 }];
	const seen = new Set([start.id]);
	while (queue.length && seen.size <= 100) {
		const current = queue.shift()!;
		for (const connection of connectionRows(current.location)) {
			if (connection.blocked) continue;
			const next = resolveLocation(data, connection.target, connection.target);
			if (!next || seen.has(next.id)) continue;
			const result = { location: next, path: [...current.path, next.name], travelTime: current.travelTime + connection.travelTime };
			if (next.id === target.id) return { path: result.path, travelTime: result.travelTime };
			seen.add(next.id);
			queue.push(result);
		}
	}
	return null;
}

export function buildSceneCheck(data: GmToolData, rawArgs: SceneCheckArgs): EvidenceReceipt<JsonRecord> {
	const args = sceneCheckArgsSchema.parse(rawArgs);
	const target = resolveLocation(data, args.locationId, args.locationName)
		?? (data.story.currentLocationId ? resolveLocation(data, data.story.currentLocationId, data.story.currentLocationId) : null);
	const unresolved: string[] = [];
	if (!target) unresolved.push(args.locationId ?? args.locationName ?? 'current location');
	const actors = [
		...args.actorIds.map((id) => resolveActor(data, id, undefined)),
		...args.actorNames.map((name) => resolveActor(data, undefined, name)),
	].filter((actor): actor is ResolvedActor => Boolean(actor));
	for (const value of [...args.actorIds, ...args.actorNames]) {
		if (!resolveActor(data, value, value)) unresolved.push(value);
	}
	const constraints: JsonRecord[] = [];
	const actorChecks = actors.map((actor) => {
		if (actor.kind === 'faction') return { id: actor.faction.id, name: actor.faction.name, kind: 'faction', reachability: 'unknown', reason: 'A faction requires named agents to attend a scene.' };
		const state = asRecord(actor.entity.state);
		const status = text(state.status, 80) ?? actor.entity.status;
		const currentLocation = currentLocationValue(data, actor.entity);
		const hardUnavailable = ['deceased', 'departed', 'inactive'].includes(status) || state.imprisoned === true || state.held === true;
		const path = target && currentLocation && !hardUnavailable ? travelPath(data, currentLocation, target) : null;
		const sameLocation = Boolean(target && currentLocation && (normalize(currentLocation) === normalize(target.id) || normalize(currentLocation) === normalize(target.name)));
		const tooFar = Boolean(path && args.availableMinutes !== undefined && path.travelTime > args.availableMinutes);
		const injuries = [...strings(state.injuries, 8), ...strings(state.wounds, 8)];
		if (hardUnavailable || injuries.length) constraints.push({ actorId: actor.entity.id, status, injuries, imprisoned: state.imprisoned === true, held: state.held === true });
		return {
			id: actor.entity.id,
			name: actor.entity.name,
			kind: actor.entity.type,
			status,
			currentLocation,
			reachability: hardUnavailable || tooFar ? 'no' : sameLocation || path ? 'yes' : 'unknown',
			path: sameLocation ? [target?.name] : path?.path ?? [],
			travelTime: sameLocation ? 0 : path?.travelTime ?? null,
			availableMinutes: args.availableMinutes ?? null,
			reason: hardUnavailable ? `Actor status is ${status}.` : tooFar ? 'Known travel time exceeds the available scene window.' : null,
			constraints: injuries,
		};
	});
	const relatedEvents = relevantEvents(data, actors.flatMap((actor) => actor.kind === 'entity' ? [actor.entity.id] : []), actors.flatMap((actor) => factionForActor(data, actor).map((row) => row.id)), 12);
	const warnings = [
		...(target ? [] : ['Target location is unresolved.']),
		...(actorChecks.some((row) => row.reachability === 'unknown') ? ['Unknown reachability means the location graph or actor location lacks enough evidence; do not invent travel time.'] : []),
		...(args.proposedTime && args.proposedTime !== data.story.currentWorldTime ? ['Proposed time is descriptive only; the scene checker does not invent calendar arithmetic.'] : []),
	];
	return {
		data: {
			storyClock: { currentTurn: data.story.currentTurn, currentWorldTime: data.story.currentWorldTime },
			targetLocation: target ? { id: target.id, name: target.name, description: text(target.description, 900), state: pickedState(target) } : null,
			proposedTime: args.proposedTime ?? null,
			proposedAction: text(args.proposedAction, 1200),
			availableMinutes: args.availableMinutes ?? null,
			actors: actorChecks,
			constraints,
			relatedEvents: relatedEvents.map((row) => ({ id: row.id, title: row.title, status: row.status, turn: eventTurn(row), locationIds: unique([row.locationId, ...row.locationIds]) })),
		},
		sourceIds: sources(target, ...actors.map((actor) => actor.kind === 'entity' ? actor.entity : actor.faction), ...relatedEvents),
		warnings,
		unresolved: unique(unresolved),
		truncated: actors.length >= 20 || relatedEvents.length >= 12,
	};
}

function nodeForActor(actor: ResolvedActor): JsonRecord {
	return actor.kind === 'entity'
		? { id: actor.entity.id, name: actor.entity.name, kind: actor.entity.type, status: actor.entity.status, visibility: actor.entity.visibility, playerAffinity: actor.entity.type === 'character' ? affinityState(actor.entity, 3) : null }
		: { id: actor.faction.id, name: actor.faction.name, kind: 'faction', pressure: actor.faction.pressure };
}

export function buildRelationshipWeb(data: GmToolData, rawArgs: RelationshipWebArgs): EvidenceReceipt<JsonRecord> {
	const args = relationshipWebArgsSchema.parse(rawArgs);
	const unresolved: string[] = [];
	const seeds = unique([...args.actorIds, ...args.actorNames]).map((value) => {
		const actor = resolveActor(data, value, value);
		if (!actor) unresolved.push(value);
		return actor;
	}).filter((actor): actor is ResolvedActor => Boolean(actor));
	if (!seeds.length) throw new Error('No relationship-web seed actors could be resolved.');
	const actorById = new Map<string, ResolvedActor>();
	for (const row of data.entities) actorById.set(row.id, { kind: 'entity', entity: row });
	for (const row of data.factions) actorById.set(row.id, { kind: 'faction', faction: row });
	const edges: JsonRecord[] = [];
	for (const row of data.relationships) edges.push({
		id: row.id, sourceId: row.sourceEntityId, targetId: row.targetEntityId, type: row.type,
		label: row.label, strength: row.strength, bidirectional: row.bidirectional, evidenceIds: sources(row),
	});
	for (const row of data.memberships.filter((row) => row.status === 'active' && row.entityId)) edges.push({
		id: row.id, sourceId: row.entityId, targetId: row.factionId, type: 'faction_membership', label: row.role,
		strength: 0.7, bidirectional: true, evidenceIds: sources(row), rank: row.rank, visibility: row.visibility,
	});
	for (const row of data.agreements.filter((row) => row.status === 'active')) {
		const parties = row.parties.map((party) => resolveActor(data, party, party)).filter((actor): actor is ResolvedActor => Boolean(actor));
		for (let index = 0; index < parties.length; index += 1) for (let other = index + 1; other < parties.length; other += 1) edges.push({
			id: `${row.id}:${index}:${other}`, sourceId: actorId(parties[index]), targetId: actorId(parties[other]), type: `agreement:${row.category}`,
			label: text(row.terms, 300), strength: 0.6, bidirectional: true, evidenceIds: sources(row), secrecy: row.secrecy,
		});
	}
	const reached = new Set(seeds.map(actorId));
	let frontier = [...reached];
	for (let depth = 0; depth < args.depth && frontier.length; depth += 1) {
		const next: string[] = [];
		for (const edge of edges) {
			const sourceId = String(edge.sourceId);
			const targetId = String(edge.targetId);
			if (frontier.includes(sourceId) && !reached.has(targetId)) next.push(targetId);
			if (frontier.includes(targetId) && !reached.has(sourceId)) next.push(sourceId);
		}
		for (const id of unique(next, 30 - reached.size)) reached.add(id);
		frontier = unique(next).filter((id) => reached.has(id));
		if (reached.size >= 30) break;
	}
	const includedEdges = edges.filter((edge) => reached.has(String(edge.sourceId)) && reached.has(String(edge.targetId))).slice(0, 60);
	const nodes = [...reached].map((id) => actorById.get(id)).filter((actor): actor is ResolvedActor => Boolean(actor)).map(nodeForActor);
	return {
		data: { seeds: seeds.map(actorId), depth: args.depth, nodes, edges: includedEdges },
		sourceIds: unique(includedEdges.flatMap((edge) => strings(edge.evidenceIds))),
		warnings: reached.size >= 30 ? ['Relationship web hit the 30-node safety limit.'] : [],
		unresolved: unique(unresolved),
		truncated: reached.size >= 30 || includedEdges.length >= 60,
	};
}

function queryWords(value: string | undefined): string[] {
	return normalize(value ?? '').split(' ').filter((word) => word.length >= 3);
}

export function buildThreadBoard(data: GmToolData, rawArgs: ThreadBoardArgs): EvidenceReceipt<JsonRecord> {
	const args = threadBoardArgsSchema.parse(rawArgs);
	const words = queryWords(args.query);
	const entityNames = new Map(data.entities.map((row) => [row.id, row.name]));
	const factionNames = new Map(data.factions.map((row) => [row.id, row.name]));
	const scored = data.threads.filter((row) => row.status !== 'closed').map((thread) => {
		const threadEvents = data.events.filter((event) => isNarrativeTimelineEvent(event) && (event.threadIds.includes(thread.id)
			|| event.actorEntityIds.some((id) => thread.relatedEntityIds.includes(id))
			|| event.targetEntityIds.some((id) => thread.relatedEntityIds.includes(id))
			|| event.factionIds.some((id) => thread.relatedFactionIds.includes(id))));
		const relatedProjects = data.projects.filter((project) => thread.relatedFactionIds.includes(project.factionId) && isOpenFactionProject(project));
		const haystack = normalize([
			thread.description,
			...thread.relatedEntityIds.map((id) => entityNames.get(id) ?? id),
			...thread.relatedFactionIds.map((id) => factionNames.get(id) ?? id),
		].join(' '));
		let score = thread.significance === 'critical' ? 50 : thread.significance === 'major' ? 30 : 10;
		score += words.filter((word) => haystack.includes(word)).length * 15;
		score += thread.relatedEntityIds.filter((id) => args.actorIds.includes(id)).length * 20;
		score += thread.relatedFactionIds.filter((id) => args.factionIds.includes(id)).length * 20;
		score += threadEvents.filter((event) => args.locationId && (event.locationId === args.locationId || event.locationIds.includes(args.locationId))).length * 15;
		const latest = [...threadEvents].sort((a, b) => eventTurn(b) - eventTurn(a))[0] ?? null;
		const due = threadEvents.filter((event) => ['due', 'scheduled'].includes(event.status)).sort((a, b) => eventTurn(a) - eventTurn(b));
		return { thread, threadEvents, relatedProjects, latest, due, score };
	}).sort((a, b) => b.score - a.score).slice(0, args.limit);
	const board = scored.map(({ thread, relatedProjects, latest, due }) => ({
		id: thread.id,
		description: text(thread.description, 900),
		status: thread.status,
		significance: thread.significance,
		actors: thread.relatedEntityIds.map((id) => ({ id, name: entityNames.get(id) ?? id })),
		factions: thread.relatedFactionIds.map((id) => ({ id, name: factionNames.get(id) ?? id })),
		lastMovement: latest ? { id: latest.id, title: latest.title, status: latest.status, turn: eventTurn(latest) } : null,
		dueEvents: due.slice(0, 5).map((event) => ({ id: event.id, title: event.title, status: event.status, turn: eventTurn(event) })),
		projects: relatedProjects.slice(0, 6).map((project) => ({ id: project.id, faction: factionNames.get(project.factionId), project: project.project, status: project.status, progress: project.progress, dueTurn: project.dueTurn })),
		dormant: latest === null,
	}));
	const collisions: JsonRecord[] = [];
	for (let index = 0; index < board.length; index += 1) for (let other = index + 1; other < board.length; other += 1) {
		const left = scored[index].thread;
		const right = scored[other].thread;
		const sharedActors = left.relatedEntityIds.filter((id) => right.relatedEntityIds.includes(id));
		const sharedFactions = left.relatedFactionIds.filter((id) => right.relatedFactionIds.includes(id));
		if (sharedActors.length || sharedFactions.length) collisions.push({ threadIds: [left.id, right.id], sharedActors, sharedFactions });
		if (collisions.length >= 12) break;
	}
	const lastFrame = appliedStrategicFrameForStory(data.story.id, data.story.currentTurn, data.story.metadata);
	return {
		data: {
			threads: board,
			collisions,
			plotDirector: lastFrame ? {
				publicSummary: text(lastFrame.publicSummary, 700),
				activationPlan: lastFrame.activationPlan,
			} : null,
		},
		sourceIds: sources(...scored.flatMap(({ thread, threadEvents, relatedProjects }) => [thread, ...threadEvents, ...relatedProjects])),
		warnings: [],
		unresolved: [],
		truncated: scored.length >= args.limit || collisions.length >= 12,
	};
}

export async function loadGmToolData(storyId: string): Promise<GmToolData> {
	const db = getDb();
	const [storyRows, entityRows, aliasRows, relationshipRows, factionRows, membershipRows, resourceRows, goalRows, projectRows, beliefRows, agreementRows, threadRows, eventRows] = await Promise.all([
		db.select().from(stories).where(eq(stories.id, storyId)).limit(1),
		db.select().from(entities).where(eq(entities.storyId, storyId)),
		db.select().from(entityAliases).where(eq(entityAliases.storyId, storyId)),
		db.select().from(relationships).where(eq(relationships.storyId, storyId)),
		db.select().from(factions).where(eq(factions.storyId, storyId)),
		db.select().from(factionMemberships).where(eq(factionMemberships.storyId, storyId)),
		db.select().from(factionResources).where(eq(factionResources.storyId, storyId)),
		db.select().from(factionGoals).where(eq(factionGoals.storyId, storyId)),
		db.select().from(factionProjects).where(eq(factionProjects.storyId, storyId)),
		db.select().from(npcBeliefs).where(eq(npcBeliefs.storyId, storyId)),
		db.select().from(agreements).where(eq(agreements.storyId, storyId)),
		db.select().from(storyThreads).where(eq(storyThreads.storyId, storyId)),
		db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId)).orderBy(desc(storyEvents.updatedAt)),
	]);
	if (!storyRows[0]) throw new Error(`Story not found: ${storyId}`);
	return {
		story: storyRows[0], entities: entityRows, aliases: aliasRows, relationships: relationshipRows,
		factions: factionRows, memberships: membershipRows, resources: resourceRows, goals: goalRows,
		projects: projectRows, beliefs: beliefRows, agreements: agreementRows, threads: threadRows, events: eventRows,
	};
}

export async function getActorBrief(storyId: string, args: ActorBriefArgs): Promise<EvidenceReceipt<JsonRecord>> {
	return buildActorBrief(await loadGmToolData(storyId), actorBriefArgsSchema.parse(args));
}

export async function getActorDecisionView(storyId: string, args: ActorDecisionViewArgs): Promise<EvidenceReceipt<JsonRecord>> {
	return buildActorDecisionView(await loadGmToolData(storyId), actorDecisionViewArgsSchema.parse(args));
}

export async function checkScene(storyId: string, args: SceneCheckArgs): Promise<EvidenceReceipt<JsonRecord>> {
	const data = await loadGmToolData(storyId);
	const result = buildSceneCheck(data, sceneCheckArgsSchema.parse(args));
	const target = asRecord(result.data.targetLocation);
	const lore = await loadLocationLore({ storyId, locationId: typeof target.id === 'string' ? target.id : null, atTurn: data.story.currentTurn });
	return { ...result, data: { ...result.data, locationLore: lore }, warnings: [...result.warnings, ...lore.warnings],
		truncated: result.truncated || lore.incomplete,
		sourceIds: unique([...result.sourceIds, ...lore.chain.flatMap(place => place.sourceEntryIds), ...lore.facts.flatMap(fact => [...fact.sourceEntryIds, ...fact.sourceEventIds, ...fact.sourcePatchIds])]),
	};
}

export async function getRelationshipWeb(storyId: string, args: RelationshipWebArgs): Promise<EvidenceReceipt<JsonRecord>> {
	return buildRelationshipWeb(await loadGmToolData(storyId), relationshipWebArgsSchema.parse(args));
}

export async function readAffinity(storyId: string, args: AffinityReadArgs): Promise<EvidenceReceipt<JsonRecord>> {
	return buildAffinityRead(await loadGmToolData(storyId), affinityReadArgsSchema.parse(args));
}

export async function getThreadBoard(storyId: string, args: ThreadBoardArgs): Promise<EvidenceReceipt<JsonRecord>> {
	return buildThreadBoard(await loadGmToolData(storyId), threadBoardArgsSchema.parse(args));
}
