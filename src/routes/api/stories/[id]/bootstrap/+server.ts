import { json, type RequestHandler } from '@sveltejs/kit';
import { getBootstrap } from '$lib/server/memory/canonical';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ params }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		return json(await getBootstrap(params.id));
	} catch (error) {
		return apiError(error);
	}
};
