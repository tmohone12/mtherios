import { describe, expect, it, vi } from 'vitest';
import { anthropicHeaders, fetchAnthropicModels, fetchOpenAICompatibleModels } from './modelLists';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Anthropic model list', () => {
	it('asks the proxy for full pages with the API key and follows has_more to the end, newest first', async () => {
		const fetchImpl = vi.fn()
			.mockResolvedValueOnce(json({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }], has_more: true, first_id: 'claude-opus-5-5', last_id: 'claude-sonnet-5-5' }))
			.mockResolvedValueOnce(json({ data: [{ id: 'claude-haiku-5-5' }, { id: 'claude-sonnet-5-5' }], has_more: false, last_id: 'claude-haiku-5-5' }));
		const ids = await fetchAnthropicModels('', 'sk-ant-api-key', fetchImpl as typeof fetch);
		expect(ids).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
		expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
			'/api/anthropic/v1/models?limit=1000',
			'/api/anthropic/v1/models?limit=1000&after_id=claude-sonnet-5-5',
		]);
		expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': 'sk-ant-api-key', 'anthropic-version': '2023-06-01' });
		expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
	});

	it('sends a setup token as a Bearer token with the OAuth beta, to a custom base URL', async () => {
		expect(anthropicHeaders('sk-ant-oat-token')).toEqual({ 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
			Authorization: 'Bearer sk-ant-oat-token', 'anthropic-beta': 'oauth-2025-04-20' });
		const fetchImpl = vi.fn().mockResolvedValue(json({ data: [{ id: 'claude-opus-5-5' }], has_more: false }));
		await fetchAnthropicModels('https://api.anthropic.com/', 'sk-ant-oat-token', fetchImpl as typeof fetch);
		expect(fetchImpl.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=1000');
	});

	it('reports the API error instead of an empty list', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
		await expect(fetchAnthropicModels('', 'bad', fetchImpl as typeof fetch)).rejects.toThrow(/^HTTP 401: .*invalid x-api-key/);
	});
});

describe('OpenAI-compatible model list', () => {
	it('reads the data, models or bare-array shapes and sorts the IDs', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(json({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] }));
		expect(await fetchOpenAICompatibleModels('https://openrouter.ai/api/v1/', 'key', fetchImpl as typeof fetch)).toEqual(['a', 'b']);
		expect(fetchImpl.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
		expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer key' });
	});
});
