import { describe, expect, it } from 'vitest';
import { characterStateView, editCharacterState, selectRelevantCharacters } from './characterState';
import { sceneEvidenceExcerpt } from './sceneEvidence';

describe('character context handoffs', () => {
	it('clears an old relative-time anchor when the opportunity is edited without erasing past action', () => {
		const edited = editCharacterState({ nextOpportunity: 'Tomorrow', nextOpportunityRecordedAt: 'Old date', lastIndependentAction: 'Sent a letter' }, 'nextOpportunity', null);
		expect(edited).toEqual({ nextOpportunity: null, lastIndependentAction: 'Sent a letter' });
	});
	it('lets users clear a displayed legacy field without it immediately reappearing', () => {
		const state = { traits: ['patient'], personalityDescriptors: ['calm'], background: 'A broker.', voice: 'Measured', appearance: 'Grey eyes' };
		for (const key of ['bio', 'personality', 'speechStyle']) expect(characterStateView(editCharacterState(state, key, null))[key]).toBeUndefined();
		expect(editCharacterState(state, 'personality', null).appearance).toBe('Grey eyes');
		expect(state.traits).toEqual(['patient']);
	});
	it('replaces displayed goals and current facts without restoring removed legacy items or losing history', () => {
		const state = {
			motivations: ['Keep the peace'], goals: ['Leave town'], knownFacts: ['The keeper is missing'],
			eventMemory: { knows: ['The gate code'], knew: ['An old code'], did: ['Opened the gate'], saw: ['A sealed letter'] },
			npcEventMemory: { knows: ['An obsolete rumor'], did: ['Met the keeper'] }, appearance: 'Grey eyes',
		};
		const before = structuredClone(state);
		const edited = editCharacterState(editCharacterState(state, 'motivations', ['Keep the peace']), 'knownFacts', ['The keeper is missing']);
		expect(characterStateView(edited)).toMatchObject({ motivations: ['Keep the peace'], knownFacts: ['The keeper is missing'] });
		expect(edited).toMatchObject({
			eventMemory: { knows: [], knew: ['An old code'], did: ['Opened the gate'], saw: ['A sealed letter'] },
			npcEventMemory: { knows: [], did: ['Met the keeper'] }, appearance: 'Grey eyes',
		});
		expect(characterStateView(editCharacterState(edited, 'motivations', [])).motivations).toEqual([]);
		expect(characterStateView(editCharacterState(edited, 'knownFacts', [])).knownFacts).toEqual([]);
		expect(state).toEqual(before);
	});
	it('projects legacy biography, traits, voice and current knowledge without mutating canon', () => {
		const state = { background: 'A former captain.', traits: ['patient'], voice: 'Measured diction', appearance: 'Grey eyes', eventMemory: { knows: ['The gate code'], knew: ['An obsolete code'], saw: ['A sealed letter'] } };
		const before = structuredClone(state);
		expect(characterStateView(state)).toMatchObject({ bio: 'A former captain.', personality: 'patient', speechStyle: 'Measured diction', knownFacts: ['The gate code'], appearance: 'Grey eyes' });
		expect(state).toEqual(before);
		expect(characterStateView({ ...state, bio: 'Explicit bio', personality: 'Explicit personality' })).toMatchObject({ bio: 'Explicit bio', personality: 'Explicit personality' });
	});

	it('keeps current named actors, unique short names, canonical aliases, and the player beyond the alphabetical cutoff', () => {
		const characters = Array.from({ length: 45 }, (_, i) => ({ id: `extra_${i}`, name: `Extra ${i}`, state: {} }));
		characters.push({ id: 'player', name: 'Player', state: {} }, { id: 'zhen', name: 'Vermillion Zhen Lian', state: {} }, { id: 'guard', name: 'Jian Tan', state: { aliases: ['The Gatekeeper'] } });
		const selected = selectRelevantCharacters(characters, ['Zhen closes the fan. The Gatekeeper steps forward.'], 32);
		expect(selected.map(c => c.id)).toEqual(expect.arrayContaining(['player', 'zhen', 'guard']));
		expect(selected).toHaveLength(32);
		expect(characters[0].id).toBe('extra_0');
	});

	it('does not use a shared short name as unique identity', () => {
		const characters = [{ id: 'other', name: 'Other', state: {} }, { id: 'a', name: 'Jon Snow', state: {} }, { id: 'b', name: 'Jon Arryn', state: {} }];
		expect(selectRelevantCharacters(characters, ['Jon waits.'], 1)[0].id).toBe('other');
	});

	it('retains scene action and the final resolution after an oversized header', () => {
		const content = `[ Time 14:10 | Location ${'Palace corridor '.repeat(40)} | Weather Clear ]\nZhen refuses the marriage. ${'The court waits. '.repeat(90)}The inspection is finished.`;
		const excerpt = sceneEvidenceExcerpt(content);
		expect(excerpt.length).toBeLessThanOrEqual(800);
		expect(excerpt).toContain('Zhen refuses the marriage.');
		expect(excerpt).toContain('The inspection is finished.');
		expect(sceneEvidenceExcerpt('A short scene.')).toBe('A short scene.');
	});
});
