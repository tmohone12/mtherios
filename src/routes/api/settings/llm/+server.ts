import { json, type RequestHandler } from '@sveltejs/kit';
import { llmSettingsPatchSchema } from '$lib/contracts/engine';
import { listLlmServiceSettings, saveLocalApiKeyRefs, upsertLlmServiceSettings } from '$lib/server/engine/llmSettings';
import { apiError, readJson } from '$lib/server/memory/http';

export const GET: RequestHandler = async () => {
	try {
		return json({ settings: await listLlmServiceSettings() });
	} catch (error) {
		return apiError(error);
	}
};

export const PATCH: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, llmSettingsPatchSchema);
		saveLocalApiKeyRefs(request.secrets);
		return json({ settings: await upsertLlmServiceSettings(request.settings) });
	} catch (error) {
		return apiError(error);
	}
};
