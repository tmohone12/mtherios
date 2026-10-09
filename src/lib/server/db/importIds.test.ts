import { describe, expect, it } from 'vitest';
import { remapImportedRecordIds } from './importIds';

describe('import record identities', () => {
	it('remaps location containment, rule owners, local exceptions and revisions without changing lore text', () => {
		const original = { story: { id: 'campaign', currentLocationId: 'room' },
			entities: [{ id: 'city', type: 'location', state: { locationKind: 'city' } }, { id: 'room', type: 'location' }],
			relationships: [{ id: 'inside', sourceEntityId: 'room', targetEntityId: 'city', type: 'part-of', metadata: { validFromTurn: 2 } }],
			facts: [{ id: 'old_rule', subjectEntityId: 'city', statement: 'city is source text, not an id reference.', metadata: { validToTurn: 5 } },
				{ id: 'rule', subjectEntityId: 'city', metadata: { supersedesId: 'old_rule', validFromTurn: 5, locationLore: { version: 1, scope: 'descendants' } } },
				{ id: 'exception', subjectEntityId: 'room', metadata: { locationLore: { version: 1, exceptionToFactIds: ['rule'] } }, sourcePatchIds: ['source_patch'] }],
			statePatches: [{ id: 'source_patch' }],
		};
		const copied = remapImportedRecordIds(original);
		expect(copied.relationships[0]).toMatchObject({ sourceEntityId: copied.entities[1].id, targetEntityId: copied.entities[0].id, metadata: { validFromTurn: 2 } });
		expect(copied.facts[1].metadata.supersedesId).toBe(copied.facts[0].id);
		expect(copied.facts[2].metadata.locationLore?.exceptionToFactIds).toEqual([copied.facts[1].id]);
		expect(copied.facts[2].sourcePatchIds).toEqual([copied.statePatches[0].id]);
		expect(copied.facts[0].statement).toBe(original.facts[0].statement);
		expect(copied.entities[0].state?.locationKind).toBe('city');
	});
	it('copies declared records and references without changing configuration or source text', () => {
		const source = {
			story: {
				id: 'story_1', shelfId: 'shelf_default', currentLocationId: 'location_1',
				serverStoryId: 'story_1', clientStoryId: 'local_1', syncStatus: 'synced',
				settings: { serviceId: 'narrative', modelId: 'model_1', templateId: 'court', profileId: 'profile_1' },
				metadata: { lastFrame: { id: 'frame_1', storyId: 'story_1', entityIds: ['entity_1'] } },
			},
			entities: [{ id: 'entity_1', locationId: 'location_1' }, { id: 'location_1' }],
			entries: [{ id: 'entry_1', content: 'entity_1', metadata: { serviceId: 'narrative' } }],
			facts: [{ id: 'fact_1', subjectEntityId: 'entity_1', sourceEntryIds: ['entry_1', 'unavailable_entry'] }],
			agreements: [{ id: 'agreement_1', parties: ['entity_1', 'a named group'] }],
		};
		const before = structuredClone(source);
		const copied = remapImportedRecordIds(source);
		expect(source).toEqual(before);
		expect(copied.story.id).not.toBe(source.story.id);
		expect(copied.entities[0].id).not.toBe('entity_1');
		expect(copied.story.currentLocationId).toBe(copied.entities[1].id);
		expect(copied.entities[0].locationId).toBe(copied.entities[1].id);
		expect(copied.facts[0]).toMatchObject({
			subjectEntityId: copied.entities[0].id,
			sourceEntryIds: [copied.entries[0].id, 'unavailable_entry'],
		});
		expect(copied.agreements[0].parties).toEqual([copied.entities[0].id, 'a named group']);
		expect(copied.story.settings).toEqual(source.story.settings);
		expect(copied.story.shelfId).toBe('shelf_default');
		expect(copied.entries[0].content).toBe('entity_1');
		expect(copied.story).toMatchObject({ serverStoryId: null, clientStoryId: null, syncStatus: 'syncing' });
		expect(copied.story.metadata.lastFrame).toEqual({
			id: 'frame_1', storyId: copied.story.id, entityIds: [copied.entities[0].id],
		});
		expect(remapImportedRecordIds(source).story.id).not.toBe(copied.story.id);
	});

	it('uses the same reference policy for legacy bundles and supplies a missing story ID', () => {
		const copied = remapImportedRecordIds({
			story: { title: 'Legacy story' },
			characters: [{ id: 'character_1' }],
			storyEntries: [{ id: 'entry_1', storyId: 'old_story', parentId: null }],
			entryRelationships: [{ id: 'relationship_1', sourceEntryId: 'character_1' }],
		});
		expect(copied.storyEntries[0].storyId).toMatch(/^story_/);
		expect(copied.storyEntries[0].parentId).toBeNull();
		expect(copied.entryRelationships[0].sourceEntryId).toBe(copied.characters[0].id);
	});
});
