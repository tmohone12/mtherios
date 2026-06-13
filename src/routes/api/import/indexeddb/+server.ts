import { json, type RequestHandler } from '@sveltejs/kit';
import { indexedDbImportRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, indexedDbImportRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: storyIdFromImportBundle(request.bundle),
			command: 'story.importIndexedDb',
			args: request,
		}));
	} catch (error) {
		return apiError(error);
	}
};

function storyIdFromImportBundle(bundle: Record<string, unknown>): string {
	const story = bundle.story && typeof bundle.story === 'object' && !Array.isArray(bundle.story)
		? bundle.story as Record<string, unknown>
		: {};
	const id = typeof story.id === 'string' ? story.id.trim() : '';
	return id || 'imported_story';
}
