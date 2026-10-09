import { z } from 'zod';
import { parseJsonFromGeneratedText } from '$lib/server/turn/provider';

export const nameRequestSchema = z.object({
  count: z.number().int().min(1).max(12),
  intent: z.enum(['character', 'place', 'organization']),
  genre: z.enum(['fantasy', 'science_fiction', 'horror', 'noir']).optional(),
  style: z.string().trim().max(200).optional(),
  culturalBlends: z.array(z.string().trim().min(2).max(50)).max(4).default([]),
  exclude: z.array(z.string().trim().min(2).max(80)).max(20).default([]),
}).strict();

export function parseNameCandidates(raw: string, count: number, exclude: string[]): string[] {
  const value = z.object({ names: z.array(z.string().trim().min(2).max(80)).length(count) }).strict().parse(parseJsonFromGeneratedText(raw));
  const names = value.names;
  const normalized = names.map(name => name.normalize('NFKC').toLocaleLowerCase());
  if (names.some(name => /[\u0000-\u001f\u007f]/.test(name)) || new Set(normalized).size !== names.length || normalized.some(name => exclude.some(blocked => blocked.normalize('NFKC').toLocaleLowerCase() === name))) {
    throw new Error('Name generator returned a duplicate, excluded, or invalid name.');
  }
  return names;
}
