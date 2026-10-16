import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './+server';

const call = (handler: typeof POST, path: string, init: RequestInit) =>
	handler({ request: new Request(`http://localhost/api/anthropic/${path}`, init), params: { path } } as never);

describe('/api/anthropic proxy', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('forwards messages with Anthropic headers only and relays the upstream status', async () => {
		const fetchMock = vi.fn(async () => new Response('{"type":"error"}', { status: 401, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } }));
		vi.stubGlobal('fetch', fetchMock);
		const response = await call(POST, 'v1/messages', { method: 'POST', body: '{"max_tokens":1}',
			headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01', cookie: 'session=secret' } });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		const headers = init.headers as Headers;
		expect(headers.get('x-api-key')).toBe('sk-ant-test');
		expect(headers.get('cookie')).toBeNull();
		expect(response.status).toBe(401);
		expect(response.headers.get('set-cookie')).toBeNull();
	});

	it('refuses paths and methods outside the allowlist', async () => {
		vi.stubGlobal('fetch', vi.fn());
		await expect(call(POST, 'v1/files', { method: 'POST' })).rejects.toMatchObject({ status: 404 });
		await expect(call(GET, 'v1/messages', { method: 'GET' })).rejects.toMatchObject({ status: 404 });
	});
});
