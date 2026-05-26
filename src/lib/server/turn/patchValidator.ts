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
	factionResources,
	memoryNodes,
	npcBeliefs,
	relationships,
	statePatches,
	stories,
	storyEvents,
} from '$lib/server/db/schema';
import { enqueueTurnProjectionJobs } from '$lib/server/jobs/outbox';
import { worldStateUpdateSchema, type WorldStateUpdate } from '$lib/services/ai/tools/schemas';

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

const TYPE_PREFIX_RE = /^(?:lore|item|character|house|group|organization|organisation|faction|location|concept|event|general lore|general history)\s*:\s+/i;
const LEADING_TITLE_RE = /^(?:(?:the|a|an|lord|lady|ser|sir|king|queen|prince|princess|duke|duchess|baron|baroness|count|countess|captain|commander|general|maester|archmaester|master|mistress|brother|sister|father|mother|high priest|high priestess|priest|priestess|saint|house|clan|guild|order)\s+)+/i;

function lookupKey(value: string): string {
	return value
		.normalize('NFKD')
		.replace(TYPE_PREFIX_RE, '')
		.replace(/[\u2019']/g, '')
		.replace(/[^a-zA-Z0-9]+/g, ' ')
		.trim()
		.toLowerCase()
		.replace(LEADING_TITLE_RE, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
		: [];
}

function mergeStrings(...groups: string[][]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of groups.flat()) {
		const clean = value.trim();
		const key = normalizeName(clean);
		if (!clean || seen.has(key)) continue;
		seen.add(key);
		out.push(clean);
	}
	return out;
}

function aliasId(entityId: string, alias: string): string {
	const key = normalizeName(alias).replace(/\s+/g, '_').slice(0, 80) || 'name';
	return `alias_${entityId}_${key}`;
}

function sourceIds(...values: Array<string | null | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
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

async function findEntityByName(storyId: string, name: string, type?: string): Promise<typeof entities.$inferSelect | null> {
	const db = getDb();
	const rows = await db
		.select()
		.from(entities)
		.where(eq(entities.storyId, storyId))
		.limit(500);
	const normalized = normalizeName(name);
	const key = lookupKey(name);
	const candidates = type ? rows.filter((row) => row.type === type) : rows;
	const exact = candidates.find((row) => row.name === name)
		?? candidates.find((row) => normalizeName(row.name) === normalized)
		?? candidates.find((row) => lookupKey(row.name) === key)
		?? candidates.find((row) => {
			const state = asRecord(row.state);
			const aliases = [
				...asStringArray(state.aliases),
				...asStringArray(state.alternateNames),
			];
			return aliases.some((alias) => normalizeName(alias) === normalized || lookupKey(alias) === key);
		});
	if (exact) return exact;

	const aliasRows = await db
		.select({ entityId: entityAliases.entityId })
		.from(entityAliases)
		.where(and(eq(entityAliases.storyId, storyId), eq(entityAliases.normalizedAlias, normalized)))
		.limit(20);
	const aliasEntityIds = new Set(aliasRows.map((row) => row.entityId));
	return candidates.find((row) => aliasEntityIds.has(row.id))
		?? rows.find((row) => aliasEntityIds.has(row.id))
		?? null;
}

async function persistEntityAliases(
	storyId: string,
	entityId: string,
	aliases: string[],
	sourceEntryIds: string[],
	serverVersion: number,
	createdAt: string,
): Promise<void> {
	const normalizedAliases = mergeStrings(aliases)
		.map((alias) => ({ alias, normalizedAlias: normalizeName(alias) }))
		.filter((alias) => alias.normalizedAlias);
	for (const alias of normalizedAliases) {
		await getDb().insert(entityAliases).values({
			id: aliasId(entityId, alias.alias),
			storyId,
			entityId,
			alias: alias.alias,
			normalizedAlias: alias.normalizedAlias,
			sourceEntryIds,
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		}).onConflictDoUpdate({
			target: entityAliases.id,
			set: {
				alias: alias.alias,
				normalizedAlias: alias.normalizedAlias,
				sourceEntryIds,
				serverVersion,
				updatedAt: createdAt,
			},
		});
	}
}

async function syncCharacterFactionTags(
	storyId: string,
	entityId: string,
	tags: string[],
	sourceEntryIds: string[],
	sourcePatchIds: string[],
	serverVersion: number,
	createdAt: string,
): Promise<string[]> {
	const cleanTags = mergeStrings(tags);
	if (cleanTags.length === 0) return [];
	const db = getDb();
	const factionRows = await db.select().from(factions).where(eq(factions.storyId, storyId)).limit(300);
	const tagAliases = cleanTags.map(normalizeName).filter(Boolean);
	const aliasRows = tagAliases.length > 0
		? await db
			.select({ entityId: entityAliases.entityId, normalizedAlias: entityAliases.normalizedAlias })
			.from(entityAliases)
			.where(and(eq(entityAliases.storyId, storyId), inArray(entityAliases.normalizedAlias, tagAliases)))
			.limit(100)
		: [];
	const aliasEntityIdsByName = new Map(aliasRows.map((row) => [row.normalizedAlias, row.entityId]));
	const unresolved: string[] = [];

	for (const tag of cleanTags) {
		const normalized = normalizeName(tag);
		const key = lookupKey(tag);
		const aliasEntityId = aliasEntityIdsByName.get(normalized);
		const faction = factionRows.find((row) =>
			row.id === tag ||
			row.entityId === tag ||
			row.entityId === aliasEntityId ||
			normalizeName(row.name) === normalized ||
			lookupKey(row.name) === key
		);
		if (!faction) {
			unresolved.push(tag);
			continue;
		}
		await db.insert(factionMemberships).values({
			id: `${faction.id}_member_${entityId}`,
			storyId,
			factionId: faction.id,
			entityId,
			role: 'member',
			rank: null,
			status: 'active',
			visibility: 'player_known',
			metadata: { factionTag: tag },
			sourceEntryIds,
			sourceEventIds: [],
			sourcePatchIds,
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		}).onConflictDoUpdate({
			target: factionMemberships.id,
			set: {
				status: 'active',
				entityId,
				metadata: { factionTag: tag },
				sourceEntryIds,
				sourcePatchIds,
				serverVersion,
				updatedAt: createdAt,
			},
		});
		const memberEntityIds = mergeStrings(asStringArray(faction.memberEntityIds), [entityId]);
		await db.update(factions).set({
			memberEntityIds,
			sourcePatchIds,
			serverVersion,
			updatedAt: createdAt,
		}).where(eq(factions.id, faction.id));
	}

	return unresolved;
}

async function upsertEntity(
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
	aliases: string[] = [],
): Promise<string> {
	const existing = await findEntityByName(storyId, name, type);
	const entityId = existing?.id ?? id('entity');
	const existingState = asRecord(existing?.state);
	const nextState = { ...existingState, ...state };
	const mergedAliases = mergeStrings(asStringArray(existingState.aliases), aliases, asStringArray(state.aliases), [name]);
	if (mergedAliases.length > 0) nextState.aliases = mergedAliases;
	const incomingFactionTags = mergeStrings(asStringArray(state.factionTags), asStringArray(state.faction_tags), asStringArray(state.involvedFactions));
	if (incomingFactionTags.length > 0) {
		nextState.factionTags = mergeStrings(asStringArray(existingState.factionTags), incomingFactionTags);
	}
	await getDb().insert(entities).values({
		id: entityId,
		storyId,
		type,
		name,
		description: description ?? existing?.description ?? null,
		status: String(state.status ?? existing?.status ?? 'active'),
		visibility: 'player_known',
		state: nextState,
		metadata: {},
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
			sourceEntryIds: sourceIds(...(existing?.sourceEntryIds ?? []), ...sourceEntryIds),
			sourceEventIds: sourceIds(...(existing?.sourceEventIds ?? []), ...sourceEventIds),
			sourcePatchIds: sourceIds(...(existing?.sourcePatchIds ?? []), ...sourcePatchIds),
			serverVersion,
			updatedAt: createdAt,
		},
	});
	await persistEntityAliases(
		storyId,
		entityId,
		mergedAliases,
		sourceIds(...(existing?.sourceEntryIds ?? []), ...sourceEntryIds),
		serverVersion,
		createdAt,
	);
	return entityId;
}

function makeOperations(update: WorldStateUpdate): Array<Record<string, unknown>> {
	const operations: Array<Record<string, unknown>> = [];
	if (update.player_reputation !== undefined) operations.push({ op: 'replace', path: '/stories/playerReputation', value: update.player_reputation });
	if (update.player_ledger !== undefined) operations.push({ op: 'replace', path: '/stories/playerLedger', value: update.player_ledger });
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

export interface ApplyTurnUpdateInput {
	storyId: string;
	playerEntryId: string;
	assistantEntryId: string;
	narration: string;
	update: WorldStateUpdate;
	parseWarnings: string[];
	retrievedMemoryIds: string[];
	serverVersion: number;
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
	const warnings = [...input.parseWarnings];
	const operations = makeOperations(input.update);
	const patchId = id('patch');

	await db.insert(statePatches).values({
		id: patchId,
		storyId: input.storyId,
		operations,
		reason: 'Server turn structured update.',
		status: input.parseWarnings.length > 0 ? 'needs_repair' : 'applied',
		validationWarnings: input.parseWarnings,
		sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
		sourceEventIds: [],
		serverVersion: input.serverVersion,
		createdAt,
		updatedAt: createdAt,
	});

	if (input.update.player_reputation !== undefined || input.update.player_ledger !== undefined) {
		const [story] = await db.select().from(stories).where(eq(stories.id, input.storyId)).limit(1);
		const metadata = story?.metadata && typeof story.metadata === 'object' ? story.metadata as Record<string, unknown> : {};
		const metadataPatch: Record<string, unknown> = {};
		if (input.update.player_reputation !== undefined) metadataPatch.playerReputation = input.update.player_reputation;
		if (input.update.player_ledger !== undefined) metadataPatch.playerLedger = input.update.player_ledger;
		await db.update(stories).set({
			metadata: { ...metadata, ...metadataPatch },
			serverVersion: input.serverVersion,
			updatedAt: createdAt,
		}).where(eq(stories.id, input.storyId));
	}

	const turnEventId = id('event');
	await db.insert(storyEvents).values({
		id: turnEventId,
		storyId: input.storyId,
		type: 'scene_transition',
		title: 'Turn resolved',
		body: input.narration.replace(/\s+/g, ' ').slice(0, 500),
		visibility: 'player_known',
		sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
		sourcePatchIds: [patchId],
		metadata: {},
		serverVersion: input.serverVersion,
		createdAt,
		updatedAt: createdAt,
	});
	eventIds.push(turnEventId);

	for (const character of input.update.characters) {
		const factionTags = mergeStrings(character.faction_tags ?? []);
		const entityId = await upsertEntity(input.storyId, 'character', character.name, character.description, {
			status: character.status,
			relationship: character.relationship,
			traits: character.traits,
			present: character.present,
			pressures: character.pressures,
			factionTags,
		}, [input.assistantEntryId], [], [patchId], input.serverVersion, createdAt, character.aliases ?? []);
		const unresolved = await syncCharacterFactionTags(
			input.storyId,
			entityId,
			factionTags,
			[input.assistantEntryId],
			[patchId],
			input.serverVersion,
			createdAt,
		);
		for (const tag of unresolved) {
			warnings.push(`Character ${character.name} kept unresolved faction tag "${tag}".`);
		}
	}

	for (const location of input.update.locations) {
		await upsertEntity(input.storyId, 'location', location.name, location.description, {
			current: location.current,
			region: location.region,
			connections: location.connections,
		}, [input.assistantEntryId], [], [patchId], input.serverVersion, createdAt);
	}

	for (const item of input.update.items) {
		await upsertEntity(input.storyId, 'item', item.name, item.description, {
			quantity: item.quantity,
			equipped: item.equipped,
			location: item.location,
		}, [input.assistantEntryId], [], [patchId], input.serverVersion, createdAt);
	}

	for (const entry of input.update.lorebook_entries) {
		const entryState = {
			hiddenInfo: entry.hidden_info,
			aliases: entry.aliases,
			keywords: entry.keywords,
			...entry.state_overrides,
		};
		const entityId = await upsertEntity(
			input.storyId,
			entry.type,
			entry.name,
			entry.description,
			entryState,
			[input.assistantEntryId],
			[],
			[patchId],
			input.serverVersion,
			createdAt,
			entry.aliases,
		);
		if (entry.type === 'character') {
			const factionTags = mergeStrings(
				asStringArray(entry.state_overrides.factionTags),
				asStringArray(entry.state_overrides.faction_tags),
				asStringArray(entry.state_overrides.involvedFactions),
			);
			const unresolved = await syncCharacterFactionTags(
				input.storyId,
				entityId,
				factionTags,
				[input.assistantEntryId],
				[patchId],
				input.serverVersion,
				createdAt,
			);
			for (const tag of unresolved) {
				warnings.push(`Lorebook character ${entry.name} kept unresolved faction tag "${tag}".`);
			}
		}
		if (entry.type === 'faction') {
			const factionId = `faction_${entityId}`;
			await db.insert(factions).values({
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
				sourcePatchIds: [patchId],
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
					sourcePatchIds: [patchId],
					serverVersion: input.serverVersion,
					updatedAt: createdAt,
				},
			});
			for (const [idx, member] of entry.known_members.entries()) {
				await db.insert(factionMemberships).values({
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
					sourcePatchIds: [patchId],
					serverVersion: input.serverVersion,
					createdAt,
					updatedAt: createdAt,
				}).onConflictDoUpdate({
					target: factionMemberships.id,
					set: { status: 'active', sourcePatchIds: [patchId], serverVersion: input.serverVersion, updatedAt: createdAt },
				});
			}
			if (entry.faction_resources) {
				for (const [kind, amount] of Object.entries(entry.faction_resources)) {
					await db.insert(factionResources).values({
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
						sourcePatchIds: [patchId],
						serverVersion: input.serverVersion,
						createdAt,
						updatedAt: createdAt,
					}).onConflictDoUpdate({
						target: factionResources.id,
						set: { amount: typeof amount === 'number' ? amount : null, sourcePatchIds: [patchId], serverVersion: input.serverVersion, updatedAt: createdAt },
					});
				}
			}
			for (const [idx, goal] of entry.faction_goals.entries()) {
				await db.insert(factionGoals).values({
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
					sourcePatchIds: [patchId],
					serverVersion: input.serverVersion,
					createdAt,
					updatedAt: createdAt,
				}).onConflictDoUpdate({
					target: factionGoals.id,
					set: { goal: goal.description, priority: goal.priority, metadata: goal, sourcePatchIds: [patchId], serverVersion: input.serverVersion, updatedAt: createdAt },
				});
			}
		}
	}

	for (const rel of input.update.relationships) {
		const source = await findEntityByName(input.storyId, rel.sourceName);
		const target = await findEntityByName(input.storyId, rel.targetName);
		if (!source || !target) {
			warnings.push(`Skipped relationship ${rel.sourceName} -> ${rel.targetName}: missing entity.`);
			continue;
		}
		await db.insert(relationships).values({
			id: id('rel'),
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
			sourcePatchIds: [patchId],
			serverVersion: input.serverVersion,
			createdAt,
			updatedAt: createdAt,
		}).onConflictDoNothing();
	}

	for (const conversation of input.update.conversations) {
		const believer = await findEntityByName(input.storyId, conversation.npcName, 'character');
		if (!believer) {
			warnings.push(`Skipped NPC belief for ${conversation.npcName}: missing character entity.`);
			continue;
		}
		const beliefText = [
			conversation.topicSummary,
			conversation.playerRevealed.length ? `Player revealed: ${conversation.playerRevealed.join('; ')}` : '',
			conversation.npcLearned.length ? `NPC learned: ${conversation.npcLearned.join('; ')}` : '',
			conversation.emotionalShift ? `Emotional shift: ${conversation.emotionalShift}` : '',
		].filter(Boolean).join('\n');
		await db.insert(npcBeliefs).values({
			id: id('belief'),
			storyId: input.storyId,
			believerEntityId: believer.id,
			subjectEntityId: null,
			belief: beliefText,
			confidence: 0.75,
			visibility: 'secret',
			evidenceEventIds: [],
			sourceEntryIds: [input.assistantEntryId],
			sourceEventIds: [],
			sourcePatchIds: [patchId],
			serverVersion: input.serverVersion,
			createdAt,
			updatedAt: createdAt,
		});
	}

	for (const agreement of input.update.agreements) {
		const eventId = id('event');
		await db.insert(storyEvents).values({
			id: eventId,
			storyId: input.storyId,
			type: 'agreement',
			title: `${agreement.action} agreement`,
			body: agreement.terms ?? agreement.reason ?? `${agreement.action} ${agreement.category ?? 'agreement'}`,
			visibility: agreement.secrecy === 'secret' ? 'secret' : 'player_known',
			sourceEntryIds: [input.assistantEntryId],
			sourcePatchIds: [patchId],
			metadata: { agreement },
			serverVersion: input.serverVersion,
			createdAt,
			updatedAt: createdAt,
		});
		eventIds.push(eventId);
		if (agreement.action === 'create' && agreement.category && agreement.terms && agreement.parties.length > 0) {
			await db.insert(agreements).values({
				id: id('agreement'),
				storyId: input.storyId,
				parties: agreement.parties,
				category: agreement.category,
				terms: agreement.terms,
				status: 'active',
				secrecy: agreement.secrecy,
				consequences: agreement.consequences,
				sourceEntryIds: [input.assistantEntryId],
				sourceEventIds: [eventId],
				sourcePatchIds: [patchId],
				serverVersion: input.serverVersion,
				createdAt,
				updatedAt: createdAt,
			});
		}
	}

	for (const beat of input.update.story_beats) {
		const eventId = id('event');
		await db.insert(storyEvents).values({
			id: eventId,
			storyId: input.storyId,
			type: 'reveal',
			title: beat.title,
			body: beat.description,
			visibility: 'player_known',
			sourceEntryIds: [input.assistantEntryId],
			sourcePatchIds: [patchId],
			metadata: { significance: beat.significance },
			serverVersion: input.serverVersion,
			createdAt,
			updatedAt: createdAt,
		});
		eventIds.push(eventId);
	}

	const memoryId = id('mem');
	await db.insert(memoryNodes).values({
		id: memoryId,
		storyId: input.storyId,
		type: 'episodic',
		title: 'Recent turn',
		content: input.narration,
		summary: input.narration.replace(/\s+/g, ' ').slice(0, 360),
		keywords: [],
		entityIds: [],
		factionIds: [],
		threadIds: [],
		locationId: null,
		visibility: 'player_known',
		importance: 0.55,
		sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
		sourceEventIds: eventIds,
		sourcePatchIds: [patchId],
		metadata: { retrievedMemoryIds: input.retrievedMemoryIds },
		serverVersion: input.serverVersion,
		createdAt,
		updatedAt: createdAt,
	});
	memoryNodeIds.push(memoryId);

	try {
		await enqueueTurnProjectionJobs({
			storyId: input.storyId,
			eventIds,
			memoryNodeIds,
			patchIds: [patchId],
			serverVersion: input.serverVersion,
		});
	} catch (error) {
		warnings.push(`Queued projection jobs failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { eventIds, patchIds: [patchId], memoryNodeIds, warnings };
}
