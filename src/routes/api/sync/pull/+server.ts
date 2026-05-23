import { json, type RequestHandler } from '@sveltejs/kit';
import { syncPullRequestSchema } from '$lib/contracts/memory';
import { getSyncChanges } from '$lib/server/memory/canonical';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const request = syncPullRequestSchema.parse({
			storyId: url.searchParams.get('storyId') ?? '',
			since: Number(url.searchParams.get('since') ?? '0'),
		});
		const changes = await getSyncChanges(request.storyId, request.since);
		const serverVersion = changes.reduce((max, change) => Math.max(max, change.version), request.since);
		return json({ storyId: request.storyId, serverVersion, changes });
	} catch (error) {
		return apiError(error);
	}
};
