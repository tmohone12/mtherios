import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedMemoryText, embedMemoryTexts, localHashEmbedding, memoryNodeEmbeddingText, type MemoryEmbeddingConfig } from './embeddings';
import { createAgentRuntimeBudget, withAgentRuntimeBudget, type AgentRuntimeState } from '$lib/server/engine/agentRuntime';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const config: MemoryEmbeddingConfig = { provider: 'openai-compatible', model: 'query-model', baseUrl: 'https://embed.test/v1', apiKey: 'secret-token', customUrl: '', batchSize: 8, dimensions: 2 };

it('checkpoints exact embedding input before dispatch and charges one shared run request', async () => {
	const state: AgentRuntimeState = { messages: [], budget: createAgentRuntimeBudget() };
	let saved: AgentRuntimeState | undefined, receipt: string | undefined;
	const fetcher = vi.fn(async (_url, options) => {
		expect(saved?.budget.modelRequests).toBe(1);
		expect(receipt).toBe(options.body);
		return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }], usage: { prompt_tokens: 7, total_tokens: 7 } }));
	});
	vi.stubGlobal('fetch', fetcher);
	await withAgentRuntimeBudget({ state, limits: { maxRequests: 1 }, onSave: async value => { saved = value; }, onRequest: (_options, _index, request) => { receipt = request.serializedBody; } }, async () => {
		expect(await embedMemoryText('Bridge promise', config)).toEqual([1, 0]);
		await expect(embedMemoryText('Second query', config)).rejects.toThrow('request_budget_exhausted');
	});
	expect(fetcher).toHaveBeenCalledOnce();
	expect(receipt).not.toContain('secret-token');
	expect(state.budget).toMatchObject({ modelRequests: 1, consumedTokens: 7, reservedTokens: 0, stopReason: 'request_budget_exhausted' });
});

it('counts each Ollama fallback dispatch and prevents an unbudgeted legacy retry', async () => {
	vi.stubEnv('MYTHENGINE_LOCAL_EMBEDDINGS', 'true');
	const state: AgentRuntimeState = { messages: [], budget: createAgentRuntimeBudget() };
	const fetcher = vi.fn(async () => new Response('{}', { status: 404 }));
	vi.stubGlobal('fetch', fetcher);
	await expect(withAgentRuntimeBudget({ state, limits: { maxRequests: 1 }, onSave: async () => {} }, () => embedMemoryText('Bridge', { ...config, provider: 'ollama' }))).rejects.toThrow('request_budget_exhausted');
	expect(fetcher).toHaveBeenCalledOnce();
	expect(state.budget.reservedTokens).toBeGreaterThan(0);
});

it('rejects a late cancelled embedding and leaves local hashing and background batches outside run accounting', async () => {
	const controller = new AbortController();
	const state: AgentRuntimeState = { messages: [], budget: createAgentRuntimeBudget() };
	vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(new Error('cancelled retrieval')); return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] })); }));
	await expect(withAgentRuntimeBudget({ state, signal: controller.signal, onSave: async () => {} }, () => embedMemoryText('Bridge', config))).rejects.toThrow('cancelled retrieval');
	const localState: AgentRuntimeState = { messages: [], budget: createAgentRuntimeBudget() };
	await withAgentRuntimeBudget({ state: localState, onSave: async () => {} }, () => embedMemoryText('Bridge', { ...config, provider: 'local-hash' }));
	expect(localState.budget.modelRequests).toBe(0);
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }))));
	expect(await embedMemoryTexts(['Background A', 'Background B'], config)).toEqual([[1, 0], [0, 1]]);
	expect(localState.budget.modelRequests).toBe(0);
});

describe('memory embedding text', () => {
	it('clips oversized memory nodes before sending them to embedding providers', () => {
		const text = memoryNodeEmbeddingText({
			title: 'Arc 3: Oversized Rollup',
			summary: `Important summary survives. ${'summary wall '.repeat(1000)} summary tail sentinel.`,
			content: `Important content survives. ${'content wall '.repeat(2000)} content tail sentinel.`,
			keywords: ['arc', 'rollup'],
		});

		expect(text).toContain('Arc 3: Oversized Rollup');
		expect(text).toContain('Important summary survives.');
		expect(text).toContain('Keywords: arc, rollup');
		expect(text).not.toContain('summary tail sentinel');
		expect(text).not.toContain('content tail sentinel');
		expect(text.length).toBeLessThanOrEqual(6000);
	});

	it('creates deterministic normalized vectors at the configured collection dimension', () => {
		const first = localHashEmbedding('Ash Harbor watch patrol', 768);
		const second = localHashEmbedding('Ash Harbor watch patrol', 768);
		const related = localHashEmbedding('The watch patrol returns to Ash Harbor', 768);
		const unrelated = localHashEmbedding('orchid pastry constellation', 768);
		const similarity = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * right[index], 0);

		expect(first).toHaveLength(768);
		expect(second).toEqual(first);
		expect(Math.sqrt(first.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 8);
		expect(similarity(first, related)).toBeGreaterThan(similarity(first, unrelated));
	});
});
