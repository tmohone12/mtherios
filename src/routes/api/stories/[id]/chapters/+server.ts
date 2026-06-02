import { json, type RequestHandler } from '@sveltejs/kit';
import { chapterUpsertRequestSchema } from '$lib/contracts/memory';
import { upsertBackendChapterFromLocal } from '$lib/server/memory/canonical';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, chapterUpsertRequestSchema);
		return json(await upsertBackendChapterFromLocal(event.params.id, request.chapter));
	} catch (error) {
		return apiError(error);
	}
};
