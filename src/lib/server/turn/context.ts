import { and, desc, eq, ne } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import type { GmTimelineBrief } from '$lib/contracts/memory';
import {
	agreements,
	entities,
	factions,
	factionGoals,
	factionMemberships,
	factionResources,
	npcBeliefs,
	stories,
	storyEntries,
	storyEvents,
	storyThreads,
} from '$lib/server/db/schema';

export interface TurnContext {
	story: typeof stories.$inferSelect;
	recentEntries: Array<typeof storyEntries.$inferSelect>;
	entities: Array<typeof entities.$inferSelect>;
	factions: Array<typeof factions.$inferSelect>;
	factionMemberships: Array<typeof factionMemberships.$inferSelect>;
	factionResources: Array<typeof factionResources.$inferSelect>;
	factionGoals: Array<typeof factionGoals.$inferSelect>;
	agreements: Array<typeof agreements.$inferSelect>;
	threads: Array<typeof storyThreads.$inferSelect>;
	events: Array<typeof storyEvents.$inferSelect>;
	beliefs: Array<typeof npcBeliefs.$inferSelect>;
	gmBrief: GmTimelineBrief | null;
}

export async function loadTurnContext(storyId: string, presentNpcIds: string[] = []): Promise<TurnContext> {
	const db = getDb();
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);

	const [
		recentEntriesDesc,
		entityRows,
		factionRows,
		factionMembershipRows,
		factionResourceRows,
		factionGoalRows,
		agreementRows,
		threadRows,
		eventRows,
		beliefRows,
	] = await Promise.all([
		db.select().from(storyEntries).where(eq(storyEntries.storyId, storyId)).orderBy(desc(storyEntries.position)).limit(40),
		db.select().from(entities).where(eq(entities.storyId, storyId)).limit(160),
		db.select().from(factions).where(eq(factions.storyId, storyId)).limit(80),
		db.select().from(factionMemberships).where(eq(factionMemberships.storyId, storyId)).limit(240),
		db.select().from(factionResources).where(eq(factionResources.storyId, storyId)).limit(240),
		db.select().from(factionGoals).where(eq(factionGoals.storyId, storyId)).limit(240),
		db.select().from(agreements).where(and(eq(agreements.storyId, storyId), ne(agreements.status, 'archived'))).limit(80),
		db.select().from(storyThreads).where(and(eq(storyThreads.storyId, storyId), ne(storyThreads.status, 'closed'))).limit(80),
		db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId)).orderBy(desc(storyEvents.updatedAt)).limit(80),
		presentNpcIds.length
			? db.select().from(npcBeliefs).where(eq(npcBeliefs.storyId, storyId)).limit(120)
			: db.select().from(npcBeliefs).where(eq(npcBeliefs.storyId, storyId)).limit(40),
	]);

	const presentSet = new Set(presentNpcIds);
	return {
		story,
		recentEntries: [...recentEntriesDesc].reverse(),
		entities: entityRows,
		factions: factionRows,
		factionMemberships: factionMembershipRows,
		factionResources: factionResourceRows,
		factionGoals: factionGoalRows,
		agreements: agreementRows,
		threads: threadRows,
		events: eventRows,
		beliefs: presentSet.size > 0
			? beliefRows.filter((belief) => presentSet.has(belief.believerEntityId))
			: beliefRows,
		gmBrief: null,
	};
}
