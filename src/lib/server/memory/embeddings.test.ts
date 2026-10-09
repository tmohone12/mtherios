import { describe, expect, it } from 'vitest';
import { localHashEmbedding, memoryNodeEmbeddingText } from './embeddings';

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
