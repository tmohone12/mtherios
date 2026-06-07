import { json, type RequestHandler } from '@sveltejs/kit';
import { executeWikiRouteCommand } from '$lib/server/engine/wikiRouteGateway';
import { apiError } from '$lib/server/memory/http';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({}));
		return json(await executeWikiRouteCommand('wiki.lint', body));
	} catch (error) {
		return apiError(error);
	}
};
