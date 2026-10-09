import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncTerminalLlmSettingsFromBrowser, syncInheritedGameMasterTools, refreshTerminalLlmSettings, patchTerminalLlmSettings } from './terminalSettings';

const fetchMock = vi.fn();

const settingsMock = vi.hoisted(() => ({
	profiles: [] as import('$lib/types').APIProfile[],
	serviceConfigs: {} as Record<string, unknown>,
	profileModels: {} as Record<string, string>,
	activeProfileId: null as string | null,
	contextBudget: 12000,
	narrativeSettings: { reasoningEffort: 'off' },
	activeProfile: {
		id: 'profile_openai',
		name: 'OpenAI Profile',
		providerType: 'openai',
		baseUrl: null,
		apiKey: 'sk-browser-key',
	},
	getServiceConfig: vi.fn((serviceId: string) => ({
		model: serviceId === 'classifier' || serviceId === 'characterUpdate' || serviceId === 'smallBrain' ? '' : 'gpt-4.1',
		temperature: serviceId === 'smallBrain' ? 0.3 : serviceId === 'classifier' || serviceId === 'characterUpdate' ? 0.2 : 0.8,
		maxTokens: serviceId === 'classifier' ? 1024 : 4096,
		enabled: true,
		systemPromptOverride: serviceId === 'narrative' ? 'Narrate with teeth.' : '',
		...(serviceId === 'batchAuthoring' ? { batchMaxCostUsd: 2.5, batchInputUsdPerMillion: 3,
			batchOutputUsdPerMillion: 12 } : {}),
	})),
	getServiceProfile: vi.fn(() => null),
}));

