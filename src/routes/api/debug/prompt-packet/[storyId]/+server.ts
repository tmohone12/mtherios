import { json, type RequestHandler } from '@sveltejs/kit';
import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { loadTurnContext } from '$lib/server/turn/context';
import { buildServerTurnPrompt } from '$lib/server/turn/promptPacket';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		if (!params.storyId) return json({ error: 'Missing story id.' }, { status: 400 });
		const query = url.searchParams.get('q') ?? 'current scene';
		const retrieved = await retrieveMemoryPacket({
			storyId: params.storyId,
			query,
			tokenBudget: Number(url.searchParams.get('tokenBudget') ?? '1200'),
		});
		const ctx = await loadTurnContext(params.storyId);
		const prompt = buildServerTurnPrompt(ctx, retrieved, 'debug_prompt', {});
		return json({
			storyId: params.storyId,
			query,
			retrieved,
			prompt,
			tokenEstimate: retrieved.tokenEstimate,
		});
	} catch (error) {
		return apiError(error);
	}
};
