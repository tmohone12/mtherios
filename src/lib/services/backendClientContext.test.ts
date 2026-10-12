import { describe, expect, it } from 'vitest';
import { buildBackendClientContext } from './backendClientContext';

it('sends a turn count by default while preserving explicit legacy token requests', () => {
	expect(buildBackendClientContext({ characters: [], locations: [], recentDialogueTurns: 20 })).toMatchObject({ recentDialogueTurns: 20 });
	expect(buildBackendClientContext({ characters: [], locations: [] })).toMatchObject({ recentDialogueTurns: 20 });
	expect(buildBackendClientContext({ characters: [], locations: [], recentDialogueTokens: 24000 })).toMatchObject({ recentDialogueTokens: 24000 });
});

it('sends the fixed 20-turn and 10-chapter cadence on the legacy wire keys', () => {
	expect(buildBackendClientContext({ characters: [], locations: [] }))
		.toMatchObject({ chapterThreshold: 20, postChapterBuffer: 0, chaptersPerArc: 10 });
});

describe('backend client context', () => {
	it('sends only scene-relevant NPCs instead of every active character', () => {
		const context = buildBackendClientContext({
			characters: [
				{ id: 'pc_aurion', name: 'Aurion Belaerys', status: 'active', relationship: 'self' },
				{ id: 'npc_maera', name: 'Maera Belaerys', status: 'active', metadata: { present: true, currentLocation: 'Villa of the Sun' } },
				{ id: 'npc_daenerys', name: 'Daenerys Targaryen', status: 'active', metadata: { lastSeenLocation: 'Phoenix Chamber' } },
				{ id: 'npc_addam', name: 'Addam Velaryon', status: 'active' },
				{ id: 'npc_aegon_iii', name: 'Aegon III Targaryen', status: 'active' },
			],
			locations: [{ id: 'loc_study', name: 'Villa of the Sun', current: true }],
			promptEntries: [{
				type: 'narration',
				content: 'Inside Maera Belaerys\'s private study, the old woman studies the map while Aurion speaks.',
			}],
			currentActionText: 'I ask Maera what the house will do next.',
			contextBudget: 32000,
		});

		expect(context.sceneEntityIds).toEqual(['pc_aurion', 'loc_study', 'npc_maera']);
		expect(context.presentNpcIds).toEqual(['npc_maera']);
		expect(context.sceneEntityIds).not.toContain('npc_addam');
		expect(context.sceneEntityIds).not.toContain('npc_aegon_iii');
	});

	it('prioritizes exactly named scene actors over stale presence and location flags', () => {
		const staleCharacters = Array.from({ length: 9 }, (_, index) => ({
			id: `npc_stale_${index}`,
			name: `Stale NPC ${index}`,
			status: 'active',
			metadata: { present: true, currentLocation: 'Occult Research Club Room' },
		}));
		const context = buildBackendClientContext({
			characters: [
				...staleCharacters,
				{ id: 'npc_amaterasu', name: 'Amaterasu', status: 'active', metadata: { present: false, currentLocation: 'Inner Residence, Bedroom' } },
			],
			locations: [{ id: 'loc_bedroom', name: 'Inner Residence, Bedroom', current: true }],
			promptEntries: [{ type: 'narration', content: 'Amaterasu rests one hand on his hair beside the pool.' }],
			currentActionText: 'I ask Amaterasu what she wants to do next.',
		});

		expect(context.presentNpcIds[0]).toBe('npc_amaterasu');
		expect(context.presentNpcIds).not.toContain('npc_stale_0');
		expect(context.sceneEntityIds).toContain('npc_amaterasu');
	});

	it('grounds montage scenes from the header and final beat, not earlier montage actors', () => {
		const context = buildBackendClientContext({
			characters: [
				{ id: 'npc_sona', name: 'Sona Sitri', status: 'active' },
				{ id: 'npc_amaterasu', name: 'Amaterasu', status: 'active' },
			],
			locations: [{ id: 'loc_bedroom', name: 'Tamegura Inner Residence Bedroom', current: true }],
			promptEntries: [{
				type: 'narration',
				content: '[ Tamegura - Inner Residence, Bedroom ]\n\nSona Sitri signs the repair report at Kuoh.\n\nTuesday passes in rain.\n\nWednesday passes quietly.\n\nThursday brings a distant letter.\n\nAmaterasu settles beside you in the bedroom.\n\nThe house is still around you both.',
			}],
		});

		expect(context.presentNpcIds).toEqual(['npc_amaterasu']);
		expect(context.sceneEntityIds).not.toContain('npc_sona');
	});

	it('does not send an NPC mentioned only as an unrealized comparison', () => {
		const context = buildBackendClientContext({
			characters: [
				{ id: 'npc_amaterasu', name: 'Amaterasu', status: 'active' },
				{ id: 'npc_great_red', name: 'Great Red', status: 'active' },
			],
			locations: [{ id: 'loc_nursery', name: 'Inner Residence Nursery', current: true }],
			promptEntries: [{
				type: 'narration',
				content: '[ Inner Residence, Nursery ]\n\nAmaterasu stands beside you at the cradle.\n\nYour diminished power is no longer enough to challenge Great Red.',
			}],
		});

		expect(context.presentNpcIds).toEqual(['npc_amaterasu']);
		expect(context.sceneEntityIds).not.toContain('npc_great_red');
	});

	it('does not treat a player action as proof that its target is already present', () => {
		const context = buildBackendClientContext({
			characters: [{ id: 'npc_great_red', name: 'Great Red', status: 'active' }],
			locations: [{ id: 'loc_nursery', name: 'Inner Residence Nursery', current: true }],
			promptEntries: [{ type: 'narration', content: '[ Inner Residence, Nursery ]\n\nYou are alone beside the cradle.' }],
			currentActionText: 'I challenge Great Red to appear before me.',
		});

		expect(context.presentNpcIds).toEqual([]);
		expect(context.sceneEntityIds).not.toContain('npc_great_red');
	});

	it('ignores locationless stale presence when the current scene location is known', () => {
		const located = buildBackendClientContext({
			characters: [{ id: 'npc_stale', name: 'Stale Witness', status: 'active', metadata: { present: true } }],
			locations: [{ id: 'loc_bedroom', name: 'Inner Residence Bedroom', current: true }],
		});
		const unknown = buildBackendClientContext({
			characters: [{ id: 'npc_stale', name: 'Stale Witness', status: 'active', metadata: { present: true } }],
			locations: [],
		});

		expect(located.presentNpcIds).toEqual([]);
		expect(unknown.presentNpcIds).toEqual(['npc_stale']);
	});
});
