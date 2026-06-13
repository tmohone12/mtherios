import { json, type RequestHandler } from '@sveltejs/kit';
import { syncPushRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, syncPushRequestSchema);
		const { storyId, ...args } = request;
		return json(await executeLegacyEngineCommand({
			storyId,
			command: 'sync.push',
			args,
		}));
	} catch (error) {
		return apiError(error);
	}
};
