import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({})) as Record<string, unknown>;
		const storyId = typeof body.storyId === 'string' ? body.storyId.trim() : '';
		if (!storyId) throw new Error('storyId is required.');

		return json(await executeLegacyEngineCommand({
			storyId,
			command: 'wiki.storyVault.materialize',
			args: body,
		}));
	} catch (error) {
		return apiError(error);
	}
};
