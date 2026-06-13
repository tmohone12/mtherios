import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

function positiveInteger(value: string | null, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalInteger(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const cursor = optionalInteger(url.searchParams.get('cursor'));
		return json(await executeLegacyEngineCommand({
			storyId: params.id,
			command: 'campaign.transcriptPage',
			args: {
				beforePosition: optionalInteger(url.searchParams.get('beforePosition')) ?? cursor,
				limit: positiveInteger(url.searchParams.get('limit'), 80),
				branchId: url.searchParams.get('branchId'),
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
