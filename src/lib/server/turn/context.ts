import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import type { GmTimelineBrief } from '$lib/contracts/memory';
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
} from '$lib/server/db/schema';

export interface TurnContext {
	story: typeof stories.$inferSelect;
	recentEntries: Array<typeof storyEntries.$inferSelect>;
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
}

export async function loadTurnContext(storyId: string, presentNpcIds: string[] = [], sceneEntityIds: string[] = []): Promise<TurnContext> {
	const db = getDb();
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);
	const requestedEntityIds = [...new Set([...presentNpcIds, ...sceneEntityIds].map((id) => id.trim()).filter((id) => id.length > 0))];

	const [
		recentEntriesDesc,
		entityRows,
		requestedEntityRows,
		factionRows,
		factionMembershipRows,
		factionResourceRows,
		factionGoalRows,
		factionProjectRows,
		agreementRows,
		threadRows,
		eventRows,
		beliefRows,
		factRows,
		patchProposalRows,
		continuityWarningRows,
		chapterRows,
		arcRows,
		sagaRows,
	] = await Promise.all([
		db.select().from(storyEntries).where(eq(storyEntries.storyId, storyId)).orderBy(desc(storyEntries.position)).limit(60),
		db.select().from(entities).where(eq(entities.storyId, storyId)).limit(160),
		requestedEntityIds.length
			? db.select().from(entities).where(and(eq(entities.storyId, storyId), inArray(entities.id, requestedEntityIds))).limit(requestedEntityIds.length)
			: Promise.resolve([] as Array<typeof entities.$inferSelect>),
		db.select().from(factions).where(eq(factions.storyId, storyId)).limit(80),
		db.select().from(factionMemberships).where(eq(factionMemberships.storyId, storyId)).limit(240),
		db.select().from(factionResources).where(eq(factionResources.storyId, storyId)).limit(240),
		db.select().from(factionGoals).where(eq(factionGoals.storyId, storyId)).limit(240),
		db.select().from(factionProjects).where(eq(factionProjects.storyId, storyId)).limit(240),
		db.select().from(agreements).where(and(eq(agreements.storyId, storyId), ne(agreements.status, 'archived'))).limit(80),
		db.select().from(storyThreads).where(and(eq(storyThreads.storyId, storyId), ne(storyThreads.status, 'closed'))).limit(80),
		db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId)).orderBy(desc(storyEvents.updatedAt)).limit(80),
		requestedEntityIds.length
			? db.select().from(npcBeliefs).where(and(eq(npcBeliefs.storyId, storyId), inArray(npcBeliefs.believerEntityId, requestedEntityIds))).limit(120)
			: db.select().from(npcBeliefs).where(eq(npcBeliefs.storyId, storyId)).limit(40),
		db.select().from(facts).where(eq(facts.storyId, storyId)).orderBy(desc(facts.updatedAt)).limit(80),
		db.select().from(patchProposals).where(eq(patchProposals.storyId, storyId)).orderBy(desc(patchProposals.updatedAt)).limit(80),
		db.select().from(continuityWarnings).where(eq(continuityWarnings.storyId, storyId)).orderBy(desc(continuityWarnings.updatedAt)).limit(80),
		db.select().from(chapters).where(eq(chapters.storyId, storyId)).orderBy(asc(chapters.number)),
		db.select().from(arcs).where(eq(arcs.storyId, storyId)).orderBy(asc(arcs.number)),
		db.select().from(sagas).where(eq(sagas.storyId, storyId)).orderBy(asc(sagas.number)),
	]);

	const mergedEntityRows = [...entityRows];
	const seenEntityIds = new Set(entityRows.map((entity) => entity.id));
	for (const entity of requestedEntityRows) {
		if (seenEntityIds.has(entity.id)) continue;
		seenEntityIds.add(entity.id);
		mergedEntityRows.push(entity);
	}
	const requestedSet = new Set(requestedEntityIds);
	return {
		story,
		recentEntries: [...recentEntriesDesc].reverse(),
		entities: mergedEntityRows,
		factions: factionRows,
		factionMemberships: factionMembershipRows,
		factionResources: factionResourceRows,
		factionGoals: factionGoalRows,
		factionProjects: factionProjectRows,
		agreements: agreementRows,
		threads: threadRows,
		events: eventRows,
		beliefs: requestedSet.size > 0
			? beliefRows.filter((belief) => requestedSet.has(belief.believerEntityId))
			: beliefRows,
		facts: factRows,
		patchProposals: patchProposalRows,
		continuityWarnings: continuityWarningRows,
		chapters: chapterRows,
		arcs: arcRows,
		sagas: sagaRows,
		gmBrief: null,
	};
}
