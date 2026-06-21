import { json, type RequestHandler } from '@sveltejs/kit';
import { contextCheckpointCreateRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const GET: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const limit = Number.parseInt(event.url.searchParams.get('limit') ?? '50', 10);
		return json(await executeLegacyEngineCommand({
			storyId: event.params.id,
			command: 'context.checkpoint.list',
			args: {
				limit: Number.isFinite(limit) ? limit : 50,
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, contextCheckpointCreateRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: event.params.id,
			command: 'context.checkpoint.create',
			args: request,
		}));
	} catch (error) {
		return apiError(error);
	}
};
