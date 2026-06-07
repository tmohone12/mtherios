import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ params }) => {
	try {
		if (!params.storyId) return json({ error: 'Missing story id.' }, { status: 400 });
		return json(await executeLegacyEngineCommand({
			storyId: params.storyId,
			command: 'story.export',
			args: {},
		}));
	} catch (error) {
		return apiError(error);
	}
};
