import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const position = Number.parseInt(params.position ?? '', 10);
		if (!Number.isFinite(position)) return json({ error: 'Invalid position.' }, { status: 400 });
		const radius = Number.parseInt(url.searchParams.get('radius') ?? '40', 10);
		return json(await executeLegacyEngineCommand({
			storyId: params.id,
			command: 'campaign.entriesAround',
			args: {
				position,
				radius: Number.isFinite(radius) ? radius : 40,
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
