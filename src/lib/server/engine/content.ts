import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { countTokens } from '$lib/utils/tokens';
import { folderArchiveSchema,type FolderArchiveReceipt,folderScopeSchema,folderCreateSchema,folderMoveSchema,inContentFolder,relocatedFolder,folderPaths,type ContentFolder } from '$lib/contracts/contentFolders';
import { readCanonicalType,saveCanonicalType,canonicalTypeHistory,restoreCanonicalType,exportCanonicalTypes,importCanonicalTypes } from './canonicalTypes';
import { setCanonicalFolderHidden, copyCanonicalFolder, relocateCanonicalFolder, createCanonicalWorkspace, copyCanonicalWorkspace, readCanonicalWorkspace, editCanonicalWorkspace, canonicalWorkspaceHistory, restoreCanonicalWorkspace } from './canonicalContent';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { contentBundleSchema, contentImportSchema, contentListSchema, contentHistorySchema, contentRestoreSchema, contentOrganizeSchema, contentReadSchema, contentScopeSchema, contentTypeSaveSchema, contentUpdateSchema, contentWriteSchema, type ContentDefinition, type ContentField, type ContentItem, type ContentType } from '$lib/contracts/content';
import { assertSafeJson, mergeJsonUpdate, MutationError } from './mutationSafety';
import { validateContentData, validateContentDefinition, validateContentFolder } from './contentValidation';
import { enqueueAutomaticCover } from './automaticCovers';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Scope = { projectId: string; gameId?: string };
const missing = (): never => { throw new MutationError('SCOPE_DENIED', 'Content was not found in the selected project and game.'); };
function revision(expected: number | undefined, actual: number) {
  if (expected === undefined) throw new MutationError('REVISION_REQUIRED', 'Read this item before saving it.');
  if (expected !== actual) throw new MutationError('REVISION_CONFLICT', 'Content or its type changed. Reload before saving.', { expected, actual });
}

// Public content commands are for human/CLI/MCP authoring. Model tools use a scoped role dispatcher.
// Lock the project before every write, including type edits and reference validation.
async function scope(db: Db | Tx, request: Scope, lock = false) {
  const [project] = await db.execute(sql`select id from shelves where id = ${request.projectId} ${lock ? sql`for update` : sql``}`);
  if (!project) missing();
  if (request.gameId) {
    const [game] = await db.execute(sql`select id from stories where id = ${request.gameId} and shelf_id = ${request.projectId} ${lock ? sql`for key share` : sql``}`);
    if (!game) missing();
  }
}
const readable = (request: Scope) => request.gameId ? sql`(i.game_id is null or i.game_id = ${request.gameId})` : sql`i.game_id is null`;
async function typeRow(db: Db | Tx, projectId: string, id: string): Promise<ContentType> {
  const [row] = await db.execute(sql`select * from content_types where project_id = ${projectId} and id = ${id}`);
  if (!row) missing();
  return row as unknown as ContentType;
}
async function itemRow(db: Db | Tx, request: Scope, id: string): Promise<ContentItem> {
  const [row] = await db.execute(sql`select i.*, t.revision as type_revision, t.extension from content_items i join content_types t on t.id = i.type_id where i.project_id = ${request.projectId} and i.id = ${id} and ${readable(request)}`);
  if (!row) missing();
  return row as unknown as ContentItem;
}
function assertWritable(item: ContentItem, request: Scope) {
  if (item.game_id !== (request.gameId ?? null)) throw new MutationError('SCOPE_DENIED', 'Switch to shared project content to edit a shared document.');
  if (item.deleted_at) throw new MutationError('CONTENT_ARCHIVED', 'Archived content is read-only.');
}
async function references(tx: Tx, request: Scope, definition: ContentDefinition, data: unknown, restoringId?: string) {
  for (const id of validateContentData(definition, data)) {
    const item = await itemRow(tx, request, id);
    if (item.deleted_at && id !== restoringId) throw new MutationError('INVALID_REFERENCE', 'A reference points to archived content.', { itemId: id });
  }
}
export async function history(tx: Tx, kind: 'type' | 'item' | 'folder', row: ContentType | ContentItem | ContentFolder, reason: string, typeRevision?: number, actor: Record<string, unknown> = { role: 'client', id: 'local-client' }) {
  await tx.execute(sql`insert into content_revisions(id,project_id,target_kind,target_id,revision,prior_revision,type_revision,snapshot,actor,reason)
    values(${randomUUID()},${row.project_id},${kind},${row.id},${row.revision},${row.revision > 1 ? row.revision - 1 : null},${typeRevision ?? null},${JSON.stringify(row)}::jsonb,${JSON.stringify(actor)}::jsonb,${reason})`);
}

