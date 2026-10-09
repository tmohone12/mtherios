import { expect, test } from 'vitest';
import { buildCharacterPortraitPrompt } from './portraitPrompt';
import type { Character, Entry } from '$lib/types';

test('character image uses current saved appearance instead of unrelated biography and traits', () => {
  const longBio = `Born in the mountain city, ${'remembered for her silver compass. '.repeat(30)}`;
  const character = {
    name: 'Asha', description: longBio, traits: ['patient', 'wary'],
    visualDescriptors: { hair: 'copper braid', face: 'scarred left cheek', clothing: 'blue wool', build: 'tall', distinguishing: 'silver ring', eyes: 'green' },
    metadata: { appearance: 'ink-stained hands', background: 'Apprenticed to a cartographer' },
  } as unknown as Character;
  const lore = { type: 'character', description: 'Keeper of the northern map room', state: { type: 'character', bio: 'Saved lore biography', appearance: 'weathered cloak' } } as unknown as Entry;
  const prompt = buildCharacterPortraitPrompt(character, lore);
  for (const detail of ['copper braid', 'green', 'scarred left cheek', 'blue wool', 'tall', 'silver ring', 'weathered cloak'])
    expect(prompt).toContain(detail);
  for (const detail of [longBio.trim(), 'ink-stained hands', 'Apprenticed to a cartographer', 'Saved lore biography', 'patient', 'wary', 'dragon'])
    expect(prompt).not.toContain(detail);
  expect(prompt).toContain('fully covering tunic, trousers and boots');
});

test('dragon image uses saved bio anatomy without forcing a human composition', () => {
  const character = { name: 'Ember', traits: [], visualDescriptors: {}, metadata: {} } as unknown as Character;
  const prompt = buildCharacterPortraitPrompt(character, { type: 'character', state: {
    bio: 'A copper dragon with four legs and enormous wings.', currentForm: 'dragon',
    appearance: { legs: 'four legs', wings: 'enormous wings', scales: 'burnished copper', eyes: 'amber' },
  } });
  for (const detail of ['four legs', 'enormous wings', 'burnished copper', 'amber', 'complete dragon body']) expect(prompt).toContain(detail);
  expect(prompt).not.toMatch(/\bportrait\b|head.and.shoulders|looking toward the viewer/i);
});

test('uses saved biography once when no appearance is available', () => {
  const bio = 'A copper dragon with four legs and enormous wings.';
  const character = { name: 'Ember', description: bio, traits: [], visualDescriptors: {}, metadata: {} } as unknown as Character;
  const prompt = buildCharacterPortraitPrompt(character, { type: 'character', description: bio, state: { bio, background: bio } });
  expect(prompt.split(bio)).toHaveLength(2);
  expect(prompt).toContain('complete dragon body');
});

test('saved attire takes precedence over the default outfit', () => {
  const character = { name: 'Mira', visualDescriptors: {}, metadata: { appearance: 'Copper braid', clothing: 'Blue naval jacket and grey trousers' } } as unknown as Character;
  const prompt = buildCharacterPortraitPrompt(character);
  expect(prompt).toContain('Blue naval jacket and grey trousers');
  expect(prompt).not.toContain('fully covering tunic');
});
