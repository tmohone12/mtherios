import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import postgres,{type Sql} from 'postgres';import {randomUUID} from 'node:crypto';
import type {RequestEvent} from '@sveltejs/kit';
import {planSummaryRecovery,RECOVERY_ROUTE,RECOVERY_LIMITS,RECOVERY_PROVIDER} from '$lib/server/jobs/summaryRecovery';
const mocks=vi.hoisted(()=>({client:vi.fn(),config:vi.fn(),service:vi.fn(),key:vi.fn()}));
vi.mock('$lib/server/db/client',()=>({getSqlClient:mocks.client}));
vi.mock('$lib/server/app/config',()=>({getMtheriosAppConfig:mocks.config}));
vi.mock('$lib/server/engine/llmSettings',()=>({resolveServiceGeneration:mocks.service,resolveApiKeyRef:mocks.key}));
import {GET,POST} from './+server';
const url=process.env.RECOVERY_TEST_DATABASE_URL,tests=url?describe:describe.skip;let db:Sql;
beforeAll(()=>{if(!url)return;const u=new URL(url);if(u.hostname!=='127.0.0.1'||u.port!=='5433'||!/^\/mythengine_summary_repair_recovery_\d+$/.test(u.pathname))throw Error('Disposable DB required');db=postgres(url,{max:2,prepare:false,onnotice:()=>{}});mocks.client.mockReturnValue(db);});
afterAll(async()=>{if(db)await db.end();vi.unstubAllGlobals();});
beforeEach(()=>{vi.clearAllMocks();mocks.client.mockReturnValue(db);mocks.key.mockReturnValue('fixture-not-a-key');vi.stubGlobal('fetch',()=>{throw Error('Network forbidden');});});
async function fixture(){const sid='runner_route_'+randomUUID();await db`insert into stories(id,title) values(${sid},'Route fixture')`;
 for(let i=0;i<20;i++){await db`insert into story_entries(id,story_id,type,content,position) values(${sid+'_p'+i},${sid},'user_action','Ask envoy',${i*2+1})`;
  await db`insert into story_entries(id,story_id,type,content,position,parent_id) values(${sid+'_n'+i},${sid},'narration','The envoy reports a rumor.',${i*2+2},${sid+'_p'+i})`;}
 return sid;}
