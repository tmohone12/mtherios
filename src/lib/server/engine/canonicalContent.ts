import { sql } from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import { getDb } from '$lib/server/db/client';
import { canonicalContentSchema } from '$lib/contracts/content';
import { canonicalCreateSchema, canonicalCopySchema, canonicalEditSchema, canonicalHistorySchema, canonicalRestoreSchema, canonicalMetadataExportSchema, type CanonicalEnvelope } from '$lib/contracts/canonicalContent';
import { assertSafeJson, MutationError, validateRecordField } from './mutationSafety';
import {canonicalExtensionDefinition,extensionValues} from './canonicalExtensions';
import { validateContentFolder } from './contentValidation';
import { createWorldRecord, patchWorldRecord, WORLD_RECORD_TYPES } from './worldRecords';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Scope = { projectId: string; gameId: string; kind: 'characters' | 'locations' | 'items' | 'factions'; id: string };
const kinds = { characters: 'character', locations: 'location', items: 'item', factions: null } as const;
const denied = (): never => { throw new MutationError('SCOPE_DENIED','Canonical content was not found in this project and game.'); };
async function scoped(db: Db | Tx, request: { projectId: string; gameId: string }, lock=false) {
  if(lock){const [project]=await db.execute(sql`select id from shelves where id=${request.projectId} for update`);if(!project)denied();}
  const [story] = await db.execute(sql`select id from stories where id=${request.gameId} and shelf_id=${request.projectId}`);
  if (!story) denied();
}
function recordQuery(request: Scope, lock = false) {
  const table = request.kind === 'factions' ? sql`factions` : sql`entities`;
  const kindFilter = request.kind === 'factions' ? sql`` : sql`and type=${kinds[request.kind]}`;
  return sql`select * from ${table} where id=${request.id} and story_id=${request.gameId} ${kindFilter} ${lock ? sql`for update` : sql``}`;
}
async function envelope(db: Db | Tx, request: Scope, lock = false): Promise<CanonicalEnvelope> {
  const [row] = await db.execute(sql`select * from canonical_content where project_id=${request.projectId} and game_id=${request.gameId} and kind=${request.kind} and record_id=${request.id} ${lock ? sql`for update` : sql``}`);
  if (!row) denied(); return row as unknown as CanonicalEnvelope;
}
function view(record: Record<string,unknown>, metadata: CanonicalEnvelope) {
  return { record, envelope: metadata, revision: { metadataRevision: metadata.revision, recordVersion: Number(record.server_version), adapterVersion: metadata.adapter_version } };
}
export async function readCanonicalWorkspace(input: unknown) {
  const request = canonicalContentSchema.parse(input);
  return getDb().transaction(async tx => {
    await scoped(tx, request);
    if (request.id) {
      const [record] = await tx.execute(recordQuery({ ...request, id: request.id }));
      if (!record) denied(); return view(record,await envelope(tx,{ ...request,id:request.id }));
    }
    const table = request.kind === 'factions' ? sql`factions` : sql`entities`;
    const kindFilter = request.kind === 'factions' ? sql`` : sql`and r.type=${kinds[request.kind]}`;
    const rows = await tx.execute(sql`select r.*,to_jsonb(c) as content_metadata from ${table} r join canonical_content c on c.record_id=r.id and c.game_id=r.story_id and c.kind=${request.kind}
      where c.project_id=${request.projectId} and c.game_id=${request.gameId} and not c.source_deleted ${kindFilter}
      ${request.includeHidden ? sql`` : sql`and not c.hidden`}
      and strpos(lower(r.name),lower(${request.q})) > 0
      order by c.folder,r.name,r.id limit 51 offset ${request.offset}`);
    return { records:rows.slice(0,50), nextCursor:rows.length > 50 ? String(request.offset+50) : null };
  },{ isolationLevel:'repeatable read',accessMode:'read only' });
}