export async function listContentTypes(input: unknown) {
  const request = contentScopeSchema.parse(input); await scope(getDb(), request);
  return { types: await getDb().execute(sql`select * from content_types where project_id = ${request.projectId} order by name,id`) };
}
export async function saveContentTypeInTransaction(tx: Tx, input: unknown, actor?: Record<string, unknown>, preview = false) {
  assertSafeJson(input);
  const request = contentTypeSaveSchema.parse(input);
  const definition = validateContentDefinition(request.definition);
    await scope(tx, request, true);
    const current = request.id ? await typeRow(tx, request.projectId, request.id) : null;
    if (current) revision(request.expectedRevision, current.revision);
    else if (request.expectedRevision !== undefined) throw new MutationError('INVALID_CONTENT', 'New types cannot have an expected revision.');
    const conflicts: Array<{ id: string; title: string; error: string }> = [];
    let items:Record<string,unknown>[]=[];
    if (current) {
      items = await tx.execute(sql`select id,title,description,data,gm_context_mode,game_id,deleted_at,revision from content_items where type_id = ${current.id} order by id`);
      for (const item of items) try {
        validateContentData(definition, item.data);
        if (!item.deleted_at) await references(tx, { projectId: request.projectId, ...(item.game_id ? { gameId: String(item.game_id) } : {}) }, definition, item.data);
      } catch (error) { conflicts.push({ id: String(item.id), title: String(item.title), error: String(error) }); }
    }
    const [collision] = await tx.execute(sql`select id from content_types where project_id = ${request.projectId} and (key = ${request.key} or extension = ${request.extension}) and id <> ${current?.id ?? ''}`);
    if (collision) throw new MutationError('CONTENT_EXISTS', 'That type key or extension is already used.');
    const expectedSnapshot=createHash('sha256').update(JSON.stringify({current,definition,items})).digest('hex');
    const requiresClearConfirmation=!!current?.definition.layout.length&&!definition.layout.length;
    if (preview) {
      const active = items.filter(item => !item.deleted_at);
      const impact = { total: active.length, inherited: active.filter(item => !item.gm_context_mode).length,
        pinned: active.filter(item => (item.gm_context_mode ?? definition.gmContextMode) === 'pinned').length,
        partial: active.filter(item => (item.gm_context_mode ?? definition.gmContextMode) === 'partial').length,
        estimatedTokens: active.reduce((sum,item) => { const mode=item.gm_context_mode ?? definition.gmContextMode;
          return sum + (mode === 'searchable' ? 0 : countTokens(String(item.title)+' '+String(item.description)+(mode === 'pinned' ? JSON.stringify(item.data) : ''))); },0) };
      return { compatible: !conflicts.length, conflicts, definition, expectedSnapshot,requiresClearConfirmation,impact };
    }
    if (conflicts.length) throw new MutationError('SCHEMA_CONFLICT', 'The new schema is incompatible with existing documents. No data was changed.', { conflicts });
    if (requiresClearConfirmation && (!request.confirmedClear||request.expectedSnapshot!==expectedSnapshot)) throw new MutationError('CONFIRMATION_REQUIRED','Review and confirm clearing this layout against its current revision.');
    // References in defaults are validated when a document is created in its scope.
    const id = current?.id ?? randomUUID();
    const [saved] = current
      ? await tx.execute(sql`update content_types set key=${request.key}, extension=${request.extension}, name=${request.name}, definition=${JSON.stringify(definition)}::jsonb, revision=revision+1, updated_at=now() where id=${id} returning *`)
      : await tx.execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values(${id},${request.projectId},${request.key},${request.extension},${request.name},${JSON.stringify(definition)}::jsonb) returning *`);
    await history(tx, 'type', saved as unknown as ContentType, current ? 'Edit content type' : 'Create content type', undefined, actor);
    return { type: saved };
}
export async function saveContentType(input: unknown, preview = false) {
  return getDb().transaction(tx => saveContentTypeInTransaction(tx, input, undefined, preview));
}
export async function listContent(input: unknown) {
  const request = contentListSchema.parse(input); await scope(getDb(), request);
  if (request.folder !== undefined) validateContentFolder(request.folder);
  const filters = [sql`i.project_id = ${request.projectId}`, readable(request)];
  if (!request.includeDeleted) filters.push(sql`i.deleted_at is null`);
  if (request.typeId) filters.push(sql`i.type_id = ${request.typeId}`);
  if (request.folder !== undefined) filters.push(sql`i.folder = ${request.folder}`);
  if (request.q) filters.push(sql`strpos(lower(i.title || ' ' || i.description || ' ' || i.data::text),lower(${request.q})) > 0`);
  const rows = await getDb().execute(sql`select i.id,i.project_id,i.game_id,i.type_id,i.title,i.description,i.folder,i.slug,i.gm_context_mode,i.visibility,i.branch_id,i.pov_character,i.revision,i.cover_asset_id,i.cover_revision,i.deleted_at,t.revision as type_revision,t.extension from content_items i join content_types t on t.id=i.type_id where ${sql.join(filters, sql` and `)} order by i.folder,i.title,i.id limit ${request.limit + 1} offset ${request.offset}`);
  return { items: rows.slice(0, request.limit), nextOffset: rows.length > request.limit ? request.offset + request.limit : null };
}
export async function readContent(input: unknown) {
  const request = contentReadSchema.parse(input); await scope(getDb(), request);
  const items = [];
  for (const id of request.ids) items.push(await itemRow(getDb(), request, id));
  return { items };
}
async function persistItem(tx: Tx, request: ReturnType<typeof contentWriteSchema.parse>, current: ContentItem | null, reason: string, actor?: Record<string, unknown>) {
  const type = await typeRow(tx, request.projectId, request.typeId);
  revision(request.expectedTypeRevision, type.revision);
  if (current) {
    assertWritable(current, request); revision(request.expectedRevision, current.revision);
    if (current.type_id !== request.typeId) throw new MutationError('INVALID_CONTENT', 'Changing an item type requires an explicit migration.');
    await assertCoverVisibility(tx, current, request.visibility);
  }
  validateContentFolder(request.folder);
  const data = current ? request.data : mergeJsonUpdate(type.definition.defaults, request.data) as Record<string, unknown>;
  await references(tx, request, type.definition, data);
  const id = current?.id ?? randomUUID();
  const [collision] = await tx.execute(sql`select id from content_items where project_id=${request.projectId} and game_id is not distinct from ${request.gameId ?? null} and folder=${request.folder} and slug=${request.slug} and type_id=${request.typeId} and deleted_at is null and id <> ${id}`);
  if (collision) throw new MutationError('CONTENT_EXISTS', 'An item already uses this folder, slug and type.');
  const [row] = current
    ? await tx.execute(sql`update content_items set title=${request.title}, description=${request.description}, folder=${request.folder}, slug=${request.slug}, data=${JSON.stringify(data)}::jsonb, gm_context_mode=${request.gmContextMode}, visibility=${request.visibility}, branch_id=${request.branchId}, pov_character=${request.povCharacter}, revision=revision+1, updated_at=now() where id=${id} returning *`)
    : await tx.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,description,folder,slug,data,gm_context_mode,visibility,branch_id,pov_character) values(${id},${request.projectId},${request.gameId ?? null},${request.typeId},${request.title},${request.description},${request.folder},${request.slug},${JSON.stringify(data)}::jsonb,${request.gmContextMode},${request.visibility},${request.branchId},${request.povCharacter}) returning *`);
  const item = { ...row, type_revision: type.revision } as unknown as ContentItem;
  await history(tx, 'item', item, reason, type.revision, actor);
  return { item };
}
async function assertCoverVisibility(tx: Tx, item: ContentItem, visibility: 'public' | 'gm') {
  if (visibility !== 'public' || !item.cover_asset_id) return;
  const [asset] = await tx.execute(sql`select visibility from assets where id=${item.cover_asset_id} and project_id=${item.project_id} and game_id is not distinct from ${item.game_id}`);
  if (asset?.visibility !== 'public') throw new MutationError('INVALID_IMAGE', 'Select a public cover or clear the private cover before making this document public.');
}
export async function writeContentInTransaction(tx: Tx, input: unknown, actor?: Record<string, unknown>) {
  assertSafeJson(input); const request = contentWriteSchema.parse(input);
  await scope(tx, request, true);
  const current = request.id ? await itemRow(tx, request, request.id) : null;
  if (!current && request.expectedRevision !== undefined) throw new MutationError('INVALID_CONTENT', 'New items cannot have an expected revision.');
  const saved = await persistItem(tx, request, current, current ? 'Replace document' : 'Create document', actor);
  if (!current) await enqueueAutomaticCover(tx, saved.item);
  return saved;
}
export async function writeContent(input: unknown) {
  return getDb().transaction(tx => writeContentInTransaction(tx, input));
}
function authored(item: ContentItem) {
  return { id: item.id, projectId: item.project_id, ...(item.game_id ? { gameId: item.game_id } : {}), typeId: item.type_id, expectedRevision: item.revision, expectedTypeRevision: item.type_revision, title: item.title, description: item.description, folder: item.folder, slug: item.slug, data: item.data, gmContextMode: item.gm_context_mode, visibility: item.visibility, branchId: item.branch_id, povCharacter: item.pov_character };
}
export async function updateContentInTransaction(tx: Tx, input: unknown, actor?: Record<string, unknown>) {
  assertSafeJson(input); const request = contentUpdateSchema.parse(input);
  await scope(tx, request, true); const current = await itemRow(tx, request, request.id);
  assertWritable(current, request);
  const data = request.changes.data === undefined ? current.data : mergeJsonUpdate(current.data, request.changes.data);
  return persistItem(tx, contentWriteSchema.parse({ ...authored(current), ...request.changes, data, expectedRevision: request.expectedRevision, expectedTypeRevision: request.expectedTypeRevision }), current, 'Update document', actor);
}
export async function updateContent(input: unknown) {
  return getDb().transaction(tx => updateContentInTransaction(tx, input));
}
export async function organizeContent(input: unknown) {
  const request = contentOrganizeSchema.parse(input);
  return getDb().transaction(async tx => {
    await scope(tx, request, true); const current = await itemRow(tx, request, request.id);
    if (request.operation === 'restore') {
      if (current.game_id !== (request.gameId ?? null)) throw new MutationError('SCOPE_DENIED','Restore shared documents from the shared project scope.');
      revision(request.expectedRevision,current.revision); revision(request.expectedTypeRevision,current.type_revision);
      if (!request.confirmed) throw new MutationError('CONFIRMATION_REQUIRED','Confirm restoring this archived document after reviewing its current content and path.');
      if (!current.deleted_at) throw new MutationError('INVALID_CONTENT','This document is already active.');
      const type = await typeRow(tx,request.projectId,current.type_id);
      await references(tx,request,type.definition,current.data,current.id);
      const [collision] = await tx.execute(sql`select id from content_items where project_id=${request.projectId} and game_id is not distinct from ${current.game_id} and folder=${current.folder} and slug=${current.slug} and type_id=${current.type_id} and deleted_at is null`);
      if (collision) throw new MutationError('CONTENT_EXISTS','Another active document now uses this path. Move it before restoring this document.');
      const [row] = await tx.execute(sql`update content_items set deleted_at=null,revision=revision+1,updated_at=now() where id=${current.id} returning *`);
      const item = { ...row,type_revision:type.revision } as unknown as ContentItem;
      await history(tx,'item',item,'Restore archived document',type.revision); return { item };
    }
    assertWritable(current, request); revision(request.expectedRevision, current.revision); revision(request.expectedTypeRevision, current.type_revision);
    if (request.operation === 'archive') {
      // Keep identities/history, but do not strand active incoming references.
      const others = await tx.execute(sql`select i.id,i.title,i.data,t.definition from content_items i join content_types t on t.id=i.type_id where i.project_id=${request.projectId} and i.deleted_at is null and i.id <> ${current.id}`);
      const incoming = others.filter(row => validateContentData(row.definition as ContentDefinition, row.data).includes(current.id));
      if (incoming.length) throw new MutationError('REFERENCE_CONFLICT', 'Other documents still refer to this item.', { ids: incoming.map(row => row.id) });
      const [row] = await tx.execute(sql`update content_items set deleted_at=now(), revision=revision+1, updated_at=now() where id=${current.id} returning *`);
      const item = { ...row, type_revision: current.type_revision } as unknown as ContentItem;
      await history(tx, 'item', item, 'Archive document', current.type_revision); return { item };
    }
    if (request.folder === undefined || request.slug === undefined) throw new MutationError('INVALID_CONTENT', 'Move and copy require a destination folder and slug.');
    const payload = { ...authored(current), folder: request.folder, slug: request.slug };
    if (request.operation === 'copy') {
      // Allocate a fresh identity; source references remain pointed at their original targets.
      delete (payload as { id?: string }).id; delete (payload as { expectedRevision?: number }).expectedRevision;
      return persistItem(tx, contentWriteSchema.parse(payload), null, `Copy document ${current.id}`);
    }
    return persistItem(tx, contentWriteSchema.parse(payload), current, 'Move document');
  });
}
function historyDiff(current:Record<string,unknown>,target:Record<string,unknown>,keys:string[]){return keys.filter(key=>JSON.stringify(current[key])!==JSON.stringify(target[key])).map(field=>({field,from:current[field]??null,to:target[field]??null}));}
function historyToken(parts:unknown){return createHash('sha256').update(JSON.stringify(parts)).digest('hex');}
export async function listContentHistory(input:unknown){
  const request=contentHistorySchema.parse(input);await scope(getDb(),request);
  if(request.targetKind==='item'){const current=await itemRow(getDb(),request,request.id);if(current.game_id!==(request.gameId??null))missing();}
  else if(request.gameId)throw new MutationError('SCOPE_DENIED','Type history belongs to the project, not a game.');
  else await typeRow(getDb(),request.projectId,request.id);
  const rows=await getDb().execute(sql`select revision,type_revision,snapshot,actor,reason,created_at from content_revisions where project_id=${request.projectId} and target_kind=${request.targetKind} and target_id=${request.id} ${request.beforeRevision?sql`and revision<${request.beforeRevision}`:sql``} order by revision desc limit ${request.limit+1}`);
  return {revisions:rows.slice(0,request.limit),nextBeforeRevision:rows.length>request.limit?Number(rows[request.limit-1].revision):null};
}
export async function restoreContentHistoryInTransaction(tx:Tx,input:unknown,preview=false,actor?:Record<string,unknown>){
  assertSafeJson(input);const request=contentRestoreSchema.parse(input);
    await scope(tx,request,true);
    if(request.targetKind==='type'&&request.gameId)throw new MutationError('SCOPE_DENIED','Type history belongs to the project.');
    const current=request.targetKind==='item'?await itemRow(tx,request,request.id):await typeRow(tx,request.projectId,request.id);
    if(request.targetKind==='item'&&(current as ContentItem).game_id!==(request.gameId??null))missing();
    if(current.revision!==request.expectedRevision)throw new MutationError('REVISION_CONFLICT','Content changed. Reload history before restoring.');
    const [version]=await tx.execute(sql`select snapshot,type_revision from content_revisions where project_id=${request.projectId} and target_kind=${request.targetKind} and target_id=${request.id} and revision=${request.targetRevision}`);
    if(!version)throw new MutationError('INVALID_CONTENT','That retained version was not found.');
    const target=version.snapshot as Record<string,unknown>,conflicts:string[]=[];let dependent:unknown[]=[];let type:ContentType|undefined;
    const keys=request.targetKind==='item'?['title','description','folder','slug','data','gm_context_mode','visibility','branch_id','pov_character','deleted_at']:['key','extension','name','definition'];
    const changes=historyDiff(current as unknown as Record<string,unknown>,target,keys);
    if(!changes.length)conflicts.push('This version already matches the current editable content.');
    if(request.targetKind==='item'){
      const item=current as ContentItem;type=await typeRow(tx,request.projectId,item.type_id);
      await assertCoverVisibility(tx,item,target.visibility as 'public'|'gm');
      try{
        const value=contentWriteSchema.parse({projectId:request.projectId,...(request.gameId?{gameId:request.gameId}:{}),typeId:item.type_id,expectedTypeRevision:type.revision,title:target.title,description:target.description,folder:target.folder,slug:target.slug,data:target.data,gmContextMode:target.gm_context_mode,visibility:target.visibility,branchId:target.branch_id,povCharacter:target.pov_character});
        validateContentFolder(value.folder);validateContentData(type.definition,value.data);
        if(!target.deleted_at)await references(tx,request,type.definition,value.data);
        else for(const ref of validateContentData(type.definition,value.data))await itemRow(tx,request,ref);
        if(!target.deleted_at){const [collision]=await tx.execute(sql`select id from content_items where project_id=${request.projectId} and game_id is not distinct from ${item.game_id} and folder=${value.folder} and slug=${value.slug} and type_id=${item.type_id} and deleted_at is null and id<>${item.id}`);if(collision)conflicts.push('An active document already occupies this path.');}
        if(target.deleted_at&&!item.deleted_at){const rows=await tx.execute(sql`select i.id,i.data,t.definition from content_items i join content_types t on t.id=i.type_id where i.project_id=${request.projectId} and i.deleted_at is null and i.id<>${item.id}`);if(rows.some(row=>validateContentData(row.definition as ContentDefinition,row.data).includes(item.id)))conflicts.push('An active document refers to this item; remove that reference before archiving it.');}
      }catch(error){conflicts.push(String(error));}
    }else{
      const existing=current as ContentType;
      try{const checked=contentTypeSaveSchema.parse({projectId:request.projectId,id:existing.id,expectedRevision:existing.revision,key:target.key,extension:target.extension,name:target.name,definition:target.definition});validateContentDefinition(checked.definition);
        dependent=await tx.execute(sql`select id,title,data,game_id,deleted_at,revision from content_items where type_id=${existing.id} order by id limit 5001`);
        if(dependent.length>5000)conflicts.push('A type restore is limited to 5,000 documents.');
        for(const row of dependent as Array<Record<string,unknown>>){try{validateContentData(checked.definition,row.data);if(!row.deleted_at)await references(tx,{projectId:request.projectId,...(row.game_id?{gameId:String(row.game_id)}:{})},checked.definition,row.data);}catch(error){conflicts.push(String(row.title)+': '+String(error));}}
        const [collision]=await tx.execute(sql`select id from content_types where project_id=${request.projectId} and id<>${existing.id} and (key=${checked.key} or extension=${checked.extension})`);if(collision)conflicts.push('Another type owns the old key or extension.');
      }catch(error){conflicts.push(String(error));}
    }
    const expectedSnapshot=historyToken({request:{projectId:request.projectId,targetKind:request.targetKind,id:request.id,targetRevision:request.targetRevision},current,target,typeRevision:type?.revision,dependent});
    const result={compatible:!conflicts.length,conflicts,changes,expectedSnapshot,title:request.targetKind==='item'?(current as ContentItem).title:(current as ContentType).name,currentRevision:current.revision,targetRevision:request.targetRevision,affectedDocuments:dependent.length};
    if(preview)return result;
    if(!request.confirmed||!request.expectedSnapshot)throw new MutationError('CONFIRMATION_REQUIRED','Preview the concrete diff and confirm the restore.');
    if(request.expectedSnapshot!==expectedSnapshot)throw new MutationError('REVISION_CONFLICT','The reviewed content or schema changed. Preview the restore again.');
    if(conflicts.length)throw new MutationError('SCHEMA_CONFLICT','Resolve restore conflicts before applying.',{conflicts});
    if(request.targetKind==='item'){
      const item=current as ContentItem;
      const [saved]=await tx.execute(sql`update content_items set title=${target.title as string},description=${target.description as string},folder=${target.folder as string},slug=${target.slug as string},data=${JSON.stringify(target.data)}::jsonb,gm_context_mode=${target.gm_context_mode as string|null},visibility=${target.visibility as string},branch_id=${(target.branch_id ?? null) as string|null},pov_character=${(target.pov_character ?? null) as string|null},deleted_at=${target.deleted_at?new Date().toISOString():null},revision=revision+1,updated_at=now() where id=${item.id} returning *`);
      await history(tx,'item',saved as unknown as ContentItem,'Restore document revision '+request.targetRevision,type!.revision,actor);
      return {...result,item:saved};
    }
    const existing=current as ContentType;
    const [saved]=await tx.execute(sql`update content_types set key=${target.key as string},extension=${target.extension as string},name=${target.name as string},definition=${JSON.stringify(target.definition)}::jsonb,revision=revision+1,updated_at=now() where id=${existing.id} returning *`);
    await history(tx,'type',saved as unknown as ContentType,'Restore type revision '+request.targetRevision,undefined,actor);
    return {...result,type:saved};
}
export async function restoreContentHistory(input:unknown,preview=false){
  return getDb().transaction(tx=>restoreContentHistoryInTransaction(tx,input,preview));
}
export const readCanonicalContent = readCanonicalWorkspace;

