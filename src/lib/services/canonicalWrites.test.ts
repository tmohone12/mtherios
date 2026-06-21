import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Arc, Character } from '$lib/types';

const mocks = vi.hoisted(() => ({
	database: {
		getStory: vi.fn(),
		getLorebookEntry: vi.fn(),
		getArcs: vi.fn(),
		putLorebookEntry: vi.fn(),
		putCharacter: vi.fn(),
		updateStory: vi.fn(),
		deleteLorebookEntry: vi.fn(),
		deleteArc: vi.fn(),
		deleteChapter: vi.fn(),
		createConversationMemory: vi.fn(),
		bulkPutFactionActions: vi.fn(),
		bulkPutRumors: vi.fn(),
		bulkPutSchemes: vi.fn(),
		putArc: vi.fn(),
		putChapter: vi.fn(),
		putSaga: vi.fn(),
		putItem: vi.fn(),
		putLocation: vi.fn(),
		putWorldEvent: vi.fn(),
		updateLorebookEntry: vi.fn(),
	},
	serverStories: {
		createBackendLorebookEntry: vi.fn(),
		upsertBackendLorebookEntry: vi.fn(),
		deleteBackendLorebookEntry: vi.fn(),
		createBackendArc: vi.fn(),
		createBackendChapter: vi.fn(),
		createBackendSaga: vi.fn(),
		deleteBackendArc: vi.fn(),
		deleteBackendChapter: vi.fn(),
		upsertBackendArc: vi.fn(),
		upsertBackendChapter: vi.fn(),
		upsertBackendLivingMemory: vi.fn(),
		upsertBackendSaga: vi.fn(),
	},
}));

vi.mock('$lib/services/database', () => mocks.database);
vi.mock('$lib/services/serverStories', () => mocks.serverStories);

import { deleteCanonicalChapter, saveCanonicalCharacter } from './canonicalWrites';

