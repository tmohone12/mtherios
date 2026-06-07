import { json, type RequestHandler } from '@sveltejs/kit';
import { syncPullRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const request = syncPullRequestSchema.parse({
			storyId: url.searchParams.get('storyId') ?? '',
			since: Number(url.searchParams.get('since') ?? '0'),
		});
		return json(await executeLegacyEngineCommand({
			storyId: request.storyId,
			command: 'sync.pull',
			args: { since: request.since },
		}));
	} catch (error) {
		return apiError(error);
	}
};
