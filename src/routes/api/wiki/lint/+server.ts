import { json, type RequestHandler } from '@sveltejs/kit';
import { lintWiki } from '$lib/server/wiki/wikiCore';
import { apiError } from '$lib/server/memory/http';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({}));
		return json(await lintWiki(body));
	} catch (error) {
		return apiError(error);
	}
};
