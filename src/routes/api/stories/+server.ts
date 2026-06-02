import { json, type RequestHandler } from '@sveltejs/kit';
import { createStoryRequestSchema } from '$lib/contracts/memory';
import { createBackendStory, listBackendStories } from '$lib/server/memory/canonical';
import { apiError, readJson } from '$lib/server/memory/http';

export const GET: RequestHandler = async () => {
	try {
		return json({ stories: await listBackendStories() });
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, createStoryRequestSchema);
		return json(await createBackendStory(request));
	} catch (error) {
		return apiError(error);
	}
};
