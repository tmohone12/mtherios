import { z } from 'zod';

const id = z.string().min(1).max(200);
const page = { cursor: z.string().max(16000).optional(), limit: z.number().int().min(1).max(50).default(20) };
export const sourceListArgsSchema = z.object({
  sourceKind: z.enum(['content', 'canonical', 'mounts', 'mounted']).default('content'),
  mountId: id.optional(), path: z.string().max(1000).default(''), ...page,
}).strict();
export const sourceSearchArgsSchema = sourceListArgsSchema.omit({ sourceKind: true }).extend({
  sourceKind: z.enum(['content', 'canonical', 'mounted']).default('content'), query: z.string().trim().min(1).max(300),
}).strict();
export const sourceReadArgsSchema = z.object({
  sourceRef: z.string().min(1).max(2000), startLine: z.number().int().min(1).max(1000000).default(1),
  lineCount: z.number().int().min(1).max(200).default(100),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), expectedRevision: z.string().min(1).max(200).optional(),
}).strict();
export const sourceMountListSchema = z.object({ projectId: id }).strict();
export const sourceMountSaveSchema = sourceMountListSchema.extend({
  id: id.optional(), expectedRevision: z.number().int().nonnegative(), name: z.string().trim().min(1).max(100),
  path: z.string().min(1).max(2000), roles: z.array(z.enum(['gm', 'assistant', 'research'])).min(1).max(3).default(['gm', 'assistant']),
}).strict();
export const sourceMountRemoveSchema = sourceMountListSchema.extend({ id, expectedRevision: z.number().int().positive() }).strict();
export const sourceRunReadSchema = sourceReadArgsSchema.extend({ projectId: id, gameId: id.optional(), runId: id,
  startLine: sourceReadArgsSchema.shape.startLine.unwrap().optional(), lineCount: sourceReadArgsSchema.shape.lineCount.unwrap().optional(),
}).strict();
export interface SourceMount { id: string; project_id: string; name: string; root_path: string; revision: number; roles: Array<'gm' | 'assistant' | 'research'> }
