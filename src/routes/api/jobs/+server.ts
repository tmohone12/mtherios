import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const storyId = url.searchParams.get('storyId');
		const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get('limit') ?? '80', 10) || 80));
		return json(await executeLegacyEngineCommand({
			storyId: storyId || '__all_stories__',
			command: 'jobs.status',
			args: {
				limit,
				allStories: !storyId,
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
