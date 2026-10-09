import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from './client';
import { storyEntries } from './schema';

type Db = ReturnType<typeof getDb>;
export type StoryEntryPositionTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

function validPreferredPosition(value: number | null | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

export async function allocateStoryEntryPosition(
	tx: StoryEntryPositionTransaction,
	storyId: string,
	preferredPosition?: number | null,
): Promise<number> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mtherios:story-entry:${storyId}`}, 0))`);
	const preferred = validPreferredPosition(preferredPosition);
	if (preferred !== null) {
		const [occupied] = await tx
			.select({ id: storyEntries.id })
			.from(storyEntries)
			.where(and(eq(storyEntries.storyId, storyId), eq(storyEntries.position, preferred)))
			.limit(1);
		if (!occupied) return preferred;
	}
	const [last] = await tx
		.select({ position: storyEntries.position })
		.from(storyEntries)
		.where(eq(storyEntries.storyId, storyId))
		.orderBy(desc(storyEntries.position))
		.limit(1);
	return (last?.position ?? -1) + 1;
}