async function saveMetadata(tx: Tx, current: CanonicalEnvelope, record: Record<string,unknown>, changes: Record<string,unknown>, reason: string, actor: Record<string,unknown> = {role:'client',id:'local-client'}) {
  const metadata = canonicalMetadataExportSchema.omit({kind:true,recordId:true}).parse({ folder:current.folder,slug:current.slug,gmContextMode:current.gm_context_mode,branchId:current.branch_id,povCharacter:current.pov_character,hidden:current.hidden,...changes });
  validateContentFolder(metadata.folder);
  const [collision] = await tx.execute(sql`select id from canonical_content where game_id=${current.game_id} and kind=${current.kind} and folder=${metadata.folder} and slug=${metadata.slug} and id<>${current.id}`);
  if (collision) throw new MutationError('CONTENT_EXISTS','Another canonical record uses this folder and slug.');
  const [saved] = await tx.execute(sql`update canonical_content set folder=${metadata.folder},slug=${metadata.slug},gm_context_mode=${metadata.gmContextMode},branch_id=${metadata.branchId},pov_character=${metadata.povCharacter},hidden=${metadata.hidden},revision=revision+1,updated_at=now() where id=${current.id} returning *`);
  await tx.execute(sql`insert into canonical_content_history(content_id,revision,snapshot,actor,reason) values(${current.id},${saved.revision},${JSON.stringify({envelope:saved,record})}::jsonb,${JSON.stringify(actor)}::jsonb,${reason})`);
  return saved as unknown as CanonicalEnvelope;
}
export async function editCanonicalWorkspace(input: unknown) {
  assertSafeJson(input); const request=canonicalEditSchema.parse(input);
  if (!Object.keys(request.metadata ?? {}).length && !Object.keys(request.updates ?? {}).length) throw new MutationError('INVALID_CONTENT','Supply metadata or record changes.');
  return getDb().transaction(async tx => {
    await scoped(tx,request,true);
    // Match canonical writers' lock order: source record, then its catalog envelope.
    const [record] = await tx.execute(recordQuery(request,true)); if (!record) denied();
    let current = await envelope(tx,request,true);
    if (current.source_deleted) denied();
    const actual = view(record,current).revision;
    if (Object.entries(actual).some(([key,value]) => request.expected[key as keyof typeof actual] !== value)) throw new MutationError('REVISION_CONFLICT','This canonical record or its workspace metadata changed. Reload before saving.',{expected:request.expected,actual});
    let updated=record;
    if (Object.keys(request.updates ?? {}).length) {
      await tx.execute(sql`select set_config('mythengine.content_actor','{"role":"client","id":"local-client"}',true)`);
      const result = await patchWorldRecord(request.gameId,request.kind,request.id,{updates:request.updates!,expectedVersion:request.expected.recordVersion,jsonMode:'merge',reason:'Canonical content workspace edit.'},{role:'client',id:'local-client'},tx);
      updated=result.record; current=await envelope(tx,request);
    }
    if (Object.keys(request.metadata ?? {}).length) current=await saveMetadata(tx,current,updated,request.metadata!,'Workspace metadata edit');
    return view(updated,current);
  });
}
export async function canonicalWorkspaceHistory(input: unknown) {
  const request=canonicalHistorySchema.parse(input); await scoped(getDb(),request);
  const current=await envelope(getDb(),request);
  const rows=await getDb().execute(sql`select * from canonical_content_history where content_id=${current.id} ${request.beforeRevision ? sql`and revision<${request.beforeRevision}` : sql``} order by revision desc limit ${request.limit+1}`);
  const page=rows.slice(0,request.limit);
  return { revisions:page,nextBeforeRevision:rows.length>request.limit ? Number(page.at(-1)!.revision) : null };
}
/** Restore authored fields through the canonical domain writer; source evidence and identity stay current. */
export async function restoreCanonicalWorkspace(input:unknown,preview=false){
  assertSafeJson(input);const request=canonicalRestoreSchema.parse(input);
  return getDb().transaction(async tx=>{
    await scoped(tx,request,true);
    const [record]=await tx.execute(recordQuery(request,true));if(!record)denied();
    const current=await envelope(tx,request,true);if(current.source_deleted)denied();
    const actual=view(record,current).revision;
    if(Object.entries(actual).some(([key,value])=>request.expected[key as keyof typeof actual]!==value))throw new MutationError('REVISION_CONFLICT','Canonical record changed. Reload its history.',{actual});
    const [version]=await tx.execute(sql`select snapshot from canonical_content_history where content_id=${current.id} and revision=${request.targetRevision}`);
    if(!version)throw new MutationError('INVALID_CONTENT','That canonical revision was not found.');
    const target=version.snapshot as {record:Record<string,unknown>;envelope:CanonicalEnvelope};
    if(!target?.record||!target.envelope||target.envelope.source_deleted)throw new MutationError('INVALID_CONTENT','Deleted canonical source revisions cannot restore a domain record.');
    const spec=WORLD_RECORD_TYPES[request.kind],updates:Record<string,unknown>={},changes:Array<{field:string;from:unknown;to:unknown}>=[],conflicts:string[]=[];
    for(const [key,column] of Object.entries(spec.editableColumns)){
      if(key.startsWith('source')||['entityId'].includes(key)||!Object.hasOwn(target.record,column))continue;
      let proposed=target.record[column];
      if(column==='state'&&proposed&&typeof proposed==='object'&&!Array.isArray(proposed)){
        const present=record.state as Record<string,unknown>|null,prior=proposed as Record<string,unknown>;
        const {playerCapabilities:_discarded,...authored}=prior;
        proposed={...authored,...(present&&Object.hasOwn(present,'playerCapabilities')?{playerCapabilities:present.playerCapabilities}:{})};
      }
      if(column==='metadata'&&proposed&&typeof proposed==='object'&&!Array.isArray(proposed)){
        const present=record.metadata as Record<string,unknown>|null,prior=proposed as Record<string,unknown>;
        const protectedKeys=['originalMetadata','entityResolver','activationPlan'];
        proposed={...Object.fromEntries(Object.entries(prior).filter(([k])=>!protectedKeys.includes(k))),...Object.fromEntries(protectedKeys.filter(k=>present&&Object.hasOwn(present,k)).map(k=>[k,present![k]]))};
      }
      if(isDeepStrictEqual(proposed,record[column]))continue;
      try{validateRecordField(request.kind,column,proposed,!!spec.jsonColumns?.has(column));}catch(error){conflicts.push(key+': '+String(error));continue;}
      updates[key]=proposed;changes.push({field:key,from:record[column]??null,to:proposed??null});
    }
    const metadata:Record<string,unknown>={};for(const [key,column] of [['folder','folder'],['slug','slug'],['gmContextMode','gm_context_mode'],['branchId','branch_id'],['povCharacter','pov_character'],['hidden','hidden']] as const){if(!isDeepStrictEqual(current[column],target.envelope[column])){metadata[key]=target.envelope[column];changes.push({field:'workspace.'+key,from:current[column],to:target.envelope[column]});}}
    if(!changes.length)conflicts.push('That version already matches the current editable fields.');
    if(metadata.folder!==undefined)try{validateContentFolder(String(metadata.folder));}catch(error){conflicts.push(String(error));}
    if(metadata.folder!==undefined||metadata.slug!==undefined){const [collision]=await tx.execute(sql`select id from canonical_content where game_id=${request.gameId} and kind=${request.kind} and folder=${String(metadata.folder??current.folder)} and slug=${String(metadata.slug??current.slug)} and id<>${current.id}`);if(collision)conflicts.push('Another canonical record occupies the historical folder and slug.');}
    const [setting]=await tx.execute(sql`select revision from canonical_type_settings where project_id=${request.projectId} and kind=${request.kind}`);
    if(updates.metadata!==undefined)try{extensionValues(await canonicalExtensionDefinition(tx,request.gameId,request.kind),updates.metadata);}catch(error){conflicts.push(String(error));}
    const expectedSnapshot=createHash('sha256').update(JSON.stringify({record,current,target,typeRevision:setting?.revision??0,updates,metadata})).digest('hex');
    const result={compatible:!conflicts.length,conflicts,changes,expectedSnapshot,currentRevision:actual,targetRevision:request.targetRevision};
    if(preview)return result;
    if(!request.confirmed||!request.expectedSnapshot)throw new MutationError('CONFIRMATION_REQUIRED','Review the concrete diff and confirm the canonical restore.');
    if(request.expectedSnapshot!==expectedSnapshot)throw new MutationError('REVISION_CONFLICT','The reviewed canonical record or type changed. Preview restore again.');
    if(conflicts.length)throw new MutationError('SCHEMA_CONFLICT','Resolve canonical restore conflicts.',{conflicts});
    let saved=record,meta=current;
    if(Object.keys(updates).length){await tx.execute(sql`select set_config('mythengine.content_actor','{"role":"client","id":"local-client"}',true)`);saved=(await patchWorldRecord(request.gameId,request.kind,request.id,{expectedVersion:actual.recordVersion,updates,jsonMode:'replace',reason:'Restore canonical revision '+request.targetRevision},{role:'client',id:'local-client'},tx)).record;meta=await envelope(tx,request);}
    if(Object.keys(metadata).length)meta=await saveMetadata(tx,meta,saved,metadata,'Restore workspace metadata from revision '+request.targetRevision);
    return {...result,restored:view(saved,meta)};
  });
}
export async function exportCanonicalWorkspace(db: Db | Tx, gameId: string) {
  return db.execute(sql`select kind,record_id as "recordId",folder,slug,gm_context_mode as "gmContextMode",branch_id as "branchId",pov_character as "povCharacter",hidden from canonical_content where game_id=${gameId} and not source_deleted order by kind,record_id`);
}
export async function importCanonicalWorkspace(tx: Tx, projectId: string, gameId: string, rows: unknown[]) {
  const seen=new Set<string>();
  for (const raw of rows) {
    const row=canonicalMetadataExportSchema.parse(raw); const identity=row.kind+'/'+row.recordId;
    if(seen.has(identity)) throw new MutationError('INVALID_CONTENT','Duplicate canonical workspace identity in import.'); seen.add(identity);
    const request={projectId,gameId,kind:row.kind,id:row.recordId};
    const [record]=await tx.execute(recordQuery(request,true)); if(!record) denied();
    const current=await envelope(tx,request,true);
    await saveMetadata(tx,current,record,{folder:row.folder,slug:row.slug,gmContextMode:row.gmContextMode,branchId:row.branchId ?? null,povCharacter:row.povCharacter ?? null,hidden:row.hidden},'Imported workspace metadata');
  }
}

