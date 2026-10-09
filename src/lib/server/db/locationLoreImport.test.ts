import { describe, expect, it } from 'vitest';
import { validateImportedLocationLore } from './worldDatabaseImport';
import { remapImportedRecordIds } from './importIds';

const seed = () => ({ story: { id: 'story', currentTurn: 12 }, entities: [
	{ id: 'city', type: 'location', state: { locationKind: 'city' } }, { id: 'room', type: 'location', state: { locationKind: 'room' } },
], relationships: [{ id: 'inside', type: 'part-of', sourceEntityId: 'room', targetEntityId: 'city' }], facts: [
	{ id: 'rule', subjectEntityId: 'city', type: 'awoiaf_lore', statement: 'Existing sourced lore.', metadata: { url: 'https://example.test/source', locationLore: { version: 1, category: 'custom', scope: 'descendants', origin: 'foundation', salience: 'core' } } },
] });

describe('full database location lore imports', () => {
	it('accepts scoped legacy facts after complete ID remapping without modifying the original', () => {
		const original = seed();
		const before = structuredClone(original);
		const copied = remapImportedRecordIds(original);
		expect(() => validateImportedLocationLore(copied, copied.story.id, 12)).not.toThrow();
		expect(copied.facts[0].type).toBe('awoiaf_lore');
		expect(copied.facts[0].metadata.url).toBe(original.facts[0].metadata.url);
		expect(original).toEqual(before);
	});
	it('rejects cyclic and multiple-parent location graphs before persistence', () => {
		const cyclic = seed(); cyclic.relationships.push({ id: 'cycle', type: 'part-of', sourceEntityId: 'city', targetEntityId: 'room' });
		expect(() => validateImportedLocationLore(cyclic, 'story', 12)).toThrow('cycle');
		const duplicate = seed(); duplicate.relationships.push({ ...duplicate.relationships[0], id: 'duplicate' });
		expect(() => validateImportedLocationLore(duplicate, 'story', 12)).toThrow('multiple');
	});
	it('rejects malformed scoped facts and missing exception references while accepting flat legacy locations', () => {
		const malformed = seed();
		(malformed.facts[0].metadata.locationLore as Record<string, unknown>).scope = 'everywhere';
		expect(() => validateImportedLocationLore(malformed, 'story', 12)).toThrow();
		const missing = seed();
		(missing.facts[0].metadata.locationLore as Record<string, unknown>).exceptionToFactIds = ['missing'];
		expect(() => validateImportedLocationLore(missing, 'story', 12)).toThrow('missing');
		expect(() => validateImportedLocationLore({ entities: [{ id: 'legacy', type: 'location' }], relationships: [], facts: [] }, 'story', 12)).not.toThrow();
	});
	it('keeps local exceptions attached to an ancestor after ID remapping and rejects sibling exceptions', () => {
		const data = seed();
		data.facts.push({ ...data.facts[0], id: 'local', subjectEntityId: 'room', metadata: { ...data.facts[0].metadata, locationLore: { ...data.facts[0].metadata.locationLore, scope: 'self', exceptionToFactIds: ['rule'] } } } as typeof data.facts[number]);
		const copy = remapImportedRecordIds(data);
		expect(() => validateImportedLocationLore(copy, copy.story.id, 12)).not.toThrow();
		data.relationships = [];
		expect(() => validateImportedLocationLore(data, 'story', 12)).toThrow('ancestor');
	});
});
