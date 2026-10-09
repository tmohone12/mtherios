import fs from 'node:fs';import assert from 'node:assert/strict';
import postgres from 'file:///E:/DEV/Projects/MythEngine/node_modules/postgres/src/index.js';
import {resolveRuntimeOptions} from 'file:///E:/DEV/Projects/MythEngine/scripts/runtime-config.mjs';
const file='C:/Users/Raijin/AppData/Local/Temp/mythengine-phase2g/browser-fixture.json';
const config=resolveRuntimeOptions([],{cwd:'E:/DEV/Projects/MythEngine'});assert.equal(new URL(config.databaseUrl).port,'5433');
const sql=postgres(config.databaseUrl,{max:1,prepare:false});
async function cmd(command,args){const r=await(await fetch('http://127.0.0.1:5174/api/engine/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storyId:'__app__',command,args})})).json();assert.equal(r.status,'succeeded',r.error);return r.result;}
try{
if(process.argv.includes('--create')){
  assert.ok(!fs.existsSync(file));const projectId=(await cmd('shelf.create',{name:'Folder recovery browser'})).shelfId;fs.writeFileSync(file,JSON.stringify({projectId}));
  const gameId=(await cmd('story.create',{shelfId:projectId,title:'Disposable recovery browser'})).storyId,scope={projectId,gameId};
  const type=(await cmd('content.types.save',{projectId,key:'guides',extension:'guide',name:'Guide',definition:{fields:{text:{kind:'text'}},defaults:{text:''},layout:[],gmContextMode:'searchable'}})).type;
  const item=(await cmd('content.write',{...scope,typeId:type.id,expectedTypeRevision:1,title:'Recovery guide',folder:'Guide/Docs',slug:'guide',data:{text:'Recover this document safely.'}})).item;
  const npc=await cmd('content.canonical.create',{...scope,kind:'characters',fields:{name:'Recovery NPC',state:{bio:'Canon survives the archive'}},metadata:{folder:'Guide/Cast'}});
  await cmd('content.folders.create',{...scope,path:'Guide/Empty'});fs.writeFileSync(file,JSON.stringify({...scope,itemId:item.id,canonicalId:npc.envelope.id}));console.log('Disposable fixture ready');
}else{
 const fixture=JSON.parse(fs.readFileSync(file,'utf8'));
 if(process.argv.includes('--cleanup')){await sql`delete from shelves where id=${fixture.projectId}`;fs.renameSync(file,file+'.completed');console.log('Only recorded browser fixture removed');}
 else{const archived=process.argv.includes('--archived');assert.equal(Boolean((await sql`select deleted_at from content_items where id=${fixture.itemId}`)[0].deleted_at),archived);assert.equal((await sql`select hidden from canonical_content where id=${fixture.canonicalId}`)[0].hidden,archived);const folders=await cmd('content.folders.list',fixture.gameId?{projectId:fixture.projectId,gameId:fixture.gameId}:{projectId:fixture.projectId});assert.equal(folders.activePaths.includes('Guide/Empty'),!archived);console.log(archived?'Saved archive verified':'Saved recovery verified');}
}
}finally{await sql.end({timeout:1});}
