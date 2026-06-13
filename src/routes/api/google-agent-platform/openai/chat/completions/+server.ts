import type { RequestHandler } from '@sveltejs/kit';
import { proxyGoogleAgentChatCompletion } from '$lib/server/engine/googleAgentProxy';

export const POST: RequestHandler = async ({ request, fetch }) => {
	return await proxyGoogleAgentChatCompletion(request, fetch);
};

