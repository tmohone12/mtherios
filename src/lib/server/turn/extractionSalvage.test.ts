import { describe, expect, it } from 'vitest';
import { parseRepairedStateExtraction, parseStateExtractionResult, salvageStateExtractionResult } from './orchestrator';

const mara = { name: 'Mara', present: true };
const conversation = { npcName: 'Ilan', topicSummary: 'Gate access', npcLearned: ['The gate is closed.'] };

describe('extraction salvage', () => {
	it('keeps the valid parts when list items are malformed, and says what was dropped', () => {
		const text = JSON.stringify({ update: {
			characters: [mara],
			conversations: [{ topicSummary: 'No speaker named' }, conversation],
		}, dueEventFeedback: [{ id: 'event_gate', outcome: 'happened' }] });
		expect(() => parseStateExtractionResult(text)).toThrow('invalid state extraction response');
		const salvaged = salvageStateExtractionResult(text)!;
		expect(salvaged.update.characters?.[0]).toMatchObject(mara);
		expect(salvaged.update.conversations).toEqual([expect.objectContaining(conversation)]);
		expect(salvaged.dueEventFeedback).toEqual([]);
		expect(salvaged.warnings).toEqual(['Dropped malformed extraction items: update.conversations[0], dueEventFeedback[0]']);
	});

	it('drops unknown keys and several bad items from one list', () => {
		const salvaged = salvageStateExtractionResult(JSON.stringify({ notes: 'model commentary', update: {
			conversations: [{ topicSummary: 'a' }, conversation, { topicSummary: 'b' }],
		} }))!;
		expect(salvaged.update.conversations).toEqual([expect.objectContaining(conversation)]);
		expect(salvaged.warnings[0]).toContain('notes');
		expect(salvaged.warnings[0]).toContain('update.conversations[2]');
	});

	it('refuses to call an answer saved when every change was dropped, or a non-list field is invalid', () => {
		expect(salvageStateExtractionResult(JSON.stringify({ update: { conversations: [{ topicSummary: 'a' }] } }))).toBeNull();
		expect(salvageStateExtractionResult(JSON.stringify({ update: { characters: 'Mara' } }))).toBeNull();
		expect(salvageStateExtractionResult('not json')).toBeNull();
	});

	it('prefers a valid repair, then a salvaged repair, then a salvaged first answer', () => {
		const valid = JSON.stringify({ update: { characters: [mara] } });
		const repairedBroken = JSON.stringify({ update: { conversations: [{ topicSummary: 'a' }] } });
		const firstPartlyValid = JSON.stringify({ update: { characters: [mara], conversations: [{ topicSummary: 'a' }] } });
		expect(parseRepairedStateExtraction(valid).warnings).toEqual([]);
		expect(parseRepairedStateExtraction(firstPartlyValid).update.characters?.[0]).toMatchObject(mara);
		expect(parseRepairedStateExtraction(repairedBroken, firstPartlyValid).update.characters?.[0]).toMatchObject(mara);
		expect(() => parseRepairedStateExtraction(repairedBroken, repairedBroken)).toThrow('invalid state extraction response');
	});
});
