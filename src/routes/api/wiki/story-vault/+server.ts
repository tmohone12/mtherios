import { json, type RequestHandler } from '@sveltejs/kit';
import { getStoryVaultStatus, materializeStoryVault } from '$lib/server/wiki/storyVault';
import { indexWiki } from '$lib/server/wiki/wikiCore';
import { apiError } from '$lib/server/memory/http';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({})) as Record<string, unknown>;
		const storyId = typeof body.storyId === 'string' ? body.storyId.trim() : '';
		if (!storyId) throw new Error('storyId is required.');

		const vault = await materializeStoryVault({
			storyId,
			clean: body.clean !== false,
		});

		const shouldIndex = body.index === true;
		const indexed = shouldIndex
			? await indexWiki({
				storyId,
				recreate: body.recreate === true,
				dryRun: body.dryRun === true,
				provider: typeof body.provider === 'string' ? body.provider : null,
				model: typeof body.model === 'string' ? body.model : null,
			})
			: null;
		const status = await getStoryVaultStatus(storyId);

		return json({
			...vault,
			indexed,
			status,
		});
	} catch (error) {
		return apiError(error);
	}
};
