import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character, Story } from '$lib/types';
import { normalizePlayerSheet } from '$lib/utils/playerSheet';

const mocks = vi.hoisted(() => ({ saveCanonicalCharacter: vi.fn() }));
vi.mock('$lib/services/canonicalWrites', async importOriginal => ({
	...await importOriginal<typeof import('$lib/services/canonicalWrites')>(),
	saveCanonicalCharacter: mocks.saveCanonicalCharacter,
}));
import { story } from './story.svelte';

const player: Character = {
	id: 'player', storyId: 'story', branchId: null, name: 'Aurion', description: 'An exiled prince.',
	traits: ['patient'], relationship: 'self', status: 'active', metadata: {}, visualDescriptors: {}, portrait: null,
};

describe('protagonist saves', () => {
	beforeEach(() => {
		story.clear();
		story.currentStory = { id: 'story', serverStoryId: 'server_story', serverVersion: 1 } as Story;
		mocks.saveCanonicalCharacter.mockImplementation(async (character: Character) => ({
			character, serverVersion: 2, entry: { id: character.id, type: 'character', name: character.name, state: {} },
		}));
	});
	afterEach(() => { story.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); });

	it('preserves description when saving only stats', async () => {
		story.characters = [{ ...player }];
		await story.saveProtagonist({ name: player.name, playerSheet: normalizePlayerSheet({ abilities: { str: 16 } }) });
		expect(story.protagonist?.description).toBe(player.description);
		expect(story.protagonist?.metadata?.playerSheet).toMatchObject({ abilities: { str: 16 } });
	});

	it('saves and clears player capabilities without changing biography or numeric scores', async () => {
		const playerSheet = normalizePlayerSheet({ abilities: { cha: 16 } });
		story.characters = [{ ...player, metadata: { playerSheet } }];
		for (const playerCapabilities of [{ abilities: ['Keen senses'], buffs: ['Cold ward until dawn'] }, { abilities: [], buffs: [] }]) {
			await story.saveProtagonist({ name: player.name, playerCapabilities });
			expect(story.protagonist?.description).toBe(player.description);
			expect(story.protagonist?.metadata).toMatchObject({ playerSheet, playerCapabilities });
		}
		const projection = story as unknown as { serverEntityToCharacter(value: Record<string, unknown>): Character };
		const reloaded = projection.serverEntityToCharacter({ id: player.id, name: player.name, type: 'character', state: { relationship: 'self', playerCapabilities: { abilities: [], buffs: [] } }, metadata: { originalMetadata: { playerCapabilities: { abilities: ['Old ability'], buffs: ['Expired ward'] } } } });
		expect(reloaded.metadata?.playerCapabilities).toEqual({ abilities: [], buffs: [] });
	});

	it.each([
		{ state: { relationship: { status: 'self', level: 100 }, currentDisposition: 'focused on the letter' }, metadata: {} },
		{ state: { relationship: { status: 'player_character' }, currentDisposition: 'grieving' }, metadata: {} },
		{ state: { currentDisposition: 'focused' }, metadata: { playerCharacter: true } },
	])('keeps the player identifiable when their disposition changes %#', row => {
		const projection = story as unknown as { serverEntityToCharacter(value: Record<string, unknown>): Character };
		story.characters = [projection.serverEntityToCharacter({ id: player.id, name: player.name, type: 'character', status: 'active', ...row })];
		expect(story.protagonist?.id).toBe(player.id);
		expect(story.protagonist?.metadata?.currentDisposition).toBe(row.state.currentDisposition);
	});

	it('preserves newly saved traits when creation also saves stats', async () => {
		vi.spyOn(story, 'addCharacter').mockImplementation(async () => {
			const created = { ...player, traits: [] };
			story.characters = [created];
			return created;
		});
		await story.saveProtagonist({ name: player.name, traits: ['resolute'], playerSheet: normalizePlayerSheet(null) });
		expect(story.protagonist?.traits).toEqual(['resolute']);
		expect(story.protagonist?.metadata?.playerSheet).toBeDefined();
	});
});
