import { folderExportSchema } from './contentFolders';
import { canonicalTypeExportSchema } from './canonicalTypes';
import { z } from 'zod';

const id = z.string().min(1).max(200);
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const contentScopeSchema = z.object({ projectId: id, gameId: id.optional() }).strict();
export const contextModeSchema = z.enum(['pinned', 'partial', 'searchable']);
export { contentFieldSchema, type ContentField } from './contentFields';
import { contentFieldSchema, type ContentField } from './contentFields';
export const contentDefinitionSchema = z.object({
  fields: z.record(z.string(), contentFieldSchema),
  layout: z.array(z.object({ title: z.string().max(100), fields: z.array(key).max(100) }).strict()).max(30).default([]),
  defaults: z.record(z.string(), z.unknown()).default({}), gmContextMode: contextModeSchema.default('searchable'),
}).strict();
export type ContentDefinition = z.infer<typeof contentDefinitionSchema>;
export const contentTypeSaveSchema = contentScopeSchema.omit({ gameId: true }).extend({
  id: id.optional(), expectedRevision: z.number().int().positive().optional(), key, extension: key,
  name: z.string().trim().min(1).max(100), definition: contentDefinitionSchema,
  confirmedClear:z.boolean().default(false), expectedSnapshot:z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const contentListSchema = contentScopeSchema.extend({
  q: z.string().max(300).default(''), folder: z.string().max(500).optional(), typeId: id.optional(),
  includeDeleted: z.boolean().default(false), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const contentReadSchema = contentScopeSchema.extend({ ids: z.array(id).min(1).max(50) }).strict();
export const contentWriteSchema = contentScopeSchema.extend({
  id: id.optional(), typeId: id, expectedRevision: z.number().int().positive().optional(), expectedTypeRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(200), description: z.string().max(2000).default(''),
  folder: z.string().max(500).default(''), slug: key,
  data: z.record(z.string(), z.unknown()), gmContextMode: contextModeSchema.nullable().default(null),
  visibility: z.enum(['public', 'gm']).default('gm'), branchId: id.nullable().default(null), povCharacter: z.string().trim().min(1).max(200).nullable().default(null),
}).strict();
export const contentUpdateSchema = contentScopeSchema.extend({
  id, expectedRevision: z.number().int().positive(), expectedTypeRevision: z.number().int().positive(),
  // Creation defaults must not materialize omitted patch fields.
  changes: contentWriteSchema.pick({ title: true, description: true, folder: true, slug: true, data: true, gmContextMode: true, visibility: true, branchId: true, povCharacter: true }).extend({
    description:contentWriteSchema.shape.description.unwrap(), folder:contentWriteSchema.shape.folder.unwrap(),
    gmContextMode:contentWriteSchema.shape.gmContextMode.unwrap(), visibility:contentWriteSchema.shape.visibility.unwrap(), branchId:contentWriteSchema.shape.branchId.unwrap(), povCharacter:contentWriteSchema.shape.povCharacter.unwrap(),
  }).partial().strict(),
}).strict();
export const contentOrganizeSchema = contentScopeSchema.extend({
  id, expectedRevision: z.number().int().positive(), expectedTypeRevision: z.number().int().positive(),
  operation: z.enum(['move', 'copy', 'archive', 'restore']), folder: z.string().max(500).optional(), slug: key.optional(), confirmed: z.boolean().default(false),
}).strict();
export const canonicalContentSchema = contentScopeSchema.extend({ gameId: id,
  kind: z.enum(['characters', 'locations', 'items', 'factions']), id: id.optional(), includeHidden: z.boolean().default(false),
  q: z.string().max(300).default(''), offset: z.number().int().min(0).max(100000).default(0),
}).strict();

export interface ContentType { id: string; project_id: string; key: string; extension: string; name: string; definition: ContentDefinition; revision: number }
export interface ContentItem { id: string; project_id: string; game_id: string | null; type_id: string; title: string; description: string; folder: string; slug: string; data: Record<string, unknown>; gm_context_mode: z.infer<typeof contextModeSchema> | null; visibility: 'public' | 'gm'; branch_id: string | null; pov_character: string | null; revision: number; type_revision: number; cover_asset_id: string | null; cover_revision: number; deleted_at: string | null }
export const contentCoverSelectSchema = contentScopeSchema.extend({ itemId: id, assetId: id.nullable(), expectedCoverRevision: z.number().int().min(0) }).strict();

export const contentBundleSchema = z.object({
  version: z.literal(1), projectId: id, gameId: id.nullable(),
  canonicalTypes:z.array(canonicalTypeExportSchema).max(4).optional(),
  folders:z.array(folderExportSchema).max(5000).optional(),
  types: z.array(z.object({ id, key, extension: key, name: z.string().min(1).max(100), definition: contentDefinitionSchema, revision: z.number().int().positive().optional() }).strict()).max(200),
  assets: z.array(z.object({ id, gameId: id.nullable(), visibility: z.enum(['public','gm']), mediaType: z.enum(['image/png','image/jpeg','image/webp']), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytesBase64: z.string().min(1).max(13_333_336) }).strict()).max(5000).optional(),
  items: z.array(z.object({ id, gameId: id.nullable(), typeId: id, title: z.string().min(1).max(200), description: z.string().max(2000), folder: z.string().max(500), slug: key, data: z.record(z.string(), z.unknown()), gmContextMode: contextModeSchema.nullable(), visibility: z.enum(['public','gm']), branchId: id.nullable().optional(), povCharacter: z.string().trim().min(1).max(200).nullable().optional(), coverAssetId: id.nullable().optional(), coverRevision: z.number().int().min(0).optional(), revision: z.number().int().positive().optional(), archived: z.boolean() }).strict()).max(5000),
  revisions: z.array(z.object({ targetKind: z.enum(['type','item']), targetId: id, revision: z.number().int().positive(), priorRevision: z.number().int().positive().nullable(), typeRevision: z.number().int().positive().nullable(), snapshot: z.record(z.string(), z.unknown()), actor: z.record(z.string(), z.unknown()), reason: z.string(), createdAt: z.string().datetime() }).strict()).max(100000).optional(),
}).strict();
export const contentImportSchema = contentScopeSchema.extend({ bundle: contentBundleSchema }).strict();

export const gearExample: ContentDefinition = { fields: { materials: { kind: 'array', items: { kind: 'text' } }, stats: { kind: 'object', fields: { weight: { kind: 'number' }, durable: { kind: 'boolean' } } }, notes: { kind: 'longtext' } }, layout: [{ title: 'Equipment', fields: ['materials', 'stats', 'notes'] }], defaults: { materials: [], stats: { weight: 0, durable: true }, notes: '' }, gmContextMode: 'searchable' };

export const contentHistorySchema=contentScopeSchema.extend({targetKind:z.enum(['type','item']),id,beforeRevision:z.number().int().positive().optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const contentRestoreSchema=contentHistorySchema.pick({projectId:true,gameId:true,targetKind:true,id:true}).extend({targetRevision:z.number().int().positive(),expectedRevision:z.number().int().positive(),expectedSnapshot:z.string().regex(/^[a-f0-9]{64}$/).optional(),confirmed:z.boolean().default(false)}).strict();
