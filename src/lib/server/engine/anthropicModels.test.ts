import { describe, expect, it, vi } from 'vitest';
import type { LlmServiceSetting } from '$lib/contracts/engine';

const mocks = vi.hoisted(() => ({ resolveApiKeyRef: vi.fn() }));
vi.mock('./llmEnvironment', () => ({ resolveApiKeyRef: mocks.resolveApiKeyRef }));
import { listSavedAnthropicModels } from './anthropicModels';

const setting = (overrides: Partial<LlmServiceSetting>) => ({ serviceId: 'narrative', providerType: 'anthropic', baseUrl: null, apiKeyRef: 'env:ANTHROPIC_API_KEY', ...overrides }) as LlmServiceSetting;
const models = () => vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }], has_more: false }), { status: 200 }));

describe('saved Anthropic model list', () => {
	it('lists models with the saved key, which stays on the server, at the Anthropic API', async () => {
		mocks.resolveApiKeyRef.mockReturnValue('sk-ant-server-key');
		const fetchImpl = models();
		const ids = await listSavedAnthropicModels({ apiKeyRef: 'env:ANTHROPIC_API_KEY', baseUrl: null }, [setting({})], fetchImpl as typeof fetch);
		expect(ids).toEqual(['claude-opus-5-5']);
		expect(mocks.resolveApiKeyRef).toHaveBeenCalledWith('env:ANTHROPIC_API_KEY');
		expect(fetchImpl.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=1000');
		expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': 'sk-ant-server-key' });
	});

	it('refuses a key reference or URL that no Anthropic setting saved together', async () => {
		mocks.resolveApiKeyRef.mockReturnValue('secret');
		const fetchImpl = models();
		const saved = [setting({}), setting({ providerType: 'openrouter', apiKeyRef: 'env:DATABASE_URL', baseUrl: 'https://evil.example' })];
		for (const args of [{ apiKeyRef: 'env:DATABASE_URL', baseUrl: null }, { apiKeyRef: 'env:DATABASE_URL', baseUrl: 'https://evil.example' },
			{ apiKeyRef: 'env:ANTHROPIC_API_KEY', baseUrl: 'https://evil.example' }, {}]) {
			await expect(listSavedAnthropicModels(args, saved, fetchImpl as typeof fetch)).rejects.toThrow();
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('says when the saved key has no value on the server', async () => {
		mocks.resolveApiKeyRef.mockReturnValue('');
		await expect(listSavedAnthropicModels({ apiKeyRef: 'env:ANTHROPIC_API_KEY' }, [setting({})], models() as typeof fetch))
			.rejects.toThrow('The server has no value for the Anthropic key env:ANTHROPIC_API_KEY');
	});
});
