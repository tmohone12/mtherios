import { json, type RequestHandler } from '@sveltejs/kit';
import { entityUpsertRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, entityUpsertRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: event.params.id,
			command: 'entity.upsert',
			args: request,
		}));
	} catch (error) {
		return apiError(error);
	}
};
