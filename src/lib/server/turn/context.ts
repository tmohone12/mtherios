import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { englishTsQuery } from '$lib/server/db/textSearch';
import type { GmTimelineBrief } from '$lib/contracts/memory';
import type { SceneCheckpoint } from '$lib/contracts/sceneCheckpoint';
import { loadSceneCheckpoint } from '$lib/server/memory/sceneCheckpoint';
import { loadLocationLore } from '$lib/server/memory/locationLore';
import type { LocationLoreContext } from '$lib/contracts/locationLore';
import { latestNarrationForPov, parseParallelPovCommand, type ParallelPovRequest } from '$lib/services/ai/context/parallelPov';
import { isNarrativeCommandInput, isNarrativeControlInput } from '$lib/services/ai/context/controlInput';
import { containsSceneActorMention } from '$lib/services/ai/context/sceneActorMention';
import { characterAliases, selectRelevantCharacters } from '$lib/utils/characterState';
import { sceneEvidenceExcerpt } from '$lib/utils/sceneEvidence';
import { memoryQueryTokens, normalizeLookup } from '$lib/server/memory/ranking';
import { selectProtagonistEntity } from './promptPacket';
import {
	agreements,
	arcs,
	chapters,
	entities,
	factions,
	factionGoals,
	factionMemberships,
	factionProjects,
	factionResources,
	facts,
	npcBeliefs,
	patchProposals,
	sagas,
	stories,
	storyEntries,
	storyEvents,
	storyThreads,
	continuityWarnings,
	entityAliases,
} from '$lib/server/db/schema';

export const NARRATOR_RECENT_ENTRY_LIMIT = 200;
export const TURN_CONTEXT_ENTITY_LIMIT = 1000;
export const TURN_CONTEXT_AGREEMENT_LIMIT = 80;

export interface TurnContext {
	story: typeof stories.$inferSelect;
	recentEntries: Array<typeof storyEntries.$inferSelect>;
	recentControlEntries?: Array<typeof storyEntries.$inferSelect>;
	sceneCheckpoint?: SceneCheckpoint | null;
	locationLore?: LocationLoreContext;
	scenePov?: ParallelPovRequest | null;
	sceneLocationId?: string | null;
	entities: Array<typeof entities.$inferSelect>;
	factions: Array<typeof factions.$inferSelect>;
	factionMemberships: Array<typeof factionMemberships.$inferSelect>;
	factionResources: Array<typeof factionResources.$inferSelect>;
	factionGoals: Array<typeof factionGoals.$inferSelect>;
	factionProjects: Array<typeof factionProjects.$inferSelect>;
	agreements: Array<typeof agreements.$inferSelect>;
	threads: Array<typeof storyThreads.$inferSelect>;
	events: Array<typeof storyEvents.$inferSelect>;
	beliefs: Array<typeof npcBeliefs.$inferSelect>;
	facts: Array<typeof facts.$inferSelect>;
	patchProposals: Array<typeof patchProposals.$inferSelect>;
	continuityWarnings: Array<typeof continuityWarnings.$inferSelect>;
	chapters: Array<typeof chapters.$inferSelect>;
	arcs: Array<typeof arcs.$inferSelect>;
	sagas: Array<typeof sagas.$inferSelect>;
	gmBrief: GmTimelineBrief | null;
	/** Set when an earlier turn's gameplay state is still pending or failed (see unsettledStateNotice). */
	gameplayNotice?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function filterNarrativeContextEntries(
	entryRows: Array<typeof storyEntries.$inferSelect>,
): Array<typeof storyEntries.$inferSelect> {
	const nonCanonUserIds = new Set<string>();
	for (const entry of entryRows) {
		if (entry.type !== 'user_action') continue;
		const metadata = asRecord(entry.metadata);
		if (metadata.nonCanon === true || metadata.actionType === 'ooc' || isNarrativeControlInput(entry.content)) {
			nonCanonUserIds.add(entry.id);
		}
	}
	return entryRows.filter((entry) => {
		const metadata = asRecord(entry.metadata);
		if (metadata.nonCanon === true || metadata.actionType === 'ooc') return false;
		if (entry.type === 'user_action') return !nonCanonUserIds.has(entry.id) && !isNarrativeCommandInput(entry.content);
		if (entry.type === 'narration' && entry.parentId && nonCanonUserIds.has(entry.parentId)) return false;
		return true;
	});
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

export function attachEntityAliases(
	entityRows: Array<typeof entities.$inferSelect>,
	aliasRows: Array<typeof entityAliases.$inferSelect>,
): Array<typeof entities.$inferSelect> {
	const aliasesByEntity = new Map<string, string[]>();
	for (const row of aliasRows) {
		const list = aliasesByEntity.get(row.entityId) ?? [];
		list.push(row.alias);
		aliasesByEntity.set(row.entityId, list);
	}
	return entityRows.map((entity) => {
		const aliases = aliasesByEntity.get(entity.id);
		if (!aliases?.length) return entity;
		const state = asRecord(entity.state);
		return {
			...entity,
			state: {
				...state,
				aliases: [...new Set([...asStringArray(state.aliases), ...aliases])],
			},
		};
	});
}

/** Item records for the classifier's gameplay state: held stacks first, then the rest (bounded). */
export async function loadGameplayItems(storyId: string): Promise<Array<typeof entities.$inferSelect>> {
	return getDb().select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.type, 'item'), ne(entities.status, 'deleted')))
		.orderBy(desc(sql`case when ${entities.state}->>'ownerId' is not null or ${entities.state}->>'inInventory' = 'true' then 1 else 0 end`), desc(entities.updatedAt))
		.limit(300);
}

