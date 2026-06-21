import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storyMock, canonicalMocks, databaseMocks } = vi.hoisted(() => {
	const storyMock = {
		currentStory: null as any,
		protagonist: null as any,
		characters: [] as any[],
		lorebookEntries: [] as any[],
		locations: [] as any[],
		items: [] as any[],
		entries: [] as any[],
		worldEvents: [] as any[],
		entryRelationships: [] as any[],
		addCharacter: vi.fn(),
		updateCharacterFromClassification: vi.fn(),
		clearPresenceForCharacters: vi.fn(),
		addOrUpdateLocation: vi.fn(),
		updatePresence: vi.fn(),
		addOrUpdateItem: vi.fn(),
		applyAgreementChanges: vi.fn(),
		preEmbedLorebook: vi.fn(),
		buildStateSnapshot: vi.fn(),
	};
	const canonicalMocks = {
		patchCanonicalLorebookEntry: vi.fn(),
		saveCanonicalConversationMemory: vi.fn(),
		saveCanonicalFactionActions: vi.fn(),
		saveCanonicalLorebookEntry: vi.fn(),
		saveCanonicalRumors: vi.fn(),
		saveCanonicalWorldEvent: vi.fn(),
	};
	const databaseMocks = {
		createEntryRelationship: vi.fn(),
		getRelationshipsForEntry: vi.fn(),
		updateEntryRelationship: vi.fn(),
		createStoryBeat: vi.fn(),
		updateStory: vi.fn(),
		getChapters: vi.fn(),
		getArcs: vi.fn(),
		getStoryThreads: vi.fn(),
		createStoryThread: vi.fn(),
		updateStoryThread: vi.fn(),
		getAgreements: vi.fn(),
		getWorldEvents: vi.fn(),
	};
	return { storyMock, canonicalMocks, databaseMocks };
});

vi.mock('$lib/stores/story.svelte', () => ({ story: storyMock }));

vi.mock('$lib/stores/settings.svelte', () => ({
	settings: { getServiceConfig: vi.fn(() => ({ enabled: false })) },
}));

vi.mock('$lib/services/ai', () => ({
	ai: {
		worldSim: {
			generateMomentum: vi.fn(),
			simulate: vi.fn(),
		},
	},
}));

vi.mock('$lib/services/terminalWiki', () => ({
	briefTerminalWiki: vi.fn(),
	contextTerminalWiki: vi.fn(),
}));

vi.mock('$lib/services/database', () => databaseMocks);
vi.mock('$lib/services/canonicalWrites', () => canonicalMocks);

vi.mock('$lib/services/ai/scheme/SchemeService', () => ({
	shouldEvaluate: vi.fn(() => false),
	evaluate: vi.fn(),
	tick: vi.fn(),
}));

import { executeToolCall } from './executor';

function resetStoryMock() {
	vi.clearAllMocks();
	storyMock.currentStory = { id: 'story-1', serverVersion: 1, syncStatus: 'synced' };
	storyMock.protagonist = null;
	storyMock.characters = [
		{
			id: 'char-established',
			storyId: 'story-1',
			name: 'Established Ally',
			description: null,
			relationship: null,
			traits: [],
			visualDescriptors: {},
			portrait: null,
			status: 'active',
			metadata: null,
			branchId: null,
		},
	];
	storyMock.lorebookEntries = [];
	storyMock.locations = [];
	storyMock.items = [];
	storyMock.entries = [];
	storyMock.worldEvents = [];
	storyMock.entryRelationships = [];
	storyMock.addCharacter.mockResolvedValue(null);
	storyMock.updateCharacterFromClassification.mockResolvedValue(undefined);
	storyMock.clearPresenceForCharacters.mockResolvedValue(undefined);
	storyMock.addOrUpdateLocation.mockResolvedValue(undefined);
	storyMock.updatePresence.mockResolvedValue(undefined);
	storyMock.addOrUpdateItem.mockResolvedValue(undefined);
	storyMock.applyAgreementChanges.mockResolvedValue(undefined);
	storyMock.preEmbedLorebook.mockResolvedValue(undefined);
	storyMock.buildStateSnapshot.mockResolvedValue({});
	canonicalMocks.patchCanonicalLorebookEntry.mockResolvedValue({ entry: null, serverVersion: 2 });
	canonicalMocks.saveCanonicalConversationMemory.mockResolvedValue(null);
	canonicalMocks.saveCanonicalFactionActions.mockResolvedValue(null);
	canonicalMocks.saveCanonicalLorebookEntry.mockResolvedValue(2);
	canonicalMocks.saveCanonicalRumors.mockResolvedValue(null);
	canonicalMocks.saveCanonicalWorldEvent.mockResolvedValue(null);
	databaseMocks.getRelationshipsForEntry.mockResolvedValue([]);
	databaseMocks.getChapters.mockResolvedValue([]);
	databaseMocks.getArcs.mockResolvedValue([]);
	databaseMocks.getStoryThreads.mockResolvedValue([]);
	databaseMocks.getAgreements.mockResolvedValue([]);
	databaseMocks.getWorldEvents.mockResolvedValue([]);
}