export async function createCanonicalWorkspace(input:unknown) {
  assertSafeJson(input);const request=canonicalCreateSchema.parse(input);
  return getDb().transaction(async tx=>{
    await scoped(tx,request,true);
    await tx.execute(sql`select set_config('mythengine.content_actor','{"role":"client","id":"local-client"}',true)`);
    const record=await createWorldRecord(request.gameId,request.kind,request.fields,tx);
    let current=await envelope(tx,{...request,id:String(record.id)});
    if(Object.keys(request.metadata??{}).length) current=await saveMetadata(tx,current,record,request.metadata!,'New record workspace metadata');
    return view(record,current);
  });
}

/** Same-game, single-record copy. Identity, evidence arrays and linked tables belong to the source. */
export function canonicalCopyFields(kind:Scope['kind'],record:Record<string,unknown>,name:string) {
  const state=(record.state??{}) as Record<string,unknown>,metadata=(record.metadata??{}) as Record<string,unknown>;
  const original=(metadata.originalMetadata??{}) as Record<string,unknown>;
  const relationship=typeof state.relationship==='string'?state.relationship:(state.relationship as Record<string,unknown>|null)?.status;
  if(kind==='characters' && (['self','player_character'].includes(String(relationship)) || state.isProtagonist===true || metadata.isProtagonist===true || metadata.playerCharacter===true || original.isProtagonist===true || original.playerCharacter===true)) throw new MutationError('INVALID_CONTENT','Player characters cannot be copied. Create a new character instead.');
  if(metadata.mergedInto || original.mergedInto) throw new MutationError('INVALID_CONTENT','Merged records cannot be copied. Open the surviving record instead.');
  const fields:Record<string,unknown>={};
  for(const [key,column] of Object.entries(WORLD_RECORD_TYPES[kind].editableColumns)) {
    if(column==='entity_id'||column.startsWith('source_')||record[column]===undefined) continue;
    fields[key]=structuredClone(record[column]);
  }
  fields.name=name;
  // Resolver/import identity and pending actor activation must not follow a new identity.
  const copiedMetadata=(fields.metadata??{}) as Record<string,unknown>;
  for(const value of [copiedMetadata,copiedMetadata.originalMetadata]) if(value&&typeof value==='object') {
    for(const key of ['entityResolver','originalId','resolvedCharacterReferenceProposalIds','localAliases','activationPlan']) delete (value as Record<string,unknown>)[key];
  }
  fields.metadata=copiedMetadata;
  return fields;
}
export async function copyCanonicalWorkspace(input:unknown) {
  assertSafeJson(input);const request=canonicalCopySchema.parse(input);
  return getDb().transaction(async tx=>{
    await scoped(tx,request,true);
    const [source]=await tx.execute(recordQuery(request,true));if(!source)denied();
    const current=await envelope(tx,request,true);if(current.source_deleted)denied();
    const actual=view(source,current).revision;
    if(Object.entries(actual).some(([key,value])=>request.expected[key as keyof typeof actual]!==value))throw new MutationError('REVISION_CONFLICT','The source changed. Reload before copying.',{expected:request.expected,actual});
    const fields=canonicalCopyFields(request.kind,source,request.name);
    return persistCanonicalCopy(tx,request,fields,current);
  });
}

