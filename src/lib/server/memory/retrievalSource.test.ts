import { afterEach, describe, expect, it, vi } from 'vitest';
import { retrieveMemorySource } from './retrievalSource';
import { embedMemoryText, type MemoryEmbeddingConfig } from './embeddings';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('independent memory sources', () => {
	it('keeps transcript evidence when an embedding provider stalls and cancels its fetch', async () => {
		vi.useFakeTimers();
		let aborted = false;
		vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_, reject) => {
			options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); });
		})));
		const config: MemoryEmbeddingConfig = { provider: 'openai-compatible', model: 'test',
			baseUrl: 'http://embedding.test', customUrl: '', apiKey: '', dimensions: 2, batchSize: 1 };
		const debug: string[] = [];
		const sources = Promise.all([
			retrieveMemorySource('Vector memory', async signal => [await embedMemoryText('old promise', config, signal)], debug, 1_200),
			retrieveMemorySource('Transcript recall', async () => ['source-entry-42'], debug),
		]);
		await vi.advanceTimersByTimeAsync(1_200);
		expect(await sources).toEqual([[], ['source-entry-42']]);
		expect(aborted).toBe(true);
		expect(debug).toEqual(['Vector memory: timed out; other memory sources retained.']);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('retains successful sources when another query fails, without exposing its error', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const debug: string[] = [];
		const result = await Promise.all([
			retrieveMemorySource('Timeline memory', async () => { throw new Error('private database details'); }, debug),
			retrieveMemorySource('Canonical memory', async () => ['canon-1'], debug),
		]);
		expect(result).toEqual([[], ['canon-1']]);
		expect(debug.join(' ')).not.toContain('private');
	});

	it('returns by its deadline even when a source ignores cancellation', async () => {
		vi.useFakeTimers();
		const result = retrieveMemorySource('Vector memory', () => new Promise<never>(() => {}), [], 50);
		await vi.advanceTimersByTimeAsync(50);
		expect(await result).toEqual([]);
	});
});
