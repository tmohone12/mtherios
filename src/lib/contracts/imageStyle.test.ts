import { expect, test } from 'vitest';
import { readProjectImageStyle, styledImagePrompt, projectImageStyleSaveSchema } from './imageStyle';

test('keeps the full saved project style inside the bounded image prompt', () => {
  const style = { revision: 4, prompt: 'x'.repeat(800) };
  const prompt = styledImagePrompt('scene '.repeat(300), style);
  expect(prompt.length).toBeLessThanOrEqual(1500);
  expect(prompt.endsWith(style.prompt)).toBe(true);
  expect(readProjectImageStyle({ imageStyle: style })).toEqual(style);
  expect(() => projectImageStyleSaveSchema.parse({ projectId: 'p', expectedRevision: 4, prompt: 'x'.repeat(801) })).toThrow();
});
