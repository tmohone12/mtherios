import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,afterAll,expect,test,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {getDb,closeDb} from '$lib/server/db/client';
import {ChatgptSessions,browserOwnerContext,scopeKey,ownerHash} from '$lib/server/chatgpt/session';
import type {ChatgptRecords} from '$lib/server/chatgpt/storage';
let sessions:ChatgptSessions;
const profile={id:'fixture-nano',name:'Fixture NanoGPT',providerType:'nanogpt',apiKey:'FAKE FIXTURE KEY',baseUrl:'https://nano-gpt.com/api/v1',customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]};
vi.mock('./llmSettings',async()=>({...await vi.importActual<typeof import('./llmSettings')>('./llmSettings'),resolveServiceGeneration:async()=>({profile,generation:{model:'fixture-nano-model',maxTokens:4096},systemPromptOverride:null,setting:null}),requireResolvedServiceProfile:()=>profile}));
vi.mock('./agentSettings',async()=>{const real=await vi.importActual<typeof import('./agentSettings')>('./agentSettings');return {...real,getAgentSettings:async(input:unknown)=>{const settings=await real.getAgentSettings(input);return {...settings,effective:{...settings.effective,assistantPiRuntime:true}};}};});
vi.mock('$lib/server/chatgpt/owner',()=>({chatgptSessions:()=>sessions,currentChatgptBinding:(p:string,g:string)=>sessions.binding(browserOwnerContext.getStore(),p,g),assertCurrentChatgptBinding:async(e:Record<string,unknown>)=>{const actual=await sessions.binding(browserOwnerContext.getStore(),String(e.projectId),String(e.gameId));if(!actual||Object.entries(e).some(([k,v])=>actual[k as keyof typeof actual]!==v))throw Error('ChatGPT binding changed');},assertChatgptConversationAccess:async(c:Record<string,unknown>)=>{if(c.chatgpt_owner_hash){const b=await sessions.binding(browserOwnerContext.getStore(),String(c.project_id),String(c.game_id));if(c.chatgpt_owner_hash!==browserOwnerContext.getStore()||b?.accountKey!==c.chatgpt_account_key)throw Error('Conversation account scope denied');}}}));
import {POST as commandRoute} from '../../../routes/api/engine/command/+server';
import {GET as statusRoute,POST as sessionRoute} from '../../../routes/api/chatgpt/session/+server';
const integration=process.env.MYTHENGINE_ASSISTANT_STORY_INTEGRATION==='1'?test:test.skip;
const cookie='A'.repeat(43),owner=ownerHash(cookie);
let projectId:string,gameId:string,other:string,records:ChatgptRecords,calls:Array<{url:string;model:string;keys:string[];tools:unknown}>,mode:string;
function event(path:string,body?:unknown,options:{ownerCookie?:boolean;csrf?:boolean}={}){const url=new URL(path,'http://127.0.0.1:5190');return {url,request:new Request(url,{method:body?'POST':'GET',headers:{Origin:url.origin,'Content-Type':'application/json',...(options.csrf===false?{}:{'X-MythEngine-CSRF':sessions.csrfToken(owner)})},...(body?{body:JSON.stringify(body)}:{})}),getClientAddress:()=> '127.0.0.1',cookies:{get:()=>options.ownerCookie===false?undefined:cookie,set:()=>{}}} as never;}
const command=async(name:string,args:Record<string,unknown>,options={})=>{const response=await commandRoute(event('/api/engine/command',{storyId:gameId,command:name,args},options));return {response,body:await response.json()};};
const status=async()=>{const response=await statusRoute(event('/api/chatgpt/session?'+new URLSearchParams({projectId,gameId})));return response.json();};
const select=async(accountKey:string|null='account-a',model='fixture-plan-a')=>{const response=await sessionRoute(event('/api/chatgpt/session',{projectId,gameId,action:'select',accountKey,model}));expect(response.status).toBe(200);return response.json();};
beforeEach(async()=>{
 if(process.env.MYTHENGINE_ASSISTANT_STORY_INTEGRATION!=='1')return;
 if(!['/mythengine_identity_candidate_20261006','/mythengine_summary_repair_recovery_20261006_aggregate'].includes(new URL(process.env.DATABASE_URL!).pathname))throw Error('Disposable fixture required');
 vi.stubEnv('MYTHENGINE_TEST_LOCAL_ONLY','false');
 const id=randomUUID();projectId='routing_fixture_'+id;gameId='routing_story_'+id;other='routing_other_'+id;calls=[];mode='text';
 await getDb().execute(sql`insert into shelves(id,name,slug) values(${projectId},'Routing fixture',${projectId})`);await getDb().execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Routing story'),(${other},${projectId},'Other fixture')`);
 records={version:1,accounts:['a','b'].map(suffix=>({key:'account-'+suffix,owner,clientId:'client-'+suffix,subject:'subject-'+suffix,email:suffix+'@example.invalid',epoch:1,accessToken:'FAKE PLAN '+suffix,scopes:['chatgpt.tokens.use.direct'],expiresAt:Date.now()+3600000,savedAt:Date.now(),state:'connected' as const})),selections:{}};
 const mockFetch=async(url:string,init?:RequestInit)=>{
  if(url==='https://api.openai.com/v1/models')return Response.json({models:[{slug:(init?.headers as Record<string,string>).Authorization.endsWith('a')?'fixture-plan-a':'fixture-plan-b',display_name:'Fixture plan',visibility:'list'}]});
  const body=JSON.parse(String(init?.body));calls.push({url,model:body.model,keys:Object.keys(body),tools:body.tools});
  if(url==='https://nano-gpt.com/api/v1/chat/completions')return new Response(JSON.stringify({error:{message:'insufficient USD balance',balanceReason:'base_request',baseModelCoveredBySubscription:false}}),{status:402});
  expect(url).toBe('https://api.openai.com/v1/responses');
  if(mode==='http-error')return new Response(JSON.stringify({error:{message:'fixture unavailable',code:'model_not_found'}}),{status:404});
  if(mode==='network-error')throw Error('Mock network unavailable');
  if(mode==='switch-during-call'){delete records.selections[scopeKey(owner,projectId,gameId)];}
  const output=mode==='tool'&&calls.length===1?[{type:'function_call',namespace:'mythengine',name:'storyContent',call_id:'fixture-list',arguments:JSON.stringify({action:'list',kind:'characters'})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixture ChatGPT answer.'}]}];
  return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output,usage:{input_tokens:20,output_tokens:10,total_tokens:30}}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
 };
 vi.stubGlobal('fetch',mockFetch);
 sessions=new ChatgptSessions({store:{supported:true,read:async()=>structuredClone(records),change:async work=>work(records)},fetch:mockFetch});
});
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();if(process.env.MYTHENGINE_ASSISTANT_STORY_INTEGRATION==='1')await getDb().execute(sql`delete from shelves where id=${projectId}`);});afterAll(async()=>{if(process.env.MYTHENGINE_ASSISTANT_STORY_INTEGRATION==='1')await closeDb();});
const send=async(connection:unknown,conversationId?:string)=>{
 if(!conversationId){const created=await command('assistant.conversation.create',{projectId,gameId,connection});expect(created.body.status,JSON.stringify(created.body)).toBe('succeeded');conversationId=created.body.result.conversation.id;}
 return command('assistant.message.send',{projectId,gameId,conversationId,connection,clientMessageId:'routing_message_'+randomUUID(),content:'Describe the fixture story.'});
};
integration('real session select → real command route → Pi → public Responses, including tool continuation and reload/new conversations',async()=>{
 const before=await status();expect(before.connection).toMatchObject({kind:'configured',provider:'nanogpt'});expect(before.selection).toBeNull();
 const active=await select();expect(active.connection).toMatchObject({kind:'chatgpt',model:'fixture-plan-a'});
 for(const value of ['text','tool','text']){mode=value;calls=[];const refreshed=await status(),sent=await send(refreshed.connection);expect(sent.body.result.run.status,JSON.stringify(sent.body)).toBe('completed');expect(calls.length).toBe(value==='tool'?2:1);expect(calls.every(c=>c.url==='https://api.openai.com/v1/responses'&&c.model==='fixture-plan-a')).toBe(true);expect(sent.body.result.run.requestReceipts).toEqual(expect.arrayContaining([expect.objectContaining({connectionKind:'chatgpt',provider:'ChatGPT plan',endpoint:'https://api.openai.com/v1/responses'})]));}
});
integration('configured sends require explicit matching intent and retain raw sanitized 402 evidence with unknown cost',async()=>{
 const chosen=(await status()).connection;const sent=await send(chosen);expect(calls).toEqual([expect.objectContaining({url:'https://nano-gpt.com/api/v1/chat/completions',model:'fixture-nano-model'})]);
 const run=sent.body.result.run;expect(run.status).toBe('failed');expect(run.error).toContain('402');expect(run.error).toContain('balanceReason');expect(run.usage.totalTokens).toBeNull();expect(run.usage.providerCostUsd).toBeNull();expect(run.requestReceipts[0]).toMatchObject({status:'failed',connectionKind:'configured',provider:'nanogpt',error:{httpStatus:402}});
});
integration.each(['missing-intent','missing-cookie','missing-csrf','removed-selection','other-story','changed-model','changed-account','expired','consent-missing','revoked'])('fails closed before inference: %s',async scenario=>{
 const chosen=(await select()).connection;
 if(scenario==='removed-selection')delete records.selections[scopeKey(owner,projectId,gameId)];
 if(scenario==='changed-model')records.selections[scopeKey(owner,projectId,gameId)].model='other';
 if(scenario==='changed-account')records.selections[scopeKey(owner,projectId,gameId)]={accountKey:'account-b',model:'fixture-plan-b'};
 if(scenario==='expired')records.accounts[0].expiresAt=0;
 if(scenario==='consent-missing')records.accounts[0].scopes=[];
 if(scenario==='revoked')records.accounts[0].state='revoked';
 const connection=scenario==='missing-intent'?undefined:scenario==='other-story'?{...chosen,gameId:other}:chosen;
 const created=await command('assistant.conversation.create',{projectId,gameId,connection},{ownerCookie:scenario!=='missing-cookie',csrf:scenario!=='missing-csrf'});
 if(created.body.status==='succeeded'){const result=await send(connection,created.body.result.conversation.id);expect(result.body.status==='failed'||result.body.result?.run?.status==='failed'||!result.response.ok).toBe(true);}else expect(created.response.ok&&created.body.status==='succeeded').toBe(false);
 expect(calls).toEqual([]);
});
integration.each(['http-error','network-error','switch-during-call'])('ChatGPT %s never retries NanoGPT',async scenario=>{const chosen=(await select()).connection;mode=scenario;const result=await send(chosen);expect(result.body.status==='failed'||result.body.result?.run?.status==='failed'||!result.response.ok).toBe(true);expect(calls).toHaveLength(1);expect(calls[0].url).toBe('https://api.openai.com/v1/responses');});
integration('saved configured Pi run cannot resume after choosing ChatGPT',async()=>{
 const configured=(await status()).connection,sent=await send(configured),runId=sent.body.result.run.id,conversationId=sent.body.result.conversation.id;
 await getDb().execute(sql`update assistant_runs set status='running',lease_until=now()-interval '1 minute' where id=${runId}`);
 const chosen=(await select()).connection;calls=[];const resumed=await command('assistant.run.resume',{projectId,gameId,conversationId,runId,connection:chosen});expect(resumed.body.status==='failed'||!resumed.response.ok).toBe(true);expect(calls).toEqual([]);
});
integration('same-account interrupted ChatGPT run resumes on its saved public Responses model',async()=>{
 const chosen=(await select()).connection;mode='http-error';const failed=await send(chosen);const {id:runId}=failed.body.result.run,conversationId=failed.body.result.conversation.id;
 // Fixture-only conversion to the checkpoint of an interrupted request. Real failed runs remain terminal.
 await getDb().execute(sql`update assistant_runs set status='running',lease_until=now()-interval '1 minute',result=result #- '{runtime,budget,stopReason}' where id=${runId}`);
 calls=[];mode='text';const resumed=await command('assistant.run.resume',{projectId,gameId,conversationId,runId,connection:(await status()).connection});expect(resumed.body.result.run.status,JSON.stringify(resumed.body)).toBe('completed');expect(calls).toEqual([expect.objectContaining({url:'https://api.openai.com/v1/responses',model:'fixture-plan-a'})]);
});
integration('account switch routes a new conversation to B and denies A history without configured fallback',async()=>{
 const a=(await select()).connection,first=await send(a),conversationId=first.body.result.conversation.id;
 const b=(await select('account-b','fixture-plan-b')).connection;calls=[];
 const denied=await command('assistant.conversation.read',{projectId,gameId,conversationId});expect(denied.body.status==='failed'||!denied.response.ok).toBe(true);
 const next=await send(b);expect(next.body.result.run.status).toBe('completed');expect(calls).toEqual([expect.objectContaining({url:'https://api.openai.com/v1/responses',model:'fixture-plan-b'})]);
});
integration('old configured UI intent cannot dispatch after ChatGPT activation',async()=>{
 const previous=(await status()).connection;await select();const rejected=await command('assistant.conversation.create',{projectId,gameId,connection:previous});expect(rejected.body.status==='failed'||!rejected.response.ok).toBe(true);expect(calls).toEqual([]);
});
integration('selecting another story does not inherit ChatGPT or expose previous story history',async()=>{
 const selected=(await select()).connection,first=await send(selected),conversationId=first.body.result.conversation.id;
 const foreign=await command('assistant.conversation.read',{projectId,gameId:other,conversationId});expect(foreign.body.status==='failed'||!foreign.response.ok).toBe(true);
 const response=await statusRoute(event('/api/chatgpt/session?'+new URLSearchParams({projectId,gameId:other})));expect((await response.json()).connection).toMatchObject({kind:'configured',gameId:other});
});
