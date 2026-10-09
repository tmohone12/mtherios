import {sql} from 'drizzle-orm';
import type {getDb} from '$lib/server/db/client';
import type {CanonicalTypeDefinition} from '$lib/contracts/canonicalTypes';
import type {ContentField} from '$lib/contracts/contentFields';
import {validateContentData,validateContentDefinition} from './contentValidation';
import {MutationError,mergeJsonUpdate} from './mutationSafety';
type Db=ReturnType<typeof getDb>;type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
export function extensionDefinition(definition:Partial<CanonicalTypeDefinition>){
  const fields=definition.fields??{};
  function check(field:ContentField){if(field.kind==='reference')throw new MutationError('INVALID_CONTENT','Built-in extension fields use embedded values; document reference fields belong to custom content types.');for(const child of Object.values(field.fields??{}))check(child);if(field.items)check(field.items);}
  const result=validateContentDefinition({fields,defaults:definition.defaults??{},layout:[],gmContextMode:'searchable'});for(const field of Object.values(fields))check(field);return result;
}
export function extensionValues(definition:Partial<CanonicalTypeDefinition>,metadata:unknown,defaults=false){
  const spec=extensionDefinition(definition),record=(metadata??{}) as Record<string,unknown>;
  const value=defaults?mergeJsonUpdate(spec.defaults,(record.contentFields===undefined?{}:record.contentFields)):(record.contentFields===undefined?{}:record.contentFields);
  validateContentData(spec,value);return value as Record<string,unknown>;
}
export async function canonicalExtensionDefinition(db:Db|Tx,storyId:string,kind:string){
  const [row]=await db.execute(sql`select t.definition from stories s left join canonical_type_settings t on t.project_id=s.shelf_id and t.kind=${kind} where s.id=${storyId}`);
  return (row?.definition??{}) as Partial<CanonicalTypeDefinition>;
}
