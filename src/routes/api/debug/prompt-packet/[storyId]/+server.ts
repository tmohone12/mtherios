import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		if (!params.storyId) return json({ error: 'Missing story id.' }, { status: 400 });
		const query = url.searchParams.get('q') ?? 'current scene';
		const requestedContextBudget = url.searchParams.get('contextBudget');
		return json(await executeLegacyEngineCommand({
			storyId: params.storyId,
			command: 'debug.promptPacket',
			args: {
				query,
				tokenBudget: Number(url.searchParams.get('tokenBudget') ?? '1200'),
				...(url.searchParams.has('recentDialogueTokens') ? { recentDialogueTokens: Number(url.searchParams.get('recentDialogueTokens')) } : {}),
				...(url.searchParams.has('recentDialogueTurns') ? { recentDialogueTurns: Number(url.searchParams.get('recentDialogueTurns')) } : {}),
				...(requestedContextBudget ? { contextBudget: Number(requestedContextBudget) } : {}),
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};
