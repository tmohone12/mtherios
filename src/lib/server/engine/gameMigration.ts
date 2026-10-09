import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {sql} from 'drizzle-orm';
import {getDb} from '$lib/server/db/client';
import {defaultCanonicalType,type CanonicalKind} from '$lib/contracts/canonicalTypes';
import type {ContentItem} from '$lib/contracts/content';
import type {FolderArchiveReceipt,ContentFolder} from '$lib/contracts/contentFolders';
import {exportContentSnapshot,importContentSnapshot,history,remapHistoricalData,remapReferences} from './content';
import {validateContentData,validateContentDefinition} from './contentValidation';
import {enqueueStoryVaultSyncJob} from '$lib/server/jobs/outbox';
import {MutationError} from './mutationSafety';
import {collectPortraitAssetIds,remapPortraitAssetUrls} from './portraitAssetPortability';
const id=z.string().min(1).max(200);
export const gameMigrationSchema=z.object({projectId:id,gameId:id,destinationProjectId:id,sharedItemIds:z.array(id).max(5000).default([]),expectedSnapshot:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
const comparable=(value:ReturnType<typeof defaultCanonicalType>)=>({...value,fields:value.fields??{},defaults:value.defaults??{}});
function historicalItemRefs(value:unknown):string[]{
  if(Array.isArray(value))return value.flatMap(historicalItemRefs);
  if(!value||typeof value!=='object')return [];
  return Object.entries(value).flatMap(([key,entry])=>key==='itemId'&&typeof entry==='string'?[entry]:historicalItemRefs(entry));
}

export async function migrateGame(input:unknown,preview=false){
  const request=gameMigrationSchema.parse(input);
  if(request.projectId===request.destinationProjectId)throw new MutationError('INVALID_CONTENT','Choose a different destination project.');
  const createdAssetKeys:string[]=[];
  try { return await getDb().transaction(async tx=>{
    const projects=await tx.execute(sql`select * from shelves where id in (${request.projectId},${request.destinationProjectId}) order by id for update`);
    if(projects.length!==2)throw new MutationError('SCOPE_DENIED','Source or destination project was not found.');
    const [story]=await tx.execute(sql`select * from stories where id=${request.gameId} and shelf_id=${request.projectId} for update`);
    if(!story)throw new MutationError('SCOPE_DENIED','The game no longer belongs to this source project.');
    const jobs=await tx.execute(sql`select id,status,metadata from backend_jobs where story_id=${request.gameId} order by id for update`);
    const turns=await tx.execute(sql`select id from sync_ops where story_id=${request.gameId} and type='turn_command' and status='running'`);
    const conflicts:string[]=[];
    if(jobs.some(r=>r.status==='running')||turns.length)conflicts.push('Wait for the running game turn or background job before moving this game.');
    // Only explicit cross-game associations matter; never infer dependencies from names.
    function associations(value:unknown){if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){if(['foundationStoryId','baseStoryId','parentStoryId','overlayStoryId'].includes(key)&&typeof child==='string'&&child!==request.gameId)conflicts.push('Resolve the explicit '+key+' association before moving this game.');else if(typeof child==='object')associations(child);}}
    associations(story.metadata);associations(story.settings);
    const source=await exportContentSnapshot(tx,request),destination=await exportContentSnapshot(tx,{projectId:request.destinationProjectId});
    const gameItems=source.items.filter(r=>r.gameId===request.gameId),shared=source.items.filter(r=>r.gameId===null),selected=new Set(request.sharedItemIds);
    for(const selectedId of selected)if(!shared.some(r=>r.id===selectedId))throw new MutationError('SCOPE_DENIED','Selected shared content is not in the source project.');
    const definitions=new Map(source.types.map(t=>[t.id,validateContentDefinition(t.definition)]));
    const queue=[...gameItems,...shared.filter(r=>selected.has(r.id))],visited=new Set<string>();
    for(let index=0;index<queue.length;index++){
      const item=queue[index];if(visited.has(item.id))continue;visited.add(item.id);
      const historicalRefs=(source.revisions??[]).filter(revision=>revision.targetKind==='item'&&revision.targetId===item.id)
        .flatMap(revision=>historicalItemRefs(revision.snapshot.data));
      for(const ref of new Set([...validateContentData(definitions.get(item.typeId)!,item.data),...historicalRefs])){
        const target=source.items.find(r=>r.id===ref);if(!target)throw new MutationError('INVALID_REFERENCE','A game dependency is missing or outside its scope.',{itemId:item.id,targetId:ref});
        if(!item.archived&&target.archived)conflicts.push('Active document '+item.title+' references archived document '+target.title+'.');
        if(target.gameId===null)selected.add(target.id);queue.push(target);
      }
    }
    const dependencies=shared.filter(r=>selected.has(r.id)),typeIds=new Set([...gameItems,...dependencies].map(r=>r.typeId)),types=source.types.filter(t=>typeIds.has(t.id));
    for(const type of types){const collision=destination.types.find(t=>t.key===type.key||t.extension===type.extension);if(collision&&(!isDeepStrictEqual(collision.definition,type.definition)||collision.key!==type.key||collision.extension!==type.extension||collision.name!==type.name))conflicts.push('Resolve the destination type conflict for '+type.key+'.');}
    for(const item of dependencies){const type=source.types.find(t=>t.id===item.typeId)!;const targetType=destination.types.find(t=>t.key===type.key&&t.extension===type.extension);if(!item.archived&&targetType&&destination.items.some(r=>!r.archived&&r.typeId===targetType.id&&r.folder===item.folder&&r.slug===item.slug))conflicts.push('Destination shared document path is occupied: '+item.folder+'/'+item.slug+'.');}
    const destinationGames=await tx.execute(sql`select id from stories where shelf_id=${request.destinationProjectId} order by id`);
    const canonicalTypes=(['characters','locations','items','factions'] as CanonicalKind[]).map(kind=>({kind,definition:source.canonicalTypes?.find(t=>t.kind===kind)?.definition??defaultCanonicalType(kind)}));
    for(const type of canonicalTypes){const current=destination.canonicalTypes?.find(t=>t.kind===type.kind);if((current||destinationGames.length)&&!isDeepStrictEqual(comparable(current?.definition??defaultCanonicalType(type.kind)),comparable(type.definition)))conflicts.push('Resolve destination built-in '+type.kind+' schema/layout settings before moving.');}
    const rows=await tx.execute(sql`select * from content_items where project_id=${request.projectId} and game_id=${request.gameId} order by id`);
    const storyImages=await tx.execute(sql`select id,client_turn_id,call_id,asset_id from story_image_cards where project_id=${request.projectId} and game_id=${request.gameId} order by id`);
    const folders=await tx.execute(sql`select * from content_folders where project_id=${request.projectId} and game_id=${request.gameId} order by id`);
    const canonical=await tx.execute(sql`select * from canonical_content where project_id=${request.projectId} and game_id=${request.gameId} order by id`);
    const portraitEntities=await tx.execute(sql`select id,state,metadata from entities where story_id=${request.gameId} and type='character' order by id`);
    const portraitPatches=await tx.execute(sql`select id,operations from state_patches where story_id=${request.gameId} order by id`);
    const portraitProposals=await tx.execute(sql`select id,operations,metadata from patch_proposals where story_id=${request.gameId} order by id`);
    const portraitSource={projectId:request.projectId,gameId:request.gameId};
    const portraitIds=collectPortraitAssetIds([...portraitEntities.flatMap(row=>[row.state,row.metadata]),...portraitPatches.map(row=>row.operations),
      ...portraitProposals.flatMap(row=>[row.operations,row.metadata]),...jobs.map(row=>row.metadata)],portraitSource);
    const portraitAssets=portraitIds.size?await tx.execute(sql`select id from assets where project_id=${request.projectId} and game_id=${request.gameId}
      and id in (${sql.join([...portraitIds].map(id=>sql`${id}`),sql`,`)})`):[];
    if(portraitAssets.length!==portraitIds.size)conflicts.push('A generated portrait references an unavailable game asset.');
    const revisions=await tx.execute(sql`select id,revision from content_types where project_id in (${request.projectId},${request.destinationProjectId}) order by id`);
    const expectedSnapshot=createHash('sha256').update(JSON.stringify({request:{...request,expectedSnapshot:undefined},projects,story,jobs,turns,source,destination,rows,storyImages,folders,canonical,portraitEntities,portraitPatches,portraitProposals,portraitAssets,revisions,destinationGames})).digest('hex');
    const summary={gameId:request.gameId,destinationProjectId:request.destinationProjectId,expectedSnapshot,compatible:!conflicts.length,conflicts,counts:{gameDocuments:gameItems.length,sharedDocuments:dependencies.length,types:types.length,folders:folders.length,canonical:canonical.length,storyImages:storyImages.length},dependencies:dependencies.map(r=>({id:r.id,title:r.title,folder:r.folder})),availableShared:shared.map(r=>({id:r.id,title:r.title,folder:r.folder})),notice:'Game and canonical identities remain unchanged. Only selected and referenced shared documents are copied with new IDs. Other source shared content stays behind; destination project settings and shared content apply after the move.'};
    if(preview)return summary;
    if(conflicts.length)throw new MutationError('SCHEMA_CONFLICT','Resolve the migration preview conflicts before moving.',{conflicts});
    if(request.expectedSnapshot!==expectedSnapshot)throw new MutationError('REVISION_CONFLICT','The game or its dependencies changed. Preview the move again.');
    const dependencyTargets=new Set(dependencies.map(item=>item.id));
    const dependencyRevisions=(source.revisions??[]).filter(revision=>revision.targetKind==='type'?typeIds.has(revision.targetId):dependencyTargets.has(revision.targetId));
    const dependencyAssetIds=new Set([...dependencies.map(item=>item.coverAssetId),...dependencyRevisions.filter(revision=>revision.targetKind==='item').map(revision=>revision.snapshot.cover_asset_id)].filter((id):id is string=>typeof id==='string'&&Boolean(id)));
    const imported=await importContentSnapshot(tx,{projectId:request.destinationProjectId},{version:1,projectId:request.projectId,gameId:null,types,canonicalTypes,items:dependencies,
      assets:source.assets?.filter(asset=>dependencyAssetIds.has(asset.id))??[],revisions:dependencyRevisions,folders:[]},undefined,createdAssetKeys);
    const sharedIds=new Map(Object.entries(imported.itemIds));
    await tx.execute(sql`set constraints content_items_type_project_fk,content_items_game_project_fk,content_items_cover_asset_project_fk,canonical_content_game_project_fk,content_folders_project_id_game_id_fkey,backend_jobs_game_project_fk,assets_game_project_fk,story_image_cards_game_project_fk,story_image_cards_asset_project_fk deferred`);
    await tx.execute(sql`update stories set shelf_id=${request.destinationProjectId},server_version=server_version+1,updated_at=now() where id=${request.gameId}`);
    await tx.execute(sql`update backend_jobs set project_id=${request.destinationProjectId} where story_id=${request.gameId}`);
    await tx.execute(sql`update assets set project_id=${request.destinationProjectId} where project_id=${request.projectId} and game_id=${request.gameId}`);
    await tx.execute(sql`update story_image_cards set project_id=${request.destinationProjectId} where project_id=${request.projectId} and game_id=${request.gameId}`);
    const portraitDestination={projectId:request.destinationProjectId,gameId:request.gameId};
    const portraitIdentity=new Map([...portraitIds].map(id=>[id,id]));
    for(const row of portraitEntities){
      if(!collectPortraitAssetIds([row.state,row.metadata],portraitSource).size)continue;
      const state=remapPortraitAssetUrls(row.state,portraitSource,portraitDestination,portraitIdentity);
      const metadata=remapPortraitAssetUrls(row.metadata,portraitSource,portraitDestination,portraitIdentity);
      await tx.execute(sql`update entities set state=${JSON.stringify(state)}::jsonb,metadata=${JSON.stringify(metadata)}::jsonb where id=${row.id}`);
    }
    for(const row of portraitPatches){
      if(!collectPortraitAssetIds([row.operations],portraitSource).size)continue;
      const operations=remapPortraitAssetUrls(row.operations,portraitSource,portraitDestination,portraitIdentity);
      await tx.execute(sql`update state_patches set operations=${JSON.stringify(operations)}::jsonb where id=${row.id}`);
    }
    for(const row of portraitProposals){
      if(!collectPortraitAssetIds([row.operations,row.metadata],portraitSource).size)continue;
      const operations=remapPortraitAssetUrls(row.operations,portraitSource,portraitDestination,portraitIdentity);
      const metadata=remapPortraitAssetUrls(row.metadata,portraitSource,portraitDestination,portraitIdentity);
      await tx.execute(sql`update patch_proposals set operations=${JSON.stringify(operations)}::jsonb,metadata=${JSON.stringify(metadata)}::jsonb where id=${row.id}`);
    }
    for(const row of jobs){
      if(!collectPortraitAssetIds([row.metadata],portraitSource).size)continue;
      const metadata=remapPortraitAssetUrls(row.metadata,portraitSource,portraitDestination,portraitIdentity);
      await tx.execute(sql`update backend_jobs set metadata=${JSON.stringify(metadata)}::jsonb where id=${row.id}`);
    }
    const gameTargets=[...rows,...folders].map(r=>String(r.id));
    if(gameTargets.length){
      const historyRows=await tx.execute(sql`select id,target_kind,target_id,snapshot from content_revisions
        where project_id=${request.projectId} and target_id in (${sql.join(gameTargets.map(id=>sql`${id}`),sql`,`)})`);
      for(const revision of historyRows){
        const snapshot:Record<string,unknown>={...(revision.snapshot as Record<string,unknown>),project_id:request.destinationProjectId};
        if(revision.target_kind==='item'){
          const owner=rows.find(row=>row.id===revision.target_id);
          if(!owner)throw new MutationError('INVALID_CONTENT','A moved document revision lost its owner.');
          snapshot.type_id=imported.typeIds[String(owner.type_id)];
          snapshot.data=remapHistoricalData(snapshot.data,sharedIds,true);
        }
        await tx.execute(sql`update content_revisions set project_id=${request.destinationProjectId},snapshot=${JSON.stringify(snapshot)}::jsonb where id=${revision.id}`);
      }
    }
    for(const row of rows){const type=source.types.find(t=>t.id===row.type_id)!;const data=remapReferences(type.definition.fields,row.data as Record<string,unknown>,sharedIds,true);const [saved]=await tx.execute(sql`update content_items set project_id=${request.destinationProjectId},type_id=${imported.typeIds[type.id]},data=${JSON.stringify(data)}::jsonb,revision=revision+1,updated_at=now() where id=${row.id} returning *`);const [targetType]=await tx.execute(sql`select revision from content_types where id=${saved.type_id}`);await history(tx,'item',saved as unknown as ContentItem,'Move game from project '+request.projectId,Number(targetType.revision));}
    for(const row of canonical){const [saved]=await tx.execute(sql`update canonical_content set project_id=${request.destinationProjectId},revision=revision+1,updated_at=now() where id=${row.id} returning *`);await tx.execute(sql`insert into canonical_content_history(content_id,revision,snapshot,actor,reason) select ${row.id},${saved.revision},jsonb_build_object('envelope',${JSON.stringify(saved)}::jsonb,'record',snapshot->'record'),' {"role":"client","id":"local-client"}'::jsonb,${'Move game from project '+request.projectId} from canonical_content_history where content_id=${row.id} order by revision desc limit 1`);}
    for(const row of folders){const receipt=structuredClone(row.archive_receipt) as FolderArchiveReceipt|null;if(receipt)for(const [key,available] of [['items',rows],['folders',folders],['canonical',canonical]] as const)for(const member of receipt[key])if(available.some(r=>r.id===member.id&&Number(r.revision)===member.revision))member.revision++;
      const [saved]=await tx.execute(sql`update content_folders set project_id=${request.destinationProjectId},archive_receipt=${receipt?JSON.stringify(receipt):null}::jsonb,revision=revision+1,updated_at=now() where id=${row.id} returning *`);await history(tx,'folder',saved as unknown as ContentFolder,'Move game from project '+request.projectId);}
    await tx.execute(sql`insert into sync_ops(id,story_id,type,payload,client_version,status) values(${globalThis.crypto.randomUUID()},${request.gameId},'project_migration',${JSON.stringify({sourceProjectId:request.projectId,destinationProjectId:request.destinationProjectId,sharedIds:imported.itemIds,typeIds:imported.typeIds,expectedSnapshot})}::jsonb,${Number(story.server_version)},'applied')`);
    await enqueueStoryVaultSyncJob({storyId:request.gameId,serverVersion:Number(story.server_version)+1,reason:'project-migration'},tx);
    return {...summary,moved:true,sharedIds:imported.itemIds};
  }); } catch(error){const {cleanupImportedImageAssets}=await import('./imageAssets');await cleanupImportedImageAssets(createdAssetKeys);throw error;}
}
