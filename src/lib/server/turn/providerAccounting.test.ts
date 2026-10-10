import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateServerTextWithMetrics, ServerGenerationError, type ServerGenerationAttempt } from './provider';

describe('provider attempt accounting', () => {
	afterEach(() => vi.unstubAllGlobals());
	const options = { profile: { providerType: 'openai' as const, apiKey: 'fixture', customModels: [], fetchedModels: [], reasoningModels: [], hiddenModels: [], favoriteModels: [] }, model: 'test-model', system: 'Fixture', prompt: 'Read fixture', maxRetries: 1 };
	it('persists each transient attempt before another dispatch and preserves request/cache/reasoning identity', async () => {
		const receipts: ServerGenerationAttempt[] = [];
		vi.stubGlobal('fetch', vi.fn(async () => {
			if (vi.mocked(fetch).mock.calls.length === 1) return new Response(JSON.stringify({ id: 'failed-request', usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.01 } }), { status: 503 });
			expect(receipts).toHaveLength(1);
			return new Response(JSON.stringify({ id: 'completed-request', choices: [{ finish_reason: 'length', message: { content: 'Partial.' } }],
				usage: { prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 7 }, cost: 0.02 } }), { status: 200 });
		}));
		const result = await generateServerTextWithMetrics({ ...options, onAttempt: attempt => { receipts.push(attempt); } });
		expect(result.attempts).toEqual(receipts);
		expect(receipts.map(row => row.providerRequestId)).toEqual(['failed-request', 'completed-request']);
		expect(receipts[0]).toMatchObject({ attempt: 0, status: 'error', statusCode: 503, usage: { providerCostUsd: 0.01 } });
		expect(receipts[1]).toMatchObject({ attempt: 1, status: 'success', finishReason: 'length', usage: { cachedInputTokens: 8, reasoningTokens: 7, providerCostUsd: 0.02 } });
		expect(receipts[0].attemptId).not.toBe(receipts[1].attemptId);
		expect(receipts[0].requestHash).toBe(receipts[1].requestHash);
		expect(JSON.stringify(receipts)).not.toContain('apiKey');
		expect(result.usage.providerCostUsd).toBe(0.02);
	});
	it('retains charged malformed tool output without buying an automatic validation retry', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'charged-bad-json', usage: { prompt_tokens: 7, completion_tokens: 11, cost: 0.03 },
			choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call', function: { name: 'read', arguments: '{bad' } }] } }] }), { status: 200 })));
		try { await generateServerTextWithMetrics(options); throw new Error('Expected validation failure'); } catch (error) {
			expect(error).toBeInstanceOf(ServerGenerationError);
			expect((error as ServerGenerationError).result.attempts).toMatchObject([{ providerRequestId: 'charged-bad-json', status: 'error', usage: { providerCostUsd: 0.03, responseTokens: 11 } }]);
		}
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each([200, 503])('stops without another dispatch if receipt persistence fails after HTTP %s', async status => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'retain-this', choices: [{ message: { content: 'Done' } }], usage: { cost: 0.05 } }), { status })));
		const error = await generateServerTextWithMetrics({ ...options, onAttempt: () => { throw new Error('Database unavailable'); } }).catch(error => error);
		expect(error).toBeInstanceOf(ServerGenerationError);
		expect(error.message).toContain('receipt could not be persisted');
		expect(error.result.attempts).toMatchObject([{ providerRequestId: 'retain-this', usage: { providerCostUsd: 0.05 } }]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it('leaves missing provider IDs/usage unknown and records no attempt when a request is rejected before dispatch', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Done' } }] }), { status: 200 })));
		const result = await generateServerTextWithMetrics(options);
		expect(result.attempts).toMatchObject([{ providerRequestId: null, usage: { requestTokens: null, responseTokens: null, providerCostUsd: null } }]);
		const error = await generateServerTextWithMetrics({ ...options, onBeforeRequest: () => { throw new Error('Budget rejected'); } }).catch(error => error);
		expect(error.result.attempts).toEqual([]);
		const rejected = await generateServerTextWithMetrics({ ...options, maxTokens: 1000000 }).catch(error => error);
		expect(rejected.result).toMatchObject({ attempts: [], statusCode: 413 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it('retains stream usage and provider identity if a later reader fails', async () => {
		let reads = 0;
		const encoder = new TextEncoder();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull(controller) {
			if (reads++ === 0) controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: 'stream-request', choices: [{ delta: { content: 'Partial' } }], usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.01 } }) + '\n\n'));
			else controller.error(new Error('Disconnected stream'));
		} }), { status: 200 })));
		const error = await generateServerTextWithMetrics({ ...options, onTextDelta: () => undefined }).catch(error => error);
		expect(error.result.attempts).toMatchObject([{ providerRequestId: 'stream-request', responseChars: 7, status: 'error', usage: { providerCostUsd: 0.01 } }]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
