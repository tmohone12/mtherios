import { json, type RequestHandler } from '@sveltejs/kit';
import { contextWiki } from '$lib/server/wiki/wikiCore';
import { apiError } from '$lib/server/memory/http';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		return json(await contextWiki(body));
	} catch (error) {
		return apiError(error);
	}
};
