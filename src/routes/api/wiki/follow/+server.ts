import { json, type RequestHandler } from '@sveltejs/kit';
import { followWiki } from '$lib/server/wiki/wikiCore';
import { apiError } from '$lib/server/memory/http';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		return json(await followWiki(body));
	} catch (error) {
		return apiError(error);
	}
};
