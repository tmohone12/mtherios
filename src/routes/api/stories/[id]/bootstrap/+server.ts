import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ params }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		return json(await executeLegacyEngineCommand({
			storyId: params.id,
			command: 'campaign.bootstrap',
			args: {},
		}));
	} catch (error) {
		return apiError(error);
	}
};