export async function exportContentSnapshot(db: Db | Tx, request: Scope) {
  await scope(db, request);
  const types = await db.execute(sql`select id,key,extension,name,definition,revision from content_types where project_id=${request.projectId} order by id`);
  const items = await db.execute(sql`select i.* from content_items i where i.project_id=${request.projectId} and ${readable(request)} order by i.id`);
  const revisionFilters = [];
  if (types.length) revisionFilters.push(sql`(target_kind='type' and target_id in (${sql.join(types.map(row => sql`${row.id}`), sql`,`) }))`);
  if (items.length) revisionFilters.push(sql`(target_kind='item' and target_id in (${sql.join(items.map(row => sql`${row.id}`), sql`,`) }))`);
  const revisionRows = revisionFilters.length ? await db.execute(sql`select target_kind,target_id,revision,prior_revision,type_revision,snapshot,actor,reason,created_at
    from content_revisions where project_id=${request.projectId} and (${sql.join(revisionFilters, sql` or `)})
    order by target_kind,target_id,revision limit 100001`) : [];
  if (revisionRows.length > 100000) throw new MutationError('INVALID_CONTENT', 'Too many content revisions for one bundle.');
  const revisions = revisionRows.map(row => ({ targetKind: row.target_kind, targetId: row.target_id, revision: row.revision,
    priorRevision: row.prior_revision, typeRevision: row.type_revision, snapshot: row.snapshot, actor: row.actor,
    reason: row.reason, createdAt: new Date(String(row.created_at)).toISOString() }));
  const assetIds = new Map<string,{ gameId: string | null; publicRequired: boolean }>();
  for (const item of items) if (item.cover_asset_id) {
    const previous = assetIds.get(String(item.cover_asset_id));
    if (previous && previous.gameId !== item.game_id) throw new MutationError('INVALID_IMAGE', 'A cover is referenced across game scopes.');
    assetIds.set(String(item.cover_asset_id), { gameId: item.game_id as string | null, publicRequired: previous?.publicRequired || item.visibility === 'public' });
  }
  for (const row of revisionRows) if (row.target_kind === 'item') {
    const snapshot = row.snapshot as Record<string, unknown>;
    if (typeof snapshot.cover_asset_id !== 'string' || !snapshot.cover_asset_id) continue;
    const assetId = snapshot.cover_asset_id;
    const gameId = typeof snapshot.game_id === 'string' ? snapshot.game_id : null;
    const previous = assetIds.get(assetId);
    if (previous && previous.gameId !== gameId) throw new MutationError('INVALID_IMAGE', 'A historical cover is referenced across game scopes.');
    assetIds.set(assetId, { gameId, publicRequired: previous?.publicRequired || snapshot.visibility === 'public' });
  }
  const assets = [];
  if (assetIds.size) {
    const { readImageAsset } = await import('./imageAssets');
    for (const [assetId, requirement] of assetIds) {
      const { asset, bytes } = await readImageAsset({ projectId: request.projectId, ...(requirement.gameId ? { gameId: requirement.gameId } : {}), assetId });
      if (requirement.publicRequired && asset.visibility !== 'public') throw new MutationError('INVALID_IMAGE', 'A public document has a hidden cover.');
      assets.push({ id: asset.id, gameId: asset.game_id, visibility: asset.visibility, mediaType: asset.media_type, sha256: asset.sha256, bytesBase64: Buffer.from(bytes).toString('base64') });
    }
  }
  return contentBundleSchema.parse({ version: 1, projectId: request.projectId, gameId: request.gameId ?? null, types, canonicalTypes:await exportCanonicalTypes(db,request.projectId),
    folders:await exportContentFolders(db,request),
    assets, revisions,
    items: items.map(row => ({ id: row.id, gameId: row.game_id, typeId: row.type_id, title: row.title, description: row.description, folder: row.folder, slug: row.slug, data: row.data, gmContextMode: row.gm_context_mode, visibility: row.visibility, branchId: row.branch_id, povCharacter: row.pov_character, coverAssetId: row.cover_asset_id, coverRevision: row.cover_revision, revision: row.revision, archived: row.deleted_at !== null })) });
}
export async function exportContent(input: unknown) {
  const request = contentScopeSchema.parse(input);
  return getDb().transaction(tx => exportContentSnapshot(tx, request), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
export function remapReferences(fields: Record<string, ContentField>, data: Record<string, unknown>, ids: Map<string,string>, retainExternal=false): Record<string, unknown> {
  function field(schema: ContentField, value: unknown): unknown {
    if (schema.kind === 'reference') {
      const previous = (value as { itemId: string }).itemId;
      if (!ids.has(previous) && !retainExternal) throw new MutationError('INVALID_REFERENCE', 'Exported reference has no item in the bundle.', { itemId: previous });
      return { itemId: ids.get(previous) ?? previous };
    }
    if (schema.kind === 'array') return (value as unknown[]).map(entry => field(schema.items!, entry));
    if (schema.kind === 'object') return remapReferences(schema.fields!, value as Record<string,unknown>, ids, retainExternal);
    return value;
  }
  return Object.fromEntries(Object.entries(data).map(([key,value]) => [key, field(fields[key],value)]));
}
export function remapHistoricalData(value: unknown, ids: Map<string,string>, retainExternal = false): unknown {
  if (Array.isArray(value)) return value.map(entry => remapHistoricalData(entry, ids, retainExternal));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === 'itemId' && typeof entry === 'string') {
      const mapped = ids.get(entry);
      if (!mapped && !retainExternal) throw new MutationError('INVALID_REFERENCE', 'Historical content refers to an item outside the bundle.', { itemId: entry });
      return [key, mapped ?? entry];
    }
    return [key, remapHistoricalData(entry, ids, retainExternal)];
  }));
}
export async function previewContentImport(input: unknown) {
  assertSafeJson(input);
  const request = contentImportSchema.parse(input);
  const bundle = request.bundle;
  if (bundle.gameId && !request.gameId) throw new MutationError('SCOPE_DENIED', 'A game export requires a destination game.');
  return getDb().transaction(async tx => {
    await scope(tx, request);
    return previewContentImportConflicts(tx, request.projectId, bundle, request.gameId);
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
export async function previewContentImportConflicts(db: Db | Tx, projectId: string, bundle: ReturnType<typeof contentBundleSchema.parse>, destinationGameId?: string) {
    await scope(db, { projectId });
    const conflicts: Array<{ kind: 'type' | 'path' | 'source'; message: string; sourceId: string; destinationId?: string }> = [];
    const typeIds = new Map<string, string | null>();
    const sourceTypeKeys = new Set<string>(), sourceTypeExtensions = new Set<string>();
    let reusedTypes = 0, newTypes = 0;
    for (const type of bundle.types) {
      const definition = validateContentDefinition(type.definition);
      if (typeIds.has(type.id) || sourceTypeKeys.has(type.key) || sourceTypeExtensions.has(type.extension)) {
        conflicts.push({ kind: 'source', message: `Duplicate type ${type.key} in the import.`, sourceId: type.id });
        continue;
      }
      sourceTypeKeys.add(type.key); sourceTypeExtensions.add(type.extension);
      const matches = await db.execute(sql`select id,key,extension,name,definition from content_types where project_id=${projectId} and (key=${type.key} or extension=${type.extension}) order by id`);
      const match = matches[0];
      if (matches.length && (matches.length !== 1 || match.key !== type.key || match.extension !== type.extension || match.name !== type.name || !isDeepStrictEqual(match.definition, definition))) {
        for (const row of matches) conflicts.push({ kind: 'type', message: `Destination type ${row.name} conflicts with imported ${type.name}.`, sourceId: type.id, destinationId: String(row.id) });
        typeIds.set(type.id, null);
      } else {
        typeIds.set(type.id, match ? String(match.id) : null);
        if (match) reusedTypes++;
        else newTypes++;
      }
    }
    const sourcePaths = new Set<string>(), sourceItemIds = new Set<string>();
    for (const item of bundle.items) {
      validateContentFolder(item.folder);
      if (item.gameId !== null && item.gameId !== bundle.gameId) throw new MutationError('SCOPE_DENIED', 'Imported document belongs to another game.');
      const type = bundle.types.find(value => value.id === item.typeId);
      if (!type) throw new MutationError('INVALID_CONTENT', 'Imported document references a missing content type.');
      validateContentData(validateContentDefinition(type.definition), item.data);
      if (sourceItemIds.has(item.id)) conflicts.push({ kind: 'source', message: 'Duplicate document identity in the import.', sourceId: item.id });
      sourceItemIds.add(item.id);
      if (item.archived) continue;
      const path = `${item.gameId ?? ''}\0${item.typeId}\0${item.folder}\0${item.slug}`;
      if (sourcePaths.has(path)) conflicts.push({ kind: 'source', message: `Duplicate imported document path ${item.folder}/${item.slug}.${type.extension}.`, sourceId: item.id });
      sourcePaths.add(path);
      const destinationTypeId = typeIds.get(item.typeId);
      if (!destinationTypeId || (item.gameId && !destinationGameId)) continue;
      const gameId = item.gameId ? destinationGameId! : null;
      const [occupied] = await db.execute(sql`select id,title from content_items where project_id=${projectId} and game_id is not distinct from ${gameId}
        and type_id=${destinationTypeId} and folder=${item.folder} and slug=${item.slug} and deleted_at is null limit 1`);
      if (occupied) conflicts.push({ kind: 'path', message: `Destination document ${occupied.title} occupies ${item.folder}/${item.slug}.${type.extension}.`, sourceId: item.id, destinationId: String(occupied.id) });
    }
    return { ready: conflicts.length === 0, conflicts, typeCount: bundle.types.length, itemCount: bundle.items.length,
      reusedTypes, newTypes, projectId, gameId: destinationGameId ?? null };
}
export async function importContentSnapshot(tx: Tx, request: Scope, raw: unknown,canonicalIds?:Map<string,string>,createdAssetKeys?:string[]) {
  assertSafeJson(raw); const bundle = contentBundleSchema.parse(raw);
  if (bundle.assets?.length && !createdAssetKeys) throw new MutationError('INVALID_IMAGE', 'Asset import requires rollback cleanup tracking.');
  await scope(tx, request, true);
  await importCanonicalTypes(tx,request.projectId,bundle.canonicalTypes??[]);
  const importedFolders=new Set<string>(),recoveryFolders=new Set<string>();
  for(const root of bundle.folders??[])if(root.recovery){recoveryFolders.add((root.gameId??'')+'/'+root.path);for(const path of root.recovery.folders){if(!bundle.folders?.some(f=>f.gameId===root.gameId&&f.path===path&&f.archived))throw new MutationError('INVALID_CONTENT','Every recovery folder must be included as an archived folder in this bundle.');recoveryFolders.add((root.gameId??'')+'/'+path);}}
  for(const folder of bundle.folders??[]){if(folder.gameId!==null&&folder.gameId!==bundle.gameId)throw new MutationError('SCOPE_DENIED','Imported folder belongs to another game.');if(folder.gameId&&!request.gameId)throw new MutationError('SCOPE_DENIED','Game folders require a destination game.');validateContentFolder(folder.path);const identity=(folder.gameId??'')+'/'+folder.path;if(importedFolders.has(identity))throw new MutationError('INVALID_CONTENT','Duplicate imported folder.');importedFolders.add(identity);await persistFolder(tx,{projectId:request.projectId,...(folder.gameId?{gameId:request.gameId!}:{})},folder.path,!recoveryFolders.has(identity),'Import folder',folder.archived??false);}
  if (bundle.gameId && !request.gameId) throw new MutationError('SCOPE_DENIED', 'A game export requires a destination game.');
  const typeIds = new Map<string,string>(), itemIds = new Map<string,string>();
  const createdTypeIds = new Set<string>();
  const definitions = new Map<string,ContentDefinition>();
  for (const type of bundle.types) {
    if (typeIds.has(type.id)) throw new MutationError('INVALID_CONTENT', 'Duplicate type identity in export.');
    const definition = validateContentDefinition(type.definition); definitions.set(type.id, definition);
    // Type defaults cannot refer to bundle identities; use explicit per-document references.
    if (validateContentData(definition, definition.defaults, true).length) throw new MutationError('INVALID_CONTENT', 'Reference defaults must be cleared before importing; document references are remapped.');
    const [existing] = await tx.execute(sql`select * from content_types where project_id=${request.projectId} and (key=${type.key} or extension=${type.extension})`);
    if (existing) {
      const [compatible] = await tx.execute(sql`select id from content_types where id=${existing.id} and key=${type.key} and extension=${type.extension} and name=${type.name} and definition=${JSON.stringify(definition)}::jsonb`);
      if (!compatible) throw new MutationError('SCHEMA_CONFLICT', 'An imported type conflicts with a destination type.', {
        key: type.key, extension: type.extension, sourceTypeId: type.id,
        destinationTypeId: String(existing.id), destinationName: String(existing.name), destinationRevision: Number(existing.revision),
      });
      typeIds.set(type.id, String(existing.id));
    } else {
      const id = randomUUID(); typeIds.set(type.id,id);
      createdTypeIds.add(type.id);
      const [created] = await tx.execute(sql`insert into content_types(id,project_id,key,extension,name,definition,revision) values(${id},${request.projectId},${type.key},${type.extension},${type.name},${JSON.stringify(definition)}::jsonb,${bundle.revisions ? type.revision ?? 1 : 1}) returning *`);
      await history(tx, 'type', created as unknown as ContentType, `Import type ${type.id} from project ${bundle.projectId}`);
    }
  }
  for (const item of bundle.items) {
    if (itemIds.has(item.id) || !typeIds.has(item.typeId) || (item.gameId !== null && item.gameId !== bundle.gameId)) throw new MutationError('INVALID_CONTENT', 'Invalid or duplicate exported item ownership.');
    validateContentFolder(item.folder); validateContentData(definitions.get(item.typeId)!,item.data);
    itemIds.set(item.id, randomUUID());
  }
  const revisionsByTarget = new Map<string, NonNullable<typeof bundle.revisions>>();
  if (bundle.revisions) {
    const typeSources = new Map(bundle.types.map(type => [type.id, type]));
    const itemSources = new Map(bundle.items.map(item => [item.id, item]));
    for (const entry of bundle.revisions) {
      const source = entry.targetKind === 'type' ? typeSources.get(entry.targetId) : itemSources.get(entry.targetId);
      if (!source || entry.snapshot.id !== entry.targetId || entry.snapshot.project_id !== bundle.projectId || entry.snapshot.revision !== entry.revision)
        throw new MutationError('INVALID_CONTENT', 'Content history has an invalid target or snapshot identity.');
      if (entry.targetKind === 'type') {
        validateContentDefinition(entry.snapshot.definition);
      } else {
        const item = source as (typeof bundle.items)[number];
        if (entry.snapshot.game_id !== item.gameId || entry.snapshot.type_id !== item.typeId)
          throw new MutationError('INVALID_CONTENT', 'Historical item changed game or type ownership.');
      }
      const key = `${entry.targetKind}/${entry.targetId}`;
      revisionsByTarget.set(key, [...(revisionsByTarget.get(key) ?? []), entry]);
    }
    for (const [kind, sources] of [['type', bundle.types], ['item', bundle.items]] as const) for (const source of sources) {
      const entries = revisionsByTarget.get(`${kind}/${source.id}`) ?? [];
      const expected = source.revision ?? 1;
      let previous = 0;
      for (const entry of entries) {
        if (entry.revision <= previous || entry.revision > expected || entry.priorRevision !== (entry.revision > 1 ? entry.revision - 1 : null))
          throw new MutationError('INVALID_CONTENT', 'Content history has a duplicate, out-of-order, or invalid revision.');
        previous = entry.revision;
      }
      const currentSnapshot = entries.find(entry => entry.revision === expected)?.snapshot;
      if (currentSnapshot && (kind === 'type'
        ? !isDeepStrictEqual([currentSnapshot.key, currentSnapshot.extension, currentSnapshot.name, currentSnapshot.definition],
            [(source as (typeof bundle.types)[number]).key, (source as (typeof bundle.types)[number]).extension, (source as (typeof bundle.types)[number]).name, (source as (typeof bundle.types)[number]).definition])
        : !isDeepStrictEqual([currentSnapshot.title, currentSnapshot.description ?? '', currentSnapshot.folder ?? '', currentSnapshot.slug, currentSnapshot.data,
            currentSnapshot.gm_context_mode ?? null, currentSnapshot.visibility, currentSnapshot.branch_id ?? null, currentSnapshot.pov_character ?? null,
            currentSnapshot.cover_asset_id ?? null, currentSnapshot.cover_revision ?? 0, Boolean(currentSnapshot.deleted_at)],
            [(source as (typeof bundle.items)[number]).title, (source as (typeof bundle.items)[number]).description,
              (source as (typeof bundle.items)[number]).folder, (source as (typeof bundle.items)[number]).slug, (source as (typeof bundle.items)[number]).data,
              (source as (typeof bundle.items)[number]).gmContextMode, (source as (typeof bundle.items)[number]).visibility,
              (source as (typeof bundle.items)[number]).branchId ?? null, (source as (typeof bundle.items)[number]).povCharacter ?? null,
              (source as (typeof bundle.items)[number]).coverAssetId ?? null, (source as (typeof bundle.items)[number]).coverRevision ?? 0,
              (source as (typeof bundle.items)[number]).archived])))
        throw new MutationError('INVALID_CONTENT', 'Current content does not match its retained revision snapshot.');
    }
  }
  const assetIds = new Map<string,string>();
  const assetSources = new Map((bundle.assets ?? []).map(asset => [asset.id,asset]));
  if (assetSources.size !== (bundle.assets ?? []).length) throw new MutationError('INVALID_IMAGE', 'Duplicate asset identity in export.');
  const referencedAssets = new Set<string>();
  for (const item of bundle.items) if (item.coverAssetId) {
    const asset = assetSources.get(item.coverAssetId);
    if (!asset || asset.gameId !== item.gameId || (item.visibility === 'public' && asset.visibility !== 'public') || (item.coverRevision ?? 0) < 1)
      throw new MutationError('INVALID_IMAGE', 'Document cover is missing, hidden, or in another game scope.');
    referencedAssets.add(asset.id);
  }
  for (const entry of bundle.revisions ?? []) if (entry.targetKind === 'item' && typeof entry.snapshot.cover_asset_id === 'string') {
    const assetId = entry.snapshot.cover_asset_id;
    const asset = assetSources.get(assetId);
    if (!asset || asset.gameId !== entry.snapshot.game_id || (entry.snapshot.visibility === 'public' && asset.visibility !== 'public'))
      throw new MutationError('INVALID_IMAGE', 'Historical cover is missing, hidden, or in another game scope.');
    referencedAssets.add(assetId);
  }
  if (referencedAssets.size !== assetSources.size) throw new MutationError('INVALID_IMAGE', 'Export contains an unreferenced image asset.');
  if (assetSources.size) {
    const { importImageAsset } = await import('./imageAssets');
    for (const asset of assetSources.values()) {
      if (asset.gameId !== null && asset.gameId !== bundle.gameId) throw new MutationError('SCOPE_DENIED', 'Image asset belongs to another game.');
      assetIds.set(asset.id, await importImageAsset(tx, { projectId: request.projectId, ...(asset.gameId ? { gameId: request.gameId! } : {}), mediaType: asset.mediaType, sha256: asset.sha256, bytesBase64: asset.bytesBase64, visibility: asset.visibility, createdKeys: createdAssetKeys! }));
    }
  }
  // Every identity is allocated before insertion so cycles and forward references remap correctly.
  for (const item of bundle.items) {
    const gameId = item.gameId ? request.gameId! : null;
    const data = remapReferences(definitions.get(item.typeId)!.fields,item.data,itemIds);
    if (!item.archived) {
      const [collision] = await tx.execute(sql`select id,title from content_items where project_id=${request.projectId} and game_id is not distinct from ${gameId} and folder=${item.folder} and slug=${item.slug} and type_id=${typeIds.get(item.typeId)!} and deleted_at is null`);
      if (collision) throw new MutationError('CONTENT_EXISTS','An imported document conflicts with an existing path. Import into a new project or resolve the destination conflict first.',{
        folder:item.folder,slug:item.slug,sourceItemId:item.id,
        destinationItemId:String(collision.id),destinationTitle:String(collision.title),
      });
    }
    const [created] = await tx.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,description,folder,slug,data,gm_context_mode,visibility,branch_id,pov_character,cover_asset_id,cover_revision,deleted_at,revision) values(${itemIds.get(item.id)!},${request.projectId},${gameId},${typeIds.get(item.typeId)!},${item.title},${item.description},${item.folder},${item.slug},${JSON.stringify(data)}::jsonb,${item.gmContextMode},${item.visibility},${item.branchId ?? null},${item.povCharacter ?? null},${item.coverAssetId ? assetIds.get(item.coverAssetId)! : null},${item.coverRevision ?? 0},${item.archived ? new Date().toISOString() : null},${bundle.revisions ? item.revision ?? 1 : 1}) returning *`);
    const type = await typeRow(tx,request.projectId,typeIds.get(item.typeId)!);
    await history(tx,'item',created as unknown as ContentItem,`Import document ${item.id} from project ${bundle.projectId}`,type.revision);
  }
  for (const item of bundle.items) {
    const definition = definitions.get(item.typeId)!;
    const data = remapReferences(definition.fields,item.data,itemIds);
    const itemScope = { projectId: request.projectId, ...(item.gameId ? { gameId: request.gameId! } : {}) };
    // Archived documents may retain references to other archived documents, but not foreign scopes.
    for (const ref of validateContentData(definition,data)) {
      const target = await itemRow(tx,itemScope,ref);
      if (!item.archived && target.deleted_at) throw new MutationError('INVALID_REFERENCE','Active imported content refers to an archived document.');
    }
  }
  if (bundle.revisions) for (const entry of bundle.revisions) {
    if (entry.targetKind === 'type' && !createdTypeIds.has(entry.targetId)) continue;
    const current = entry.targetKind === 'type' ? bundle.types.find(type => type.id === entry.targetId)!.revision ?? 1
      : bundle.items.find(item => item.id === entry.targetId)!.revision ?? 1;
    const sourceItem = entry.targetKind === 'item' ? bundle.items.find(item => item.id === entry.targetId)! : null;
    const snapshot: Record<string, unknown> = { ...entry.snapshot, id: entry.targetKind === 'item' ? itemIds.get(entry.targetId)! : typeIds.get(entry.targetId)!, project_id: request.projectId };
    if (sourceItem) {
      snapshot.game_id = sourceItem.gameId ? request.gameId! : null;
      snapshot.type_id = typeIds.get(sourceItem.typeId)!;
      snapshot.data = remapHistoricalData(snapshot.data, itemIds);
      if (typeof snapshot.cover_asset_id === 'string') snapshot.cover_asset_id = assetIds.get(snapshot.cover_asset_id)!;
    }
    if (entry.revision === current) await tx.execute(sql`delete from content_revisions where project_id=${request.projectId} and target_kind=${entry.targetKind} and target_id=${snapshot.id as string} and revision=${current}`);
    await tx.execute(sql`insert into content_revisions(id,project_id,target_kind,target_id,revision,prior_revision,type_revision,snapshot,actor,reason,created_at)
      values(${randomUUID()},${request.projectId},${entry.targetKind},${snapshot.id as string},${entry.revision},${entry.priorRevision},${entry.typeRevision},${JSON.stringify(snapshot)}::jsonb,${JSON.stringify(entry.actor)}::jsonb,${entry.reason},${entry.createdAt}::timestamptz)`);
  }
  await importFolderReceipts(tx,request,bundle,itemIds,canonicalIds);
  return { typeIds: Object.fromEntries(typeIds), itemIds: Object.fromEntries(itemIds), assetIds: Object.fromEntries(assetIds),
    skippedTypeHistory: bundle.revisions ? bundle.types.filter(type => !createdTypeIds.has(type.id) && revisionsByTarget.has(`type/${type.id}`)).map(type => type.id) : [] };
}
export async function importContent(input: unknown) {
  assertSafeJson(input); const request = contentImportSchema.parse(input);
  const createdAssetKeys: string[] = [];
  try { return await getDb().transaction(tx => importContentSnapshot(tx, request, request.bundle, undefined, createdAssetKeys)); }
  catch (error) { const { cleanupImportedImageAssets } = await import('./imageAssets'); await cleanupImportedImageAssets(createdAssetKeys); throw error; }
}

export async function contentCommand(command: string, input: unknown, storyId: string) {
  // Strict per-operation parsers below reject role, raw SQL, arbitrary fields and paths.
  const request = input as Scope;
  if (!request || (storyId !== '__app__' && storyId !== request.gameId)) throw new MutationError('SCOPE_DENIED', 'Command game scope does not match the content scope.');
  switch (command) {
    case 'content.canonicalTypes.read': return readCanonicalType(input);
    case 'content.canonicalTypes.preview': return saveCanonicalType(input,true);
    case 'content.canonicalTypes.save': return saveCanonicalType(input);
    case 'content.canonicalTypes.history': return canonicalTypeHistory(input);
    case 'content.canonicalTypes.previewRestore': return restoreCanonicalType(input,true);
    case 'content.canonicalTypes.restore': return restoreCanonicalType(input);
    case 'content.folders.previewArchive': return archiveFolder(input,true);
    case 'content.folders.archive': return archiveFolder(input);
    case 'content.folders.previewRestore': return archiveFolder(input,true,'restore');
    case 'content.folders.restore': return archiveFolder(input,false,'restore');
    case 'content.folders.list': return listFolders(input);
    case 'content.folders.create': return createFolder(input);
    case 'content.folders.previewCopy': return copyFolder(input,true);
    case 'content.folders.copy': return copyFolder(input);
    case 'content.folders.previewMove': return moveFolder(input,true);
    case 'content.folders.move': return moveFolder(input);
    case 'content.history': return listContentHistory(input);
    case 'content.history.previewRestore': return restoreContentHistory(input,true);
    case 'content.history.restore': return restoreContentHistory(input);
    case 'content.types.list': return listContentTypes(input);
    case 'content.types.preview': return saveContentType(input, true);
    case 'content.types.save': return saveContentType(input);
    case 'content.list': return listContent(input);
    case 'content.read': return readContent(input);
    case 'content.write': return writeContent(input);
    case 'content.update': return updateContent(input);
    case 'content.organize': return organizeContent(input);
    case 'content.canonical': return readCanonicalContent(input);
    case 'content.canonical.create': return createCanonicalWorkspace(input);
    case 'content.canonical.copy': return copyCanonicalWorkspace(input);
    case 'content.canonical.edit': return editCanonicalWorkspace(input);
    case 'content.canonical.history': return canonicalWorkspaceHistory(input);
    case 'content.canonical.previewRestore': return restoreCanonicalWorkspace(input,true);
    case 'content.canonical.restore': return restoreCanonicalWorkspace(input);
    case 'content.export': return exportContent(input);
    case 'content.import.preview': return previewContentImport(input);
    case 'content.import': return importContent(input);
    default: throw new MutationError('INVALID_COMMAND', 'Unknown content operation.');
  }
}


async function folderInventory(db:Db|Tx,request:Scope){
  const explicit=await db.execute(sql`select * from content_folders where project_id=${request.projectId} and game_id is not distinct from ${request.gameId??null} order by id limit 5001`);
  const items=await db.execute(sql`select i.id,i.title,i.folder,i.revision,i.deleted_at,t.revision as type_revision from content_items i join content_types t on t.id=i.type_id where i.project_id=${request.projectId} and i.game_id is not distinct from ${request.gameId??null} order by i.id limit 5001`);
  const canonical=request.gameId?await db.execute(sql`select * from canonical_content where project_id=${request.projectId} and game_id=${request.gameId} order by kind,record_id limit 5001`):[];
  if(explicit.length+items.length+canonical.length>5000)throw new MutationError('CONTENT_LIMIT','Folder operations currently support at most 5,000 records per scope.');
  return {explicit,items,canonical};
}
export async function listFoldersInTransaction(tx:Tx,input:unknown){const request=folderScopeSchema.parse(input);await scope(tx,request);const rows=await folderInventory(tx,request);return {paths:folderPaths([...rows.explicit.map(r=>String(r.path)),...rows.items.map(r=>String(r.folder)),...rows.canonical.map(r=>String(r.folder))]),activePaths:folderPaths([...rows.explicit.filter(r=>!r.archived_at).map(r=>String(r.path)),...rows.items.filter(r=>!r.deleted_at).map(r=>String(r.folder)),...rows.canonical.filter(r=>!r.hidden&&!r.source_deleted).map(r=>String(r.folder))]),explicit:rows.explicit};}
export async function listFolders(input:unknown){return getDb().transaction(tx=>listFoldersInTransaction(tx,input),{isolationLevel:'repeatable read',accessMode:'read only'});}
async function persistFolder(tx:Tx,request:Scope,path:string,existingAllowed=false,reason='Create folder',archived=false,actor?:Record<string,unknown>){
  const [existing]=await tx.execute(sql`select * from content_folders where project_id=${request.projectId} and game_id is not distinct from ${request.gameId??null} and path=${path}`);
  if(existing){if(existingAllowed){if(Boolean(existing.archived_at)!==archived)throw new MutationError('CONTENT_EXISTS','Imported folder archive state conflicts with the destination.');return existing;}throw new MutationError('CONTENT_EXISTS','This folder already exists.');}
  const [saved]=await tx.execute(sql`insert into content_folders(id,project_id,game_id,path,archived_at) values(${randomUUID()},${request.projectId},${request.gameId??null},${path},${archived?new Date().toISOString():null}) returning *`);await history(tx,'folder',saved as unknown as ContentFolder,reason,undefined,actor);return saved;
}
export async function createFolderInTransaction(tx:Tx,input:unknown,actor?:Record<string,unknown>){const request=folderCreateSchema.parse(input);validateContentFolder(request.path);await scope(tx,request,true);return {folder:await persistFolder(tx,request,request.path,false,'Create folder',false,actor)};}
export async function createFolder(input:unknown){return getDb().transaction(tx=>createFolderInTransaction(tx,input));}
export function copyFolder(input:unknown,preview=false){return moveFolder(input,preview,'copy');}
function folderMoveRequest(input:unknown){const request=folderMoveSchema.parse(input);validateContentFolder(request.from);validateContentFolder(request.to);if(inContentFolder(request.to,request.from))throw new MutationError('INVALID_CONTENT','Choose a different destination outside the source folder.');return request;}
export async function moveFolder(input:unknown,preview=false,operation:'move'|'copy'='move'){
  const request=folderMoveRequest(input);
  return getDb().transaction(tx=>moveFolderInTransaction(tx,request,preview,operation));
}
export async function moveFolderInTransaction(tx:Tx,input:unknown,preview=false,operation:'move'|'copy'='move',actor?:Record<string,unknown>){
  const request=folderMoveRequest(input);
    await scope(tx,request,true);const rows=await folderInventory(tx,request);
    if(rows.explicit.some(r=>r.archived_at&&(inContentFolder(String(r.path),request.from)||inContentFolder(request.from,String(r.path))||inContentFolder(request.to,String(r.path)))))throw new MutationError('CONTENT_ARCHIVED','Restore archived folders before moving or copying their tree.');
    const paths=folderPaths([...rows.explicit.map(r=>String(r.path)),...rows.items.map(r=>String(r.folder)),...rows.canonical.map(r=>String(r.folder))]);
    if(!paths.includes(request.from))throw new MutationError('SCOPE_DENIED','Source folder was not found in this scope.');
    if(paths.includes(request.to))throw new MutationError('CONTENT_EXISTS','Destination folder already exists. Choose an unused path; folder merging is not supported.');
    const folders=rows.explicit.filter(r=>inContentFolder(String(r.path),request.from));
    const items=rows.items.filter(r=>inContentFolder(String(r.folder),request.from));
    const canonical=rows.canonical.filter(r=>inContentFolder(String(r.folder),request.from));
    for(const path of [...folders.map(r=>String(r.path)),...items.map(r=>String(r.folder)),...canonical.map(r=>String(r.folder))]){const next=relocatedFolder(path,request.from,request.to);if(next.length>500)throw new MutationError('INVALID_CONTENT','A moved child path would exceed 500 characters.');validateContentFolder(next);}
    const expectedSnapshot=createHash('sha256').update(JSON.stringify({operation,projectId:request.projectId,gameId:request.gameId??null,from:request.from,to:request.to,folders:folders.map(r=>[r.id,r.path,r.revision]),items:items.map(r=>[r.id,r.folder,r.revision,r.type_revision]),canonical:canonical.map(r=>[r.id,r.folder,r.revision])})).digest('hex');
    const summary={operation,from:request.from,to:request.to,expectedSnapshot,counts:{folders:folders.length,documents:items.length,canonical:canonical.length},items:[...items.map(r=>({kind:'document',id:r.id,name:r.title,from:r.folder,to:relocatedFolder(String(r.folder),request.from,request.to)})),...canonical.map(r=>({kind:r.kind,id:r.record_id,from:r.folder,to:relocatedFolder(String(r.folder),request.from,request.to)}))]};
    if(operation==='copy'){
      for(const row of canonical)await copyCanonicalFolder(tx,{projectId:request.projectId,gameId:request.gameId!,kind:row.kind as 'characters'|'locations'|'items'|'factions',id:String(row.record_id)},Number(row.revision),relocatedFolder(String(row.folder),request.from,request.to),true,actor);
    }
    if(preview)return summary;
    if(request.expectedSnapshot!==expectedSnapshot)throw new MutationError('REVISION_CONFLICT','Folder contents changed or no preview was supplied. Preview the operation again.');
    if(operation==='copy'){
      const itemIds=await copyFolderDocuments(tx,request,items.map(row=>String(row.id)),actor);
      const canonicalIds:Record<string,string>={};
      for(const row of canonical){const copied=await copyCanonicalFolder(tx,{projectId:request.projectId,gameId:request.gameId!,kind:row.kind as 'characters'|'locations'|'items'|'factions',id:String(row.record_id)},Number(row.revision),relocatedFolder(String(row.folder),request.from,request.to),false,actor);canonicalIds[String(row.record_id)]=String((copied as {record:Record<string,unknown>}).record.id);}
      for(const row of folders)await persistFolder(tx,request,relocatedFolder(String(row.path),request.from,request.to),false,'Copied from folder '+row.id+' at revision '+row.revision,false,actor);
      return {...summary,copied:true,itemIds,canonicalIds};
    }
    for(const row of canonical)await relocateCanonicalFolder(tx,{projectId:request.projectId,gameId:request.gameId!,kind:row.kind as 'characters'|'locations'|'items'|'factions',id:String(row.record_id)},Number(row.revision),relocatedFolder(String(row.folder),request.from,request.to),actor);
    for(const row of items){const [saved]=await tx.execute(sql`update content_items set folder=${relocatedFolder(String(row.folder),request.from,request.to)},revision=revision+1,updated_at=now() where id=${row.id} returning *`);await history(tx,'item',saved as unknown as ContentItem,'Move folder',Number(row.type_revision),actor);}
    for(const row of folders){const [saved]=await tx.execute(sql`update content_folders set path=${relocatedFolder(String(row.path),request.from,request.to)},revision=revision+1,updated_at=now() where id=${row.id} returning *`);await history(tx,'folder',saved as unknown as ContentFolder,'Move folder',undefined,actor);}
    return {...summary,moved:true};
}

async function copyFolderDocuments(tx:Tx,request:Scope&{from:string;to:string},sourceIds:string[],actor?:Record<string,unknown>){
  const ids=new Map(sourceIds.map(id=>[id,randomUUID()]));
  const sources=[];
  for(const id of sourceIds){const item=await itemRow(tx,request,id);const type=await typeRow(tx,request.projectId,item.type_id);validateContentData(type.definition,item.data);sources.push({item,type});}
  // Allocate all IDs before insertion: cycles, self-references and forward references stay inside the copy.
  for(const {item,type} of sources){
    const data=remapReferences(type.definition.fields,item.data,ids,true);
    const [saved]=await tx.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,description,folder,slug,data,gm_context_mode,visibility,branch_id,pov_character,deleted_at) values(${ids.get(item.id)!},${request.projectId},${item.game_id},${item.type_id},${item.title},${item.description},${relocatedFolder(item.folder,request.from,request.to)},${item.slug},${JSON.stringify(data)}::jsonb,${item.gm_context_mode},${item.visibility},${item.branch_id},${item.pov_character},${item.deleted_at}) returning *`);
    await history(tx,'item',saved as unknown as ContentItem,'Copied from document '+item.id+' at revision '+item.revision,type.revision,actor);
  }
  for(const {item,type} of sources){
    const data=remapReferences(type.definition.fields,item.data,ids,true);
    for(const ref of validateContentData(type.definition,data)){const target=await itemRow(tx,request,ref);if(!item.deleted_at&&target.deleted_at)throw new MutationError('INVALID_REFERENCE','An active copied document would refer to archived content.');}
  }
  return Object.fromEntries(ids);
}

/** One transaction and a recovery receipt preserve pre-existing archives and later human edits. */
export async function archiveFolder(input:unknown,preview=false,operation:'archive'|'restore'='archive'){
  const request=folderArchiveSchema.parse(input);validateContentFolder(request.path);
  return getDb().transaction(async tx=>{
    await scope(tx,request,true);
    const rows=await folderInventory(tx,request);
    const root=rows.explicit.find(r=>r.path===request.path);
    const subtree=(path:unknown)=>inContentFolder(String(path),request.path);
    const skipped:{id:string;kind:string;reason:string}[]=[];
    let folders:Record<string,unknown>[]=[],items:Record<string,unknown>[]=[],canonical:Record<string,unknown>[]=[];
    if(operation==='archive'){
      if(rows.explicit.some(r=>r.archived_at&&inContentFolder(request.path,String(r.path))))throw new MutationError('CONTENT_ARCHIVED','This folder or an ancestor is already archived. Restore that folder first.');
      if(!folderPaths([...rows.explicit.map(r=>String(r.path)),...rows.items.map(r=>String(r.folder)),...rows.canonical.map(r=>String(r.folder))]).includes(request.path))missing();
      const archivedRoots=rows.explicit.filter(r=>r.archived_at&&subtree(r.path));
      const eligible=(path:unknown)=>subtree(path)&&!archivedRoots.some(r=>inContentFolder(String(path),String(r.path)));
      folders=rows.explicit.filter(r=>eligible(r.path)&&!r.archived_at&&r.id!==root?.id);
      items=rows.items.filter(r=>eligible(r.folder)&&!r.deleted_at);
      canonical=rows.canonical.filter(r=>eligible(r.folder)&&!r.hidden&&!r.source_deleted);
      const ids=new Set(items.map(r=>String(r.id)));
      const others=await tx.execute(sql`select i.id,i.data,t.definition from content_items i join content_types t on t.id=i.type_id where i.project_id=${request.projectId} and i.deleted_at is null`);
      const incoming=others.filter(r=>!ids.has(String(r.id))&&validateContentData(r.definition as ContentDefinition,r.data).some(id=>ids.has(id)));
      if(incoming.length)throw new MutationError('REFERENCE_CONFLICT','Active documents outside this archive still refer to its documents. Update those references before archiving.',{ids:incoming.map(r=>r.id)});
    }else{
      if(!root?.archived_at)throw new MutationError('INVALID_CONTENT','Choose an archived saved folder.');
      const receipt=root.archive_receipt as FolderArchiveReceipt|null;
      function recover<T extends Record<string,unknown>>(members:{id:string;revision:number}[],available:T[],kind:string,archived:(r:T)=>boolean):T[]{
        return members.flatMap(member=>{const row=available.find(r=>r.id===member.id);if(row&&Number(row.revision)===member.revision&&archived(row))return [row];skipped.push({id:member.id,kind,reason:'Changed since this folder archive; left unchanged. Recover individually if needed.'});return [];});
      }
      folders=receipt?recover(receipt.folders,rows.explicit,'folder',r=>Boolean(r.archived_at)):rows.explicit.filter(r=>r.id!==root.id&&subtree(r.path)&&r.archived_at&&!r.archive_receipt);
      items=receipt?recover(receipt.items,rows.items,'document',r=>Boolean(r.deleted_at)):[];
      canonical=receipt?recover(receipt.canonical,rows.canonical,'canonical',r=>Boolean(r.hidden)&&!r.source_deleted):[];
      // Validate together so cycles can be restored atomically; unrelated archived targets still block.
      const ids=new Set(items.map(r=>String(r.id)));
      for(const row of items){
        const item=await itemRow(tx,request,String(row.id)),type=await typeRow(tx,request.projectId,item.type_id);
        for(const ref of validateContentData(type.definition,item.data)){const target=await itemRow(tx,request,ref);if(target.deleted_at&&!ids.has(ref))throw new MutationError('INVALID_REFERENCE','A recovery document refers to an archived document outside this recovery. Restore that target first.',{itemId:item.id,targetId:ref});}
        const [collision]=await tx.execute(sql`select id from content_items where project_id=${request.projectId} and game_id is not distinct from ${request.gameId??null} and folder=${item.folder} and slug=${item.slug} and type_id=${item.type_id} and deleted_at is null`);
        if(collision)throw new MutationError('CONTENT_EXISTS','An active document now uses a recovery path. Move it before restoring this folder.',{itemId:item.id,conflictingId:collision.id});
      }
    }
    const expectedSnapshot=createHash('sha256').update(JSON.stringify({operation,request:{projectId:request.projectId,gameId:request.gameId??null,path:request.path},root,folders,items,canonical,skipped})).digest('hex');
    const summary={operation,from:request.path,to:request.path,expectedSnapshot,counts:{folders:folders.length+1,documents:items.length,canonical:canonical.length},skipped,importedRecovery:operation==='restore'&&!root?.archive_receipt,items:[...items.map(r=>({id:r.id,kind:'document',name:r.title,from:r.folder,to:r.folder})),...canonical.map(r=>({id:r.record_id,kind:r.kind,from:r.folder,to:r.folder}))]};
    if(preview)return summary;
    if(request.expectedSnapshot!==expectedSnapshot)throw new MutationError('REVISION_CONFLICT','Folder contents changed or no preview was supplied. Preview the operation again.');
    const receipt:FolderArchiveReceipt={folders:[],items:[],canonical:[]};
    for(const row of canonical){const saved=await setCanonicalFolderHidden(tx,{projectId:request.projectId,gameId:request.gameId!,kind:row.kind as 'characters'|'locations'|'items'|'factions',id:String(row.record_id)},Number(row.revision),operation==='archive');receipt.canonical.push({id:saved.id,revision:saved.revision});}
    for(const row of items){const [saved]=await tx.execute(sql`update content_items set deleted_at=${operation==='archive'?sql`now()`:sql`null`},revision=revision+1,updated_at=now() where id=${row.id} returning *`);await history(tx,'item',saved as unknown as ContentItem,operation==='archive'?'Archive folder':'Restore folder',Number(row.type_revision));receipt.items.push({id:String(saved.id),revision:Number(saved.revision)});}
    for(const row of folders){const [saved]=await tx.execute(sql`update content_folders set archived_at=${operation==='archive'?sql`now()`:sql`null`},revision=revision+1,updated_at=now() where id=${row.id} returning *`);await history(tx,'folder',saved as unknown as ContentFolder,operation==='archive'?'Archive folder':'Restore folder');receipt.folders.push({id:String(saved.id),revision:Number(saved.revision)});}
    const target=root??await persistFolder(tx,request,request.path);
    const [saved]=await tx.execute(sql`update content_folders set archived_at=${operation==='archive'?sql`now()`:sql`null`},archive_receipt=${operation==='archive'?JSON.stringify(receipt):null}::jsonb,revision=revision+1,updated_at=now() where id=${target.id} returning *`);
    await history(tx,'folder',saved as unknown as ContentFolder,operation==='archive'?'Archive subtree recovery receipt':'Restore subtree recovery receipt');
    return {...summary,applied:true};
  });
}

async function exportContentFolders(db:Db|Tx,request:Scope){
  const folders=await db.execute(sql`select * from content_folders where project_id=${request.projectId} and ${request.gameId?sql`(game_id is null or game_id=${request.gameId})`:sql`game_id is null`} order by game_id nulls first,path`);
  const items=await db.execute(sql`select i.id,i.game_id,i.revision,i.deleted_at from content_items i where i.project_id=${request.projectId} and ${readable(request)}`);
  const canonical=request.gameId?await db.execute(sql`select * from canonical_content where project_id=${request.projectId} and game_id=${request.gameId}`):[];
  return folders.map(root=>{
    const receipt=root.archive_receipt as FolderArchiveReceipt|null;
    const matches=(members:{id:string;revision:number}[],available:Record<string,unknown>[],active:(r:Record<string,unknown>)=>boolean)=>members.flatMap(m=>{const row=available.find(r=>r.id===m.id&&r.game_id===root.game_id&&Number(r.revision)===m.revision&&active(r));return row?[row]:[];});
    return {gameId:root.game_id,path:root.path,archived:!!root.archived_at,...(receipt?{recovery:{folders:matches(receipt.folders,folders,r=>!!r.archived_at).map(r=>r.path),items:matches(receipt.items,items,r=>!!r.deleted_at).map(r=>r.id),canonical:matches(receipt.canonical,canonical,r=>!!r.hidden&&!r.source_deleted).map(r=>({kind:r.kind,recordId:r.record_id}))}}:{})};
  });
}
async function importFolderReceipts(tx:Tx,request:Scope,bundle:ReturnType<typeof contentBundleSchema.parse>,ids:Map<string,string>,canonicalIds?:Map<string,string>){
  // Children first so a parent receipt captures each child's final imported revision.
  for(const root of [...(bundle.folders??[])].filter(f=>f.recovery).sort((a,b)=>b.path.length-a.path.length)){
    if(!root.archived)throw new MutationError('INVALID_CONTENT','A recovery receipt requires an archived folder.');
    const gameId=root.gameId?request.gameId!:null,receipt:FolderArchiveReceipt={folders:[],items:[],canonical:[]},seen=new Set<string>();
    const unique=(kind:string,id:string)=>{const key=kind+'/'+id;if(seen.has(key))throw new MutationError('INVALID_CONTENT','Duplicate recovery member.');seen.add(key);};
    for(const path of root.recovery!.folders){unique('folder',path);if(path===root.path||!inContentFolder(path,root.path))throw new MutationError('INVALID_CONTENT','A recovery folder must be a descendant.');const [row]=await tx.execute(sql`select id,revision from content_folders where project_id=${request.projectId} and game_id is not distinct from ${gameId} and path=${path} and archived_at is not null`);if(!row)missing();receipt.folders.push({id:String(row.id),revision:Number(row.revision)});}
    for(const sourceId of root.recovery!.items){unique('item',sourceId);const source=bundle.items.find(i=>i.id===sourceId);if(!source||source.gameId!==root.gameId||!source.archived||!inContentFolder(source.folder,root.path)||!ids.has(sourceId))throw new MutationError('INVALID_CONTENT','Recovery documents must be archived descendants in the same scope.');receipt.items.push({id:ids.get(sourceId)!,revision:1});}
    for(const member of root.recovery!.canonical){unique(member.kind,member.recordId);const id=canonicalIds?.get(member.kind+'/'+member.recordId);if(!gameId||!id)throw new MutationError('INVALID_CONTENT','This folder includes canonical recovery members. Import the full campaign snapshot to transfer their identities.');const [row]=await tx.execute(sql`select * from canonical_content where project_id=${request.projectId} and game_id=${gameId} and kind=${member.kind} and record_id=${id} and hidden and not source_deleted`);if(!row||!inContentFolder(String(row.folder),root.path))throw new MutationError('INVALID_CONTENT','Canonical recovery member is not a hidden descendant.');receipt.canonical.push({id:String(row.id),revision:Number(row.revision)});}
    const [current]=await tx.execute(sql`select * from content_folders where project_id=${request.projectId} and game_id is not distinct from ${gameId} and path=${root.path}`);
    if(!current||Number(current.revision)!==1||current.archive_receipt)throw new MutationError('CONTENT_EXISTS','A recovery receipt cannot replace an existing folder history.');
    const [saved]=await tx.execute(sql`update content_folders set archive_receipt=${JSON.stringify(receipt)}::jsonb,revision=revision+1,updated_at=now() where id=${current.id} returning *`);await history(tx,'folder',saved as unknown as ContentFolder,'Import remapped archive recovery receipt');
  }
}
