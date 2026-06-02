import { json, type RequestHandler } from '@sveltejs/kit';
import { pageWiki } from '$lib/server/wiki/wikiCore';
import { apiError } from '$lib/server/memory/http';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		return json(await pageWiki(body));
	} catch (error) {
		return apiError(error);
	}
};
