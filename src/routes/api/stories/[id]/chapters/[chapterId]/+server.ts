import { json, type RequestHandler } from '@sveltejs/kit';
import { chapterUpsertRequestSchema } from '$lib/contracts/memory';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

export const PATCH: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = await readJson(event, chapterUpsertRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: event.params.id,
			command: 'chapter.upsert',
			args: {
				chapter: {
					...request.chapter,
					id: event.params.chapterId ?? request.chapter.id,
				},
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		if (!event.params.chapterId) return json({ error: 'Missing chapter id.' }, { status: 400 });
		return json(await executeLegacyEngineCommand({
			storyId: event.params.id,
			command: 'chapter.delete',
			args: {
				chapterId: event.params.chapterId,
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
