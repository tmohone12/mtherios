import { json, type RequestHandler } from '@sveltejs/kit';
import { engineCommandRequestSchema } from '$lib/contracts/engine';
import { executeEngineCommand } from '$lib/server/engine/command';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const command = await readJson(event, engineCommandRequestSchema);
		return json(await executeEngineCommand(command));
	} catch (error) {
		return apiError(error);
	}
};