/** Folder metadata uses the same history owner, including retained deleted-source snapshots. */
export async function relocateCanonicalFolder(tx:Tx,request:Scope,expectedRevision:number,folder:string,actor?:Record<string,unknown>){
  const [record]=await tx.execute(recordQuery(request,true));
  const current=await envelope(tx,request,true);
  if(current.revision!==expectedRevision)throw new MutationError('REVISION_CONFLICT','Canonical folder contents changed. Preview the move again.');
  let payload=record;
  if(!payload && current.source_deleted){const [latest]=await tx.execute(sql`select snapshot from canonical_content_history where content_id=${current.id} order by revision desc limit 1`);payload=(latest?.snapshot as {record:Record<string,unknown>}|undefined)?.record as Record<string,unknown>;}
  if(!payload)denied();
  return saveMetadata(tx,current,payload,{folder},'Move folder',actor);
}

async function persistCanonicalCopy(tx:Tx,request:ReturnType<typeof canonicalCopySchema.parse>,fields:Record<string,unknown>,current:CanonicalEnvelope,actor:Record<string,unknown>={role:'client',id:'local-client'}){
    await tx.execute(sql`select set_config('mythengine.content_actor',${JSON.stringify(actor)},true)`);
    const reason='Copied from '+request.kind+'/'+request.id+' at workspace revision '+current.revision;
    const record=await createWorldRecord(request.gameId,request.kind,fields,tx,reason);
    let target=await envelope(tx,{...request,id:String(record.id)});
    target=await saveMetadata(tx,target,record,{...request.metadata,gmContextMode:current.gm_context_mode,branchId:current.branch_id,povCharacter:current.pov_character,hidden:current.hidden},reason,actor);
    return view(record,target);
}