describe('executeToolCall update_world_state', () => {
	beforeEach(() => {
		resetStoryMock();
	});

	it('updates existing characters but does not create unknown character canon from inline tools', async () => {
		const result = await executeToolCall('update_world_state', {
			characters: [
				{
					name: 'Established Ally',
					description: 'Now openly suspicious of the bargain.',
					relationship: 'uneasy ally',
					status: 'active',
					traits: ['watchful'],
					present: true,
				},
				{
					name: 'Unnamed Scout',
					description: 'A quiet figure watching from the ridge.',
					relationship: 'stranger',
					status: 'active',
					traits: ['quiet'],
					present: true,
				},
			],
			locations: [
				{
					name: 'Old Gate',
					current: true,
				},
			],
			lorebook_entries: [
				{
					name: 'Unnamed Scout',
					type: 'character',
					description: 'A quiet figure watching from the ridge.',
				},
			],
		});

		expect(JSON.parse(result)).toEqual({ success: true });
		expect(storyMock.updateCharacterFromClassification).toHaveBeenCalledWith(
			'Established Ally',
			{
				description: 'Now openly suspicious of the bargain.',
				relationship: 'uneasy ally',
				status: 'active',
				traits: ['watchful'],
			},
		);
		expect(storyMock.addCharacter).not.toHaveBeenCalled();
		expect(canonicalMocks.saveCanonicalLorebookEntry).not.toHaveBeenCalled();
		expect(storyMock.updatePresence).toHaveBeenCalledWith(['Established Ally'], 'Old Gate');
	});

	it('keeps unknown faction members as unresolved context instead of dropping or creating them', async () => {
		storyMock.lorebookEntries = [
			{
				id: 'entry-established-ally',
				storyId: 'story-1',
				name: 'Established Ally',
				type: 'character',
				description: 'A known ally.',
				hiddenInfo: null,
				aliases: [],
				state: { type: 'character' },
				adventureState: null,
				creativeState: null,
				injection: { mode: 'keyword', keywords: ['Established Ally'], priority: 80 },
				firstMentioned: null,
				lastMentioned: null,
				mentionCount: 0,
				createdBy: 'user',
				createdAt: 1,
				updatedAt: 1,
				loreManagementBlacklisted: false,
				branchId: null,
			},
		];

		const result = await executeToolCall('update_world_state', {
			lorebook_entries: [
				{
					name: 'Ridge Watch',
					type: 'faction',
					description: 'A border faction watching the ridgeline.',
					known_members: ['Established Ally', 'Unnamed Scout'],
				},
			],
		});

		expect(JSON.parse(result)).toEqual({ success: true });
		expect(storyMock.addCharacter).not.toHaveBeenCalled();
		expect(canonicalMocks.saveCanonicalLorebookEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'Ridge Watch',
				type: 'faction',
				state: expect.objectContaining({
					knownMembers: ['entry-established-ally'],
					unresolvedKnownMembers: ['Unnamed Scout'],
				}),
			}),
			'create',
		);
	});
});
