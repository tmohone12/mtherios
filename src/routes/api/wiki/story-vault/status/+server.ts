import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const storyId = url.searchParams.get('storyId')?.trim() ?? '';
		if (!storyId) throw new Error('storyId is required.');
		return json(await executeLegacyEngineCommand({
			storyId,
			command: 'wiki.storyVault.status',
			args: { storyId },
		}));
	} catch (error) {
		return apiError(error);
	}
};
