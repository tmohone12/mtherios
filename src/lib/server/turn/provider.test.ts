import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateServerTextWithMetrics } from './provider';

const requests: Array<{ url: string; body: Record<string, any>; headers: Record<string, string> }> = [];

function stubFetch(responseBody: Record<string, any>) {
	vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
		requests.push({
			url,
			body: JSON.parse(String(init.body ?? '{}')),
			headers: init.headers as Record<string, string>,
		});
		return new Response(JSON.stringify(responseBody), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}));
}

describe('server generation provider cache hints', () => {
	beforeEach(() => {
		requests.length = 0;
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('sends OpenRouter cache-control breakpoints for stable and dynamic system segments', async () => {
		stubFetch({
			choices: [{ message: { content: 'The hall grows quiet.' } }],
			usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
		});

		await generateServerTextWithMetrics({
			profile: {
				providerType: 'openrouter',
				apiKey: 'test-key',
				baseUrl: 'https://openrouter.ai/api/v1',
			} as any,
			model: 'anthropic/claude-sonnet-4',
			system: 'Stable narrator rules.',
			systemDynamic: 'Per-turn world state.',
			messages: [{ role: 'assistant', content: 'Earlier narration.' }],
			prompt: 'Player action:\nListen.',
		});

		const body = requests[0].body;
		expect(body.messages[0]).toEqual({
			role: 'system',
			content: [
				{ type: 'text', text: 'Stable narrator rules.', cache_control: { type: 'ephemeral' } },
				{ type: 'text', text: 'Per-turn world state.' },
			],
		});
		expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Player action:\nListen.' });
	});

	it('sends Anthropic system cache-control blocks through the terminal provider path', async () => {
		stubFetch({
			content: [{ type: 'text', text: 'The court waits.' }],
			usage: { input_tokens: 80, output_tokens: 10 },
		});

		await generateServerTextWithMetrics({
			profile: {
				providerType: 'anthropic',
				apiKey: 'test-key',
				baseUrl: 'https://api.anthropic.com',
			} as any,
			model: 'claude-sonnet-4-5',
			system: 'Stable narrator rules.',
			systemDynamic: 'Per-turn world state.',
			prompt: 'Player action:\nListen.',
		});

		const body = requests[0].body;
		expect(body.system).toEqual([
			{ type: 'text', text: 'Stable narrator rules.', cache_control: { type: 'ephemeral' } },
			{ type: 'text', text: 'Per-turn world state.' },
		]);
		expect(body.messages).toEqual([{ role: 'user', content: 'Player action:\nListen.' }]);
	});

	it('passes an abort signal to upstream provider fetches so turns cannot hang indefinitely', async () => {
		stubFetch({
			choices: [{ message: { content: 'The hall grows quiet.' } }],
		});

		await generateServerTextWithMetrics({
			profile: {
				providerType: 'openrouter',
				apiKey: 'test-key',
				baseUrl: 'https://openrouter.ai/api/v1',
			} as any,
			model: 'zai-org/glm-5.1',
			system: 'Stable narrator rules.',
			prompt: 'Player action:\nListen.',
		});

		const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
	});

	it('reports upstream provider timeout as a structured server generation error', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
			const signal = init.signal as AbortSignal;
			signal.addEventListener('abort', () => reject(signal.reason), { once: true });
		})));

		const result = generateServerTextWithMetrics({
			profile: {
				providerType: 'openrouter',
				apiKey: 'test-key',
				baseUrl: 'https://openrouter.ai/api/v1',
			} as any,
			model: 'zai-org/glm-5.1',
			system: 'Stable narrator rules.',
			prompt: 'Player action:\nListen.',
			timeoutMs: 25,
		});

		const assertion = expect(result).rejects.toMatchObject({
			name: 'ServerGenerationError',
			message: 'Server LLM request timed out after 25ms',
			result: {
				model: 'zai-org/glm-5.1',
				endpoint: 'https://openrouter.ai/api/v1/chat/completions',
				durationMs: expect.any(Number),
				promptChars: 44,
			},
		});
		await vi.advanceTimersByTimeAsync(30);
		await assertion;
	});
});