export async function loadClassifierAgreements(storyId: string, text: string): Promise<Array<typeof agreements.$inferSelect>> {
	const tokens = memoryQueryTokens(text);
	const matches = tokens.length ? sql`to_tsvector('english', ${agreements.terms} || ' ' || ${agreements.parties}::text)
		@@ ${englishTsQuery(tokens.join(' | '))}` : sql`false`;
	return getDb().select().from(agreements).where(and(eq(agreements.storyId, storyId), sql`${agreements.status} != 'deleted'`))
		.orderBy(desc(sql`case when ${matches} then 1 else 0 end`), desc(agreements.updatedAt), asc(agreements.id)).limit(40);
}

export async function loadCanonicalCharacters(storyId: string): Promise<Array<typeof entities.$inferSelect>> {
	const db = getDb();
	const [rows, aliases] = await Promise.all([
		db.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.type, 'character'))).orderBy(desc(entities.updatedAt)),
		db.select().from(entityAliases).where(eq(entityAliases.storyId, storyId)),
	]);
	return attachEntityAliases(rows.filter(row => row.status !== 'deleted' && !(asRecord(row.metadata).mergedInto)), aliases);
}

export async function loadClassifierLocations(storyId: string): Promise<Array<{ id: string; name: string }>> {
	return getDb().select({ id: entities.id, name: entities.name }).from(entities)
		.where(and(eq(entities.storyId, storyId), eq(entities.type, 'location'), eq(entities.status, 'active'))).orderBy(asc(entities.id));
}

export async function loadClassifierFactions(storyId: string): Promise<Array<{ id: string; name: string }>> {
	return getDb().select({ id: factions.id, name: factions.name }).from(factions)
		.where(eq(factions.storyId, storyId)).orderBy(asc(factions.id));
}

