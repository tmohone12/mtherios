import { expect, it, vi } from 'vitest';
import * as generation from './summaryGeneration';
import { summarizeChapterMemoryWithLlm } from './processor';

it('keeps supplementary narration between its surrounding source records when compiling a chapter', async () => {
	const entries = Array.from({ length: 20 }, (_, index) => [
		{ id: `player-${index}`, storyId: 'story', type: 'user_action', content: `Player question ${index}.`, position: index * 3 + 1, parentId: null, metadata: {} },
		{ id: `answer-${index}`, storyId: 'story', type: 'narration', content: `Narrator answer ${index}.`, position: index * 3 + 3, parentId: `player-${index}`, metadata: {} },
	]).flat() as Parameters<typeof summarizeChapterMemoryWithLlm>[0];
	entries.push({ ...entries[1], id: 'supplement', content: 'An accepted correction before the second answer.', position: 5, parentId: null });
	entries.sort((left, right) => left.position - right.position);
	const generated = { title: 'Recorded questions', narrative: 'The envoy answered all of the questions, accepted the correction, and preserved the conditional agreement throughout the negotiations.', endingScene: undefined,
		accounts: Array.from({ length: 20 }, (_, index) => ({ sourceId: `answer-${index}`, summary: `The envoy answered question ${index}.` })),
		characters: [], openThreads: [], locations: [], keywords: [], threadChanges: [], newThreads: [], model: 'fixture' };
	const call = vi.spyOn(generation, 'generateChronologicalMemory').mockResolvedValue(generated);
	try {
		await summarizeChapterMemoryWithLlm(entries, [], { title: 'fallback', summary: 'fallback', keywords: [], keyCharacters: [], keyLocations: [], plotThreads: [], emotionalTone: '', source: 'deterministic' }, []);
		const source = call.mock.calls[0][0].sources[1];
		expect(source.text.indexOf('Player question 1.')).toBeLessThan(source.text.indexOf('An accepted correction'));
		expect(source.text.indexOf('An accepted correction')).toBeLessThan(source.text.indexOf('Narrator answer 1.'));
		expect(call.mock.calls[0][0].sources[0].text).not.toContain('An accepted correction');
	} finally { call.mockRestore(); }
});
