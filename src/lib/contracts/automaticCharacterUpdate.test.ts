import { expect, it } from 'vitest';
import { automaticCharacterUpdate, retainAutomaticCharacterIdentity } from './automaticCharacterUpdate';
it('sends only changed fields and their old values, retaining identity locally', () => {
	const current = { bio: 'A Yi Tish courtesan.', appearance: 'Golden skin.', stats: { hp: 12 }, currentAction: 'Waiting.' };
	const proposed = { ...current, bio: 'A Lengii spy.', currentAction: 'Delivers a letter.' };
	const delta = automaticCharacterUpdate(current, proposed, ['entry', 'entry']);
	 expect(delta).toEqual({ patch: { bio: 'A Lengii spy.', currentAction: 'Delivers a letter.' }, expected: { bio: current.bio, currentAction: current.currentAction }, sourceEntryIds: ['entry'] });
	 expect(retainAutomaticCharacterIdentity(current, proposed)).toEqual({ ...current, currentAction: 'Delivers a letter.' });
});
