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

	it('stops a pending request at the configured timeout', async () => {
		vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
			init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason), { once: true });
		})));
		await expect(generateServerTextWithMetrics({
			profile: { providerType: 'openai', apiKey: 'test-key' } as any,
			model: 'test-model', system: 'Test.', prompt: 'Wait.', timeoutMs: 20, maxRetries: 0,
		})).rejects.toThrow('timed out after 20ms');
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('forwards cancellation to a pending provider request', async () => {
		vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
			init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason), { once: true });
		})));
		const abort = new AbortController();
		const pending = generateServerTextWithMetrics({
			profile: { providerType: 'openai', apiKey: 'test-key' } as any,
			model: 'test-model', system: 'Test.', prompt: 'Wait.', timeoutMs: 1_000, maxRetries: 0, signal: abort.signal,
		});
		abort.abort(new Error('Assistant run cancelled.'));
		await expect(pending).rejects.toThrow('Assistant run cancelled.');
		expect(fetch).toHaveBeenCalledTimes(1);
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
			cache: { key: 'story-session' },
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
		expect(body.session_id).toBe('story-session');
	});

	it('keeps the campaign-history cache breakpoint when scene wiki changes', async () => {
		stubFetch({ choices: [{ message: { content: 'Done.' } }] });
		const system = 'Campaign history.\n\nScene wiki.';
		await generateServerTextWithMetrics({
			profile: { providerType: 'openrouter', apiKey: 'test-key' } as any,
			model: 'anthropic/claude-sonnet-4', system,
			systemCacheBoundary: system.indexOf('Scene wiki.'),
			systemDynamic: 'Current scene.', prompt: 'Act.',
		});
		expect(requests[0].body.messages[0].content).toEqual([
			{ type: 'text', text: 'Campaign history.\n\n', cache_control: { type: 'ephemeral' } },
			{ type: 'text', text: 'Scene wiki.', cache_control: { type: 'ephemeral' } },
			{ type: 'text', text: 'Current scene.' },
		]);
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

	it('counts native Anthropic cache reads and writes in total input', async () => {
		stubFetch({ content: [{ type: 'text', text: 'Done.' }], usage: {
			input_tokens: 12, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300, output_tokens: 5,
		} });
		const result = await generateServerTextWithMetrics({
			profile: { providerType: 'anthropic', apiKey: 'test-key' } as any,
			model: 'claude-sonnet-4-5', system: 'Rules.', prompt: 'Continue.',
		});
		expect(result.usage).toMatchObject({ requestTokens: 1512, inputTokens: 1512,
			cachedInputTokens: 1200, cacheWriteTokens: 300, responseTokens: 5, totalTokens: 1517 });
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
				cost: 0.01234,
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
			providerCostUsd: 0.01234,
		});
		expect(result.finishReason).toBe('stop');
	});

	it('uses the NanoGPT charged-USD receipt before the generic usage cost', async () => {
		stubFetch({
			choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 },
			x_nanogpt_pricing: { cost: 0.0042, currency: 'USD', inputTokens: 100, outputTokens: 20 },
		});
		const result = await generateServerTextWithMetrics({
			profile: { providerType: 'nanogpt', apiKey: 'test-key' } as any,
			model: 'zai-org/glm-5:thinking', system: 'Test.', prompt: 'Reply.',
		});
		expect(result.usage.providerCostUsd).toBe(0.0042);
	});
	it('keeps NanoGPT dialogue ahead of changing turn context across successive turns', async () => {
		stubFetch({ choices: [{ message: { content: 'The scene continues.' } }],
			usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
		const profile = { providerType: 'nanogpt', apiKey: 'test-key' } as any;
		const earlier = [
			{ role: 'user' as const, content: 'I ask about the gate.' },
			{ role: 'assistant' as const, content: 'The guard answers.' },
		];
		await generateServerTextWithMetrics({ profile, model: 'z-ai/glm-5.3', system: 'Stable rules and chapter.',
			systemDynamic: 'Current scene: gate closed.', messages: earlier,
			prompt: 'Player action: I wait.', contextAfterDialogue: true });
		await generateServerTextWithMetrics({ profile, model: 'z-ai/glm-5.3', system: 'Stable rules and chapter.',
			systemDynamic: 'Current scene: gate open.', messages: [...earlier,
				{ role: 'user', content: 'I wait.' }, { role: 'assistant', content: 'The gate opens.' }],
			prompt: 'Player action: I enter.', contextAfterDialogue: true });
		const firstPrefix = requests[0].body.messages.slice(0, -1);
		expect(requests[1].body.messages.slice(0, firstPrefix.length)).toEqual(firstPrefix);
		expect(firstPrefix.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant']);
		expect(firstPrefix[0].content).not.toContain('Current scene:');
		expect(requests[0].body.messages.at(-1).content).toContain('Current scene: gate closed.');
		expect(requests[1].body.messages.at(-1).content).toMatch(/Current scene: gate open\.[\s\S]*Player action: I enter\./);
	});

	it('keeps OpenRouter dialogue in a reusable prefix until a chapter or budget boundary', async () => {
		stubFetch({ choices: [{ message: { content: 'The scene continues.' } }] });
		const profile = { providerType: 'openrouter', apiKey: 'test-key' } as any;
		const chapterA = 'Stable rules.\n\nChapter A.';
		const earlier = [
			{ role: 'user' as const, content: 'I ask about the gate.' },
			{ role: 'assistant' as const, content: 'The guard answers.' },
		];
		const common = { profile, model: 'anthropic/claude-sonnet-4',
			systemCacheBoundary: chapterA.indexOf('Chapter A.'), contextAfterDialogue: true,
			cache: { key: 'story-session' } };
		await generateServerTextWithMetrics({ ...common, system: chapterA,
			systemDynamic: 'Current scene: gate closed.', messages: earlier,
			prompt: 'Player action: I wait.' });
		await generateServerTextWithMetrics({ ...common, system: chapterA,
			systemDynamic: 'Current scene: gate open.', messages: [...earlier,
				{ role: 'user', content: 'I wait.' }, { role: 'assistant', content: 'The gate opens.' }],
			prompt: 'Player action: I enter.' });
		const firstPrefix = requests[0].body.messages.slice(0, -1);
		const textMessages = (messages: any[]) => messages.map(message => ({ ...message,
			content: Array.isArray(message.content) ? message.content.map((block: any) => block.text).join('') : message.content }));
		expect(textMessages(requests[1].body.messages.slice(0, firstPrefix.length))).toEqual(textMessages(firstPrefix));
		expect(firstPrefix.at(-1).content[0].cache_control).toEqual({ type: 'ephemeral' });
		expect(requests[1].body.messages.at(-2).content[0]).toMatchObject({ text: 'The gate opens.', cache_control: { type: 'ephemeral' } });
		expect(firstPrefix.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant']);
		expect(firstPrefix[0].content).toEqual([
			{ type: 'text', text: 'Stable rules.\n\n', cache_control: { type: 'ephemeral' } },
			{ type: 'text', text: 'Chapter A.', cache_control: { type: 'ephemeral' } },
		]);
		expect(requests[0].body.messages.at(-1).content).toMatch(/Current scene: gate closed\.[\s\S]*Player action: I wait\./);
		expect(requests[1].body.messages.at(-1).content).toMatch(/Current scene: gate open\.[\s\S]*Player action: I enter\./);

		await generateServerTextWithMetrics({ ...common, system: 'Stable rules.\n\nChapter B.',
			systemDynamic: 'Current scene: new chapter.', messages: [], prompt: 'Player action: I listen.' });
		expect(requests[2].body.messages[0].content[1].text).toBe('Chapter B.');
		expect(requests[2].body.messages).toHaveLength(2);
		await generateServerTextWithMetrics({ ...common, system: chapterA,
			systemDynamic: 'Current scene: later.', messages: [
				{ role: 'user', content: 'I wait.' }, { role: 'assistant', content: 'The gate opens.' }],
			prompt: 'Player action: I listen.' });
		expect(requests[3].body.messages[0]).toEqual(requests[0].body.messages[0]);
		expect(requests[3].body.messages[1]).not.toEqual(requests[0].body.messages[1]);
	});

	it.each(['openrouter', 'anthropic', 'openai', 'nanogpt'])('keeps fresh native GM context after history on %s, including tool continuations', async providerType => {
		stubFetch({ choices: [{ message: { content: 'Done.' } }], content: [{ type: 'text', text: 'Done.' }] });
		const history = [
			{ role: 'user' as const, content: 'Earlier action.' },
			{ role: 'assistant' as const, content: 'Earlier narration.' },
			{ role: 'user' as const, content: 'Current action.' },
			{ role: 'assistant' as const, content: '', toolCalls: [{ id: 'read-1', name: 'read', arguments: {} }] },
			{ role: 'tool' as const, content: 'Fresh evidence.', toolCallId: 'read-1', toolName: 'read' },
		];
		const before = structuredClone(history);
		const common = { profile: { providerType, apiKey: 'test-key' } as any,
			model: providerType === 'anthropic' ? 'claude-sonnet-4-5' : 'anthropic/claude-sonnet-4',
			system: 'Instructions. Reference. History. Wiki.', systemCacheBoundaries: [13, 23],
			messages: history, appendPrompt: false, prompt: '', contextAfterDialogue: true,
			cache: { key: 'stable-story' } };
		for (const snapshot of ['Scene revision 1.', 'Scene revision 2.']) {
			await generateServerTextWithMetrics({ ...common, systemDynamic: snapshot });
		}
		const bodies = requests.map(request => request.body);
		const system = providerType === 'anthropic' ? bodies[0].system : bodies[0].messages[0].content;
		expect(JSON.stringify(system)).not.toContain('Scene revision');
		const dialogue = bodies.map(body => providerType === 'anthropic' ? body.messages : body.messages.slice(1));
		expect(dialogue[1].slice(0, 2)).toEqual(dialogue[0].slice(0, 2));
		expect(JSON.stringify(dialogue[0][2])).toContain('Scene revision 1.');
		expect(JSON.stringify(dialogue[1][2])).toContain('Scene revision 2.');
		expect(JSON.stringify(dialogue[1][2])).toContain('Current action.');
		expect(JSON.stringify(dialogue[1].slice(3))).toContain('read-1');
		expect(JSON.stringify(dialogue[1].slice(3))).toContain('Fresh evidence.');
		expect(JSON.stringify(bodies[0]).match(/cache_control/g)?.length ?? 0).toBe(['anthropic', 'openrouter'].includes(providerType) ? 4 : 0);
		expect(history).toEqual(before);
	});

	it('extends Gemini explicit caching through stable dialogue while searches stay in the final message', async () => {
		stubFetch({ choices: [{ message: { content: 'Done.' } }] });
		const common = { profile: { providerType: 'openrouter', apiKey: 'test-key' } as any,
			model: 'google/gemini-4-argon', system: 'Stable authored lore. Accepted chapter. Wiki.',
			systemCacheBoundaries: [20, 38], contextAfterDialogue: true, appendPrompt: false,
			prompt: '', cache: { key: 'stable-session' } };
		const earlier = [{ role: 'user' as const, content: 'Earlier action.' }, { role: 'assistant' as const, content: 'Earlier narration.' }];
		await generateServerTextWithMetrics({ ...common, systemDynamic: 'Scene 1.', messages: [...earlier, { role: 'user', content: 'Act 1.' }] });
		await generateServerTextWithMetrics({ ...common, systemDynamic: 'Scene 2.', messages: [...earlier,
			{ role: 'user', content: 'Act 1.' }, { role: 'assistant', content: 'Result 1.' }, { role: 'user', content: 'Act 2.' }] });
		expect(requests[1].body.messages[0]).toEqual(requests[0].body.messages[0]);
		expect(requests[1].body.messages[1]).toEqual(requests[0].body.messages[1]);
		expect(requests[0].body.messages[2].content[0]).toMatchObject({ text: 'Earlier narration.', cache_control: { type: 'ephemeral' } });
		expect(requests[1].body.messages.at(-2).content[0]).toMatchObject({ text: 'Result 1.', cache_control: { type: 'ephemeral' } });
		for (const request of requests) {
			expect(JSON.stringify(request.body.messages.at(-1))).not.toContain('cache_control');
			expect(request.body.messages[0].content.map((block: any) => block.text).join('')).toBe(common.system);
			expect(request.body.session_id).toBe('stable-session');
		}
		expect(requests[1].body.messages.at(-1).content).toMatch(/Scene 2\.[\s\S]*Act 2\./);
	});

	it('caches a stable Anthropic system even without a dynamic system tail', async () => {
		stubFetch({ content: [{ type: 'text', text: 'Done.' }] });
		await generateServerTextWithMetrics({ profile: { providerType: 'anthropic', apiKey: 'test-key' } as any,
			model: 'claude-sonnet-4-5', system: 'Stable instructions.', prompt: 'Act.', cache: { key: 'story' } });
		expect(requests[0].body.system).toEqual([{ type: 'text', text: 'Stable instructions.', cache_control: { type: 'ephemeral' } }]);
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

	it('omits narration caps and retains the whole non-streamed response and provider usage', async () => {
		const text = 'The story continues. '.repeat(1800) + 'THE END.';
		stubFetch({ choices: [{ message: { content: text }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 100, completion_tokens: 12000, total_tokens: 12100,
				completion_tokens_details: { reasoning_tokens: 3000 } } });
		const result = await generateServerTextWithMetrics({
			profile: { providerType: 'openrouter', apiKey: 'test-key' } as any,
			model: 'google/gemini-3.8-flash', system: 'Narrate.', prompt: 'Continue.',
			maxTokens: 4096, providerOutputLimit: true,
		});
		expect(requests[0].body).not.toHaveProperty('max_tokens');
		expect(requests[0].body).not.toHaveProperty('max_completion_tokens');
		expect(result.text).toBe(text);
		expect(result.responseChars).toBe(text.length);
		expect(result.usage).toMatchObject({ responseTokens: 12000, totalTokens: 12100, reasoningTokens: 3000 });
	});

	it('keeps every streamed narration chunk and counts usage after the final text chunk', async () => {
		const text = 'A long complete narration. '.repeat(1500);
		stubStreamingFetch([
			`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [{ delta: { content: 'THE END.' }, finish_reason: 'stop' }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 14000, total_tokens: 14100, completion_tokens_details: { reasoning_tokens: 4000 } } })}\n\n`,
			'data: [DONE]\n\n',
		]);
		const chunks: string[] = [];
		const result = await generateServerTextWithMetrics({
			profile: { providerType: 'openrouter', apiKey: 'test-key' } as any,
			model: 'google/gemini-3.8-flash', system: 'Narrate.', prompt: 'Continue.',
			maxTokens: 4096, providerOutputLimit: true, onTextDelta: chunk => { chunks.push(chunk); },
		});
		expect(requests[0].body).not.toHaveProperty('max_tokens');
		expect(result.text).toBe(text + 'THE END.');
		expect(chunks.join('')).toBe(result.text);
		expect(result.usage).toMatchObject({ responseTokens: 14000, totalTokens: 14100, reasoningTokens: 4000 });
	});

	it('enables DeepSeek V4 private reasoning at the requested effort', async () => {
		stubFetch({
			choices: [{ message: { reasoning_content: 'private analysis', content: 'The court waits.' } }],
			usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
		});

		const result = await generateServerTextWithMetrics({
			profile: {
				providerType: 'deepseek',
				apiKey: 'test-key',
				baseUrl: 'https://api.deepseek.com/v1',
			} as any,
			model: 'deepseek-v4-pro',
			reasoningEffort: 'max',
			system: 'Narrate the scene.',
			prompt: 'Player action:\nListen.',
		});

		expect(requests[0].body.thinking).toEqual({ type: 'enabled' });
		expect(requests[0].body.reasoning_effort).toBe('max');
		expect(result.text).toBe('The court waits.');
	});

	it('disables DeepSeek private reasoning when narration requests off', async () => {
		stubFetch({
			choices: [{ message: { content: 'The court waits.' } }],
			usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
		});

		await generateServerTextWithMetrics({
			profile: {
				providerType: 'deepseek',
				apiKey: 'test-key',
				baseUrl: 'https://api.deepseek.com/v1',
			} as any,
			model: 'deepseek-v4-pro',
			reasoningEffort: 'off',
			system: 'Narrate the scene.',
			prompt: 'Player action:\nListen.',
		});

		expect(requests[0].body.thinking).toEqual({ type: 'disabled' });
		expect(requests[0].body.reasoning_effort).toBeUndefined();
	});

	it.each([
		['deepseek/deepseek-v4-pro-0813', 'off', 'none'],
		['deepseek/deepseek-v4-pro-0813', 'none', 'none'],
		['deepseek/deepseek-v4-pro-0813', 'high', 'high'],
		['deepseek/deepseek-v4-pro-0813', 'max', 'max'],
		['openai/gpt-5', 'low', 'low'],
		['z-ai/glm-5.3', 'off', 'low'],
	])('sends OpenRouter reasoning controls for %s at %s', async (model, reasoningEffort, effort) => {
		stubFetch({
			choices: [{ message: { content: 'The courier arrives.' }, finish_reason: 'stop' }],
			usage: { completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } },
		});
		const result = await generateServerTextWithMetrics({
			profile: { providerType: 'openrouter', apiKey: 'test-key' } as any,
			model, reasoningEffort, maxTokens: 4096,
			system: 'Narrate the scene.', prompt: 'A courier arrives at the harbor.',
		});
		expect(requests[0].body.reasoning).toEqual({ effort });
		expect(requests[0].body.thinking).toBeUndefined();
		expect(requests[0].body.reasoning_effort).toBeUndefined();
		expect(requests[0].body.max_tokens).toBe(4096);
		expect(result.finishReason).toBe('stop');
		expect(result.usage.reasoningTokens).toBe(0);
	});

	it('maps NanoGPT reasoning controls for structured callers', async () => {
		stubFetch({
			choices: [{ message: { content: '{"ok":true}' } }],
			usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
		});

		await generateServerTextWithMetrics({
			profile: {
				providerType: 'nanogpt',
				apiKey: 'test-key',
				baseUrl: 'https://nano-gpt.com/api/v1',
			} as any,
			model: 'zai-org/glm-5:thinking',
			reasoningEffort: 'off',
			system: 'Return JSON.',
			prompt: 'Plan.',
			responseFormat: 'json_object',
		});

		await generateServerTextWithMetrics({
			profile: {
				providerType: 'nanogpt',
				apiKey: 'test-key',
				baseUrl: 'https://nano-gpt.com/api/v1',
			} as any,
			model: 'zai-org/glm-5:thinking',
			reasoningEffort: 'max',
			system: 'Return JSON.',
			prompt: 'Plan.',
			responseFormat: 'json_object',
		});

		expect(requests[0].body.reasoning_effort).toBe('none');
		expect(requests[1].body.reasoning_effort).toBe('xhigh');
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
		// Gemini rejects strict state-patch schemas; it is sent JSON mode instead.
		expect(getProviderCapabilities({ providerType: 'openrouter', apiKey: 'test-key' } as any, 'google/gemini-3.8-flash').structuredOutputs).toBe(false);
		expect(getProviderCapabilities({ providerType: 'google', apiKey: 'test-key' } as any, 'gemini-2.5-pro').structuredOutputs).toBe(false);
		expect(getProviderCapabilities({ providerType: 'z-ai', apiKey: 'test-key' } as any, 'glm-5.2')).toMatchObject({
			cacheMode: 'none',
			structuredOutputs: true,
			nativeTokenCounting: true,
		});
	});

	it('uses an explicit model capacity override for budgeting and serialization guards', () => {
		expect(getProviderCapabilities({
			providerType: 'openrouter',
			apiKey: 'test-key',
			contextWindowTokens: 16_384,
		} as any, 'unknown-provider-model')).toMatchObject({
			maxContextTokens: 16_384,
			contextWindowSource: 'explicit-override',
		});
	});

	it.each(['z-ai/glm-5.3-flash', 'zai-org/glm-5.3:thinking'])('uses low reasoning for old off settings on mandatory-thinking model %s', async model => {
		stubFetch({ choices: [{ message: { content: '{}' } }] });
		await generateServerTextWithMetrics({ profile: { providerType: 'nanogpt', apiKey: 'test-key' } as any,
			model, reasoningEffort: 'off', system: 'Extract durable facts.', prompt: 'A promise is made.' });
		expect(requests[0].body.reasoning_effort).toBe('low');
	});

	it('counts history, current observations, schema and output reserve before any provider request', async () => {
		stubFetch({ choices: [{ message: { content: 'unused' } }] });
		await expect(generateServerTextWithMetrics({ profile: { providerType: 'openai', apiKey: 'test-key' } as any,
			model: 'gpt-4', system: 'instructions '.repeat(1_000), systemDynamic: 'scene '.repeat(1_000),
			messages: [{ role: 'assistant', content: 'pre-roll narration '.repeat(1_000) }],
			prompt: 'tool observation '.repeat(1_000), maxTokens: 2_000,
			responseSchema: { name: 'facts', schema: { description: 'evidence '.repeat(1_000), type: 'object' } },
		})).rejects.toMatchObject({ name: 'ServerGenerationError', result: { statusCode: 413, retryCount: 0 } });
		expect(requests).toHaveLength(0);
	});

	it('shares a provider cooldown after 429 instead of immediately retrying', async () => {
		vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
			requests.push({
				url,
				body: JSON.parse(String(init.body ?? '{}')),
				headers: init.headers as Record<string, string>,
			});
			if (requests.length === 1) {
				return new Response('rate limited', { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '2' } });
			}
			return new Response(JSON.stringify({
				choices: [{ message: { content: 'The hall grows quiet.' } }],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}));

		const options = {
			profile: {
				providerType: 'openai',
				apiKey: 'rate-limit-test-key',
			} as any,
			model: 'gpt-5-mini',
			system: 'Stable narrator rules.',
			prompt: 'Player action:\nListen.',
		};

		await expect(generateServerTextWithMetrics(options)).rejects.toMatchObject({
			result: { statusCode: 429, retryCount: 0, retryAfterMs: 2000 },
		});
		await expect(generateServerTextWithMetrics(options)).rejects.toMatchObject({
			result: { statusCode: 429 },
		});
		expect(requests).toHaveLength(1);
	});

	it('sends strict OpenAI-compatible JSON schema response formats', async () => {
		stubFetch({
			choices: [{ message: { content: '{"update":{}}' } }],
			usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
		});

		await generateServerTextWithMetrics({
			profile: {
				providerType: 'openai',
				apiKey: 'unit-test-key',
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

	it('falls back to JSON object mode for DeepSeek classifiers routed through OpenRouter', async () => {
		stubFetch({
			choices: [{ message: { content: '{"update":{}}' } }],
			usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
		});

		await generateServerTextWithMetrics({
			profile: {
				providerType: 'openrouter',
				apiKey: 'unit-test-key',
				baseUrl: 'https://openrouter.ai/api/v1',
			} as any,
			model: 'deepseek/deepseek-v3.2',
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
		});

		expect(requests[0].body.response_format).toEqual({ type: 'json_object' });
		expect(getProviderCapabilities({ providerType: 'openrouter', apiKey: 'unit-test-key', } as any, 'deepseek/deepseek-v3.2')).toMatchObject({
			structuredOutputs: false,
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
			'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":1200,"cache_creation_input_tokens":300,"output_tokens":1}}}\n\n',
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
		expect(result.usage).toMatchObject({ requestTokens: 1512, inputTokens: 1512,
			cachedInputTokens: 1200, cacheWriteTokens: 300, responseTokens: 5, totalTokens: 1517 });
		expect(result.finishReason).toBe('end_turn');
	});
});
