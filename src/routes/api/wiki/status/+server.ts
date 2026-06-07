import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';

export const GET: RequestHandler = async () => {
	return json(await executeLegacyEngineCommand({
		storyId: '__wiki__',
		command: 'wiki.status',
		args: {},
	}));
};
