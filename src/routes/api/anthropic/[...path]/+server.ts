import { error, type RequestHandler } from '@sveltejs/kit';

// Production counterpart of the Vite dev proxy in vite.config.ts. Browser-side
// Anthropic calls (provider test, client generation) use /api/anthropic because
// api.anthropic.com rejects cross-origin browser requests without opt-in headers.
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const ALLOWED = new Map([
	['v1/messages', 'POST'],
	['v1/messages/count_tokens', 'POST'],
	['v1/models', 'GET'],
]);
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'x-api-key', 'authorization'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'request-id', 'retry-after'];

async function forward(request: Request, path: string, method: string): Promise<Response> {
	if (ALLOWED.get(path) !== method) error(404, 'Not an Anthropic API path this proxy forwards.');
	const headers = new Headers();
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	const upstream = await fetch(`${ANTHROPIC_ORIGIN}/${path}${new URL(request.url).search}`, {
		method,
		headers,
		body: method === 'POST' ? await request.arrayBuffer() : undefined,
		signal: request.signal,
	});
	const responseHeaders = new Headers();
	for (const name of FORWARDED_RESPONSE_HEADERS) {
		const value = upstream.headers.get(name);
		if (value) responseHeaders.set(name, value);
	}
	for (const [name, value] of upstream.headers) {
		if (name.startsWith('anthropic-ratelimit-')) responseHeaders.set(name, value);
	}
	return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const POST: RequestHandler = ({ request, params }) => forward(request, params.path ?? '', 'POST');
export const GET: RequestHandler = ({ request, params }) => forward(request, params.path ?? '', 'GET');
