import { json, type RequestHandler } from '@sveltejs/kit';
import { llmSettingsPatchSchema } from '$lib/contracts/engine';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const GET: RequestHandler = async () => {
	try {
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'settings.llm.list',
			args: {},
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const PATCH: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, llmSettingsPatchSchema);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'settings.llm.save',
			args: request,
		}));
	} catch (error) {
		return apiError(error);
	}
};