describe('canonical character writes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.database.getStory.mockResolvedValue({
			id: 'local-story-1',
			serverStoryId: 'server-story-1',
		});
		mocks.database.getLorebookEntry.mockResolvedValue(null);
		mocks.database.getArcs.mockResolvedValue([]);
		mocks.database.putLorebookEntry.mockResolvedValue(undefined);
		mocks.database.putCharacter.mockResolvedValue(undefined);
		mocks.database.updateStory.mockResolvedValue(undefined);
		mocks.database.putArc.mockResolvedValue(undefined);
		mocks.database.deleteChapter.mockResolvedValue(undefined);
		mocks.serverStories.createBackendLorebookEntry.mockResolvedValue({
			serverVersion: 42,
			entity: { id: 'char_mira', type: 'character', name: 'Mira of the Harbor' },
			resolvedCharacterReferences: [
				{ proposalId: 'proposal_ser_olyvar', name: 'Ser Olyvar', entityId: 'char_mira' },
			],
		});
		mocks.serverStories.upsertBackendLorebookEntry.mockResolvedValue({ serverVersion: 43 });
		mocks.serverStories.deleteBackendChapter.mockResolvedValue({
			storyId: 'server-story-1',
			serverVersion: 44,
			chapterId: 'chapter-1',
			deleted: true,
			unwrappedArcIds: [],
			unwrappedArcs: [],
		});
	});

	it('preserves explicit character control fields in the canonical entry state', async () => {
		const character = {
			id: 'char_mira',
			storyId: 'local-story-1',
			branchId: null,
			name: 'Mira of the Harbor',
			description: 'A harbor fixer with an eye for debt and silence.',
			traits: ['watchful', 'pragmatic'],
			relationship: 'ally',
			status: 'active',
			metadata: {
				appearance: 'Salt-stiff cloak, copper rings, narrow scar over one brow.',
				voice: 'Low, amused, never rushed.',
				mannerisms: ['taps coin twice before lying'],
				personalityDescriptors: ['patient', 'transactional'],
				lastSeenLocation: 'Black Quay',
				factionName: 'Harbor Compact',
				rank: 'Broker',
				role: 'Informant',
				visibilityNote: 'Player-known contact; her patron remains secret.',
			},
			visualDescriptors: {
				distinguishing: 'Salt-stiff cloak, copper rings, narrow scar over one brow.',
			},
			portrait: null,
		} satisfies Character;

		const result = await saveCanonicalCharacter(character, 'create');

		expect(result.serverVersion).toBe(42);
		expect(result.resolvedCharacterReferences).toEqual([
			{ proposalId: 'proposal_ser_olyvar', name: 'Ser Olyvar', entityId: 'char_mira' },
		]);
		expect(result.entry).toMatchObject({
			id: 'char_mira',
			type: 'character',
			name: 'Mira of the Harbor',
			state: {
				type: 'character',
				appearance: 'Salt-stiff cloak, copper rings, narrow scar over one brow.',
				voice: 'Low, amused, never rushed.',
				mannerisms: ['taps coin twice before lying'],
				personalityDescriptors: ['patient', 'transactional'],
				lastSeenLocation: 'Black Quay',
				factionName: 'Harbor Compact',
				rank: 'Broker',
				role: 'Informant',
				visibilityNote: 'Player-known contact; her patron remains secret.',
			},
		});
		expect(mocks.serverStories.createBackendLorebookEntry).toHaveBeenCalledWith('server-story-1', result.entry);
		expect(mocks.database.putLorebookEntry).toHaveBeenCalledWith(result.entry);
		expect(mocks.database.putCharacter).toHaveBeenCalledWith(character);
	});

	it('adopts the backend-resolved character id before updating local canon projections', async () => {
		mocks.serverStories.createBackendLorebookEntry.mockResolvedValueOnce({
			serverVersion: 45,
			entity: { id: 'char_existing_mira', type: 'character', name: 'Mira of the Harbor' },
		});
		const duplicateDraft = {
			id: 'char_duplicate_draft',
			storyId: 'local-story-1',
			branchId: null,
			name: 'Mira of the Harbor',
			description: 'A second manual entry for the same harbor fixer.',
			traits: [],
			relationship: 'ally',
			status: 'active',
			metadata: null,
			visualDescriptors: {},
			portrait: null,
		} satisfies Character;

		const result = await saveCanonicalCharacter(duplicateDraft, 'create');

		expect(result.entry.id).toBe('char_existing_mira');
		expect(mocks.database.putLorebookEntry).toHaveBeenCalledWith(expect.objectContaining({
			id: 'char_existing_mira',
			name: 'Mira of the Harbor',
			type: 'character',
		}));
		expect(mocks.database.putCharacter).toHaveBeenCalledWith(expect.objectContaining({
			id: 'char_existing_mira',
			name: 'Mira of the Harbor',
		}));
		expect(mocks.database.putCharacter).not.toHaveBeenCalledWith(expect.objectContaining({
			id: 'char_duplicate_draft',
		}));
	});

	it('deletes chapters through the backend and unwraps local arcs that referenced them', async () => {
		const arcWithChapter = {
			id: 'arc-1',
			storyId: 'local-story-1',
			arcNumber: 1,
			title: 'Harbor Trouble',
			summary: 'The harbor thread tightens.',
			keyPlotPoints: [],
			characterArcs: [],
			unresolvedThreads: [],
			threadIds: [],
			resolvedThreadIds: [],
			emotionalProgression: 'uneasy',
			chapterIds: ['chapter-1', 'chapter-2'],
			chapterRange: '1-2',
			branchId: null,
			createdAt: 1,
		} satisfies Arc;
		const unrelatedArc = {
			...arcWithChapter,
			id: 'arc-2',
			arcNumber: 2,
			title: 'Market Ashes',
			chapterIds: ['chapter-3'],
			chapterRange: '3',
		} satisfies Arc;
		mocks.database.getArcs.mockResolvedValueOnce([arcWithChapter, unrelatedArc]);
		mocks.serverStories.deleteBackendChapter.mockResolvedValueOnce({
			storyId: 'server-story-1',
			serverVersion: 46,
			chapterId: 'chapter-1',
			deleted: true,
			unwrappedArcIds: ['arc-1'],
			unwrappedArcs: [{ id: 'arc-1', chapterIds: ['chapter-2'] }],
		});

		await expect(deleteCanonicalChapter('local-story-1', 'chapter-1')).resolves.toBe(46);

		expect(mocks.serverStories.deleteBackendChapter).toHaveBeenCalledWith('server-story-1', 'chapter-1');
		expect(mocks.database.deleteChapter).toHaveBeenCalledWith('chapter-1');
		expect(mocks.database.getArcs).toHaveBeenCalledWith('local-story-1');
		expect(mocks.database.putArc).toHaveBeenCalledTimes(1);
		expect(mocks.database.putArc).toHaveBeenCalledWith({
			...arcWithChapter,
			chapterIds: ['chapter-2'],
		});
	});
});
