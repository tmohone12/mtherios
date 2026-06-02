import { json, type RequestHandler } from '@sveltejs/kit';
import { livingMemoryUpsertRequestSchema } from '$lib/contracts/memory';
import { upsertBackendLivingMemoryFromLocal } from '$lib/server/memory/canonical';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, livingMemoryUpsertRequestSchema);
		const records = request.record ? [request.record, ...request.records] : request.records;
		if (records.length === 0) return json({ error: 'Missing living-memory record.' }, { status: 400 });
		return json(await upsertBackendLivingMemoryFromLocal(event.params.id, request.kind, records));
	} catch (error) {
		return apiError(error);
	}
};
