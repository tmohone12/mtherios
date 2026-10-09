import { expect, it } from 'vitest';
import { classifierRepairGeneration } from './orchestrator';

it('changes an exhausted extraction request but preserves ordinary repair settings', () => {
	expect(classifierRepairGeneration({ maxTokens: 4096, reasoningEffort: 'high' }, { finishReason: 'length' })).toEqual({ maxTokens: 8192, reasoningEffort: 'low' });
	expect(classifierRepairGeneration({ maxTokens: 12000 }, { finishReason: 'max_tokens' }).maxTokens).toBe(16384);
	expect(classifierRepairGeneration({ maxTokens: 32000 }, { finishReason: 'length' }).maxTokens).toBe(32000);
	expect(classifierRepairGeneration({ maxTokens: 4096, reasoningEffort: 'medium' }, { finishReason: 'stop' })).toEqual({ maxTokens: 4096, reasoningEffort: 'medium' });
});
