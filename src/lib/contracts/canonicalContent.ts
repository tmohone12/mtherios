import { z } from 'zod';
import { canonicalContentSchema, contextModeSchema } from './content';
export const canonicalMetadataSchema = z.object({
  folder: z.string().max(500), slug: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  gmContextMode: contextModeSchema.nullable(), branchId: z.string().min(1).max(200).nullable().default(null), povCharacter: z.string().trim().min(1).max(200).nullable().default(null), hidden: z.boolean(),
}).strict();
export const canonicalRevisionSchema = z.object({ metadataRevision: z.number().int().positive(), recordVersion: z.number().int().nonnegative(), adapterVersion: z.literal(1) }).strict();
export const canonicalEditSchema = canonicalContentSchema.pick({ projectId: true, gameId: true, kind: true }).extend({
  id: z.string().min(1).max(200), expected: canonicalRevisionSchema,
  metadata: canonicalMetadataSchema.partial().optional(), updates: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const canonicalHistorySchema = canonicalContentSchema.pick({ projectId: true, gameId: true, kind: true }).extend({
  id: z.string().min(1).max(200), beforeRevision: z.number().int().positive().optional(), limit: z.number().int().min(1).max(30).default(10),
}).strict();
export const canonicalMetadataExportSchema = canonicalMetadataSchema.extend({ kind: z.enum(['characters','locations','items','factions']), recordId: z.string().min(1).max(200) }).strict();
export interface CanonicalEnvelope { id: string; project_id: string; game_id: string; kind: string; record_id: string; folder: string; slug: string; gm_context_mode: 'pinned' | 'partial' | 'searchable' | null; branch_id: string | null; pov_character: string | null; hidden: boolean; source_deleted: boolean; revision: number; adapter_version: 1 }
export interface CanonicalView { record: Record<string,unknown>; envelope: CanonicalEnvelope; revision: z.infer<typeof canonicalRevisionSchema> }

export const canonicalCreateSchema = canonicalContentSchema.pick({projectId:true,gameId:true,kind:true}).extend({
  fields:z.record(z.string(),z.unknown()), metadata:canonicalMetadataSchema.partial().optional(),
}).strict();
export const canonicalCopySchema = canonicalEditSchema.pick({projectId:true,gameId:true,kind:true,id:true,expected:true}).extend({
  name:z.string().trim().min(1).max(500), metadata:canonicalMetadataSchema.pick({folder:true,slug:true}),
}).strict();

export const canonicalRestoreSchema=canonicalHistorySchema.pick({projectId:true,gameId:true,kind:true,id:true}).extend({targetRevision:z.number().int().positive(),expected:canonicalRevisionSchema,expectedSnapshot:z.string().regex(/^[a-f0-9]{64}$/).optional(),confirmed:z.boolean().default(false)}).strict();
