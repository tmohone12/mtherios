import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

function positiveInteger(value: string | null, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		return json(await executeLegacyEngineCommand({
			storyId: params.id,
			command: 'campaign.status',
			args: {
				entryLimit: positiveInteger(url.searchParams.get('limit'), 80),
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
