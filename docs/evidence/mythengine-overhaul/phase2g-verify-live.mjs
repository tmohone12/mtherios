import fs from 'node:fs';import assert from 'node:assert/strict';
import postgres from 'file:///E:/DEV/Projects/MythEngine/node_modules/postgres/src/index.js';
import {resolveRuntimeOptions} from 'file:///E:/DEV/Projects/MythEngine/scripts/runtime-config.mjs';
const root='E:/DEV/Projects/MythEngine',stage='C:/Users/Raijin/AppData/Local/Temp/mythengine-phase2g';
const config=resolveRuntimeOptions([],{cwd:root});assert.equal(new URL(config.databaseUrl).port,'5433');assert.equal(config.port,5174);
const sql=postgres(config.databaseUrl,{max:1,prepare:false}),projects=[];let trigger=false;
async function cmd(command,args={},ok=true){const r=await(await fetch('http://127.0.0.1:5174/api/engine/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,args,storyId:'__app__'})})).json();if(ok)assert.equal(r.status,'succeeded',r.error);return ok?r.result:r;}
const proof={recordedAt:new Date().toISOString(),checks:[],existingStories:await sql`select id,server_version from stories order by id`};const pass=s=>{proof.checks.push(s);console.log('PASS '+s);};
try{
  const projectId=(await cmd('shelf.create',{name:'Disposable folder archive'})).shelfId;projects.push(projectId);
  const gameId=(await cmd('story.create',{shelfId:projectId,title:'Disposable recovery game'})).storyId,scope={projectId,gameId},request={...scope,path:'Source'};
  await cmd('content.folders.create',{...scope,path:'Source/Empty'});
  const type=(await cmd('content.types.save',{projectId,key:'notes',extension:'note',name:'Notes',definition:{fields:{notes:{kind:'text'},links:{kind:'array',items:{kind:'reference'}}},defaults:{notes:''},layout:[],gmContextMode:'searchable'}})).type;
  const make=async(slug,args={})=>(await cmd('content.write',{...scope,typeId:type.id,expectedTypeRevision:type.revision,title:slug,folder:'Source/Docs',slug,data:{notes:slug},...args})).item;
  const a=await make('first'),b=await make('second'),old=await make('old'),outside=await make('outside',{folder:'Outside'}),shared=await make('shared',{gameId:undefined});
  await cmd('content.update',{...scope,id:a.id,expectedRevision:1,expectedTypeRevision:1,changes:{data:{links:[{itemId:b.id},{itemId:a.id}]}}});
  await cmd('content.update',{...scope,id:b.id,expectedRevision:1,expectedTypeRevision:1,changes:{data:{links:[{itemId:a.id}]}}});
  await cmd('content.organize',{...scope,id:old.id,expectedRevision:1,expectedTypeRevision:1,operation:'archive'});
  const npc=await cmd('content.canonical.create',{...scope,kind:'characters',fields:{name:'Archive NPC',state:{bio:'Keep canon'}},metadata:{folder:'Source/Cast'}});
  const hidden=await cmd('content.canonical.create',{...scope,kind:'characters',fields:{name:'Already hidden'},metadata:{folder:'Source/Cast',hidden:true}});
  const canonBefore=await sql`select * from entities where story_id=${gameId} order by id`,version=(await sql`select server_version from stories where id=${gameId}`)[0].server_version;
  const originalOld=(await sql`select * from content_items where id=${old.id}`)[0];
  const preview=await cmd('content.folders.previewArchive',request);assert.deepEqual(preview.counts,{folders:2,documents:2,canonical:1});assert.equal((await sql`select deleted_at from content_items where id=${a.id}`)[0].deleted_at,null);pass('Archive preview is read-only, scoped and excludes old archives and hidden canonical entries');
  await cmd('content.update',{...scope,id:outside.id,expectedRevision:1,expectedTypeRevision:1,changes:{data:{links:[{itemId:a.id}]}}});
  assert.equal((await cmd('content.folders.archive',{...request,expectedSnapshot:preview.expectedSnapshot},false)).errorDetails.code,'REFERENCE_CONFLICT');
  await cmd('content.update',{...scope,id:outside.id,expectedRevision:2,expectedTypeRevision:1,changes:{data:{links:[]}}});pass('Outside incoming references block even a previously reviewed archive');
  await cmd('content.folders.create',{...scope,path:'Source/New'});assert.equal((await cmd('content.folders.archive',{...request,expectedSnapshot:preview.expectedSnapshot},false)).errorDetails.code,'REVISION_CONFLICT');
  const fresh=await cmd('content.folders.previewArchive',request);
  const before=await sql`select * from content_items where project_id=${projectId} order by id`;
  await sql.unsafe(`create function phase2g_fail_history() returns trigger language plpgsql as $$ begin if NEW.project_id=TG_ARGV[0] and NEW.reason='Archive subtree recovery receipt' then raise exception 'Temporary archive history failure'; end if; return NEW; end $$`);
  await sql.unsafe(`create trigger phase2g_history_failure before insert on content_revisions for each row execute function phase2g_fail_history('${projectId.replaceAll("'","''")}')`);trigger=true;
  assert.equal((await cmd('content.folders.archive',{...request,expectedSnapshot:fresh.expectedSnapshot},false)).status,'failed');
  assert.deepEqual(await sql`select * from content_items where project_id=${projectId} order by id`,before);assert.equal((await sql`select hidden from canonical_content where id=${npc.envelope.id}`)[0].hidden,false);assert.equal((await sql`select count(*)::int n from content_folders where project_id=${projectId} and archived_at is not null`)[0].n,0);
  await sql.unsafe('drop trigger phase2g_history_failure on content_revisions');await sql.unsafe('drop function phase2g_fail_history()');trigger=false;pass('Stale previews fail and a late receipt-history failure rolls the entire archive back');
  await cmd('content.folders.archive',{...request,expectedSnapshot:fresh.expectedSnapshot});
  assert.ok((await sql`select deleted_at from content_items where id=${a.id}`)[0].deleted_at);assert.deepEqual((await sql`select * from content_items where id=${old.id}`)[0],originalOld);assert.equal((await sql`select hidden from canonical_content where id=${npc.envelope.id}`)[0].hidden,true);assert.equal((await sql`select deleted_at from content_items where id=${shared.id}`)[0].deleted_at,null);
  assert.deepEqual(await sql`select * from entities where story_id=${gameId} order by id`,canonBefore);assert.equal((await sql`select server_version from stories where id=${gameId}`)[0].server_version,version);
  assert.ok(!(await cmd('content.folders.list',scope)).activePaths.includes('Source'));assert.equal((await cmd('content.folders.previewCopy',{...scope,from:'Source',to:'Copy'},false)).errorDetails.code,'CONTENT_ARCHIVED');pass('Archive preserves canon, game version, shared content and old archives; tree hides archived paths');
  const bundle=await cmd('content.export',scope);assert.ok(bundle.folders.find(f=>f.path==='Source').archived);
  const dest=(await cmd('shelf.create',{name:'Disposable archive import'})).shelfId;projects.push(dest);const destGame=(await cmd('story.create',{shelfId:dest,title:'Archive import'})).storyId;
  await cmd('content.import',{projectId:dest,gameId:destGame,bundle});const imported=await cmd('content.folders.previewRestore',{projectId:dest,gameId:destGame,path:'Source'});assert.equal(imported.importedRecovery,true);assert.equal(imported.counts.documents,0);assert.equal((await sql`select count(*)::int n from content_items where project_id=${dest} and deleted_at is not null`)[0].n,3);pass('Export/import preserves archive flags and explicitly limits imported recovery to folder paths');
  const restore=await cmd('content.folders.previewRestore',request);assert.deepEqual(restore.counts,{folders:3,documents:2,canonical:1});
  await cmd('content.folders.restore',{...request,expectedSnapshot:restore.expectedSnapshot});assert.equal((await sql`select deleted_at from content_items where id=${a.id}`)[0].deleted_at,null);assert.equal((await sql`select hidden from canonical_content where id=${npc.envelope.id}`)[0].hidden,false);assert.equal((await sql`select hidden from canonical_content where id=${hidden.envelope.id}`)[0].hidden,true);assert.deepEqual((await sql`select * from content_items where id=${old.id}`)[0],originalOld);pass('Recovery restores cycles, empty folders and only records changed by its archive');
  const p2=await cmd('content.folders.previewArchive',request);await cmd('content.folders.archive',{...request,expectedSnapshot:p2.expectedSnapshot});
  const beforeEdit=await cmd('content.folders.previewRestore',request);const current=await cmd('content.canonical',{...scope,kind:'characters',id:npc.record.id});await cmd('content.canonical.edit',{...scope,kind:'characters',id:npc.record.id,expected:current.revision,metadata:{folder:'Elsewhere'}});
  assert.equal((await cmd('content.folders.restore',{...request,expectedSnapshot:beforeEdit.expectedSnapshot},false)).errorDetails.code,'REVISION_CONFLICT');const p3=await cmd('content.folders.previewRestore',request);assert.equal(p3.skipped.length,1);assert.equal(p3.skipped[0].id,npc.envelope.id);
  const collision=await make('first');assert.equal((await cmd('content.folders.previewRestore',request,false)).errorDetails.code,'CONTENT_EXISTS');await cmd('content.organize',{...scope,id:collision.id,expectedRevision:1,expectedTypeRevision:1,operation:'archive'});
  const p4=await cmd('content.folders.previewRestore',request);await cmd('content.folders.restore',{...request,expectedSnapshot:p4.expectedSnapshot});const afterEdit=await cmd('content.canonical',{...scope,kind:'characters',id:npc.record.id});assert.equal(afterEdit.envelope.folder,'Elsewhere');assert.equal(afterEdit.envelope.hidden,true);pass('Later edits survive recovery, changed previews fail and active path collisions block without partial recovery');
  const concurrentPreview=await cmd('content.folders.previewArchive',request);const race=await Promise.all([1,2].map(()=>cmd('content.folders.archive',{...request,expectedSnapshot:concurrentPreview.expectedSnapshot},false)));assert.equal(race.filter(r=>r.status==='succeeded').length,1);assert.equal(race.filter(r=>r.status==='failed').length,1);pass('Concurrent archive submissions apply exactly once');
}finally{
  if(trigger){await sql.unsafe('drop trigger if exists phase2g_history_failure on content_revisions');await sql.unsafe('drop function if exists phase2g_fail_history()');}
  for(const projectId of projects)await sql`delete from shelves where id=${projectId}`;
  assert.deepEqual(await sql`select id,server_version from stories order by id`,proof.existingStories);await sql.end({timeout:1});
}
proof.fixturesRemoved=true;proof.runtime=await(await fetch('http://127.0.0.1:5174/api/app/status')).json();proof.originalPid=(await(await fetch('http://127.0.0.1:5173/api/app/status')).json()).runtime.pid;
fs.mkdirSync(stage+'/files/docs/evidence/mythengine-overhaul',{recursive:true});fs.writeFileSync(stage+'/files/docs/evidence/mythengine-overhaul/phase2g-live-verification.json',JSON.stringify(proof,null,2)+'\n');
