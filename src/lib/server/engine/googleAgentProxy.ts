import {
	GOOGLE_AGENT_PLATFORM_MODELS,
	getGoogleAgentPlatformAccessToken,
	getGoogleAgentPlatformBaseUrl,
	getGoogleAgentPlatformEndpoint,
	getGoogleAgentPlatformHeaders,
} from '$lib/server/ai/googleAgentPlatform';

const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'content-length',
	'host',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

export async function listGoogleAgentModels(): Promise<{
	object: 'list';
	data: Array<{ id: string; object: 'model'; owned_by: 'google' }>;
}> {
	await getGoogleAgentPlatformBaseUrl();
	await getGoogleAgentPlatformAccessToken();
	return {
		object: 'list',
		data: GOOGLE_AGENT_PLATFORM_MODELS.map((id) => ({
			id,
			object: 'model',
			owned_by: 'google',
		})),
	};
}

function requestHeadersForProxy(request: Request, authHeaders: Record<string, string>): Headers {
	const headers = new Headers();
	request.headers.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'authorization') return;
		headers.set(key, value);
	});
	if (!headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	for (const [key, value] of Object.entries(authHeaders)) {
		headers.set(key, value);
	}
	return headers;
}

function responseHeadersForProxy(upstream: Response): Headers {
	const headers = new Headers();
	upstream.headers.forEach((value, key) => {
		if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
		headers.set(key, value);
	});
	return headers;
}

function googleAgentPlatformJsonError(error: unknown, fallbackStatus = 500): Response {
	const message = error instanceof Error ? error.message : String(error);
	return new Response(JSON.stringify({ error: { message, type: 'google_agent_platform_error' } }), {
		status: fallbackStatus,
		headers: { 'Content-Type': 'application/json' },
	});
}

export async function proxyGoogleAgentChatCompletion(
	request: Request,
	fetchImpl: typeof fetch = fetch,
): Promise<Response> {
	try {
		const endpoint = await getGoogleAgentPlatformEndpoint('chat/completions');
		const response = await fetchImpl(endpoint, {
			method: 'POST',
			headers: requestHeadersForProxy(request, await getGoogleAgentPlatformHeaders()),
			body: await request.text(),
			signal: request.signal,
		});

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeadersForProxy(response),
		});
	} catch (error) {
		return googleAgentPlatformJsonError(error, 502);
	}
}

export { googleAgentPlatformJsonError };
