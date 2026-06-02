import { json, type RequestHandler } from '@sveltejs/kit';
import { arcUpsertRequestSchema } from '$lib/contracts/memory';
import { upsertBackendArcFromLocal } from '$lib/server/memory/canonical';
import { apiError, readJson } from '$lib/server/memory/http';

export const PATCH: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, arcUpsertRequestSchema);
		return json(await upsertBackendArcFromLocal(event.params.id, {
			...request.arc,
			id: event.params.arcId ?? request.arc.id,
		}));
	} catch (error) {
		return apiError(error);
	}
};
