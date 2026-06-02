import { json, type RequestHandler } from '@sveltejs/kit';
import { searchQuerySchema } from '$lib/contracts/engine';
import { searchCanonicalWorld } from '$lib/server/engine/canonicalSearch';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const request = searchQuerySchema.parse({
			q: url.searchParams.get('q') ?? '',
			type: url.searchParams.get('type'),
			limit: Number(url.searchParams.get('limit') ?? '12'),
			includeSemantic: url.searchParams.get('semantic') !== 'false',
		});
		return json(await searchCanonicalWorld({
			storyId: params.id,
			query: request.q,
			type: request.type,
			limit: request.limit,
			includeSemantic: request.includeSemantic,
		}));
	} catch (error) {
		return apiError(error);
	}
};
