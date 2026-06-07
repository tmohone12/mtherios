import { json, type RequestHandler } from '@sveltejs/kit';
import { turnRequestSchema } from '$lib/contracts/memory';
import { apiError, readJson } from '$lib/server/memory/http';
import { executeTurnSubmitCommand } from '$lib/server/engine/turnFacade';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, turnRequestSchema);
		return json(await executeTurnSubmitCommand(request));
	} catch (error) {
		return apiError(error);
	}
};
