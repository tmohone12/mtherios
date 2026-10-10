import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {handoffFixture} from '$lib/server/factions/fixtures/handoffQualification';
import {syntheticPiDecision} from './fixtures/piRoleplay';
import {runPiRoleplayPrototype,PrototypeTurnLedger,PI_PROTOTYPE_LIMITS,type JsonObject} from '../../../../experiments/pi-roleplay/src/runtime';
import {scriptedStream,syntheticModel,type ScriptStep} from '../../../../experiments/pi-roleplay/src/scriptedStream';
import {mythPrototypeAdapters} from '../../../../experiments/pi-roleplay/src/adapters';
import {probePiOpenRouter} from '../../../../experiments/pi-roleplay/src/providerProbe';
const action='I ask Maera what relief she has in mind. I have accepted nothing.';
const narration='Maera offers a discussion of relief. "You can tell us what help you actually want," she says, smiling. She waits for your answer.';
const call=(id:string,name:string,args:JsonObject)=>({type:'toolCall' as const,id,name,arguments:args});
const text=(value:string)=>({type:'text' as const,text:value});
const draft={kind:'proposal',quote:'Maera offers a discussion of relief.',basisIds:['known_response'],updateJson:JSON.stringify({conversations:[{npcName:'Maera',topicSummary:'Offered relief discussion; no agreement.'}]})};
function setup(steps:ScriptStep[]){
 const f=handoffFixture();
 const attempt=syntheticPiDecision(f.prior);
 (f.ctx.story.metadata as any).factionWorkflow.attempts=[attempt];
 const adapted=mythPrototypeAdapters({ctx:f.ctx,actorId:f.actor,playerId:'player_elian',packet:f.packet,attempt,playerAction:action});
 const script=scriptedStream(steps),ledger=new PrototypeTurnLedger(),chunks:string[]=[];
 const run=(extra:Partial<Parameters<typeof runPiRoleplayPrototype>[0]>={})=>runPiRoleplayPrototype({enabled:true,turnId:'pi_turn',playerAction:action,snapshot:adapted.snapshot,model:syntheticModel,streamFn:script.streamFn,adapters:adapted.adapters,ledger,onNarration:chunk=>{chunks.push(chunk);},...extra});
 return {f,adapted,script,ledger,chunks,run};
}
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No network or inference authorized in Pi tests.');}));});
afterEach(()=>vi.unstubAllGlobals());
test('real Pi completes bounded sourced tools, validated draft, streamed prose and yields without writing canon',async()=>{
 const t=setup([{content:[text('PRIVATE_INTERMEDIATE_TOOL_PLANNING'),call('lore','lookup_lore',{query:'courtyard'}),call('npc','npc_knowledge',{actorId:'maera'}),call('decision','read_decision',{actorId:'maera'})]},
  {content:[call('draft','propose_world_change',draft)]},{content:[text(narration)]}]);
 const before=JSON.stringify(t.f.ctx),result=await t.run();
 expect(result).toMatchObject({status:'yielded',reason:null,narration,canonWrites:0,modelRequests:3,toolRequests:4,toolExecutions:4});
 expect(result.proposals).toEqual([expect.objectContaining({status:'validated_draft',canonical:false,basisIds:['known_response']})]);
 expect(t.chunks.join('')).toBe(narration);expect(t.chunks.length).toBeGreaterThan(1);expect(t.chunks.join('')).not.toContain('PRIVATE_INTERMEDIATE');
 expect(result.eventTypes).toEqual(expect.arrayContaining(['agent_start','message_update','tool_execution_end','turn_end','agent_end']));
 const context=JSON.stringify(t.script.contexts);
 expect(context).toContain(t.f.claim);expect(context).toContain('league_relief_talk');expect(context).toContain('outcomeEstablished');
 for(const secret of ['PRIVATE_RIVAL_PLAN','UNSHARED_MEMBER_SECRET','FORECAST_NOT_CANON'])expect(context).not.toContain(secret);
 expect(JSON.stringify(t.f.ctx)).toBe(before);expect(globalThis.fetch).not.toHaveBeenCalled();
});
test('Pi context preserves existing history before the dynamic cue and handles a later material canonical snapshot',async()=>{
 const t=setup([{content:[text(narration)]}]);await t.run();
 const first=(t.script.contexts[0] as any).messages;
 const history=first.findIndex((message:any)=>JSON.stringify(message.content).includes('Maera invited Rowan'));
 const tail=first.findIndex((message:any)=>JSON.stringify(message.content).includes('GM ONLY'));
 expect(history).toBeGreaterThan(0);expect(tail).toBeGreaterThan(history);expect(JSON.stringify(first[0])).not.toContain('GM ONLY');
 const updated=structuredClone(t.adapted.snapshot);updated.version++;updated.dynamicTail+='\nNew canonical observation: Rowan requested bandages; no consent to grain.';
 const second=scriptedStream([{content:[text('Maera acknowledges the request and waits.')]}]);
 const result=await t.run({turnId:'pi_turn_2',snapshot:updated,streamFn:second.streamFn});
 expect(result.status).toBe('yielded');expect(JSON.stringify(second.contexts)).toContain('Rowan requested bandages');expect(second.calls).toBe(1);
});
test.each(['rival','player_elian'])('NPC tool denies out-of-scope actor %s before adapter access',async actorId=>{
 const t=setup([{content:[call('scope','npc_knowledge',{actorId})]}]);const read=vi.spyOn(t.adapted.adapters,'npcKnowledge');
 const result=await t.run();expect(result.status).toBe('held');expect(read).not.toHaveBeenCalled();expect(result.modelRequests).toBe(1);expect(t.chunks).toEqual([]);
});
test('public GM lore does not become NPC learned knowledge',async()=>{
 const t=setup([{content:[call('lore','lookup_lore',{query:'customs'}),call('npc','npc_knowledge',{actorId:'maera'})]},{content:[text(narration)]}]);
 t.f.ctx.entities.find(row=>row.id===t.f.location)!.state={current:true,customs:'PUBLIC_COURTYARD_CUSTOM_NOT_LEARNED'};
 await t.run();const transcript=(t.script.contexts[1] as any).messages;
 const lore=transcript.find((m:any)=>m.role==='toolResult'&&m.toolName==='lookup_lore');
 const npc=transcript.find((m:any)=>m.role==='toolResult'&&m.toolName==='npc_knowledge');
 expect(JSON.stringify(lore)).toContain('PUBLIC_COURTYARD_CUSTOM_NOT_LEARNED');expect(JSON.stringify(npc)).not.toContain('PUBLIC_COURTYARD_CUSTOM_NOT_LEARNED');
});
test('explicit player yield terminates mixed tool batch and waits without accepting or simulating an answer',async()=>{
 const t=setup([{content:[call('read','npc_knowledge',{actorId:'maera'}),call('ask','yield_to_player',{question:'Would you like to discuss relief?'}),call('after','lookup_lore',{query:'after yield'})]}]);
 const lore=vi.spyOn(t.adapted.adapters,'lore'),result=await t.run();
 expect(result).toMatchObject({status:'awaiting_player',question:'Would you like to discuss relief?',canonWrites:0,modelRequests:1});expect(lore).not.toHaveBeenCalled();expect(result.proposals).toEqual([]);
});
test('same call ID and args reuse evidence once; conflicting call identity holds',async()=>{
 const same=call('repeat','npc_knowledge',{actorId:'maera'});
 const t=setup([{content:[same,same]},{content:[text(narration)]}]);const read=vi.spyOn(t.adapted.adapters,'npcKnowledge');
 const result=await t.run();expect(result.status).toBe('yielded');expect(read).toHaveBeenCalledTimes(1);expect(result.receipts[1].replayed).toBe(true);
 const conflict=setup([{content:[same,call('repeat','lookup_lore',{query:'courtyard'})]}]);expect((await conflict.run()).reason).toBe('tool_call_identity_conflict');
});
test('duplicate concurrent/repeated client turn shares one result; changed identity is rejected',async()=>{
 const t=setup([{content:[text(narration)]}]);const [a,b]=await Promise.all([t.run(),t.run()]);expect(a).toBe(b);expect(await t.run()).toBe(a);expect(t.script.calls).toBe(1);
 await expect(t.run({playerAction:'I leave instead.'})).rejects.toThrow('client_turn_identity_conflict');
});
test.each(['invented_basis','resource_write','new_knowledge','missing_quote'])('world-change draft %s cannot become accepted canon',async mode=>{
 const proposed={...draft};if(mode==='invented_basis')proposed.basisIds=['private_unknown'];
 if(mode==='resource_write')proposed.updateJson=JSON.stringify({meter_changes:[{name:'grain',delta:-10}]});
 if(mode==='new_knowledge')proposed.updateJson=JSON.stringify({conversations:[{npcName:'Maera',topicSummary:'Learned rival plan',npcLearned:['PRIVATE_RIVAL_PLAN']}]});
 if(mode==='missing_quote')proposed.quote='A delivery was actually completed.';
 const t=setup([{content:[call('read','npc_knowledge',{actorId:'maera'})]},{content:[call('draft','propose_world_change',proposed)]},{content:[text(narration)]}]);
 const result=await t.run();expect(result.status).toBe('held');expect(result.proposals).toEqual([]);expect(result.canonWrites).toBe(0);expect(t.chunks).toEqual([]);
});
test('arbitrary shell/filesystem tool names are not exposed or executable',async()=>{
 const t=setup([{content:[call('unsafe','bash',{command:'ignored'})]}]);const result=await t.run();
 expect(result.status).toBe('held');expect(result.toolExecutions).toBe(0);expect(JSON.stringify(t.script.contexts)).not.toContain('"name":"bash"');
});
test('schema-invalid tool arguments hold without invoking adapter',async()=>{
 const t=setup([{content:[call('bad','npc_knowledge',{actorId:'maera',includeSecrets:true})]}]);const read=vi.spyOn(t.adapted.adapters,'npcKnowledge');
 expect((await t.run()).status).toBe('held');expect(read).not.toHaveBeenCalled();
});
test('tool and model bounds stop the loop without fallback extra requests',async()=>{
 const many=setup([{content:Array.from({length:PI_PROTOTYPE_LIMITS.toolCalls+1},(_,i)=>call('read'+i,'npc_knowledge',{actorId:'maera'}))}]);
 expect((await many.run()).toolExecutions).toBe(0);expect(many.script.calls).toBe(1);
 const loop=setup(Array.from({length:4},(_,i)=>({content:[call('read'+i,'npc_knowledge',{actorId:'maera'})]})));
 const result=await loop.run();expect(result).toMatchObject({status:'held',reason:'model_turn_bound',modelRequests:3});expect(loop.script.calls).toBe(3);
});
test.each(['error','length'] as const)('provider %s holds staged changes and never retries',async stopReason=>{
 const t=setup([{content:[text('Partial narration.')],stopReason}]);const result=await t.run();
 expect(result.status).toBe('held');expect(result.modelRequests).toBe(1);expect(result.proposals).toEqual([]);expect(t.chunks).toEqual([]);
});
test('failed read holds and does not expose private exception text',async()=>{
 const t=setup([{content:[call('read','lookup_lore',{query:'courtyard'})]}]);t.adapted.adapters.lore=async()=>{throw Error('PRIVATE_DATABASE_ERROR');};
 const result=await t.run();expect(result.status).toBe('held');expect(JSON.stringify(result.transcript)).not.toContain('PRIVATE_DATABASE_ERROR');expect(result.modelRequests).toBe(1);
});
test('cancellation and deadline settle real Pi without canonical side effects',async()=>{
 const controller=new AbortController(),t=setup([{content:[],waitForAbort:true}]);
 const pending=t.run({signal:controller.signal});await vi.waitFor(()=>expect(t.script.calls).toBe(1));controller.abort();
 expect(await pending).toMatchObject({status:'cancelled',canonWrites:0,modelRequests:1});expect(t.chunks).toEqual([]);
 const deadline=setup([{content:[],waitForAbort:true}]);expect(await deadline.run({timeoutMs:5})).toMatchObject({status:'held',reason:'deadline_exceeded',canonWrites:0});
});
test('pre-aborted and non-opted-in runs make no model request',async()=>{
 const t=setup([{content:[text(narration)]}]);await expect(t.run({enabled:false})).rejects.toThrow('opt-in');
 const abort=new AbortController();abort.abort();expect((await t.run({signal:abort.signal})).status).toBe('cancelled');expect(t.script.calls).toBe(0);
});
test('pinned Pi OpenRouter serializer is inspected before HTTP, without treating its classifier as the existing Jev protocol',async()=>{
 const t=setup([]),base={system:t.adapted.snapshot.system,history:t.adapted.snapshot.history,tail:t.adapted.snapshot.dynamicTail};
 const high=await probePiOpenRouter({...base,thinking:'high'}),low=await probePiOpenRouter({...base,thinking:'low'}),off=await probePiOpenRouter({...base,thinking:'off'});
 expect(high.payload).toBeDefined();expect(low.payload).toBeDefined();
 expect(high.stopReason).toBe('error');expect(globalThis.fetch).not.toHaveBeenCalled();
 const body=high.payload as any;expect(body.model).toBe('z-ai/glm-5.3-flash');expect(body.stream).toBe(true);
 const stable=await probePiOpenRouter({...base,tail:base.tail+'\nMaterial scene change.',thinking:'high'});
 expect((stable.payload as any).messages.slice(0,-1)).toEqual(body.messages.slice(0,-1));
 expect((low.payload as any).reasoning?.effort).toBe('low');
 expect((off.payload as any).reasoning).toBeUndefined();
});
test('cancellation while a slow adapter runs settles and discards its later result',async()=>{
 const controller=new AbortController(),t=setup([{content:[call('slow','npc_knowledge',{actorId:'maera'})]}]);
 let release!:()=>void;let started=false;
 t.adapted.adapters.npcKnowledge=async()=>{started=true;await new Promise<void>(resolve=>{release=resolve;});return {data:'LATE_IGNORED_RESULT',sourceIds:['late']};};
 const pending=t.run({signal:controller.signal});await vi.waitFor(()=>expect(started).toBe(true));controller.abort();
 const result=await pending;expect(result.status).toBe('cancelled');expect(result.receipts).toEqual([]);release();await Promise.resolve();expect(t.chunks).toEqual([]);
});
test('deadline settles even when the injected provider ignores abort; late work has no writer',async()=>{
 const t=setup([{content:[],waitForAbort:true}]);
 const result=await t.run({timeoutMs:5,streamFn:(model,context,options)=>t.script.streamFn(model,context,{...options,signal:undefined})});
 expect(result).toMatchObject({status:'held',reason:'deadline_exceeded',canonWrites:0});expect(t.script.calls).toBe(1);
});
test('oversized tool results and oversized response context hold before follow-up or presentation',async()=>{
 const t=setup([{content:[call('big','lookup_lore',{query:'courtyard'})]}]);t.adapted.adapters.lore=async()=>({data:'X'.repeat(PI_PROTOTYPE_LIMITS.toolResultBytes),sourceIds:['big']});
 expect((await t.run()).status).toBe('held');expect(t.script.calls).toBe(1);expect(t.chunks).toEqual([]);
 const large=setup([{content:[text('X'.repeat(PI_PROTOTYPE_LIMITS.outputBytes))]}]);expect((await large.run()).status).toBe('held');expect(large.chunks).toEqual([]);
 const bad=setup([]);await expect(bad.run({snapshot:{...bad.adapted.snapshot,dynamicTail:'X'.repeat(PI_PROTOTYPE_LIMITS.contextBytes)}})).rejects.toThrow('Prepared context exceeds');expect(bad.script.calls).toBe(0);
});