vi.mock('$lib/stores/settings.svelte', () => ({
	SERVICE_DEFINITIONS: {
		narrative: { profile: 'narrative' },
		classifier: { profile: 'memoryContext' },
		characterUpdate: { profile: 'narrative' },
		smallBrain: { profile: 'narrative' },
		suggestions: { profile: 'guidance' },
		batchAuthoring: { profile: 'batchAuthoring' },
		dialogue: { profile: 'dialogue' },
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
		settingsMock.serviceConfigs = {};
		settingsMock.profileModels = {};
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
			secrets: [],
		});
	});
	it('does not resync retired service configs', async () => {
		await syncTerminalLlmSettingsFromBrowser(['activeRecall', 'worldSimulation']);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it('keeps retired disabled choices readable after a server refresh', async () => {
		fetchMock.mockResolvedValueOnce(engineResponse('settings.llm.list', { settings: ['activeRecall', 'worldSimulation'].map(serviceId => ({
			serviceId, providerType: 'openai', model: `saved-${serviceId}`, temperature: 0.2,
			maxTokens: 900, enabled: false,
		})) }));
		await refreshTerminalLlmSettings();
		expect(settingsMock.serviceConfigs.activeRecall).toMatchObject({ enabled: false, model: 'saved-activeRecall' });
		expect(settingsMock.serviceConfigs.worldSimulation).toMatchObject({ enabled: false, model: 'saved-worldSimulation' });
	});
	it('round trips optional dialogue coverage through server metadata', async () => {
		settingsMock.getServiceConfig.mockImplementationOnce(() => ({ model: 'gpt-4.1', temperature: 0.7,
			maxTokens: 2048, enabled: true, systemPromptOverride: '', dialogueMode: 'important' }));
		fetchMock.mockResolvedValueOnce(engineResponse('settings.llm.save', { settings: [] }));
		await syncTerminalLlmSettingsFromBrowser(['dialogue']);
		const body = await postedCommand();
		expect((body.args as { settings: Array<{ metadata: Record<string, unknown> }> }).settings[0].metadata.dialogueMode).toBe('important');
		fetchMock.mockResolvedValueOnce(engineResponse('settings.llm.list', { settings: [{
			serviceId: 'dialogue', providerType: 'openai', model: 'gpt-4.1', temperature: 0.7,
			maxTokens: 2048, enabled: true, metadata: { dialogueMode: 'important' },
		}] }));
		await refreshTerminalLlmSettings();
		expect(settingsMock.serviceConfigs.dialogue).toMatchObject({ dialogueMode: 'important' });
	});

	it('surfaces failed engine settings sync as terminal settings errors', async () => {
		fetchMock.mockResolvedValue(engineResponse('settings.llm.save', null, 'failed'));

		await expect(syncTerminalLlmSettingsFromBrowser(['narrative']))
			.rejects.toThrow('settings failed');
	});

	it.each([
		['smallBrain', 0.3],
		['characterUpdate', 0.2],
	])('uses classification provider defaults for %s terminal sync', async (serviceId, temperature) => {
		fetchMock.mockResolvedValue(engineResponse('settings.llm.save', { settings: [] }));

		await syncTerminalLlmSettingsFromBrowser([serviceId]);

		const body = await postedCommand();
		expect(body.args).toEqual({
			settings: [
				expect.objectContaining({
					serviceId,
					providerType: 'openai',
					model: 'gpt-4.1-mini',
					temperature,
					maxTokens: 4096,
				}),
			],
			secrets: [],
		});
	});

	it('syncs the batch spend ceiling and conservative prices to server metadata', async () => {
		fetchMock.mockResolvedValue(engineResponse('settings.llm.save', { settings: [] }));
		await syncTerminalLlmSettingsFromBrowser(['batchAuthoring']);
		expect((await postedCommand()).args).toEqual({ settings: [expect.objectContaining({
			serviceId: 'batchAuthoring', metadata: expect.objectContaining({ batchBudget: {
				maxCostUsd: 2.5, inputUsdPerMillion: 3, outputUsdPerMillion: 12,
			} }),
		})], secrets: [] });
	});

	it('sends secrets only during an explicit credential save', async () => {
		fetchMock.mockResolvedValue(engineResponse('settings.llm.save', { settings: [] }));
		await syncTerminalLlmSettingsFromBrowser(['narrative'], true);
		expect((await postedCommand()).args).toEqual(expect.objectContaining({ secrets: [{ ref: 'env:OPENAI_API_KEY', value: 'sk-browser-key' }] }));
	});
	it('updates inherited Memory and Context tasks while preserving saved specialist models', async () => {
		fetchMock.mockResolvedValue(engineResponse('settings.llm.save', { settings: [] }));
		settingsMock.serviceConfigs.characterUpdate = { model: 'specialist-model' };
		settingsMock.profileModels.guidance = 'guidance-model';
		await syncInheritedGameMasterTools();
		const body = await postedCommand();
		const saved = (body.args as { settings: Array<{ serviceId: string }> }).settings.map(setting => setting.serviceId);
		expect(saved).toEqual(['classifier', 'smallBrain']);
	});
	it('changes context budget without sending cached reasoning, provider or credentials', async () => {
		fetchMock.mockResolvedValue(engineResponse('settings.llm.save', { settings: [] }));
		await patchTerminalLlmSettings([{ serviceId: 'narrative', contextBudget: 32000 }]);
		expect((await postedCommand()).args).toEqual({ settings: [{ serviceId: 'narrative', contextBudget: 32000 }], secrets: [] });
	});
	it('mirrors terminal model and reasoning without writing settings or exposing credentials', async () => {
		fetchMock.mockResolvedValue(engineResponse('settings.llm.list', { settings: [{ serviceId: 'narrative', providerType: 'openai', model: 'server-model', reasoningEffort: 'high', apiKeyRef: 'env:OPENAI_API_KEY', contextBudget: 45000 }] }));
		await refreshTerminalLlmSettings();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((await postedCommand()).command).toBe('settings.llm.list');
		expect(settingsMock.narrativeSettings).toMatchObject({ model: 'server-model', reasoningEffort: 'high' });
		expect(settingsMock.contextBudget).toBe(45000);
		expect(settingsMock.serviceConfigs.narrative).toMatchObject({ model: 'server-model' });
		expect(settingsMock.profiles.find(profile => profile.id === settingsMock.activeProfileId)).toMatchObject({ apiKey: '', terminalApiKeyRef: 'env:OPENAI_API_KEY' });
	});
});
