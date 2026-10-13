import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { memoryNodes, shelves, stories } from '$lib/server/db/schema';
import { retrieveMemoryPacket } from './retrieval';

const databaseUrl = process.env.SUMMARY_CHECKPOINT_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

afterAll(async () => { if (databaseUrl) await closeDb(); });

integration('history summaries in turn retrieval (disposable PostgreSQL)', () => {
	it('leaves chapter, arc and saga summaries to the canon timeline and keeps other memories', async () => {
		if (!/summary_repair|test/i.test(new URL(databaseUrl!).pathname)) throw new Error('Disposable summary test database required');
		const db = getDb();
		const [current] = await db.execute(sql`select current_database() as name`);
		if (current.name !== decodeURIComponent(new URL(databaseUrl!).pathname.slice(1))) throw new Error('Database target differs from disposable test database');
		const storyId = `story_history_retrieval_${randomUUID()}`;
		const shelfId = `shelf_${storyId}`;
		const node = (id: string, title: string) => ({ id, storyId, type: 'plot_ledger' as const, title, content: `${title}: the dragon egg in the vault.`,
			summary: `${title}: the dragon egg in the vault.`, visibility: 'player_known' as const, importance: 0.9 });
		try {
			await db.insert(shelves).values({ id: shelfId, name: 'Disposable retrieval test', slug: shelfId });
			await db.insert(stories).values({ id: shelfId.replace('shelf_', ''), shelfId, title: 'Disposable retrieval test' });
			await db.insert(memoryNodes).values([
				node('mem_chapter_c1', 'Chapter one'), node('mem_arc_a1', 'Arc one'), node('mem_saga_s1', 'Saga one'),
				{ ...node('mem_event_vault', 'Vault event'), type: 'episodic' as const },
			]);
			const ids = async (excludeHistorySummaries?: boolean) => (await retrieveMemoryPacket({ storyId, query: 'dragon egg vault', includeSemantic: false, excludeHistorySummaries }))
				.nodes.map(item => item.id).filter(id => id.startsWith('mem_')).sort();
			expect(await ids()).toEqual(['mem_arc_a1', 'mem_chapter_c1', 'mem_event_vault', 'mem_saga_s1']);
			expect(await ids(true)).toEqual(['mem_event_vault']);
		} finally {
			await db.delete(shelves).where(eq(shelves.id, shelfId));
		}
	});
});
