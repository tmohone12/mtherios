import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { readCampaignState } from '$lib/contracts/campaignState';
import { getDb } from '$lib/server/db/client';
import { stories } from '$lib/server/db/schema';
import { MutationError } from './mutationSafety';

export const campaignFactRemoveSchema = z.object({
	key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
	expectedSourceEntryId: z.string().min(1),
}).strict();

export async function removeCampaignFact(storyId: string, input: unknown) {
	const request = campaignFactRemoveSchema.parse(input);
	return getDb().transaction(async tx => {
		const [story] = await tx.select({ metadata: stories.metadata }).from(stories).where(eq(stories.id, storyId)).for('update');
		if (!story) throw new MutationError('SCOPE_DENIED', 'Story was not found.');
		const facts = readCampaignState(story.metadata);
		const fact = facts.find(value => value.key === request.key);
		if (!fact) throw new MutationError('REVISION_CONFLICT', 'This campaign fact is no longer in the brief. Refresh and try again.');
		if (fact.sourceEntryId !== request.expectedSourceEntryId) throw new MutationError('REVISION_CONFLICT', 'This campaign fact changed. Refresh and review it before removal.');
		const remaining = facts.filter(value => value.key !== request.key);
		const metadata = story.metadata && typeof story.metadata === 'object' && !Array.isArray(story.metadata)
			? story.metadata as Record<string, unknown> : {};
		const history = Array.isArray(metadata.campaignStateRemovalHistory) ? metadata.campaignStateRemovalHistory : [];
		await tx.update(stories).set({
			metadata: { ...metadata, campaignState: remaining,
				campaignStateRemovalHistory: [...history, { fact, removedAt: new Date().toISOString(), actor: 'local-user' }].slice(-100) },
			serverVersion: sql`${stories.serverVersion} + 1`, updatedAt: new Date().toISOString(),
		}).where(eq(stories.id, storyId));
		return { removed: fact, remaining: remaining.length };
	});
}
