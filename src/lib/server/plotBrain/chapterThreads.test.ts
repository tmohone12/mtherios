import { describe, expect, it } from 'vitest';
import {
	buildChapterThreadPlan,
	chapterThreadMetadata,
	coerceChapterThreadDirectives,
	humanizeChapterOpenThreads,
	type ChapterCanonicalThread,
} from './chapterThreads';

const existingThread: ChapterCanonicalThread = {
	id: 'plot_thread_story_1_ashen_throne',
	description: 'The Ashen Throne: Rival claimants contest the capital.',
	status: 'open',
	significance: 'major',
	relatedFactionIds: [],
	relatedEntityIds: [],
	sourceEntryIds: ['entry_old'],
	sourceEventIds: ['event_old'],
	sourcePatchIds: [],
};

function plan(overrides: Partial<Parameters<typeof buildChapterThreadPlan>[0]> = {}) {
	return buildChapterThreadPlan({
		storyId: 'story_1',
		chapterId: 'chapter_7',
		existingThreads: [existingThread],
		events: [{ id: 'event_7', threadIds: [] }],
		directives: { threadChanges: [], newThreads: [] },
		sourceEntryIds: ['entry_7'],
		serverVersion: 12,
		now: '2026-08-24T12:00:00.000Z',
		...overrides,
	});
}

describe('chapter thread reconciliation', () => {
	it('bounds generated directives and rejects unsupported actions', () => {
		const directives = coerceChapterThreadDirectives({
			threadChanges: Array.from({ length: 9 }, (_, index) => ({ threadId: `thread_${index}`, action: 'hold' })),
			newThreads: Array.from({ length: 4 }, (_, index) => ({
				title: `New ${index}`,
				currentState: 'Developing.',
				significance: 'major',
			})),
		});

		expect(directives.threadChanges).toHaveLength(8);
		expect(directives.newThreads).toHaveLength(3);
		expect(coerceChapterThreadDirectives({
			threadChanges: [{ threadId: 'thread_bad', action: 'delete' }],
		}).threadChanges).toEqual([]);
	});

	it('collapses new thread text onto an existing normalized title', () => {
		const result = plan({
			directives: {
				threadChanges: [],
				newThreads: [{
					title: 'The Ashen-Throne!',
					currentState: 'The claimant now controls the eastern gate.',
					significance: 'major',
					evidenceEventIds: ['event_7'],
				}],
			},
		});

		expect(result.inserts).toHaveLength(0);
		expect(result.updates).toHaveLength(1);
		expect(result.updates[0].threadId).toBe(existingThread.id);
		expect(result.openThreadIds).toEqual([existingThread.id]);
	});

	it('collapses duplicate new titles and merges their chapter evidence', () => {
		const result = plan({
			existingThreads: [],
			events: [{ id: 'event_7', threadIds: [] }, { id: 'event_8', threadIds: [] }],
			directives: {
				threadChanges: [],
				newThreads: [
					{ title: 'The Glass Crown', currentState: 'A claimant appears.', significance: 'major', evidenceEventIds: ['event_7'] },
					{ title: 'the glass-crown!', currentState: 'Duplicate wording.', significance: 'major', evidenceEventIds: ['event_8'] },
				],
			},
		});

		expect(result.inserts).toHaveLength(1);
		expect(result.inserts[0].sourceEventIds).toEqual(['event_7', 'event_8']);
		expect(result.openThreadIds).toHaveLength(1);
	});

	it('updates only an exact canonical id and filters unsupported evidence ids', () => {
		const result = plan({
			directives: {
				threadChanges: [{
					threadId: existingThread.id,
					action: 'advance',
					currentState: 'The claimant has seized the eastern gate.',
					evidenceEventIds: ['event_7', 'event_not_in_chapter'],
				}],
				newThreads: [],
			},
		});

		expect(result.updates[0]).toMatchObject({
			threadId: existingThread.id,
			values: {
				status: 'open',
				sourceEventIds: ['event_old', 'event_7'],
			},
		});
		expect(result.updates[0].values.description).toContain('Current state: The claimant has seized the eastern gate.');
		// The deferred apply compares the snapshot so a later edit to the event is never overwritten.
		expect(result.eventUpdates).toEqual([{ eventId: 'event_7', threadIds: [existingThread.id], previousThreadIds: [] }]);
	});

	it('ignores a resolve action without current-chapter evidence', () => {
		const result = plan({
			events: [{ id: 'event_7', threadIds: [existingThread.id] }],
			directives: {
				threadChanges: [{
					threadId: existingThread.id,
					action: 'resolve',
					evidenceEventIds: ['event_not_in_chapter'],
				}],
				newThreads: [],
			},
		});

		expect(result.openThreadIds).toEqual([existingThread.id]);
		expect(result.updates[0].values).not.toHaveProperty('closedAt');
		expect(result.updates[0].values).not.toHaveProperty('closureReason');
		expect(result.updates[0].values).not.toMatchObject({ status: 'closed' });
	});

	it('treats an evidenced closure as terminal when generated directives conflict', () => {
		const result = plan({
			directives: {
				threadChanges: [
					{ threadId: existingThread.id, action: 'resolve', evidenceEventIds: ['event_7'] },
					{ threadId: existingThread.id, action: 'advance', currentState: 'Conflicting retry.', evidenceEventIds: ['event_7'] },
				],
				newThreads: [],
			},
		});

		expect(result.updates[0].values).toMatchObject({ status: 'closed' });
		expect(result.updates[0].values.description).toBeUndefined();
		expect(result.openThreadIds).not.toContain(existingThread.id);
	});

	it('does not reopen an abandoned thread when a source event still references it', () => {
		const result = plan({
			existingThreads: [{ ...existingThread, status: 'abandoned' }],
			events: [{ id: 'event_7', threadIds: [existingThread.id] }],
		});

		expect(result.updates).toEqual([]);
		expect(result.openThreadIds).toEqual([]);
	});

	it('keeps canonical ids in metadata while chapter threads stay readable', () => {
		expect(chapterThreadMetadata([existingThread.id, existingThread.id])).toEqual({
			openThreadIds: [existingThread.id],
		});
		expect(humanizeChapterOpenThreads([existingThread.id, 'The Ashen Throne: duplicate wording'], [existingThread])).toEqual([
			existingThread.description,
		]);
	});
});
