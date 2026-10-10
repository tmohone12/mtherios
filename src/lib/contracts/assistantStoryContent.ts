import { z } from 'zod';
import { canonicalRevisionSchema } from './canonicalContent';

export const storyContentKind = z.enum(['characters', 'locations', 'items', 'factions']);
// Deliberately excludes identity, visibility, evidence, activation and world-state JSON.
export const storyProseChanges = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(12000).optional(),
  goals: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Supply an authored field.');
export const storyContentArgs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), kind: storyContentKind, query: z.string().max(300).default(''), offset: z.number().int().min(0).max(100000).default(0) }).strict(),
  z.object({ action: z.literal('read'), kind: storyContentKind, id: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('propose'), kind: storyContentKind, id: z.string().min(1).max(200), expected: canonicalRevisionSchema, changes: storyProseChanges, reason: z.string().trim().min(1).max(1000) }).strict(),
]);
export const storyEditRequest = storyContentArgs.options[2].omit({ action: true }).extend({ projectId: z.string().min(1), gameId: z.string().min(1) }).strict();
export type StoryEditRequest = z.infer<typeof storyEditRequest>;
