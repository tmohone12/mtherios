import { describe, expect, it } from 'vitest';
import { memoryNodeEmbeddingText } from './embeddings';

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
});
