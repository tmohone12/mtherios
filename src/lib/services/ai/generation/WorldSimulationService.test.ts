import { describe, expect, it } from 'vitest';
import { buildChapterWorldSimulationPrompt } from './WorldSimulationService';
import type { Chapter, Entry, FactionEntryState, StoryEntry } from '$lib/types';

function entry(position: number, content: string): StoryEntry {
	return {
		id: `entry-${position}`,
		storyId: 'story-1',
		type: position % 2 === 0 ? 'user_action' : 'narration',
		content,
		parentId: null,
		position,
		createdAt: position,
		metadata: null,
		branchId: null,
	};
}

function faction(name: string, description = ''): Entry {
	const state: FactionEntryState = {
		type: 'faction',
		playerStanding: 0,
		status: 'unknown',
		knownMembers: [],
	};

	return {
		id: `faction-${name.toLowerCase().replace(/\W+/g, '-')}`,
		storyId: 'story-1',
		name,
		type: 'faction',
		description,
		hiddenInfo: null,
		aliases: [],
		state,
		adventureState: null,
		creativeState: null,
		injection: { mode: 'keyword', keywords: [name], priority: 0 },
		firstMentioned: null,
		lastMentioned: null,
		mentionCount: 0,
		branchId: null,
		createdBy: 'user',
		createdAt: 0,
		updatedAt: 0,
		loreManagementBlacklisted: false,
	};
}

describe('buildChapterWorldSimulationPrompt', () => {
	it('uses only the latest chapter, last twelve entries, and relevant factions', () => {
		const latestChapter: Chapter = {
			id: 'chapter-3',
			storyId: 'story-1',
			number: 3,
			title: 'The Gate Debt',
			startEntryId: 'entry-20',
			endEntryId: 'entry-31',
			entryCount: 12,
			summary: 'House Stark shelters the wounded courier while river agents circle the gate.',
			startTime: null,
			endTime: null,
			keywords: ['gate', 'courier'],
			characters: ['Asha'],
			locations: ['Riverrun Gate'],
			plotThreads: ['The courier debt'],
			emotionalTone: 'tense',
			branchId: null,
			createdAt: 0,
		};
		const recentEntries = [
			entry(1, 'old-turn-1: an unrelated court feast'),
			...Array.from({ length: 13 }, (_, i) => entry(i + 2, `recent-turn-${i + 2}: House Stark watches the gate`)),
		];

		const prompt = buildChapterWorldSimulationPrompt({
			latestChapter,
			recentEntries,
			factionEntries: [
				faction('House Stark', 'Northern faction at the gate.'),
				faction('Iron Bank', 'Distant creditor not present in this chapter.'),
			],
			mode: 'adventure',
			pov: 'second',
			tense: 'present',
		});

		expect(prompt.system).toContain('ONLY the newly closed chapter');
		expect(prompt.user).toContain('The Gate Debt');
		expect(prompt.user).toContain('recent-turn-14');
		expect(prompt.user).not.toContain('old-turn-1');
		expect(prompt.relevantFactions.map((item) => item.name)).toEqual(['House Stark']);
		expect(prompt.user).toContain('House Stark');
		expect(prompt.user).not.toContain('Iron Bank');
	});
});
