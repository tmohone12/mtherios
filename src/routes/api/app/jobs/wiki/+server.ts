import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({})) as Record<string, unknown>;
		const storyId = typeof body.storyId === 'string' ? body.storyId.trim() : '';
		const runBulk = body.all === true || storyId === '*' || storyId === 'all';
		if (!storyId && !runBulk) throw new Error('storyId is required.');

		const { storyId: _storyId, all: _all, ...args } = body;
		return json(await executeLegacyEngineCommand({
			storyId: runBulk ? '__all_stories__' : storyId,
			command: 'jobs.storyVaultSync',
			args: {
				...args,
				allStories: runBulk,
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
