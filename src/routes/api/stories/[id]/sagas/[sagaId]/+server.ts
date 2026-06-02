import { json, type RequestHandler } from '@sveltejs/kit';
import { sagaUpsertRequestSchema } from '$lib/contracts/memory';
import { upsertBackendSagaFromLocal } from '$lib/server/memory/canonical';
import { apiError, readJson } from '$lib/server/memory/http';

export const PATCH: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, sagaUpsertRequestSchema);
		return json(await upsertBackendSagaFromLocal(event.params.id, {
			...request.saga,
			id: event.params.sagaId ?? request.saga.id,
		}));
	} catch (error) {
		return apiError(error);
	}
};
