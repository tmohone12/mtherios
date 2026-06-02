import { json, type RequestHandler } from '@sveltejs/kit';
import { entityUpsertRequestSchema } from '$lib/contracts/memory';
import { deleteBackendEntity, upsertBackendEntityFromEntry } from '$lib/server/memory/canonical';
import { apiError, readJson } from '$lib/server/memory/http';

export const PATCH: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, entityUpsertRequestSchema);
		return json(await upsertBackendEntityFromEntry(event.params.id, {
			...request.entry,
			id: event.params.entityId ?? request.entry.id,
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		if (!params.entityId) return json({ error: 'Missing entity id.' }, { status: 400 });
		return json(await deleteBackendEntity(params.id, params.entityId));
	} catch (error) {
		return apiError(error);
	}
};
