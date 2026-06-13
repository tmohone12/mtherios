import { json, type RequestHandler } from '@sveltejs/kit';
import { memoryRetrieveRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, memoryRetrieveRequestSchema);
		const { storyId, ...args } = request;
		return json(await executeLegacyEngineCommand({
			storyId,
			command: 'memory.retrieve',
			args,
		}));
	} catch (error) {
		return apiError(error);
	}
};
