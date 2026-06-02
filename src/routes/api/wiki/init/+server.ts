import { json, type RequestHandler } from '@sveltejs/kit';
import { initWiki } from '$lib/server/wiki/wikiCore';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({}));
		const result = await initWiki(body ?? {});
		return json(result);
	} catch (error) {
		return json(
			{ ok: false, error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
};
