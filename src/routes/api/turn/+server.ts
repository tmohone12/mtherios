import { json, type RequestHandler } from '@sveltejs/kit';
import { turnRequestSchema } from '$lib/contracts/memory';
import { processBackendTurn } from '$lib/server/memory/turn';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, turnRequestSchema);
		return json(await processBackendTurn(request));
	} catch (error) {
		return apiError(error);
	}
};
