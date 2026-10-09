import fs from 'node:fs';import assert from 'node:assert/strict';
import postgres from 'file:///E:/DEV/Projects/MythEngine/node_modules/postgres/src/index.js';
import {resolveRuntimeOptions} from 'file:///E:/DEV/Projects/MythEngine/scripts/runtime-config.mjs';
const root='E:/DEV/Projects/MythEngine',stage=process.env.TEMP+'/mythengine-phase3',config=resolveRuntimeOptions([],{cwd:root});assert.equal(new URL(config.databaseUrl).port,'5433');assert.equal(config.port,5174);
const sql=postgres(config.databaseUrl,{max:1,prepare:false});let projectId='',trigger=false;const protectedStory='story_4c39f4c1-cd13-4488-a481-1dde5690df89';async function protectedHashes(){const rows={};for(const table of ['stories','story_entries','story_events','story_threads']){const [value]=await sql.unsafe(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) hash from ${table} t where ${table==='stories'?'id':'story_id'}=$1`,[protectedStory]);rows[table]=value.hash;}return rows;}const proof={recordedAt:new Date().toISOString(),checks:[],before:await sql`select id,server_version,current_world_time from stories order by id`,protectedBefore:await protectedHashes()};
async function cmd(command,args={},storyId='__app__',ok=true){const response=await fetch('http://127.0.0.1:5174/api/engine/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storyId,command,args})});const value=await response.json();if(ok)assert.equal(value.status,'succeeded',value.error);return ok?value.result:value;}
function pass(label){proof.checks.push(label);console.log('PASS '+label);}
try{
  projectId=(await cmd('shelf.create',{name:'Disposable Phase 3 history'})).shelfId;
  const gameId=(await cmd('story.create',{shelfId:projectId,title:'Disposable Phase 3 game'})).storyId,scope={projectId,gameId};
  const definition={fields:{text:{kind:'text'}},defaults:{text:''},layout:[{title:'Content',fields:['text']}],gmContextMode:'searchable'};
  let type=(await cmd('content.types.save',{projectId,key:'notes',extension:'note',name:'Notes',definition})).type;
  let item=(await cmd('content.write',{...scope,typeId:type.id,expectedTypeRevision:type.revision,title:'First title',description:'',folder:'',slug:'first',data:{text:'first'},visibility:'gm',gmContextMode:null})).item;
  item=(await cmd('content.update',{...scope,id:item.id,expectedRevision:item.revision,expectedTypeRevision:type.revision,changes:{title:'Second title',data:{text:'second'}}})).item;
  const history=(await cmd('content.history',{...scope,targetKind:'item',id:item.id,limit:1}));assert.equal(history.revisions[0].revision,2);assert.equal(history.nextBeforeRevision,2);assert.equal((await cmd('content.history',{...scope,targetKind:'item',id:item.id,beforeRevision:2})).revisions[0].revision,1);
  let review=await cmd('content.history.previewRestore',{...scope,targetKind:'item',id:item.id,targetRevision:1,expectedRevision:2});assert.equal(review.compatible,true);assert.ok(review.changes.some(r=>r.field==='data'));
  assert.equal((await cmd('content.history.restore',{...scope,targetKind:'item',id:item.id,targetRevision:1,expectedRevision:2,expectedSnapshot:review.expectedSnapshot},'__app__',false)).errorDetails.code,'CONFIRMATION_REQUIRED');
  item=(await cmd('content.history.restore',{...scope,targetKind:'item',id:item.id,targetRevision:1,expectedRevision:2,expectedSnapshot:review.expectedSnapshot,confirmed:true})).item;assert.equal(item.revision,3);assert.equal(item.title,'First title');assert.equal((await cmd('content.history',{...scope,targetKind:'item',id:item.id})).revisions.length,3);pass('Document history paginates, shows concrete differences, requires confirmation and appends a restore revision');
  const stale=await cmd('content.history.previewRestore',{...scope,targetKind:'item',id:item.id,targetRevision:2,expectedRevision:3});item=(await cmd('content.update',{...scope,id:item.id,expectedRevision:3,expectedTypeRevision:type.revision,changes:{title:'Human later edit'}})).item;
  assert.equal((await cmd('content.history.restore',{...scope,targetKind:'item',id:item.id,targetRevision:2,expectedRevision:3,expectedSnapshot:stale.expectedSnapshot,confirmed:true},'__app__',false)).errorDetails.code,'REVISION_CONFLICT');assert.equal((await cmd('content.read',{...scope,ids:[item.id]})).items[0].title,'Human later edit');pass('A stale reviewed restore cannot overwrite a later human edit');
  type=(await cmd('content.types.save',{projectId,id:type.id,expectedRevision:1,key:'notes',extension:'note',name:'Notes',definition:{...definition,fields:{...definition.fields,tag:{kind:'text'}},layout:[{title:'Content',fields:['text','tag']}]}})).type;
  item=(await cmd('content.write',{...scope,id:item.id,typeId:type.id,expectedRevision:item.revision,expectedTypeRevision:type.revision,title:item.title,description:item.description,folder:item.folder,slug:item.slug,data:{text:'first',tag:'new'},visibility:'gm',gmContextMode:null})).item;
  review=await cmd('content.history.previewRestore',{projectId,targetKind:'type',id:type.id,targetRevision:1,expectedRevision:2});assert.equal(review.compatible,false);assert.ok(review.conflicts.some(s=>s.includes('Unknown field')));
  item=(await cmd('content.write',{...scope,id:item.id,typeId:type.id,expectedRevision:item.revision,expectedTypeRevision:type.revision,title:item.title,description:item.description,folder:item.folder,slug:item.slug,data:{text:'first'},visibility:'gm',gmContextMode:null})).item;
  review=await cmd('content.history.previewRestore',{projectId,targetKind:'type',id:type.id,targetRevision:1,expectedRevision:2});assert.equal(review.compatible,true);assert.equal(review.affectedDocuments,1);
  type=(await cmd('content.history.restore',{projectId,targetKind:'type',id:type.id,targetRevision:1,expectedRevision:2,expectedSnapshot:review.expectedSnapshot,confirmed:true})).type;assert.equal(type.revision,3);assert.equal(Object.hasOwn(type.definition.fields,'tag'),false);
  const clear={projectId,id:type.id,expectedRevision:3,key:'notes',extension:'note',name:'Notes',definition:{...definition,layout:[]}};
  const clearReview=await cmd('content.types.preview',clear);assert.equal(clearReview.requiresClearConfirmation,true);assert.equal((await cmd('content.types.save',clear,'__app__',false)).errorDetails.code,'CONFIRMATION_REQUIRED');
  type=(await cmd('content.types.save',{...clear,expectedSnapshot:clearReview.expectedSnapshot,confirmedClear:true})).type;assert.equal(type.revision,4);assert.equal(type.definition.layout.length,0);pass('Type restore reports incompatible documents, accepts a corrected schema, retains history and confirms layout clear');
  const canonical=await cmd('content.canonicalTypes.read',{projectId,kind:'characters'});assert.equal(canonical.revision,0);
  const canonicalDef={...canonical.definition,fields:{health:{kind:'number'}},defaults:{health:10}};
  const canonicalReview=await cmd('content.canonicalTypes.preview',{projectId,kind:'characters',expectedRevision:0,definition:canonicalDef});
  await cmd('content.canonicalTypes.save',{projectId,kind:'characters',expectedRevision:0,definition:canonicalDef,expectedSnapshot:canonicalReview.expectedSnapshot});
  let npc=await cmd('content.canonical.create',{...scope,kind:'characters',fields:{name:'Ana',metadata:{contentFields:{health:12}}}});
  npc=await cmd('content.canonical.edit',{...scope,kind:'characters',id:npc.record.id,expected:npc.revision,updates:{name:'Ana two'}});
  const canonicalHistory=(await cmd('content.canonical.history',{...scope,kind:'characters',id:npc.record.id})).revisions;assert.ok(canonicalHistory.length>=2);
  const firstName=canonicalHistory.find(r=>r.snapshot.record.name==='Ana');assert.ok(firstName);
  let canonicalRestore=await cmd('content.canonical.previewRestore',{...scope,kind:'characters',id:npc.record.id,targetRevision:firstName.revision,expected:npc.revision});assert.equal(canonicalRestore.compatible,true);
  npc=(await cmd('content.canonical.restore',{...scope,kind:'characters',id:npc.record.id,targetRevision:firstName.revision,expected:npc.revision,expectedSnapshot:canonicalRestore.expectedSnapshot,confirmed:true})).restored;assert.equal(npc.record.name,'Ana');assert.ok(npc.revision.metadataRevision>firstName.revision);
  let typeReview=await cmd('content.canonicalTypes.previewRestore',{projectId,kind:'characters',targetRevision:0,expectedRevision:1});assert.equal(typeReview.compatible,false);
  npc=await cmd('content.canonical.edit',{...scope,kind:'characters',id:npc.record.id,expected:npc.revision,updates:{contentFields:{}}});
  typeReview=await cmd('content.canonicalTypes.previewRestore',{projectId,kind:'characters',targetRevision:0,expectedRevision:1});assert.equal(typeReview.compatible,true);
  const restoredType=await cmd('content.canonicalTypes.restore',{projectId,kind:'characters',targetRevision:0,expectedRevision:1,expectedSnapshot:typeReview.expectedSnapshot,confirmed:true});assert.equal(restoredType.revision,2);
  pass('Canonical record and built-in type restores honor domain/schema validation and append revisions');
  let beforeFailure=(await cmd('content.read',{...scope,ids:[item.id]})).items[0],beforeCount=(await sql`select count(*)::int n from content_revisions where target_id=${item.id}`)[0].n;
  await sql.unsafe(`create function phase3_fail_history() returns trigger language plpgsql as $$ begin if NEW.target_id=TG_ARGV[0] then raise exception 'Temporary Phase 3 history failure'; end if; return NEW; end $$`);
  await sql.unsafe(`create trigger phase3_history_failure before insert on content_revisions for each row execute function phase3_fail_history('${item.id.replaceAll("'","''")}')`);trigger=true;
  assert.equal((await cmd('content.update',{...scope,id:item.id,expectedRevision:item.revision,expectedTypeRevision:type.revision,changes:{title:'Should roll back'}},'__app__',false)).status,'failed');
  assert.equal((await cmd('content.read',{...scope,ids:[item.id]})).items[0].title,beforeFailure.title);assert.equal((await sql`select count(*)::int n from content_revisions where target_id=${item.id}`)[0].n,beforeCount);pass('A failed history insert rolls back the document update and revision together');
}finally{
 if(trigger){await sql.unsafe('drop trigger if exists phase3_history_failure on content_revisions');await sql.unsafe('drop function if exists phase3_fail_history()');}
 if(projectId)await sql`delete from shelves where id=${projectId}`;
 assert.deepEqual(await sql`select id,server_version,current_world_time from stories order by id`,proof.before);
 proof.protectedAfter=await protectedHashes();assert.deepEqual(proof.protectedAfter,proof.protectedBefore);
 await sql.end({timeout:1});
}
proof.fixturesRemoved=true;proof.runtime=await(await fetch('http://127.0.0.1:5174/api/app/status')).json();fs.writeFileSync(stage+'/live-proof.json',JSON.stringify(proof,null,2)+'\n');
