import { describe, expect, it } from 'vitest';
import { buildWikiLintPromptPayload } from './WikiLintService';
import type { Chapter, Entry, EntryRelationship, EntryType } from '$lib/types';

function entry(index: number, type: EntryType = 'concept'): Entry {
	const now = 1_700_000_000_000 + index;
	return {
		id: `entry_${index}`,
		storyId: 'story_1',
		branchId: null,
		name: `Entry ${index}`,
		type,
		description: `Description for entry ${index}.`,
		hiddenInfo: index % 10 === 0 ? `Hidden detail ${index}.` : null,
		aliases: [`Alias ${index}`],
		state: type === 'faction'
			? {
				type: 'faction',
				playerStanding: 0,
				status: 'neutral',
				knownMembers: [],
				goals: [{
					description: `Goal ${index}`,
					priority: 5,
					progress: 10,
					type: 'diplomatic',
				}],
			}
			: { type },
		adventureState: null,
		creativeState: null,
		injection: { mode: 'keyword', keywords: [`entry${index}`], priority: 50 },
		firstMentioned: null,
		lastMentioned: null,
		mentionCount: index,
		createdBy: 'user',
		createdAt: now,
		updatedAt: now,
		loreManagementBlacklisted: false,
	} as Entry;
}

function chapter(index: number): Chapter {
	return {
		id: `chapter_${index}`,
		storyId: 'story_1',
		number: index,
		title: `Chapter ${index}`,
		startEntryId: `start_${index}`,
		endEntryId: `end_${index}`,
		entryCount: 2,
		summary: `Chapter ${index} mentions Entry ${index}.`,
		startTime: null,
		endTime: null,
		keywords: [],
		characters: [],
		locations: [],
		plotThreads: [],
		emotionalTone: null,
		branchId: null,
		createdAt: 1_700_000_000_000 + index,
	};
}

describe('buildWikiLintPromptPayload', () => {
	it('includes every active entry instead of sampling the first page', () => {
		const entries = Array.from({ length: 95 }, (_, index) => entry(index + 1, index === 94 ? 'faction' : 'concept'));
		const deleted = { ...entry(999), deleted: true };
		const relationships: EntryRelationship[] = [{
			id: 'rel_1',
			storyId: 'story_1',
			sourceEntryId: 'entry_1',
			targetEntryId: 'entry_95',
			type: 'related-to',
			label: 'test link',
			strength: 50,
			bidirectional: false,
			metadata: null,
			createdAt: 1,
			updatedAt: 1,
		}];

		const payload = buildWikiLintPromptPayload([...entries, deleted], relationships, [chapter(1)]);

		expect(payload.coverage.entryCount).toBe(95);
		expect(payload.coverage.allEntriesIncluded).toBe(true);
		expect(payload.prompt).toContain('ALL ACTIVE ENTRIES');
		expect(payload.prompt).toContain('id=entry_1');
		expect(payload.prompt).toContain('id=entry_95');
		expect(payload.prompt).not.toContain('id=entry_999');
		expect(payload.prompt).toContain('rel_1');
	});
});
