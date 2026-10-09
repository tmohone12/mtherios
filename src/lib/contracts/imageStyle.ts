import { z } from 'zod';

export const projectImageStyleSchema = z.object({ revision: z.number().int().nonnegative(), prompt: z.string().trim().max(800) }).strict();
export type ProjectImageStyle = z.infer<typeof projectImageStyleSchema>;
export const projectImageStyleSaveSchema = z.object({ projectId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(), prompt: projectImageStyleSchema.shape.prompt }).strict();

export function readProjectImageStyle(settings: unknown): ProjectImageStyle {
  const record = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings as Record<string, unknown> : {};
  return record.imageStyle === undefined ? { revision: 0, prompt: '' } : projectImageStyleSchema.parse(record.imageStyle);
}

export function styledImagePrompt(prompt: string, style: ProjectImageStyle): string {
  const suffix = style.prompt ? `\nProject art style: ${style.prompt}` : '';
  return `${prompt.trim().slice(0, 1500 - suffix.length)}${suffix}`;
}
