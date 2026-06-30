import { describe, expect, it } from 'vitest';
import { buildBackendClientContext } from './backendClientContext';

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
});
