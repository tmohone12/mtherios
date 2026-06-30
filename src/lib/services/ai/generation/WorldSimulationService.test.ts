import { describe, expect, it } from 'vitest';
import { WorldSimulationService, buildChapterWorldSimulationPrompt } from './WorldSimulationService';
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

function chapter(number: number): Chapter {
	return {
		id: `chapter-${number}`,
		storyId: 'story-1',
		number,
		title: `Chapter ${number}`,
		startEntryId: `entry-${number}-start`,
		endEntryId: `entry-${number}-end`,
		entryCount: 1,
		summary: `Summary ${number}`,
		startTime: null,
		endTime: null,
		keywords: [],
		characters: [],
		locations: [],
		plotThreads: [],
		emotionalTone: null,
		branchId: null,
		createdAt: number,
	};
}

function faction(name: string, description = '', stateOverrides: Partial<FactionEntryState> = {}, entryOverrides: Partial<Entry> = {}): Entry {
	const state: FactionEntryState = {
		type: 'faction',
		playerStanding: 0,
		status: 'unknown',
		knownMembers: [],
		...stateOverrides,
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
		...entryOverrides,
	};
}

class CapturingWorldSimulationService extends WorldSimulationService {
	lastSystem = '';

	protected override async generateStructured<T>(_schema: unknown, system: string): Promise<T> {
		this.lastSystem = system;
		return {
			plotInjection: null,
			worldNarrative: '',
			factionActions: [],
			rumors: [],
			worldTension: 0,
			plotSeeds: [],
			plotMomentum: null,
			threadUpdates: [],
		} as T;
	}
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

	it('renders structured faction goal descriptions in chapter prompts', () => {
		const latestChapter: Chapter = {
			id: 'chapter-4', storyId: 'story-1', number: 4, title: 'The River Gate',
			startEntryId: 'entry-40', endEntryId: 'entry-45', entryCount: 6,
			summary: 'House Stark presses its claim at the river gate.',
			startTime: null, endTime: null, keywords: ['gate'], characters: [], locations: [], plotThreads: [], emotionalTone: null, branchId: null, createdAt: 0,
		};

		const prompt = buildChapterWorldSimulationPrompt({
			latestChapter,
			recentEntries: [entry(40, 'House Stark envoys speak of the gate.')],
			factionEntries: [faction('House Stark', 'Northern faction.', {
				goals: [{ description: 'secure the river gate', priority: 8, progress: 25, type: 'military' }],
			})],
		});

		expect(prompt.user).toContain('goals: secure the river gate');
	});

	it('does not select deleted factions for chapter prompts', () => {
		const latestChapter: Chapter = {
			id: 'chapter-5', storyId: 'story-1', number: 5, title: 'Ghost Banners',
			startEntryId: 'entry-50', endEntryId: 'entry-55', entryCount: 6,
			summary: 'The Ghost House is mentioned only as a fallen faction.',
			startTime: null, endTime: null, keywords: ['Ghost House'], characters: [], locations: [], plotThreads: [], emotionalTone: null, branchId: null, createdAt: 0,
		};

		const prompt = buildChapterWorldSimulationPrompt({
			latestChapter,
			recentEntries: [entry(50, 'A scribe mentions Ghost House ruins.')],
			factionEntries: [faction('Ghost House', 'Deleted faction.', {}, { deleted: true })],
		});

		expect(prompt.relevantFactions).toEqual([]);
		expect(prompt.user).not.toContain('Deleted faction.');
	});

	it('matches faction names as whole terms instead of substrings', () => {
		const latestChapter: Chapter = {
			id: 'chapter-6', storyId: 'story-1', number: 6, title: 'Hundred Banners',
			startEntryId: 'entry-60', endEntryId: 'entry-65', entryCount: 6,
			summary: 'A hundred banners rise above the gate while no faction is named.',
			startTime: null, endTime: null, keywords: ['hundred'], characters: [], locations: [], plotThreads: [], emotionalTone: null, branchId: null, createdAt: 0,
		};

		const prompt = buildChapterWorldSimulationPrompt({
			latestChapter,
			recentEntries: [entry(60, 'The word hundred is repeated by the herald.')],
			factionEntries: [faction('Red', 'Should not match hundred.')],
		});

		expect(prompt.relevantFactions).toEqual([]);
	});

	it('uses the newest relation shifts when building world-simulation context', async () => {
		const service = new CapturingWorldSimulationService();
		const relationChangeLog = Array.from({ length: 9 }, (_, index) => ({
			source: 'House A',
			target: 'House B',
			event: `relation shift ${index + 1}`,
			delta: 5,
			chapter: index + 1,
		}));

		await service.simulate(
			[chapter(1)], [], [], [], [], [], [], [], [], 'Gatehouse', '', null,
			'adventure', 'second', 'present', [], relationChangeLog,
		);

		expect(service.lastSystem).toContain('Ch.9');
		expect(service.lastSystem).not.toContain('Ch.1: House A ↔ House B');
	});
});
