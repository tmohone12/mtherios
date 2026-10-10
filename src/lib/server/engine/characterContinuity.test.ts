import { describe, it, expect } from 'vitest';
import { boundCharacterIdentity, characterIdentityRevision } from './characterContinuity';

const identity = { bio: 'Su Lan is a Yi Tish first-rank courtesan raised in Yin.', appearance: 'Golden skin and dark eyes.', stats: { hp: 12 }, personality: 'Patient and practical.' };
const base = { storyId: 'veil', entityId: 'moon', names: ['Su Lan', 'The Weeping Moon'], current: identity, sources: [] };
describe('bounded character continuity', () => {
	it('keeps courtesan identity through an unsupported spy inference and allows new scene details', () => {
		const result = boundCharacterIdentity({ ...base, patch: { bio: 'Su Lan is a Lengii spy.', currentAction: 'Su Lan delivers a sealed letter.', presentation: 'A blue travel cloak.' } });
		expect(result.patch).toEqual({ currentAction: 'Su Lan delivers a sealed letter.', presentation: 'A blue travel cloak.' });
		expect(result.conflicts).toMatchObject([{ field: 'bio', previous: identity.bio, proposed: 'Su Lan is a Lengii spy.', sources: [] }]);
		expect(identity.stats).toEqual({ hp: 12 });
	});
	it.each(['rumor', 'disguise', 'belief', 'accusation', 'retcon'])('retains %s as original evidence pending review, never as rewritten origin', kind => {
		const quote = `Su Lan reports a ${kind}: she served the Lengii court.`;
		const result = boundCharacterIdentity({ ...base, patch: { bio: quote }, sources: [{ id: 'passage', storyId: 'veil', content: quote }] });
		expect(result.patch).toEqual({});
		expect(result.conflicts[0].sources).toEqual([{ id: 'passage', quote, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
	});
	it('does not accept a digest, namesake entity, other story or substring actor as evidence', () => {
		const quote = 'Su Lan delivers letters for Leng.';
		const result = boundCharacterIdentity({ ...base, patch: { bio: quote }, sources: [
			{ id: 'digest', storyId: 'veil', content: quote, narrative: false },
			{ id: 'other-story', storyId: 'journey', content: quote },
			{ id: 'innkeeper', storyId: 'veil', content: quote, entityId: 'innkeeper' },
		] });
		expect(result.conflicts[0].sources).toEqual([]);
		const substring = boundCharacterIdentity({ ...base, patch: { bio: 'Su Lanna is a court spy.' }, sources: [{ id: 'p', storyId: 'veil', content: 'Su Lanna is a court spy.' }] });
		expect(substring.conflicts[0].sources).toEqual([]);
	});
	it('omits empty/partial/unchanged output and never appends a duplicate biography', () => {
		for (const patch of [{}, { bio: null }, { bio: '' }, { bio: {} }, { bio: identity.bio }, { bio: 'Yi Tish first-rank courtesan' }]) expect(boundCharacterIdentity({ ...base, patch }).conflicts).toEqual([]);
		expect(boundCharacterIdentity({ ...base, patch: { rank: 'updated', personality: 'placeholder' } }).patch).toEqual({});
	});
	it('identity fingerprints change on author changes while unrelated current-state updates preserve them', () => {
		expect(characterIdentityRevision(identity)).toBe(characterIdentityRevision({ ...identity, currentAction: 'reading' }));
		expect(characterIdentityRevision(identity)).not.toBe(characterIdentityRevision({ ...identity, bio: 'User approved retcon.' }));
	});
});
