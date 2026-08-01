import { json, type RequestHandler } from '@sveltejs/kit';
import { seedPreviewRequestSchema } from '$lib/contracts/worldSeed';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, seedPreviewRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'database.seed.preview',
			args: request,
		}));
	} catch (error) {
		return apiError(error);
	}
};
