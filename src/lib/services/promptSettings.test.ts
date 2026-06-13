import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmServiceSetting } from '$lib/contracts/engine';
import {
	buildPromptOverridePatch,
	loadTerminalPromptSettings,
	saveTerminalPromptOverrides,
} from './promptSettings';

const fetchMock = vi.fn();

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
		createdAt: '2026-06-12T00:00:00.000Z',
		updatedAt: '2026-06-12T00:00:00.000Z',
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

function setting(serviceId: string, systemPromptOverride: string | null): LlmServiceSetting {
	return {
		serviceId,
		providerType: serviceId === 'narrative' ? 'deepseek' : 'openrouter',
		baseUrl: 'https://example.test/v1',
		model: serviceId === 'narrative' ? 'deepseek-v4-pro' : 'deepseek/deepseek-v4-flash',
		temperature: serviceId === 'narrative' ? 1 : 0.2,
		maxTokens: serviceId === 'narrative' ? 8192 : 2048,
		topP: null,
		frequencyPenalty: null,
		presencePenalty: null,
		reasoningEffort: null,
		contextBudget: 12000,
		enabled: true,
		systemPromptOverride,
		apiKeyRef: 'env:TEST_KEY',
		metadata: { source: 'test' },
		createdAt: '2026-06-12T00:00:00.000Z',
		updatedAt: '2026-06-12T00:00:00.000Z',
	};
}

async function lastPatchBody(): Promise<Record<string, unknown>> {
	expect(fetchMock).toHaveBeenCalledWith('/api/settings/llm', expect.objectContaining({
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
	}));
	const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
	return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('terminal prompt settings client', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('builds prompt override patches without changing provider or model settings', () => {
		const rows = [
			setting('narrative', 'Old custom prompt'),
			setting('classifier', null),
		];

		const patch = buildPromptOverridePatch(rows, {
			narrative: '',
			classifier: 'Return strict JSON.',
		});

		expect(patch).toEqual([
			expect.objectContaining({
				serviceId: 'narrative',
				providerType: 'deepseek',
				model: 'deepseek-v4-pro',
				temperature: 1,
				systemPromptOverride: null,
			}),
			expect.objectContaining({
				serviceId: 'classifier',
				providerType: 'openrouter',
				model: 'deepseek/deepseek-v4-flash',
				temperature: 0.2,
				systemPromptOverride: 'Return strict JSON.',
			}),
		]);
	});

	it('loads terminal LLM settings from the shared settings endpoint', async () => {
		fetchMock.mockResolvedValue(engineResponse('settings.llm.list', {
			settings: [setting('narrative', 'Old custom prompt')],
		}));

		const rows = await loadTerminalPromptSettings();

		expect(fetchMock).toHaveBeenCalledWith('/api/settings/llm', { method: 'GET' });
		expect(rows.map((row) => row.serviceId)).toEqual(['narrative']);
	});

	it('accepts the unwrapped settings result returned by the SvelteKit settings route', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({
			settings: [setting('narrative', null)],
		}), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}));

		const rows = await loadTerminalPromptSettings();

		expect(rows).toHaveLength(1);
		expect(rows[0].serviceId).toBe('narrative');
		expect(rows[0].systemPromptOverride).toBeNull();
	});

	it('saves unwrapped settings responses from the SvelteKit settings route', async () => {
		const rows = [setting('narrative', 'Old custom prompt')];
		fetchMock.mockResolvedValue(new Response(JSON.stringify({
			settings: [{ ...rows[0], systemPromptOverride: null }],
		}), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		}));

		const saved = await saveTerminalPromptOverrides(rows, { narrative: '' });

		expect(saved[0].systemPromptOverride).toBeNull();
	});

	it('saves changed prompt overrides through the terminal settings endpoint', async () => {
		const rows = [setting('narrative', 'Old custom prompt')];
		fetchMock.mockResolvedValue(engineResponse('settings.llm.save', { settings: rows }));

		await saveTerminalPromptOverrides(rows, { narrative: '' });

		const body = await lastPatchBody();
		expect(body).toEqual({
			settings: [
				expect.objectContaining({
					serviceId: 'narrative',
					providerType: 'deepseek',
					model: 'deepseek-v4-pro',
					systemPromptOverride: null,
				}),
			],
		});
	});
});
