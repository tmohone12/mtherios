import {createHash} from 'node:crypto';
import {extensionDefinition,extensionValues} from './canonicalExtensions';
import {patchWorldRecord} from './worldRecords';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { canonicalTypeScopeSchema,canonicalTypeSaveSchema,canonicalTypeHistorySchema,canonicalTypeRestoreSchema,canonicalTypeExportSchema,defaultCanonicalType,validateCanonicalType,type CanonicalKind,type CanonicalTypeSettings,type CanonicalTypeDefinition } from '$lib/contracts/canonicalTypes';
import { assertSafeJson,MutationError } from './mutationSafety';
type Db=ReturnType<typeof getDb>;type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
async function project(db:Db|Tx,id:string,lock=false){const [row]=await db.execute(sql`select id from shelves where id=${id} ${lock?sql`for update`:sql``}`);if(!row)throw new MutationError('SCOPE_DENIED','Project not found.');}
async function current(db:Db|Tx,projectId:string,kind:CanonicalKind):Promise<CanonicalTypeSettings>{const [row]=await db.execute(sql`select definition,revision from canonical_type_settings where project_id=${projectId} and kind=${kind}`);return {projectId,kind,revision:row?Number(row.revision):0,definition:row?row.definition as CanonicalTypeDefinition:defaultCanonicalType(kind)};}
export async function readCanonicalType(input:unknown){const request=canonicalTypeScopeSchema.parse(input);await project(getDb(),request.projectId);return current(getDb(),request.projectId,request.kind);}
async function persist(tx:Tx,prior:CanonicalTypeSettings,definition:CanonicalTypeDefinition,reason:string){
  if(prior.revision===0){await tx.execute(sql`insert into canonical_type_settings(project_id,kind,definition) values(${prior.projectId},${prior.kind},${JSON.stringify(prior.definition)}::jsonb)`);await history(tx,prior,'Default layout baseline');}
  const [saved]=await tx.execute(sql`update canonical_type_settings set definition=${JSON.stringify(definition)}::jsonb,revision=revision+1,updated_at=now() where project_id=${prior.projectId} and kind=${prior.kind} returning revision`);
  const result={...prior,definition,revision:Number(saved.revision)};await history(tx,result,reason);return result;
}
async function history(tx:Tx,value:CanonicalTypeSettings,reason:string){await tx.execute(sql`insert into canonical_type_history(project_id,kind,revision,definition,actor,reason) values(${value.projectId},${value.kind},${value.revision},${JSON.stringify(value.definition)}::jsonb,'{"role":"client","id":"local-client"}'::jsonb,${reason})`);}
export async function saveCanonicalType(input:unknown,preview=false,reason?:string,requireSnapshot=false){
  assertSafeJson(input);const request=canonicalTypeSaveSchema.parse(input),definition=validateCanonicalType(request.kind,request.definition);
  return getDb().transaction(async tx=>{await project(tx,request.projectId,true);const prior=await current(tx,request.projectId,request.kind);
    if(prior.revision!==request.expectedRevision)throw new MutationError('REVISION_CONFLICT','This type changed. Reload before saving.',{actual:prior.revision,expected:request.expectedRevision});
    extensionDefinition(definition);
    const schemaChanged=!isDeepStrictEqual(prior.definition.fields??{},definition.fields??{})||!isDeepStrictEqual(prior.definition.defaults??{},definition.defaults??{});
    const records=schemaChanged||request.migrateDefaults?await canonicalTypeRecords(tx,request.projectId,request.kind,true):[];
    const migrations:{record:Record<string,unknown>;value:Record<string,unknown>}[]=[],conflicts:{id:unknown;name:unknown;error:string}[]=[];
    for(const record of records){try{const value=extensionValues(definition,record.metadata,request.migrateDefaults);if(!isDeepStrictEqual(value,(record.metadata as Record<string,unknown>|null)?.contentFields??{}))migrations.push({record,value});}catch(error){conflicts.push({id:record.id,name:record.name,error:String(error)});}}
    const expectedSnapshot=createHash('sha256').update(JSON.stringify({projectId:request.projectId,kind:request.kind,revision:prior.revision,definition,migrateDefaults:request.migrateDefaults,records:records.map(r=>[r.id,r.server_version,r.metadata])})).digest('hex');
    const clearing=prior.definition.layout.length>0 && definition.layout.length===0;
    if(preview){
        const [impactRow]=await tx.execute(sql`select count(*) as total, count(*) filter(where c.gm_context_mode is null) as inherited,
          count(*) filter(where coalesce(c.gm_context_mode,${definition.gmContextMode})='pinned') as pinned,
          count(*) filter(where coalesce(c.gm_context_mode,${definition.gmContextMode})='partial') as partial,
          coalesce(sum(case when coalesce(c.gm_context_mode,${definition.gmContextMode})='searchable' then 0
            when coalesce(c.gm_context_mode,${definition.gmContextMode})='partial' then length(coalesce(e.name,f.name,''))+length(coalesce(e.description,''))
            else length(coalesce(e.name,f.name,''))+length(coalesce(e.description,''))+length(coalesce(e.state::text,f.goals::text,''))+length(coalesce(e.metadata::text,f.metadata::text,'')) end),0) as estimated_chars
          from canonical_content c left join entities e on e.id=c.record_id and c.kind<>'factions'
            left join factions f on f.id=c.record_id and c.kind='factions'
          where c.project_id=${request.projectId} and c.kind=${request.kind} and not c.hidden and not c.source_deleted`);
        const impact={total:Number(impactRow.total),inherited:Number(impactRow.inherited),pinned:Number(impactRow.pinned),partial:Number(impactRow.partial),estimatedTokens:Math.ceil(Number(impactRow.estimated_chars)/4)};
        return {definition,revision:prior.revision,requiresClearConfirmation:clearing,expectedSnapshot,compatible:!conflicts.length,conflicts,migrationCount:migrations.length,impact};
      }
    if(conflicts.length)throw new MutationError('SCHEMA_CONFLICT','Existing canonical records do not fit this schema. Preview and resolve the listed conflicts.',{conflicts});
    if(clearing&&!request.confirmedClear)throw new MutationError('CONFIRMATION_REQUIRED','Review and confirm clearing this saved layout.');
    if((requireSnapshot||schemaChanged||request.migrateDefaults||clearing)&&request.expectedSnapshot!==expectedSnapshot)throw new MutationError('REVISION_CONFLICT','Schema or records changed. Preview the migration again.');
    const saved=await persist(tx,prior,definition,reason??(clearing?'Confirmed layout clear':'Edit built-in type settings'));
    for(const {record,value} of migrations)await patchWorldRecord(String(record.story_id),request.kind,String(record.id),{expectedVersion:Number(record.server_version),updates:{metadata:{contentFields:value}},reason:'Apply missing built-in field defaults at type revision '+saved.revision},{role:'client',id:'local-client'},tx);
    return saved;
  });
}
export async function canonicalTypeHistory(input:unknown){
  const request=canonicalTypeHistorySchema.parse(input);await project(getDb(),request.projectId);
  const rows=await getDb().execute(sql`select revision,definition,actor,reason,created_at from canonical_type_history where project_id=${request.projectId} and kind=${request.kind} ${request.beforeRevision!==undefined?sql`and revision<${request.beforeRevision}`:sql``} order by revision desc limit ${request.limit+1}`);
  return {revisions:rows.slice(0,request.limit),nextBeforeRevision:rows.length>request.limit?Number(rows[request.limit-1].revision):null};
}
export async function restoreCanonicalType(input:unknown,preview=false){
  assertSafeJson(input);const request=canonicalTypeRestoreSchema.parse(input);
  const [target]=await getDb().execute(sql`select definition from canonical_type_history where project_id=${request.projectId} and kind=${request.kind} and revision=${request.targetRevision}`);
  if(!target)throw new MutationError('INVALID_CONTENT','That built-in type revision was not found.');
  const prior=await readCanonicalType({projectId:request.projectId,kind:request.kind});
  if(prior.revision!==request.expectedRevision)throw new MutationError('REVISION_CONFLICT','Built-in type changed. Reload its history.');
  const definition=validateCanonicalType(request.kind,target.definition),changes=[...new Set([...Object.keys(prior.definition),...Object.keys(definition)])].filter(key=>!isDeepStrictEqual(prior.definition[key as keyof typeof definition],definition[key as keyof typeof definition])).map(field=>({field,from:prior.definition[field as keyof typeof definition]??null,to:definition[field as keyof typeof definition]??null}));
  if(!changes.length)throw new MutationError('INVALID_CONTENT','That revision already matches the current type.');
  if(!preview&&(!request.confirmed||!request.expectedSnapshot))throw new MutationError('CONFIRMATION_REQUIRED','Review and confirm the type restore.');
  const result=await saveCanonicalType({projectId:request.projectId,kind:request.kind,expectedRevision:request.expectedRevision,definition,migrateDefaults:request.migrateDefaults,...(!preview?{confirmedClear:true,expectedSnapshot:request.expectedSnapshot}: {})},preview,'Restore built-in type revision '+request.targetRevision,true);
  if(preview)return {...result,changes,targetRevision:request.targetRevision};
  return result;
}
export async function exportCanonicalTypes(db:Db|Tx,projectId:string){return db.execute(sql`select kind,definition from canonical_type_settings where project_id=${projectId} order by kind`);}
export async function importCanonicalTypes(tx:Tx,projectId:string,rows:unknown[]){
  const seen=new Set<string>();for(const raw of rows){const row=canonicalTypeExportSchema.parse(raw);if(seen.has(row.kind))throw new MutationError('INVALID_CONTENT','Duplicate built-in type settings.');seen.add(row.kind);const definition=validateCanonicalType(row.kind,row.definition),prior=await current(tx,projectId,row.kind);
    extensionDefinition(definition);
    if(prior.revision>0){if(!isDeepStrictEqual({...prior.definition,fields:prior.definition.fields??{},defaults:prior.definition.defaults??{}},{...definition,fields:definition.fields??{},defaults:definition.defaults??{}}))throw new MutationError('SCHEMA_CONFLICT','Imported built-in type settings conflict with this project.');continue;}
    extensionDefinition(definition);
    await persist(tx,prior,definition,'Imported built-in type settings');
  }
  for(const kind of ['characters','locations','items','factions'] as CanonicalKind[]){const setting=await current(tx,projectId,kind);for(const record of await canonicalTypeRecords(tx,projectId,kind,true))extensionValues(setting.definition,record.metadata);}
}

export async function canonicalTypeRecords(db:Db|Tx,projectId:string,kind:CanonicalKind,lock=false){
  const table=kind==='factions'?sql`factions`:sql`entities`,filter=kind==='factions'?sql``:sql`and r.type=${{characters:'character',locations:'location',items:'item'}[kind]}`;
  const rows=await db.execute(sql`select r.* from ${table} r join stories s on s.id=r.story_id where s.shelf_id=${projectId} ${filter} order by r.id limit 5001 ${lock?sql`for update of r`:sql``}`);
  if(rows.length>5000)throw new MutationError('CONTENT_LIMIT','Schema changes support at most 5,000 canonical records of one kind per project.');return rows;
}
