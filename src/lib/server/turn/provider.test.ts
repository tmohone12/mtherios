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

function stubStreamingFetch(chunks: string[]) {
	vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
		requests.push({
			url,
			body: JSON.parse(String(init.body ?? '{}')),
			headers: init.headers as Record<string, string>,
		});
		const encoder = new TextEncoder();
		return new Response(new ReadableStream({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		}), {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream' },
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

	it('repairs lone surrogates before serializing provider messages', async () => {
		stubFetch({
			choices: [{ message: { content: 'The hall grows quiet.' } }],
		});
		const brokenWeatherEmoji = '🌤️'.slice(0, 1);

		await generateServerTextWithMetrics({
			profile: {
				providerType: 'deepseek',
				apiKey: 'test-key',
				baseUrl: 'https://api.deepseek.com/v1',
			} as any,
			model: 'deepseek-chat',
			system: `Stable narrator rules ${brokenWeatherEmoji}`,
			systemDynamic: `Dynamic state ${brokenWeatherEmoji}`,
			messages: [{ role: 'assistant', content: `Earlier narration ${brokenWeatherEmoji}` }],
			prompt: `Player action ${brokenWeatherEmoji}`,
		});

		const body = requests[0].body;
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain('\\ud83c');
		expect(body.messages[0].content).toContain('Stable narrator rules �');
		expect(body.messages[1].content).toContain('Earlier narration �');
		expect(body.messages[2].content).toContain('Player action �');
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

	it('streams OpenAI-compatible text deltas while preserving final metrics', async () => {
		stubStreamingFetch([
			'data: {"choices":[{"delta":{"content":"The hall"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":" wakes."}}]}\n\n',
			'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n',
			'data: [DONE]\n\n',
		]);
		const deltas: string[] = [];

		const result = await generateServerTextWithMetrics({
			profile: {
				providerType: 'openrouter',
				apiKey: 'test-key',
				baseUrl: 'https://openrouter.ai/api/v1',
			} as any,
			model: 'openai/gpt-5-mini',
			system: 'Stable narrator rules.',
			prompt: 'Player action:\nListen.',
			onTextDelta: (chunk) => {
				deltas.push(chunk);
			},
		});

		expect(requests[0].body.stream).toBe(true);
		expect(requests[0].body.stream_options).toEqual({ include_usage: true });
		expect(deltas).toEqual(['The hall', ' wakes.']);
		expect(result.text).toBe('The hall wakes.');
		expect(result.usage).toEqual({ requestTokens: 12, responseTokens: 3, totalTokens: 15 });
	});

	it('streams Anthropic text deltas through the terminal provider path', async () => {
		stubStreamingFetch([
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The court"}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" listens."}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
		]);
		const deltas: string[] = [];

		const result = await generateServerTextWithMetrics({
			profile: {
				providerType: 'anthropic',
				apiKey: 'test-key',
				baseUrl: 'https://api.anthropic.com',
			} as any,
			model: 'claude-sonnet-4-5',
			system: 'Stable narrator rules.',
			prompt: 'Player action:\nListen.',
			onTextDelta: (chunk) => {
				deltas.push(chunk);
			},
		});

		expect(requests[0].body.stream).toBe(true);
		expect(deltas).toEqual(['The court', ' listens.']);
		expect(result.text).toBe('The court listens.');
		expect(result.usage.responseTokens).toBe(5);
	});
});
