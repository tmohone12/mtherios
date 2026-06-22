import { json, type RequestHandler } from '@sveltejs/kit';
import { smallBrainRunRequestSchema } from '$lib/contracts/engine';
import { runSmallBrain } from '$lib/server/engine/smallBrain';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, smallBrainRunRequestSchema);
		return json(await runSmallBrain(request));
	} catch (error) {
		return apiError(error);
	}
};
