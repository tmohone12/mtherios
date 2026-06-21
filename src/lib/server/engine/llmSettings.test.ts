import { describe, expect, it } from 'vitest';
import { mergeLlmServiceSettingPatch } from './llmSettings';
import type { LlmServiceSetting } from '$lib/contracts/engine';

function setting(): LlmServiceSetting {
	return {
		serviceId: 'narrative',
		providerType: 'openrouter',
		baseUrl: 'https://openrouter.ai/api/v1',
		model: 'z-ai/glm-5',
		temperature: 1,
		maxTokens: 4096,
		topP: null,
		frequencyPenalty: null,
		presencePenalty: null,
		reasoningEffort: null,
		contextBudget: null,
		enabled: true,
		systemPromptOverride: null,
		apiKeyRef: 'env:OPENROUTER_API_KEY',
		metadata: { source: 'test' },
	};
}

describe('LLM settings patches', () => {
	it('changes the model without clearing the existing provider settings', () => {
		expect(mergeLlmServiceSettingPatch(setting(), {
			serviceId: 'narrative',
			model: 'deepseek/deepseek-v3.2',
		})).toEqual(expect.objectContaining({
			serviceId: 'narrative',
			providerType: 'openrouter',
			baseUrl: 'https://openrouter.ai/api/v1',
			model: 'deepseek/deepseek-v3.2',
			apiKeyRef: 'env:OPENROUTER_API_KEY',
		}));
	});
});
