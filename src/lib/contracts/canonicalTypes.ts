import { z } from 'zod';
import {contentFieldSchema} from './contentFields';
export const canonicalKindSchema=z.enum(['characters','locations','items','factions']);
export type CanonicalKind=z.infer<typeof canonicalKindSchema>;
export const canonicalTypeDefinitionSchema=z.object({
  fields:z.record(z.string(),contentFieldSchema).optional(),defaults:z.record(z.string(),z.unknown()).optional(),
  gmContextMode:z.enum(['pinned','partial','searchable']),
  layout:z.array(z.object({title:z.string().trim().min(1).max(100),fields:z.array(z.object({path:z.string().min(1).max(200),label:z.string().trim().min(1).max(100)}).strict()).min(1).max(50)}).strict()).max(30),
}).strict();
export type CanonicalTypeDefinition=z.infer<typeof canonicalTypeDefinitionSchema>;
export const canonicalTypeScopeSchema=z.object({projectId:z.string().min(1).max(200),kind:canonicalKindSchema}).strict();
export const canonicalTypeSaveSchema=canonicalTypeScopeSchema.extend({expectedRevision:z.number().int().nonnegative(),definition:canonicalTypeDefinitionSchema,confirmedClear:z.boolean().default(false),migrateDefaults:z.boolean().default(false),expectedSnapshot:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export const canonicalTypeExportSchema=z.object({kind:canonicalKindSchema,definition:canonicalTypeDefinitionSchema}).strict();
export interface CanonicalTypeSettings {projectId:string;kind:CanonicalKind;revision:number;definition:CanonicalTypeDefinition}
export const canonicalLayoutRoots:Record<CanonicalKind,string[]>={characters:['name','description','status','visibility','state','metadata'],locations:['name','description','status','visibility','state','metadata'],items:['name','description','status','visibility','state','metadata'],factions:['name','goals','resources','pressure','member_entity_ids','territory_ids','allies','enemies','metadata']};
export function defaultCanonicalType(kind:CanonicalKind):CanonicalTypeDefinition {
  const paths=kind==='factions'?['name','goals','resources']:['name','description','state'];
  return {gmContextMode:'searchable',layout:[{title:'Overview',fields:paths.map(path=>({path,label:path[0].toUpperCase()+path.slice(1)}))}]};
}
export function validateCanonicalType(kind:CanonicalKind,input:unknown):CanonicalTypeDefinition {
  const value=canonicalTypeDefinitionSchema.parse(input),seen=new Set<string>();
  for(const section of value.layout)for(const field of section.fields){
    const parts=field.path.split('.');
    if(parts.length>8||parts.some(p=>!/^[_a-zA-Z0-9-]+$/.test(p)||['__proto__','prototype','constructor'].includes(p))||!canonicalLayoutRoots[kind].includes(parts[0])||(parts.length>1&&!['state','metadata','resources'].includes(parts[0])))throw new Error('Unsupported layout field: '+field.path);
    if(seen.has(field.path)||seen.size>=200)throw new Error('Layout fields must be unique and limited to 200.');seen.add(field.path);
  }
  return value;
}
export function canonicalLayoutValue(record:Record<string,unknown>,path:string):unknown {
  let value:unknown=record;
  for(const key of path.split('.')){if(['__proto__','prototype','constructor'].includes(key)||!value||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=(value as Record<string,unknown>)[key];}
  return value;
}

export const canonicalTypeHistorySchema=canonicalTypeScopeSchema.extend({beforeRevision:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const canonicalTypeRestoreSchema=canonicalTypeScopeSchema.extend({targetRevision:z.number().int().nonnegative(),expectedRevision:z.number().int().nonnegative(),expectedSnapshot:z.string().regex(/^[a-f0-9]{64}$/).optional(),confirmed:z.boolean().default(false),migrateDefaults:z.boolean().default(false)}).strict();
