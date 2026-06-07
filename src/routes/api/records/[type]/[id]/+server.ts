import { json, type RequestHandler } from '@sveltejs/kit';
import { recordPatchRequestSchema } from '$lib/contracts/engine';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ params }) => {
	try {
		if (!params.type || !params.id) return json({ error: 'Missing record type or id.' }, { status: 400 });
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'world.record.get',
			args: {
				type: params.type,
				recordId: params.id,
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const PATCH: RequestHandler = async (event) => {
	try {
		const { params } = event;
		if (!params.type || !params.id) return json({ error: 'Missing record type or id.' }, { status: 400 });
		const request = await readJson(event, recordPatchRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'world.record.patch',
			args: {
				type: params.type,
				recordId: params.id,
				updates: request.updates,
				reason: request.reason,
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
