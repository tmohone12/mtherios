import { json, type RequestHandler } from '@sveltejs/kit';
import { updateShelfRequestSchema } from '$lib/contracts/shelves';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

function shelfIdFromParams(params: Partial<Record<string, string>>): string {
	const shelfId = params.shelfId?.trim() ?? '';
	if (!shelfId) throw new Error('shelfId is required.');
	return shelfId;
}

export const GET: RequestHandler = async ({ params }) => {
	try {
		const shelfId = shelfIdFromParams(params);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'shelf.get',
			args: { shelfId },
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const PATCH: RequestHandler = async (event) => {
	try {
		const shelfId = shelfIdFromParams(event.params);
		const request = await readJson(event, updateShelfRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'shelf.update',
			args: { shelfId, ...request },
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		const shelfId = shelfIdFromParams(params);
		return json(await executeLegacyEngineCommand({
			storyId: '__app__',
			command: 'shelf.delete',
			args: { shelfId },
		}));
	} catch (error) {
		return apiError(error);
	}
};
