import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateServerTextWithMetrics, getProviderCapabilities } from './provider';

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

	it('sends OpenAI prompt cache fields and reports cached-token usage', async () => {
		stubFetch({
			choices: [{ message: { content: 'The hall grows quiet.' }, finish_reason: 'stop' }],
			usage: {
				prompt_tokens: 2048,
				completion_tokens: 128,
				total_tokens: 2176,
				prompt_tokens_details: { cached_tokens: 1024 },
				completion_tokens_details: { reasoning_tokens: 64 },
			},
		});

		const result = await generateServerTextWithMetrics({
			profile: {
				providerType: 'openai',
				apiKey: 'test-key',
			} as any,
			model: 'gpt-5',
			system: 'Stable narrator rules.',
			prompt: 'Player action:\nListen.',
			cache: {
				key: 'mtherios:v3:openai:gpt-5:story:test',
				retention: 'in_memory',
			},
		});

		expect(requests[0].body.prompt_cache_key).toBe('mtherios:v3:openai:gpt-5:story:test');
		expect(requests[0].body.prompt_cache_retention).toBe('in-memory');
		expect(result.usage).toMatchObject({
			requestTokens: 2048,
			inputTokens: 2048,
			cachedInputTokens: 1024,
			responseTokens: 128,
			outputTokens: 128,
			reasoningTokens: 64,
			totalTokens: 2176,
		});
		expect(result.finishReason).toBe('stop');
	});

	it('captures OpenAI-compatible length finish reasons from provider responses', async () => {
		stubFetch({
			choices: [{ message: { content: 'The sentence is' }, finish_reason: 'length' }],
			usage: { prompt_tokens: 20, completion_tokens: 4096, total_tokens: 4116 },
		});

		const result = await generateServerTextWithMetrics({
			profile: {
				providerType: 'z-ai',
				apiKey: 'test-key',
				baseUrl: 'https://api.z.ai/api/paas/v4',
			} as any,
			model: 'glm-5.2',
			system: 'Stable narrator rules.',
			prompt: 'Player action:\nContinue.',
		});

		expect(result.text).toBe('The sentence is');
		expect(result.finishReason).toBe('length');
	});

	it('reports provider runtime capabilities from existing provider metadata', () => {
		expect(getProviderCapabilities({ providerType: 'openai', apiKey: 'test-key' } as any)).toMatchObject({
			cacheMode: 'openai_implicit',
			structuredOutputs: true,
			nativeTokenCounting: true,
		});
		expect(getProviderCapabilities({ providerType: 'anthropic', apiKey: 'test-key' } as any)).toMatchObject({
			cacheMode: 'anthropic_breakpoint',
			structuredOutputs: false,
			nativeTokenCounting: true,
		});
		expect(getProviderCapabilities({ providerType: 'openrouter', apiKey: 'test-key' } as any)).toMatchObject({
			cacheMode: 'openrouter',
			structuredOutputs: true,
		});
		expect(getProviderCapabilities({ providerType: 'z-ai', apiKey: 'test-key' } as any, 'glm-5.2')).toMatchObject({
			cacheMode: 'none',
			structuredOutputs: true,
			nativeTokenCounting: true,
		});
	});

	it('retries transient provider failures and reports retry count', async () => {
		vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
			requests.push({
				url,
				body: JSON.parse(String(init.body ?? '{}')),
				headers: init.headers as Record<string, string>,
			});
			if (requests.length === 1) {
				return new Response('rate limited', { status: 429, statusText: 'Too Many Requests' });
			}
			return new Response(JSON.stringify({
				choices: [{ message: { content: 'The hall grows quiet.' } }],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}));

		const result = await generateServerTextWithMetrics({
			profile: {
				providerType: 'openai',
				apiKey: 'test-key',
			} as any,
			model: 'gpt-5-mini',
			system: 'Stable narrator rules.',
			prompt: 'Player action:\nListen.',
		});

		expect(requests).toHaveLength(2);
		expect(result.text).toBe('The hall grows quiet.');
		expect(result.retryCount).toBe(1);
	});

	it('sends strict OpenAI-compatible JSON schema response formats', async () => {
		stubFetch({
			choices: [{ message: { content: '{"update":{}}' } }],
			usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
		});

		await generateServerTextWithMetrics({
			profile: {
				providerType: 'openai',
				apiKey: 'test-key',
			} as any,
			model: 'gpt-5-mini',
			system: 'Extract state.',
			prompt: 'Narration changed nothing.',
			responseSchema: {
				name: 'mtherios_state_patch',
				strict: true,
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: { update: { type: 'object' } },
					required: ['update'],
				},
			},
			onTextDelta: () => {
				throw new Error('schema calls should not stream');
			},
		});

		expect(requests[0].body.stream).toBeUndefined();
		expect(requests[0].body.response_format).toEqual({
			type: 'json_schema',
			json_schema: {
				name: 'mtherios_state_patch',
				strict: true,
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: { update: { type: 'object' } },
					required: ['update'],
				},
			},
		});
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
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
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
		expect(result.usage).toMatchObject({ requestTokens: 12, responseTokens: 3, totalTokens: 15 });
		expect(result.finishReason).toBe('stop');
		expect(result.timeToFirstTokenMs).toEqual(expect.any(Number));
	});

	it('streams Anthropic text deltas through the terminal provider path', async () => {
		stubStreamingFetch([
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The court"}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" listens."}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
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
		expect(result.finishReason).toBe('end_turn');
	});
});