/** Caller owns the project lock; source locks and revision guards also cover backend writers. */
export async function copyCanonicalFolder(tx:Tx,request:Scope,expectedRevision:number,folder:string,preview=false,actor?:Record<string,unknown>){
  const [source]=await tx.execute(recordQuery(request,true));
  const current=await envelope(tx,request,true);
  if(current.revision!==expectedRevision)throw new MutationError('REVISION_CONFLICT','Canonical folder contents changed. Preview the copy again.');
  if(!source||current.source_deleted)throw new MutationError('INVALID_CONTENT','A deleted canonical source cannot be copied. Move it out of the folder first.',{kind:request.kind,id:request.id});
  const copy=canonicalCopySchema.parse({...request,expected:view(source,current).revision,name:source.name,metadata:{folder,slug:current.slug}});
  const fields=canonicalCopyFields(request.kind,source,copy.name);
  if(preview)return {name:copy.name};
  return persistCanonicalCopy(tx,copy,fields,current,actor);
}

/** Catalog visibility only: the canonical source, game version and gameplay context are unchanged. */
export async function setCanonicalFolderHidden(tx:Tx,request:Scope,expectedRevision:number,hidden:boolean){
  const [record]=await tx.execute(recordQuery(request,true));
  const current=await envelope(tx,request,true);
  if(current.revision!==expectedRevision)throw new MutationError('REVISION_CONFLICT','Canonical contents changed. Preview the folder operation again.');
  if(!record||current.source_deleted)denied();
  return saveMetadata(tx,current,record,{hidden},hidden?'Archive folder catalog view':'Restore folder catalog view');
}
