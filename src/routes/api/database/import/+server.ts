import { json, type RequestHandler } from '@sveltejs/kit';
import { worldDatabaseImportRequestSchema } from '$lib/contracts/worldDatabase';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, worldDatabaseImportRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'database.importWorldBundle',
			args: request,
		}));
	} catch (error) {
		return apiError(error);
	}
};
