import { json, type RequestHandler } from '@sveltejs/kit';
import { engineCacheStatusArgsSchema } from '$lib/contracts/engine';
import { getEngineCacheStatus } from '$lib/server/engine/cache';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const storyId = url.searchParams.get('storyId');
		const args = engineCacheStatusArgsSchema.parse({
			includeSegments: url.searchParams.get('includeSegments') === 'true' || url.searchParams.get('segments') === 'true',
			segmentLimit: Number(url.searchParams.get('segmentLimit') ?? url.searchParams.get('limit') ?? 25),
			kind: url.searchParams.get('kind') ?? undefined,
		});
		return json(await getEngineCacheStatus(storyId, args));
	} catch (error) {
		return apiError(error);
	}
};
