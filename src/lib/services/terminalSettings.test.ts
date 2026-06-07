import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncTerminalLlmSettingsFromBrowser } from './terminalSettings';

const fetchMock = vi.fn();

const settingsMock = vi.hoisted(() => ({
	contextBudget: 12000,
	activeProfile: {
		id: 'profile_openai',
		name: 'OpenAI Profile',
		providerType: 'openai',
		baseUrl: null,
		apiKey: 'sk-browser-key',
	},
	getServiceConfig: vi.fn((serviceId: string) => ({
		model: serviceId === 'classifier' ? '' : 'gpt-4.1',
		temperature: serviceId === 'classifier' ? 0.2 : 0.8,
		maxTokens: serviceId === 'classifier' ? 1024 : 4096,
		enabled: true,
		systemPromptOverride: serviceId === 'narrative' ? 'Narrate with teeth.' : '',
	})),
	getServiceProfile: vi.fn(() => null),
}));

vi.mock('$lib/stores/settings.svelte', () => ({
	SERVICE_DEFINITIONS: {
		narrative: {},
		classifier: {},
	},
	settings: settingsMock,
}));

vi.mock('$lib/services/ai/sdk/providers/config', () => ({
	PROVIDERS: {
		openai: {
			requiresApiKey: true,
			baseUrl: 'https://api.openai.com/v1',
			fallbackModels: ['gpt-4.1-mini'],
			services: {
				narrative: { model: 'gpt-4.1' },
				classification: { model: 'gpt-4.1-mini' },
			},
		},
	},
}));

function engineResponse(command: string, result: unknown, status: 'succeeded' | 'failed' = 'succeeded'): Response {
	return new Response(JSON.stringify({
		commandId: `cmd_${command}`,
		clientCommandId: null,
		storyId: '__app__',
		command,
		status,
		result,
		projectionChanges: {},
		error: status === 'failed' ? 'settings failed' : null,
		createdAt: '2026-06-07T00:00:00.000Z',
		updatedAt: '2026-06-07T00:00:00.000Z',
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

async function postedCommand(): Promise<Record<string, unknown>> {
	expect(fetchMock).toHaveBeenCalledWith('/api/engine/command', expect.objectContaining({
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
	}));
	const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
	return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('terminal settings engine gateway client', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		settingsMock.getServiceConfig.mockClear();
		settingsMock.getServiceProfile.mockClear();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('syncs browser LLM settings through the shared engine command gateway', async () => {
		fetchMock.mockResolvedValue(engineResponse('settings.llm.save', { settings: [] }));

		await syncTerminalLlmSettingsFromBrowser(['narrative', 'classifier']);

		const body = await postedCommand();
		expect(body.storyId).toBe('__app__');
		expect(body.command).toBe('settings.llm.save');
		expect(body.args).toEqual({
			settings: [
				expect.objectContaining({
					serviceId: 'narrative',
					providerType: 'openai',
					baseUrl: 'https://api.openai.com/v1',
					model: 'gpt-4.1',
					temperature: 0.8,
					maxTokens: 4096,
					contextBudget: 12000,
					enabled: true,
					systemPromptOverride: 'Narrate with teeth.',
					apiKeyRef: 'env:OPENAI_API_KEY',
					metadata: expect.objectContaining({
						source: 'frontend_settings',
						profileId: 'profile_openai',
						browserProfileHasLocalKey: true,
						syncedAt: expect.any(String),
					}),
				}),
				expect.objectContaining({
					serviceId: 'classifier',
					providerType: 'openai',
					model: 'gpt-4.1-mini',
					temperature: 0.2,
					maxTokens: 1024,
					systemPromptOverride: null,
					apiKeyRef: 'env:OPENAI_API_KEY',
				}),
			],
			secrets: [{ ref: 'env:OPENAI_API_KEY', value: 'sk-browser-key' }],
		});
	});

	it('surfaces failed engine settings sync as terminal settings errors', async () => {
		fetchMock.mockResolvedValue(engineResponse('settings.llm.save', null, 'failed'));

		await expect(syncTerminalLlmSettingsFromBrowser(['narrative']))
			.rejects.toThrow('settings failed');
	});
});
