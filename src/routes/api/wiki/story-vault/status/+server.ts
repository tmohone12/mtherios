import { json, type RequestHandler } from '@sveltejs/kit';
import { getStoryVaultStatus } from '$lib/server/wiki/storyVault';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const storyId = url.searchParams.get('storyId')?.trim() ?? '';
		if (!storyId) throw new Error('storyId is required.');
		return json({
			ok: true,
			...(await getStoryVaultStatus(storyId)),
		});
	} catch (error) {
		return apiError(error);
	}
};
