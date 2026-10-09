import { describe, expect, it } from 'vitest';
import { buildBatchTurnMemoryPrompt, parseBatchTurnMemoryResult } from './batchTurnMemory';

describe('bounded turn memory batch', () => {
	it('accounts for each source separately and rejects duplicates', () => {
		const sources = [
			{ assistantEntryId: 'narration_1', playerText: 'I listen.', narration: 'Mira gives Sansa the key.', position: 2 },
			{ assistantEntryId: 'narration_2', playerText: 'I wait.', narration: 'Rain falls.', position: 4 },
		];
		const prompt = buildBatchTurnMemoryPrompt(sources, 'Known characters: Mira and Sansa.');
		expect(prompt).toContain('narration_1');
		expect(prompt).toContain('narration_2');
		const result = parseBatchTurnMemoryResult('{"updates":[{"assistantEntryId":"narration_1","update":{"items":[{"name":"key","location":"Sansa"}]}},{"assistantEntryId":"narration_2","update":{}}]}', sources.map(source => source.assistantEntryId));
		expect(result.size).toBe(2);
		expect(JSON.parse(result.get('narration_1')!).update.items[0].location).toBe('Sansa');
		expect(() => parseBatchTurnMemoryResult('{"updates":[{"assistantEntryId":"narration_1","update":{}},{"assistantEntryId":"narration_1","update":{}}]}', sources.map(source => source.assistantEntryId))).toThrow(/duplicate/);
	});
});
