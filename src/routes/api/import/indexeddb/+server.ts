import { json, type RequestHandler } from '@sveltejs/kit';
import { indexedDbImportRequestSchema } from '$lib/contracts/memory';
import { importIndexedDbBundle } from '$lib/server/memory/canonical';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, indexedDbImportRequestSchema);
		return json(await importIndexedDbBundle(request));
	} catch (error) {
		return apiError(error);
	}
};
