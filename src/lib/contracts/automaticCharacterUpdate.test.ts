import { expect, it } from 'vitest';
import { appendCharacterDevelopments, automaticCharacterUpdate, CHARACTER_DEVELOPMENT_LIMIT, foldAuthoredTextIntoDevelopments, readCharacterDevelopments, retainAutomaticCharacterIdentity } from './automaticCharacterUpdate';
it('sends only changed fields and their old values, retaining identity locally', () => {
	const current = { bio: 'A Yi Tish courtesan.', appearance: 'Golden skin.', stats: { hp: 12 }, currentAction: 'Waiting.' };
	const proposed = { ...current, bio: 'A Lengii spy.', currentAction: 'Delivers a letter.' };
	const delta = automaticCharacterUpdate(current, proposed, ['entry', 'entry']);
	 expect(delta).toEqual({ patch: { bio: 'A Lengii spy.', currentAction: 'Delivers a letter.' }, expected: { bio: current.bio, currentAction: current.currentAction }, sourceEntryIds: ['entry'] });
	 expect(retainAutomaticCharacterIdentity(current, proposed)).toEqual({ ...current, currentAction: 'Delivers a letter.' });
});

it('folds an approved bio fragment into a development instead of deleting the authored bio', () => {
	const bio = 'Aegon was raised in Volantis as Aurion Belarys, hidden from his enemies, and trained with sword and dragon.';
	// An extracted fragment describing his son, matched to Aegon by mistake.
	const folded = foldAuthoredTextIntoDevelopments({ bio, personality: 'Proud, careful, generous to his own.' },
		{ bio: 'Trueborn son and prince of Aegon Targaryen and Daenerys Targaryen, born in Maegor\'s Holdfast.', personality: 'Quiet and watchful.', currentAction: 'Waiting.' });
	expect(folded).toEqual({ currentAction: 'Waiting.', developments: [
		'Trueborn son and prince of Aegon Targaryen and Daenerys Targaryen, born in Maegor\'s Holdfast.', 'Personality: Quiet and watchful.'] });
	expect(folded).not.toHaveProperty('bio');
	expect(folded).not.toHaveProperty('personality');
});

it('keeps only what an expansion adds, and nothing already stated', () => {
	const current = { bio: 'Raised behind the Black Walls.', developments: ['Knighted at the Ford.'] };
	expect(foldAuthoredTextIntoDevelopments(current, { bio: 'Raised behind the Black Walls, he is a sword prodigy.' }))
		.toEqual({ developments: ['Knighted at the Ford.', 'He is a sword prodigy.'] });
	// Restating the bio, an earlier development, or the description adds nothing.
	expect(foldAuthoredTextIntoDevelopments(current, { bio: 'Raised behind the Black Walls.', developments: ['knighted at the ford.'] })).toEqual({});
	expect(foldAuthoredTextIntoDevelopments({}, { bio: 'A harbor broker. Mira now guards the ledger at Yin.' }, 'A harbor broker.'))
		.toEqual({ developments: ['Mira now guards the ledger at Yin.'] });
});

it('appends developments without duplicates and keeps the newest when full', () => {
	const many = Array.from({ length: CHARACTER_DEVELOPMENT_LIMIT }, (_, index) => `Development number ${index + 1}.`);
	const next = appendCharacterDevelopments({ developments: many }, ['Development number 3.', 'Crowned at Dragonstone.']);
	expect(next).toHaveLength(CHARACTER_DEVELOPMENT_LIMIT);
	expect(next.at(-1)).toBe('Crowned at Dragonstone.');
	expect(next[0]).toBe('Development number 2.');
	expect(readCharacterDevelopments({ developments: ['  A  ', 3, ''] })).toEqual(['A']);
});
