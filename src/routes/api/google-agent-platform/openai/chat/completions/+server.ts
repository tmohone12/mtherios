import type { RequestHandler } from '@sveltejs/kit';
import {
	getGoogleAgentPlatformEndpoint,
	getGoogleAgentPlatformHeaders,
	googleAgentPlatformJsonError,
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

export const POST: RequestHandler = async ({ request, fetch }) => {
	try {
		const endpoint = await getGoogleAgentPlatformEndpoint('chat/completions');
		const response = await fetch(endpoint, {
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
};

