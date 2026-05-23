import { json, type RequestHandler } from '@sveltejs/kit';
import { memoryRetrieveRequestSchema } from '$lib/contracts/memory';
import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, memoryRetrieveRequestSchema);
		return json(await retrieveMemoryPacket(request));
	} catch (error) {
		return apiError(error);
	}
};
