import { json, type RequestHandler } from '@sveltejs/kit';
import { arcUpsertRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const PATCH: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, arcUpsertRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: event.params.id,
			command: 'arc.upsert',
			args: {
				arc: {
					...request.arc,
					id: event.params.arcId ?? request.arc.id,
				},
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
