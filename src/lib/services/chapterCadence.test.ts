import { describe, expect, it } from 'vitest';
import { selectCompletedChapterTurns, selectNextChapterWindow, type ChapterSourceEntry } from './chapterCadence';

function turns(count: number, start = 1, branchId: string | null = null): ChapterSourceEntry[] {
	return Array.from({ length: count }, (_, index) => {
		const number = start + index;
		return [
			{ id: `player-${number}`, type: 'user_action', content: `I ask question ${number}.`, position: number * 2, parentId: null, branchId },
			{ id: `narration-${number}`, type: 'narration', content: `Answer ${number} changes the agreement.`, position: number * 2 + 1, parentId: `player-${number}`, branchId },
		];
	}).flat();
}

describe('completed-turn chapter windows', () => {
	it('closes immediately after turn20 and keeps the next player action for the next chapter', () => {
		const entries = turns(41);
		expect(selectNextChapterWindow(entries.slice(0, 39))).toBeNull();
		const first = selectNextChapterWindow(entries.slice(0, 41))!;
		expect(first.turns).toHaveLength(20);
		expect(first.entries.map(entry => entry.id)).toEqual(entries.slice(0, 40).map(entry => entry.id));
		const second = selectNextChapterWindow(entries.filter(entry => entry.position > first.endPosition))!;
		expect(second.turns).toHaveLength(20);
		expect(second.entries[0].id).toBe('player-21');
		expect(second.entries.at(-1)?.id).toBe('narration-40');
		expect(selectNextChapterWindow(entries.filter(entry => entry.position > second.endPosition))).toBeNull();
	});

	it('retains opening and legacy narrator-only evidence without counting either as a turn', () => {
		const opening = { id: 'opening', type: 'narration', content: 'The ship lands at the harbor.', position: 0, branchId: 'main' };
		const legacy = { id: 'legacy', type: 'narration', content: 'The captain privately sends the letter.', position: 1 };
		expect(selectNextChapterWindow([opening, legacy, ...turns(19)])).toBeNull();
		const window = selectNextChapterWindow([opening, legacy, ...turns(20)])!;
		expect(window.entries.slice(0, 2)).toEqual([opening, legacy]);
		expect(window.unmatchedEntryIds).toEqual(['opening', 'legacy']);
		expect(window.turns).toHaveLength(20);
	});

	it('leaves an interleaved pending action for the chapter containing its later response', () => {
		const entries = turns(40);
		const pending = entries.find(entry => entry.id === 'player-21')!;
		pending.position = 40.5;
		const first = selectNextChapterWindow(entries)!;
		expect(first.endPosition).toBe(41);
		expect(first.entries.map(entry => entry.id)).not.toContain('player-21');
		// Loaders must supply a late response's parent even when the action predates the last boundary.
		const laterSources = entries.filter(entry => entry.position > first.endPosition || entry.id === pending.id);
		const second = selectNextChapterWindow(laterSources)!;
		expect(second.turns[0].player.id).toBe('player-21');
		expect(second.entries[0].id).toBe('player-21');
		expect(second.entries.at(-1)?.id).toBe('narration-40');
	});

	it('excludes OOC parents and their replies, failed actions, and alternate branches from the count', () => {
		const entries = turns(20);
		entries[0].content = 'GM: correct the last reply';
		entries[2].metadata = { actionType: 'ooc' };
		entries[4].metadata = { narrativeMode: 'ooc' };
		entries[7].metadata = { nonCanon: true };
		entries[9].content = '';
		entries.push(...turns(2, 21, 'alternate'));
		entries.push({ id: 'pending', type: 'user_action', content: 'I open the door.', position: 100 });
		expect(selectCompletedChapterTurns(entries)).toHaveLength(15);
		expect(selectCompletedChapterTurns(entries, 'alternate')).toHaveLength(2);
		expect(selectNextChapterWindow(entries)).toBeNull();
	});

	it('keeps canonical parallel POV narration paired with its command and never pairs across branches', () => {
		const entries = turns(20);
		entries[0].content = '/pov Captain | Read the sealed letter';
		entries[1].metadata = { narrativeMode: 'parallel_pov', parallelPov: { character: 'Captain' } };
		expect(selectNextChapterWindow(entries)?.turns[0].player.content).toContain('/pov');
		entries[1].branchId = 'alternate';
		expect(selectCompletedChapterTurns(entries)).toHaveLength(19);
		expect(selectCompletedChapterTurns(entries, 'alternate')).toHaveLength(0);
	});

	it('keeps accepted story narration after a GM correction as supplementary evidence without counting a turn', () => {
		const corrections: ChapterSourceEntry[] = [
			{ id: 'gm-correction', type: 'user_action', content: 'GM: advance seven days.', position: 0, metadata: { actionType: 'ooc' } },
			{ id: 'accepted-narration', type: 'narration', content: 'Seven days pass. The three dark sails turn out to be fishing junks.', position: 1, parentId: 'gm-correction' },
			{ id: 'ooc-reply', type: 'narration', content: 'Understood.', position: 1.5, parentId: 'gm-correction', metadata: { narrativeMode: 'ooc' } },
		];
		expect(selectNextChapterWindow([...corrections, ...turns(19)])).toBeNull();
		const window = selectNextChapterWindow([...corrections, ...turns(20)])!;
		expect(window.turns).toHaveLength(20);
		expect(window.entries[0].id).toBe('accepted-narration');
		expect(window.unmatchedEntryIds).toEqual(['accepted-narration']);
		expect(window.entries.map(entry => entry.id)).not.toContain('gm-correction');
		expect(window.entries.map(entry => entry.id)).not.toContain('ooc-reply');
	});

	it('counts multiple saved responses to one action once and rejects reversed pairs', () => {
		const entries = turns(20);
		entries.push({ ...entries[1], id: 'duplicate-response', position: 100 });
		expect(selectCompletedChapterTurns(entries)).toHaveLength(20);
		expect(selectCompletedChapterTurns(entries)[0].narration.id).toBe('narration-1');
		expect(selectNextChapterWindow(entries)?.endPosition).toBe(41);
		entries[3].position = 1;
		expect(selectCompletedChapterTurns(entries)).toHaveLength(19);
	});
});
