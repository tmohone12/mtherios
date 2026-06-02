import { describe, expect, it } from 'vitest';
import { createTimingRecorder, sanitizeTimingMetadata } from './timing';
import { mapWithConcurrency } from './concurrency';

describe('sanitizeTimingMetadata', () => {
	it('keeps safe generation metadata and redacts prompt-like or secret values', () => {
		const sanitized = sanitizeTimingMetadata({
			model: 'test-model',
			promptChars: 1234,
			requestTokens: 100,
			responseTokens: 20,
			maxOutputTokens: 512,
			apiKey: 'secret-key',
			Authorization: 'Bearer secret',
			systemPrompt: 'raw prompt',
			nested: {
				content: 'private narration',
				count: 2,
			},
		});

		expect(sanitized).toEqual({
			model: 'test-model',
			promptChars: 1234,
			requestTokens: 100,
			responseTokens: 20,
			maxOutputTokens: 512,
			apiKey: '[redacted]',
			Authorization: '[redacted]',
			systemPrompt: '[redacted]',
			nested: {
				content: '[redacted]',
				count: 2,
			},
		});
	});
});

describe('createTimingRecorder', () => {
	it('records duration and emits structured JSON logs', async () => {
		const logs: unknown[] = [];
		const recorder = createTimingRecorder({
			pipeline: 'test.pipeline',
			log: (entry) => logs.push(entry),
			now: (() => {
				const values = [100, 145];
				return () => values.shift() ?? 145;
			})(),
		});

		const result = await recorder.time('test.phase', { prompt: 'private', count: 3 }, async () => 'ok');

		expect(result).toBe('ok');
		expect(recorder.timings).toEqual([
			{
				phase: 'test.phase',
				durationMs: 45,
				metadata: { prompt: '[redacted]', count: 3 },
			},
		]);
		expect(logs).toEqual([
			expect.objectContaining({
				event: 'mtherios.generation.timing',
				pipeline: 'test.pipeline',
				phase: 'test.phase',
				durationMs: 45,
				metadata: { prompt: '[redacted]', count: 3 },
			}),
		]);
	});
});

describe('mapWithConcurrency', () => {
	it('does not run more tasks than the configured concurrency limit', async () => {
		let active = 0;
		let maxActive = 0;

		const promises = mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			return value * 2;
		});

		await expect(promises).resolves.toEqual([2, 4, 6, 8, 10]);
		expect(maxActive).toBe(2);
	});
});
