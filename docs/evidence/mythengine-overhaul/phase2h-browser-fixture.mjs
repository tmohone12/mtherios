import fs from 'node:fs';import assert from 'node:assert/strict';
import postgres from 'file:///E:/DEV/Projects/MythEngine/node_modules/postgres/src/index.js';
import {resolveRuntimeOptions} from 'file:///E:/DEV/Projects/MythEngine/scripts/runtime-config.mjs';
const stage='C:/Users/Raijin/AppData/Local/Temp/mythengine-phase2h',file=stage+'/browser-fixture.json';const config=resolveRuntimeOptions([],{cwd:'E:/DEV/Projects/MythEngine'});assert.equal(new URL(config.databaseUrl).port,'5433');const sql=postgres(config.databaseUrl,{max:1,prepare:false});
async function cmd(command,args){const r=await(await fetch('http://127.0.0.1:5174/api/engine/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storyId:'__app__',command,args})})).json();assert.equal(r.status,'succeeded',r.error);return r.result;}
try{
 if(process.argv.includes('--create')){
  assert.ok(!fs.existsSync(file));const projectId=(await cmd('shelf.create',{name:'Phase 2 browser source'})).shelfId;fs.writeFileSync(file,JSON.stringify({projectId}));
  const destinationProjectId=(await cmd('shelf.create',{name:'Phase 2 browser destination'})).shelfId;fs.writeFileSync(file,JSON.stringify({projectId,destinationProjectId}));
  const gameId=(await cmd('story.create',{shelfId:projectId,title:'Phase 2 browser game'})).storyId,scope={projectId,gameId};
  const npc=await cmd('content.canonical.create',{...scope,kind:'characters',fields:{name:'Browser schema NPC',metadata:{keep:'Preserve this'},state:{bio:'Retain biography'}}});
  const type=(await cmd('content.types.save',{projectId,key:'notes',extension:'note',name:'Notes',definition:{fields:{text:{kind:'text'},link:{kind:'reference'}},defaults:{text:''},layout:[],gmContextMode:'searchable'}})).type;
  const shared=(await cmd('content.write',{projectId,typeId:type.id,expectedTypeRevision:1,title:'Shared travel rule',folder:'Rules',slug:'travel',data:{text:'Shared travel rule'}})).item;
  const extra=(await cmd('content.write',{projectId,typeId:type.id,expectedTypeRevision:1,title:'Optional lore',folder:'Lore',slug:'optional',data:{text:'Optional lore'}})).item;
  const doc=(await cmd('content.write',{...scope,typeId:type.id,expectedTypeRevision:1,title:'Game guide',folder:'Guide',slug:'guide',data:{text:'Guide',link:{itemId:shared.id}}})).item;
  fs.writeFileSync(file,JSON.stringify({...scope,destinationProjectId,npcId:npc.record.id,docId:doc.id,sharedId:shared.id,extraId:extra.id}));console.log('Browser fixture ready');
 }else{
  const f=JSON.parse(fs.readFileSync(file,'utf8'));
  if(process.argv.includes('--cleanup')){for(const id of [f.projectId,f.destinationProjectId])if(id)await sql`delete from shelves where id=${id}`;fs.renameSync(file,file+'.completed');console.log('Browser projects removed');}
  else if(process.argv.includes('--schema')){const [npc]=await sql`select metadata,state from entities where id=${f.npcId}`;assert.equal(npc.metadata.contentFields.health,12);assert.equal(npc.metadata.keep,'Preserve this');assert.equal(npc.state.bio,'Retain biography');console.log('Saved UI schema and migrated defaults verified');}
  else{const [game]=await sql`select shelf_id from stories where id=${f.gameId}`;assert.equal(game.shelf_id,f.destinationProjectId);const [npc]=await sql`select metadata from entities where id=${f.npcId}`;assert.deepEqual(npc.metadata.contentFields,{health:18,note:'UI verified'});assert.equal(npc.metadata.keep,'Preserve this');const [doc]=await sql`select project_id,data from content_items where id=${f.docId}`;assert.equal(doc.project_id,f.destinationProjectId);assert.notEqual(doc.data.link.itemId,f.sharedId);const copies=await sql`select title from content_items where project_id=${f.destinationProjectId} and game_id is null order by title`;assert.deepEqual(copies.map(r=>r.title),['Optional lore','Shared travel rule']);console.log('Saved UI field values, game move and selected dependency copies verified');}
 }
}finally{await sql.end({timeout:1});}
