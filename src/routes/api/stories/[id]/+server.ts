import { json, type RequestHandler } from '@sveltejs/kit';
import { deleteBackendStory } from '$lib/server/memory/canonical';
import { apiError } from '$lib/server/memory/http';

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		return json(await deleteBackendStory(params.id));
	} catch (error) {
		return apiError(error);
	}
};
