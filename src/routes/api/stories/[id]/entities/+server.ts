import { json, type RequestHandler } from '@sveltejs/kit';
import { entityUpsertRequestSchema } from '$lib/contracts/memory';
import { upsertBackendEntityFromEntry } from '$lib/server/memory/canonical';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, entityUpsertRequestSchema);
		return json(await upsertBackendEntityFromEntry(event.params.id, request.entry));
	} catch (error) {
		return apiError(error);
	}
};
