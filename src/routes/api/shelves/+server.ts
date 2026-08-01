import { json, type RequestHandler } from '@sveltejs/kit';
import { createShelfRequestSchema } from '$lib/contracts/shelves';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const GET: RequestHandler = async () => {
	try {
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'shelf.list',
			args: {},
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, createShelfRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'shelf.create',
			args: request,
		}));
	} catch (error) {
		return apiError(error);
	}
};
