import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const storyId = url.searchParams.get('storyId')?.trim() || null;
		return json(await executeLegacyEngineCommand({
			storyId: storyId ?? '__app__',
			command: 'app.status',
			args: {},
		}));
	} catch (error) {
		return apiError(error);
	}
};
