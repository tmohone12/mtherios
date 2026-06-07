import { json, type RequestHandler } from '@sveltejs/kit';
import { entityUpsertRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const PATCH: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, entityUpsertRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: event.params.id,
			command: 'entity.upsert',
			args: {
				entry: {
					...request.entry,
					id: event.params.entityId ?? request.entry.id,
				},
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		if (!params.entityId) return json({ error: 'Missing entity id.' }, { status: 400 });
		return json(await executeLegacyEngineCommand({
			storyId: params.id,
			command: 'entity.delete',
			args: { entityId: params.entityId },
		}));
	} catch (error) {
		return apiError(error);
	}
};
