import { json, type RequestHandler } from '@sveltejs/kit';
import { sagaUpsertRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const PATCH: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, sagaUpsertRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: event.params.id,
			command: 'saga.upsert',
			args: {
				saga: {
					...request.saga,
					id: event.params.sagaId ?? request.saga.id,
				},
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
