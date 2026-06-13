import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { googleAgentPlatformJsonError } from '$lib/server/engine/googleAgentProxy';

export const GET: RequestHandler = async () => {
	try {
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'googleAgent.models',
			args: {},
		}));
	} catch (error) {
		return googleAgentPlatformJsonError(error, 503);
	}
};
