import { describe, expect, it } from 'vitest';
import { chronologicalMemoryPrompt, normalizeReadableNarrative, validateChronologicalMemory, summaryCheckpointIdentity, SUMMARY_GENERATION_POLICY } from './summaryGeneration';

describe('complete chronological summaries', () => {
	it('changes both root completion and failure identities when system or generation policy changes', () => {
		const input = { storyId: 'test', kind: 'chapter' as const, sources: [{ id: 'entry', text: 'A recorded consequence.' }] };
		const original = summaryCheckpointIdentity(input, [], 'window');
		for (const policy of [
			{ ...SUMMARY_GENERATION_POLICY, summarySystem: `${SUMMARY_GENERATION_POLICY.summarySystem} Corrected policy.` },
			{ ...SUMMARY_GENERATION_POLICY, summaryTokens: 16000 },
			{ ...SUMMARY_GENERATION_POLICY, readableInstructions: ['A corrected readable prompt.'] },
		]) {
			const changed = summaryCheckpointIdentity(input, [], 'window', undefined, policy);
			expect(changed.fingerprint).not.toBe(original.fingerprint);
			expect(changed.failureFingerprint).not.toBe(original.failureFingerprint);
		}
	});
	it('requires a real account for every source in order and rejects failed output', () => {
		const sourceIds = Array.from({ length: 20 }, (_, index) => `turn_${index + 1}`);
		const draft = { title: 'The bargain and its consequences', narrative: 'The negotiators began with a disputed bargain, then settled its consequences in a way that changed the terms of their alliance for the future.', accounts: sourceIds.map(sourceId => ({ sourceId, summary: `An established consequence at ${sourceId}.` })) };
		expect(validateChronologicalMemory(draft, sourceIds).accounts).toHaveLength(20);
		for (const accounts of [draft.accounts.slice(1), [...draft.accounts].reverse(), [...draft.accounts.slice(0, 19), draft.accounts[0]]]) {
			expect(() => validateChronologicalMemory({ ...draft, accounts }, sourceIds)).toThrow('every source');
		}
		for (const invalid of [null, {}, { title: 'Title', summary: 'Old fallback' }, { ...draft, accounts: draft.accounts.map(account => ({ ...account, summary: '' })) }]) {
			expect(() => validateChronologicalMemory(invalid, sourceIds)).toThrow();
		}
	});
	it('supplies full middle and ending evidence across all ten chapters', () => {
		const sources = Array.from({ length: 10 }, (_, index) => ({ id: `chapter_${index + 1}`, text: `Opening ${index}. ${'Context. '.repeat(200)} Middle discovery ${index}. Ending resolution ${index}.` }));
		const prompt = chronologicalMemoryPrompt('arc', sources);
		for (const source of sources) expect(prompt).toContain(source.text);
		expect(prompt).toContain('Later resolutions must not remain open threads');
		const outputShape = prompt.slice(prompt.indexOf('Return JSON with accounts first:'));
		expect(outputShape.indexOf('"accounts"')).toBeLessThan(outputShape.indexOf('"narrative"'));
	});
	it('retains an unknown character identity and normalizes numeric local source labels', () => {
		const result = validateChronologicalMemory({ title: 'The crossing', narrative: 'Maera crossed the river, declined the offered payment, and left the ferryman with a debt neither party agreed how to settle.', endingScene: null, accounts: [{ sourceId: 1, summary: 'Maera crossed the river and declined the offered payment.' }], characters: [{ name: 'Maera', entityId: null, bullets: ['Declined payment.'] }] }, ['1']);
		expect(result.accounts[0].sourceId).toBe('1');
		expect(result.characters[0]).toMatchObject({ name: 'Maera', entityId: undefined });
	});
	 it('splits a model-produced wall of prose into readable paragraphs without changing its sentences', () => {
		const wall = Array.from({ length: 32 }, (_, index) => `Sentence ${index + 1}.`).join(' ');
		const normalized = normalizeReadableNarrative(wall);
		expect(normalized.split(/\n\s*\n/)).toHaveLength(4);
		expect(normalized.replace(/\s+/g, ' ')).toContain('Sentence 32.');
	});
});
