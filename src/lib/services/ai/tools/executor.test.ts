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
		rumors: [] as any[],
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
vi.mock('$lib/services/ai/sdk/generate', () => ({ generateStructuredWithTools: vi.fn() }));

import { executeToolCall } from './executor';
import { generateStructuredWithTools } from '$lib/services/ai/sdk/generate';

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
	storyMock.rumors = [];
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
				relationship: 'uneasy ally',
				status: 'active',
				partyMember: undefined,
				partyRole: undefined,
			},
		);
		expect(storyMock.addCharacter).not.toHaveBeenCalled();
		expect(canonicalMocks.saveCanonicalLorebookEntry).not.toHaveBeenCalled();
		expect(storyMock.updatePresence).toHaveBeenCalledWith(['Established Ally'], 'Old Gate');
	});

	it('does not choose one of several matching character aliases', async () => {
		storyMock.lorebookEntries = ['one', 'two'].map(id => ({ id, type: 'character', name: id, aliases: ['Shared Alias'], state: {} } as any));
		await executeToolCall('update_world_state', { characters: [{ name: 'Shared Alias', background: 'A fabricated spy history.', current_action: 'watching' }] });
		expect(canonicalMocks.patchCanonicalLorebookEntry).not.toHaveBeenCalled();
		expect(storyMock.updateCharacterFromClassification).not.toHaveBeenCalled();
	});

	it('uses the refreshed canonical projection after classification commits', async () => {
		storyMock.entries = [{ id: 'original_source' }];
		storyMock.lorebookEntries = [{ id: 'char-established', type: 'character', name: 'Established Ally', state: { currentDisposition: 'old disposition' } } as any];
		storyMock.updateCharacterFromClassification.mockImplementationOnce(async () => {
			storyMock.lorebookEntries = [{ ...storyMock.lorebookEntries[0], state: { currentDisposition: 'new disposition' } }];
		});
		await executeToolCall('update_world_state', { characters: [{ name: 'Established Ally', relationship: 'new disposition', current_action: 'reading' }] });
		const automatic = canonicalMocks.patchCanonicalLorebookEntry.mock.calls[0][1].metadata.automaticCharacterUpdate;
		expect(automatic.patch.currentAction).toBe('reading');
		expect(automatic.patch).not.toHaveProperty('currentDisposition');
	});

	it('advances local time without ticking antagonist schemes', async () => {
		expect(JSON.parse(await executeToolCall('update_world_state', { time_delta: '1 day' }))).toEqual({ success: true });
		expect(generateStructuredWithTools).not.toHaveBeenCalled();
		expect(databaseMocks.updateStory).toHaveBeenCalled();
	});

	it('persists the full supported character continuity patch and applies affinity once per evidence entry', async () => {
		storyMock.entries = [{ id: 'entry_turn_12', position: 12 }];
		storyMock.lorebookEntries = [{
			id: 'char-established',
			storyId: 'story-1',
			name: 'Established Ally',
			type: 'character',
			aliases: ['The Ally'],
			state: {
				type: 'character',
				relationship: { level: 40, status: 'ally', history: [] },
				eventMemory: { saw: ['the old seal'] },
			},
		} as any];
		const update = {
			characters: [{
				name: 'Established Ally',
				aliases: ['Harbor Witness'],
				relationship: 'wary ally',
				present: true,
				pressures: ['The guild is closing in.'],
				faction_tags: ['Harbor Guild'],
				affinity_delta: -4,
				affinity_reason: 'The player exposed the seal.',
				current_location: 'Counting Room',
				current_action: 'guarding the ledger',
				emotional_state: 'controlled fear',
				appearance: 'salt-stained blue coat',
				background: 'Former guild auditor.',
				goals: ['Protect her brother.'],
				speech_style: 'precise and guarded',
				eventMemory: { saw: ['the new ledger'], knows: ['who broke the seal'] },
			}],
		};

		expect(JSON.parse(await executeToolCall('update_world_state', update))).toEqual({ success: true });
		const [, patch] = canonicalMocks.patchCanonicalLorebookEntry.mock.calls[0];

		expect(patch.aliases).toEqual(['The Ally']);
		expect(patch.metadata.automaticCharacterUpdate.patch).toMatchObject({ bio: 'Former guild auditor.', appearance: 'salt-stained blue coat', speechStyle: 'precise and guarded' });
		expect(patch.state).not.toHaveProperty('bio');
		expect(patch.state).not.toHaveProperty('appearance');
		expect(patch.state).toMatchObject({
			currentDisposition: 'wary ally',
			present: true,
			isPresent: true,
			pressures: ['The guild is closing in.'],
			factionTags: ['Harbor Guild'],
			currentLocation: 'Counting Room',
			currentAction: 'guarding the ledger',
			emotionalState: 'controlled fear',
			goals: ['Protect her brother.'],
			relationship: {
				level: 36,
				status: 'wary ally',
				history: [expect.objectContaining({ delta: -4, entryId: 'entry_turn_12' })],
			},
			eventMemory: {
				saw: ['the old seal', 'the new ledger'],
				knows: ['who broke the seal'],
			},
		});

		await executeToolCall('update_world_state', update);
		expect(canonicalMocks.patchCanonicalLorebookEntry).toHaveBeenCalledOnce();
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

describe('executeToolCall roll_check', () => {
	it('returns a renderable dice marker', async () => {
		const result = JSON.parse(await executeToolCall('roll_check', {
			notation: '1d20+3',
			dc: 15,
			ability: 'DEX',
			description: 'Cross the rain-slick roof',
		}));

		expect(result.ok).toBe(true);
		expect(result.result.dc).toBe(15);
		expect(result.diceMarker).toContain('{{dice:1d20+3|');
	});

	it('uses the protagonist sheet for ability checks', async () => {
		storyMock.protagonist = { metadata: { playerSheet: { abilities: { dex: 16 } } } };
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
		try {
			const result = JSON.parse(await executeToolCall('roll_check', {
				notation: '1d20+99', dc: 15, ability: 'Stealth', description: 'Cross the rain-slick roof',
			}));
			expect(result.result.notation).toBe('1d20+3');
		} finally {
			random.mockRestore();
		}
	});
});