export async function loadTurnContext(storyId: string, presentNpcIds: string[] = [], sceneEntityIds: string[] = [], actionText = ''): Promise<TurnContext> {
	const db = getDb();
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);
	const requestedEntityIds = [...new Set([...presentNpcIds, ...sceneEntityIds, story.currentLocationId ?? ''].map((id) => id.trim()).filter((id) => id.length > 0))];

	const [
		recentEntriesTail,
		entityRows,
		requestedEntityRows,
		factionRows,
		factionMembershipRows,
		factionResourceRows,
		factionGoalRows,
		factionProjectRows,
		threadRows,
		eventRows,
		chapterRows,
		arcRows,
		sagaRows,
		aliasRows,
	] = await Promise.all([
		db.select().from(storyEntries).where(and(
			eq(storyEntries.storyId, storyId),
			inArray(storyEntries.type, ['user_action', 'narration']),
		)).orderBy(desc(storyEntries.position)).limit(NARRATOR_RECENT_ENTRY_LIMIT),
		db.select().from(entities).where(eq(entities.storyId, storyId)).orderBy(desc(entities.updatedAt)).limit(TURN_CONTEXT_ENTITY_LIMIT),
		requestedEntityIds.length
			? db.select().from(entities).where(and(eq(entities.storyId, storyId), inArray(entities.id, requestedEntityIds))).limit(requestedEntityIds.length)
			: Promise.resolve([] as Array<typeof entities.$inferSelect>),
		// Rank factions against the scene in prompt assembly, not an arbitrary
		// database page. The rendered faction count and fields remain bounded.
		db.select().from(factions).where(eq(factions.storyId, storyId)).orderBy(asc(factions.id)),
		db.select().from(factionMemberships).where(and(eq(factionMemberships.storyId, storyId), ne(factionMemberships.status, 'archived'))).orderBy(asc(factionMemberships.id)),
		db.select().from(factionResources).where(eq(factionResources.storyId, storyId)).orderBy(asc(factionResources.id)),
		db.select().from(factionGoals).where(eq(factionGoals.storyId, storyId)).orderBy(asc(factionGoals.id)),
		db.select().from(factionProjects).where(eq(factionProjects.storyId, storyId)).orderBy(asc(factionProjects.id)),
		db.select().from(storyThreads).where(and(eq(storyThreads.storyId, storyId), inArray(storyThreads.status, ['open', 'imminent', 'stalled']))).limit(80),
		db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId)).orderBy(desc(storyEvents.updatedAt)).limit(80),
		db.select().from(chapters).where(eq(chapters.storyId, storyId)).orderBy(asc(chapters.number)),
		db.select().from(arcs).where(eq(arcs.storyId, storyId)).orderBy(asc(arcs.number)),
		db.select().from(sagas).where(eq(sagas.storyId, storyId)).orderBy(asc(sagas.number)),
		db.select().from(entityAliases).where(eq(entityAliases.storyId, storyId)).limit(500),
	]);

	// The initial bounded read is only an optimization. It must not become a
	// sliding prompt window while the current chapter is still being written.
	const lastChapterEnd = chapterRows.at(-1)?.metadata?.endPosition;
	const tailCoversChapter = typeof lastChapterEnd === 'number'
		&& (recentEntriesTail.at(-1)?.position ?? Infinity) < lastChapterEnd - 4;
	const recentEntriesDesc = recentEntriesTail.length >= NARRATOR_RECENT_ENTRY_LIMIT && !tailCoversChapter
		? await db.select().from(storyEntries).where(and(eq(storyEntries.storyId, storyId),
			inArray(storyEntries.type, ['user_action', 'narration']))).orderBy(desc(storyEntries.position))
		: recentEntriesTail;
	const requestedEntityById = new Map(requestedEntityRows.map((entity) => [entity.id, entity]));
	const broadEntityById = new Map(entityRows.map((entity) => [entity.id, entity]));
	const mergedEntityRows = [
		...requestedEntityIds.map((entityId) => requestedEntityById.get(entityId) ?? broadEntityById.get(entityId)).filter((entity): entity is typeof entities.$inferSelect => Boolean(entity)),
		...entityRows.filter((entity) => !requestedEntityIds.includes(entity.id)),
	];
	const requestedSet = new Set(requestedEntityIds);
	const canonicalEntities = attachEntityAliases(mergedEntityRows, aliasRows);
	const recentEntries = filterNarrativeContextEntries([...recentEntriesDesc].reverse());
	const latestPosition = recentEntriesDesc[0]?.position ?? 0;
	const recentControlEntries = [...recentEntriesDesc].reverse().filter(entry => entry.type === 'user_action'
		&& entry.position >= latestPosition - 60
		&& (asRecord(entry.metadata).nonCanon === true || asRecord(entry.metadata).actionType === 'ooc'
			|| isNarrativeControlInput(entry.content) || isNarrativeCommandInput(entry.content))).slice(-12);
	const scenePov = parseParallelPovCommand(actionText);
	let sceneLocationId = story.currentLocationId;
	if (scenePov) {
		const actors = canonicalEntities.filter(entity => entity.type === 'character' && [entity.id, entity.name, ...characterAliases(entity)].some(name => normalizeLookup(name) === normalizeLookup(scenePov.character)));
		const state = actors.length === 1 ? asRecord(actors[0].state) : {};
		const reference = String(state.currentLocationId ?? state.currentLocation ?? state.current_location ?? '');
		const locations = canonicalEntities.filter(entity => entity.type === 'location' && (entity.id === reference || normalizeLookup(entity.name) === normalizeLookup(reference)));
		sceneLocationId = locations.length === 1 ? locations[0].id : null;
	}
	const scene = sceneEvidenceExcerpt(latestNarrationForPov(recentEntries, scenePov, recentEntriesDesc)?.content ?? '', 6000);
	// Browser cast hints can lag a scene transition. Load beliefs for actors the
	// server can see in canon or narration before the prompt selects its cast.
	const narratedActorIds = new Set<string>();
	const addressedActorIds = new Set<string>();
	const normalizedAction = ` ${normalizeLookup(actionText)} `;
	const beliefActors = canonicalEntities.filter((entity) => {
		if (entity.type !== 'character' || entity.status === 'deleted' || asRecord(entity.metadata).mergedInto) return false;
		const state = asRecord(entity.state);
		if ([entity.name, ...characterAliases(entity)].some((name) => containsSceneActorMention(scene, name))) narratedActorIds.add(entity.id);
		if ([entity.name, ...characterAliases(entity)].some((name) => {
			const normalizedName = normalizeLookup(name);
			return normalizedName.length >= 3 && normalizedAction.includes(` ${normalizedName} `);
		})) addressedActorIds.add(entity.id);
		return requestedSet.has(entity.id) || state.present === true || state.isPresent === true
			|| narratedActorIds.has(entity.id) || addressedActorIds.has(entity.id);
	});
	const beliefActorIds = selectRelevantCharacters(beliefActors, [scene, actionText], beliefActors.length, [...requestedSet])
		.sort((a, b) => Number(addressedActorIds.has(b.id)) - Number(addressedActorIds.has(a.id))
			|| Number(narratedActorIds.has(b.id)) - Number(narratedActorIds.has(a.id)))
		.slice(0, 32).map((entity) => entity.id);
	const protagonistId = selectProtagonistEntity(canonicalEntities)?.id;
	const sceneParties = [...new Set(canonicalEntities.filter((entity) => entity.id !== protagonistId
		&& entity.status !== 'deleted' && !asRecord(entity.metadata).mergedInto
		&& (beliefActorIds.includes(entity.id) || requestedSet.has(entity.id)
			|| [entity.name, ...characterAliases(entity)].some((name) => containsSceneActorMention(actionText, name))))
		.flatMap((entity) => [entity.id, entity.name, ...characterAliases(entity)]).map(normalizeLookup).filter(Boolean))];
	const actionTokens = memoryQueryTokens(actionText);
	const partyScore = sceneParties.length ? sql`case when exists (
		select 1 from jsonb_array_elements_text(${agreements.parties}) as party
		where trim(regexp_replace(lower(party), '[^a-z0-9]+', ' ', 'g')) in (${sql.join(sceneParties.map((party) => sql`${party}`), sql`, `)})
	) then 8 else 0 end` : sql`0`;
	const actionScore = actionTokens.length ? sql`least(6, (
		select count(*) from unnest(array[${sql.join(actionTokens.map((token) => sql`${token}`), sql`, `)}]::text[]) as token
		where to_tsvector('english', ${agreements.terms} || ' ' || ${agreements.parties}::text) @@ ${englishTsQuery(sql`token`, 'plain')}
	))` : sql`0`;
	const dueScore = sql`case when exists (
		select 1 from ${storyEvents} where ${storyEvents.storyId} = ${storyId}
		and ${agreements.sourceEventIds} ? ${storyEvents.id}
		and (${storyEvents.status} = 'due' or (${storyEvents.status} = 'scheduled' and ${storyEvents.scheduledTurn} <= ${story.currentTurn}))
	) then 4 else 0 end`;
	// Rank against scene identities, action and due events before the bounded
	// fetch, so an old promise survives a roster of newer unrelated agreements.
	const [beliefRows, agreementRows] = await Promise.all([
		beliefActorIds.length
			? db.select().from(npcBeliefs).where(and(eq(npcBeliefs.storyId, storyId), inArray(npcBeliefs.believerEntityId, beliefActorIds))).orderBy(desc(npcBeliefs.updatedAt)).limit(120)
			: Promise.resolve([]),
		db.select().from(agreements).where(and(eq(agreements.storyId, storyId), inArray(agreements.status, ['active', 'contested'])))
			.orderBy(desc(sql`(${partyScore} + ${actionScore} + ${dueScore})`), desc(agreements.updatedAt), asc(agreements.id))
			.limit(TURN_CONTEXT_AGREEMENT_LIMIT),
	]);
	return {
		story,
		recentEntries,
		recentControlEntries,
		scenePov,
		sceneLocationId,
		locationLore: await loadLocationLore({ storyId, locationId: sceneLocationId, atTurn: story.currentTurn, db }),
		sceneCheckpoint: await loadSceneCheckpoint(story, recentEntries).catch(() => null),
		entities: canonicalEntities,
		factions: factionRows,
		factionMemberships: factionMembershipRows,
		factionResources: factionResourceRows,
		factionGoals: factionGoalRows,
		factionProjects: factionProjectRows,
		agreements: agreementRows,
		threads: threadRows,
		events: eventRows,
		beliefs: beliefRows,
		// ponytail: repair/audit tables stay out of normal narration; repair tools load them directly.
		facts: [],
		patchProposals: [],
		continuityWarnings: [],
		chapters: chapterRows,
		arcs: arcRows,
		sagas: sagaRows,
		gmBrief: null,
	};
}
