import { describe, expect, it } from 'vitest';
import { validateLocationParent } from './locationRecords';
import { locationSaveArgsSchema } from '$lib/contracts/locationLore';

const places = ['city', 'manse', 'room', 'harbor'].map(id => ({ id, storyId: 'story', type: 'location', status: 'active' }));
const edge = (child: string, parent: string) => ({ id: `${child}-${parent}`, storyId: 'story', sourceEntityId: child, targetEntityId: parent, type: 'part-of', bidirectional: false, metadata: {} });
const validate = (childId: string, parentId: string | null, relationships = [edge('room', 'manse'), edge('manse', 'city')]) => validateLocationParent({ storyId: 'story', childId, parentId, turn: 20, places, relationships });

describe('canonical location parent validation', () => {
	it('accepts one physical parent and removal without treating sibling places as routes', () => {
		expect(() => validate('harbor', 'city')).not.toThrow();
		expect(() => validate('room', null)).not.toThrow();
	});
	it('rejects self-parenting, descendant cycles and ambiguous ancestry', () => {
		expect(() => validate('room', 'room')).toThrow('cycle');
		expect(() => validate('city', 'room')).toThrow('cycle');
		expect(() => validate('harbor', 'room', [edge('room', 'manse'), edge('room', 'city')])).toThrow('ambiguous');
	});
	it('rejects missing, foreign and non-location endpoints', () => {
		for (const invalid of [{ id: 'outside', storyId: 'other', type: 'location', status: 'active' }, { id: 'outside', storyId: 'story', type: 'character', status: 'active' }]) {
			expect(() => validateLocationParent({ storyId: 'story', childId: 'room', parentId: 'outside', turn: 20, places: [...places, invalid], relationships: [] })).toThrow('parent');
		}
		expect(() => validate('room', 'missing')).toThrow('parent');
	});
	it('ignores historical parents after their validity interval closes', () => {
		expect(() => validate('harbor', 'room', [edge('room', 'city'), { ...edge('room', 'manse'), metadata: { validToTurn: 20 } }])).not.toThrow();
	});
	it('requires a revision and a concrete change while rejecting duplicate parent storage', () => {
		expect(locationSaveArgsSchema.safeParse({ locationId: 'room', parentLocationId: 'city' }).success).toBe(false);
		expect(locationSaveArgsSchema.safeParse({ locationId: 'room', expectedVersion: 2 }).success).toBe(false);
		expect(locationSaveArgsSchema.safeParse({ locationId: 'room', expectedVersion: 2, parentLocationId: 'city', state: { parentId: 'other' } }).success).toBe(false);
		expect(locationSaveArgsSchema.parse({ locationId: 'room', expectedVersion: 2, parentLocationId: null }).parentLocationId).toBe(null);
	});
});
