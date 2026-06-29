import { describe, expect, it } from 'vitest';
import { getBaseUrl, getProviderList, PROVIDERS } from './config';
import type { ProviderType } from '$lib/types';

describe('Z.AI provider metadata', () => {
	const providerType = 'z-ai' as ProviderType;

	it('registers Z.AI as an OpenAI-compatible GLM provider', () => {
		const provider = PROVIDERS[providerType];

		expect(provider).toMatchObject({
			name: 'Z.AI',
			baseUrl: 'https://api.z.ai/api/paas/v4',
			requiresApiKey: true,
			capabilities: {
				textGeneration: true,
				imageGeneration: true,
				structuredOutput: true,
				reasoning: 'native',
			},
		});
		expect(provider.fallbackModels).toEqual(expect.arrayContaining([
			'glm-5.2',
			'glm-5.1',
			'glm-5-turbo',
			'glm-5',
		]));
		expect(provider.services?.narrative.model).toBe('glm-5.2');
		expect(provider.services?.classification.model).toBe('glm-5-turbo');
	});

	it('exposes Z.AI in provider dropdown metadata', () => {
		expect(getBaseUrl(providerType)).toBe('https://api.z.ai/api/paas/v4');
		expect(getProviderList()).toContainEqual(expect.objectContaining({
			value: 'z-ai',
			label: 'Z.AI',
		}));
	});
});
