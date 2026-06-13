import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		if (!params.storyId) return json({ error: 'Missing story id.' }, { status: 400 });
		const query = url.searchParams.get('q') ?? 'current scene';
		return json(await executeLegacyEngineCommand({
			storyId: params.storyId,
			command: 'debug.promptPacket',
			args: {
				query,
				tokenBudget: Number(url.searchParams.get('tokenBudget') ?? '1200'),
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