const event=(body:unknown)=>({request:new Request('http://localhost/api/app/chapters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}) as RequestEvent;
const approval=()=>({confirmed:true,model:RECOVERY_ROUTE.model,endpoint:RECOVERY_ROUTE.endpoint,afterPosition:-1,maxChapters:1,totalUsd:RECOVERY_LIMITS.usd,minIntervalMinutes:60,expiresAt:new Date(Date.now()+7*86400000).toISOString()});
const catalog=()=>({canonicalId:RECOVERY_ROUTE.model,supportsProviderSelection:true,providers:[{provider:RECOVERY_ROUTE.endpoint,available:true,quantization:'fp8',effectivePricing:{currency:'USD',unit:'per_1k_tokens',is_fresh:true},pricing:{inputPer1kTokens:0.000147,outputPer1kTokens:0.000294}}]});
tests('chapter-only public route with actual mocked transport',()=>{
 it('GET/status and a disabled tick cannot resolve credentials or dispatch, and forged routes are rejected',async()=>{
  const sid=await fixture();mocks.config.mockReturnValue({chapterRunnerEnabled:false,chapterRunnerStoryId:sid});
  const status=await GET({url:new URL(`http://localhost/api/app/chapters?storyId=${sid}`)} as RequestEvent);expect((await status.json()).enabled).toBe(false);
  await POST(event({action:'tick',storyId:sid}));expect(mocks.service).not.toHaveBeenCalled();expect(mocks.key).not.toHaveBeenCalled();
  const invalid=await POST(event({action:'enable',storyId:sid,approval:{...approval(),model:'different/model'}}));expect(invalid.status).toBe(400);
  expect((await db`select story_id from chapter_summary_runners where story_id=${sid}`)).toHaveLength(0);
 });
 it('enable then daemon tick retains approved routing even when general memory uses another provider',async()=>{
  const sid=await fixture(),m=await planSummaryRecovery(db,sid,'chapter');mocks.config.mockReturnValue({chapterRunnerEnabled:true,chapterRunnerStoryId:sid});
  mocks.service.mockResolvedValue({profile:{providerType:'openrouter',baseUrl:'https://openrouter.ai/api/v1',apiKey:'fixture-other-key'},generation:{model:'google/gemini-3.8-flash'}});
  const requests:Record<string,unknown>[]=[],fetch=vi.fn(async(url:unknown,init?:RequestInit)=>{
   if(String(url).includes('?detailed='))return new Response(JSON.stringify({data:[{id:RECOVERY_ROUTE.model}]})); if(String(url).endsWith('/providers'))return new Response(JSON.stringify(catalog()));
   expect(String(url)).toBe('https://api.nano-gpt.com/api/v1/chat/completions');const body=JSON.parse(String(init?.body));requests.push(body);
   const text=JSON.stringify({accounts:m.sources.map(s=>({sourceId:s.id,evidenceRefs:Object.keys(s.evidence).map((_,i)=>`r${i}.0`)}))});
   const response=new Response(JSON.stringify({id:'mocked-completion-id',model:RECOVERY_ROUTE.model,choices:[{message:{content:text},finish_reason:'stop'}],...(body.include_usage===true?{usage:{prompt_tokens:1000,completion_tokens:500,total_tokens:1500,cost:0.00028}}:{})}),{headers:{'Content-Type':'application/json','x-request-id':'mocked-chapter-request'}});
   const readJson=response.json.bind(response);response.json=async()=>{
    const [run]=await db`select document from summary_recovery_runs where story_id=${sid}`;
    expect(run.document.attempts[0].responseHeaders).toMatchObject({billingRequestId:'mocked-chapter-request',statusCode:200});
    expect(run.document.attempts[0].receipt).toBeUndefined();return readJson();
   };return response;
  });vi.stubGlobal('fetch',fetch);
  expect((await POST(event({action:'enable',storyId:sid,approval:approval()}))).status).toBe(200);expect(fetch).not.toHaveBeenCalled();
  const result=await POST(event({action:'tick',storyId:sid})),status=await result.json();expect(result.status).toBe(200);expect(status.completedChapters).toBe(1);expect(status.enabled).toBe(false);
  expect(mocks.service).not.toHaveBeenCalled();expect(mocks.key).toHaveBeenCalledWith('env:NANOGPT_API_KEY');expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({model:RECOVERY_ROUTE.model,max_tokens:12000,include_usage:true,provider:RECOVERY_PROVIDER});
  const [run]=await db`select document from summary_recovery_runs where story_id=${sid}`;expect(run.document.attempts[0].receipt.usage.providerCostUsd).toBe(0.00028);
  expect(run.document.attempts[0].receipt).toMatchObject({billingRequestId:'mocked-chapter-request',providerRequestId:'mocked-chapter-request',completionId:'mocked-completion-id'});
  expect((await db`select server_version from chapters where story_id=${sid}`)[0].server_version).toBe(2);
  await POST(event({action:'tick',storyId:sid}));expect(requests).toHaveLength(1);
 });
 it('durably retains billing headers when the response body fails, and holds without replay',async()=>{
  const sid=await fixture();mocks.config.mockReturnValue({chapterRunnerEnabled:true,chapterRunnerStoryId:sid});
  mocks.service.mockResolvedValue({profile:{providerType:'nanogpt',baseUrl:'https://nano-gpt.com/api/v1',apiKey:'fixture-not-a-key'},generation:{model:RECOVERY_ROUTE.model}});
  let inference=0;const fetch=vi.fn(async(url:unknown)=>{
   if(String(url).includes('?detailed='))return new Response(JSON.stringify({data:[{id:RECOVERY_ROUTE.model}]})); if(String(url).endsWith('/providers'))return new Response(JSON.stringify(catalog()));inference++;
   return new Response(new ReadableStream({start(controller){controller.error(Error('Fixture body disconnected'));}}),{status:200,headers:{'x-request-id':'billing-before-disconnect'}});
  });vi.stubGlobal('fetch',fetch);
  await POST(event({action:'enable',storyId:sid,approval:approval()}));
  const status=await(await POST(event({action:'tick',storyId:sid}))).json();expect(status.phase).toBe('held');expect(status.enabled).toBe(false);
  const [run]=await db`select document from summary_recovery_runs where story_id=${sid}`;
  expect(run.document.attempts[0]).toMatchObject({status:'blocked',responseHeaders:{billingRequestId:'billing-before-disconnect',statusCode:200},receipt:{billingRequestId:'billing-before-disconnect',completionId:null,status:'error'}});
  await POST(event({action:'tick',storyId:sid}));expect(inference).toBe(1);
  expect((await db`select id from chapters where story_id=${sid}`)).toHaveLength(0);
 });
 it('missing approved NanoGPT credential holds without falling back to another service',async()=>{
  const sid=await fixture();mocks.config.mockReturnValue({chapterRunnerEnabled:true,chapterRunnerStoryId:sid});mocks.key.mockReturnValue('');
  const fetch=vi.fn(async(url:unknown)=>new Response(JSON.stringify(String(url).includes('?detailed=')?{data:[{id:RECOVERY_ROUTE.model}]}:catalog())));vi.stubGlobal('fetch',fetch);
  await POST(event({action:'enable',storyId:sid,approval:approval()}));const s=await(await POST(event({action:'tick',storyId:sid}))).json();expect(s.phase).toBe('held');expect(s.message).toContain('Pinned NanoGPT chapter connection');expect(s.reservedCalls).toBe(0);expect(fetch).toHaveBeenCalledTimes(2);expect(mocks.service).not.toHaveBeenCalled();
 });
});
