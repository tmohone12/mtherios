import { expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), service: vi.fn() }));
vi.mock('$lib/server/turn/provider', async importOriginal => ({ ...await importOriginal<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: mocks.generate }));
vi.mock('./llmSettings', () => ({ resolveServiceGeneration: mocks.service, requireResolvedServiceProfile: (_id: string, service: { profile: unknown }) => service.profile }));
import { buildSceneImagePrompt, generateSceneImagePrompt, sceneCharacterState, validateSceneImagePrompt, type SceneImageContext } from './sceneImagePrompt';

test('scene prompt includes saved scene, location, and character appearance', () => {
  const prompt = buildSceneImagePrompt({ narration: 'Mira walks into the rain at the harbor.',
    location: { name: 'Storm Harbor', description: 'Copper lanterns line the quay.' },
    characters: [{ name: 'Mira', description: 'A weathered cartographer.', state: {
      appearance: 'scarred left cheek', visualDescriptors: { hair: 'copper braid', eyes: 'green' }, presentation: 'naval jacket',
    } }] });
  for (const detail of ['Mira walks into the rain', 'Storm Harbor', 'Copper lanterns', 'scarred left cheek', 'copper braid', 'green', 'naval jacket'])
    expect(prompt).toContain(detail);
});

const context: SceneImageContext = {
  narration: 'Mira stands at the gate. Asha waits beside her. Ember lands nearby. Finn holds a torch. Gale watches the gate. Hale walks toward them. They remember the absent king.',
  recentNarration: ['The six companions arrived together under the copper lanterns.'],
  location: { name: 'Storm Harbor' },
  characters: ['Mira', 'Asha', 'Ember', 'Finn', 'Gale', 'Hale', 'King'].map(name => ({ id: name, name,
    state: name === 'Ember' ? { bio: 'A young quadrupedal dragon, never a humanoid.', appearance: { scales: 'copper scales', wings: 'broad wings' } } : { bio: `${name} wears a weathered cloak.` } })),
};

test('scene agent reads full bio and preceding scene, and includes a cast larger than four', async () => {
  mocks.service.mockResolvedValue({ profile: { providerType: 'openai' }, generation: { model: 'scene-model' } });
  mocks.generate.mockResolvedValue({ text: JSON.stringify({ prompt: 'Six companions gather beneath copper lanterns, a young dragon standing on four legs beside them.',
    participantIds: ['Mira', 'Asha', 'Ember', 'Finn', 'Gale', 'Hale'] }), model: 'scene-model', usage: {} });
  const result = await generateSceneImagePrompt(context, 'Watercolor');
  expect(JSON.parse(mocks.generate.mock.calls[0][0].prompt)).toEqual(context);
  for (const name of ['Mira', 'Asha', 'Ember', 'Finn', 'Gale', 'Hale']) expect(result.prompt).toContain(`Include ${name}`);
  expect(result.prompt).toContain('copper scales');
  expect(result.prompt).toContain('Watercolor');
  expect(result.prompt).not.toContain('Include King');
  expect(result.prompt).not.toMatch(/\bportrait\b/i);
});

test('scene validation rejects dropped, unavailable or duplicate actors and oversized prompts before image spend', () => {
  const ids = ['Mira', 'Asha', 'Ember', 'Finn', 'Gale', 'Hale'];
  expect(() => validateSceneImagePrompt(context, { prompt: 'The gate', participantIds: ids.slice(0, 4) }, '')).toThrow('omitted');
  for (const participantIds of [[...ids, 'secret'], [...ids, 'Mira']])
    expect(() => validateSceneImagePrompt(context, { prompt: 'The gate', participantIds }, '')).toThrow('unavailable');
  expect(() => validateSceneImagePrompt(context, { prompt: 'A group portrait', participantIds: ids }, '')).toThrow('framing');
  const oversized = { ...context, characters: context.characters.map(c => ({ ...c, state: { appearance: 'x'.repeat(1000) } })) };
  expect(() => validateSceneImagePrompt(oversized, { prompt: 'x'.repeat(6000), participantIds: ids }, '')).toThrow('No participants were truncated');
});

test('canonical scene projection reads metadata bio and excludes hidden memory', () => {
  expect(sceneCharacterState({ appearance: 'red scales', beliefs: ['secret'], eventMemory: { knows: ['secret'] } }, { background: 'A winged dragon' }))
    .toEqual({ appearance: 'red scales', bio: 'A winged dragon' });
  const evidence = buildSceneImagePrompt({ ...context, characters: context.characters });
  expect(evidence).toContain('Hale wears a weathered cloak');
  expect(evidence).toContain('A young quadrupedal dragon');
});
