import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$lib/services/database', () => ({ getSetting: vi.fn(async (key: string) => key === 'apiProfiles'
  ? JSON.stringify([{ id: 'image', providerType: 'openai', apiKey: 'fixture-key' }]) : 'image') }));
vi.mock('$lib/stores/settings.svelte', () => ({ settings: { uiSettings: {
  imageStyle: 'custom', imageCustomStyle: 'Painterly', imageSize: '1024x1024', imageCharacterPrompt: '', imageModel: 'dall-e-3', imageProfileId: 'image',
} } }));
vi.mock('$lib/stores/story.svelte', () => ({ story: { currentStory: null } }));

import { ImageGenerationService } from './ImageGenerationService';

afterEach(() => vi.unstubAllGlobals());

test('portrait generation forwards the complete composed prompt without scene clipping', async () => {
  const prompt = `A portrait with ${'detailed saved biography and appearance. '.repeat(30)}`;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body)).prompt).toContain(prompt);
    return Response.json({ data: [{ url: 'https://example.com/portrait.png' }] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const result = await new ImageGenerationService().generatePortraitImage(prompt);
  expect(result.image?.url).toBe('https://example.com/portrait.png');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
