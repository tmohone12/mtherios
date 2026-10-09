import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { removeCampaignFact } from './campaignFacts';

const integration = process.env.MYTHENGINE_CAMPAIGN_FACT_INTEGRATION === '1' ? test : test.skip;

integration('removes one exact campaign fact while retaining its source and rejecting stale edits', async () => {
	const db = getDb();
	const suffix = randomUUID();
	const shelfId = `shelf_campaign_fact_${suffix}`;
	const storyId = `story_campaign_fact_${suffix}`;
	const fact = { key: 'harbor_oath', kind: 'open_thread', statement: 'The harbor oath remains unresolved.',
		evidence: 'The harbor oath remains unresolved.', sourceEntryId: 'narration_1', sourcePosition: 1 };
	try {
		await db.execute(sql`insert into shelves(id,name,slug) values(${shelfId},'Campaign fact test',${shelfId})`);
		await db.execute(sql`insert into stories(id,shelf_id,title,metadata) values(${storyId},${shelfId},'Campaign fact test',${JSON.stringify({ campaignState: [fact] })}::jsonb)`);
		await expect(removeCampaignFact(storyId, { key: fact.key, expectedSourceEntryId: 'old-source' })).rejects.toThrow('changed');
		await removeCampaignFact(storyId, { key: fact.key, expectedSourceEntryId: fact.sourceEntryId });
		const [saved] = await db.execute(sql`select metadata,server_version from stories where id=${storyId}`);
		const metadata = saved.metadata as { campaignState: unknown[]; campaignStateRemovalHistory: Array<{ fact: unknown }> };
		expect(metadata.campaignState).toEqual([]);
		expect(metadata.campaignStateRemovalHistory[0].fact).toMatchObject(fact);
		expect(Number(saved.server_version)).toBe(2);
		await expect(removeCampaignFact(storyId, { key: fact.key, expectedSourceEntryId: fact.sourceEntryId })).rejects.toThrow('no longer');
	} finally {
		await db.execute(sql`delete from shelves where id=${shelfId}`);
	}
});

afterAll(async () => { if (process.env.MYTHENGINE_CAMPAIGN_FACT_INTEGRATION === '1') await closeDb(); });
