import {afterEach,describe,expect,it,vi} from 'vitest';
import {generateServerTextWithMetrics,ServerGenerationError,type ServerGenerationAttempt,type ServerGenerationOptions,type ServerGenerationResponseHeaders} from './provider';

afterEach(()=>vi.unstubAllGlobals());
const options:ServerGenerationOptions={profile:{providerType:'nanogpt',baseUrl:'https://nano-gpt.com/api/v1',apiKey:'fixture-only',customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]},model:'xiaomi/mimo-v2.6-flash',system:'Fixture',prompt:'Fixture',maxRetries:0};
describe('NanoGPT usage and billing correlation',()=>{
 it.each(['plain','json','schema','tools'] as const)('explicitly requests usage for non-streaming %s output',async mode=>{
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
   const body=JSON.parse(String(init?.body));expect(body.include_usage).toBe(true);expect(body.stream).toBeUndefined();
   return new Response(JSON.stringify({id:'completion',choices:[{message:{content:'{}'},finish_reason:'stop'}],...(body.include_usage?{usage:{prompt_tokens:8,completion_tokens:2,cost:0.0001}}:{})}));
  });vi.stubGlobal('fetch',fetch);
  const result=await generateServerTextWithMetrics({...options,...(mode==='json'?{responseFormat:'json_object' as const,onTextDelta:()=>undefined}:mode==='schema'?{responseSchema:{name:'fixture',schema:{type:'object'}}}:mode==='tools'?{tools:[{name:'read',description:'Read fixture',parameters:{type:'object'}}]}:{})});
  expect(result.usage).toMatchObject({inputTokens:8,outputTokens:2,providerCostUsd:0.0001});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('keeps other non-streaming providers free of the NanoGPT extension',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{expect(JSON.parse(String(init?.body))).not.toHaveProperty('include_usage');return new Response(JSON.stringify({choices:[{message:{content:'Done'}}]}));}));
  await generateServerTextWithMetrics({...options,profile:{...options.profile,providerType:'openai',baseUrl:'https://api.openai.com/v1'}});
 });
 it.each([200,503])('retains distinct header and completion IDs after HTTP %s',async status=>{
  const headers:ServerGenerationResponseHeaders[]=[],receipts:ServerGenerationAttempt[]=[];
  vi.stubGlobal('fetch',vi.fn(async()=>{
   const response=new Response(JSON.stringify({id:'body-completion',choices:[{message:{content:'Done'},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:2,cost:0.0001}}),{status,headers:{'x-request-id':'header-billing'}});
   for(const name of ['json','text'] as const){const read=response[name].bind(response);response[name]=async()=>{expect(headers).toHaveLength(1);return read();};}
   return response;
  }));
  const result=await generateServerTextWithMetrics({...options,onResponseHeaders:r=>{headers.push(r);},onAttempt:r=>{receipts.push(r);}}).catch(error=>error);
  expect(headers[0]).toMatchObject({billingRequestId:'header-billing',statusCode:status});
  expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({providerRequestId:'header-billing',billingRequestId:'header-billing',completionId:'body-completion'});
  expect(headers[0].attemptId).toBe(receipts[0].attemptId);expect(headers[0].requestHash).toBe(receipts[0].requestHash);
  expect(JSON.stringify(headers)).not.toContain('fixture-only');expect(fetch).toHaveBeenCalledTimes(1);
  if(status!==200)expect(result).toBeInstanceOf(ServerGenerationError);
 });
 it('never substitutes a completion ID for a missing billing header',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({id:'body-only',choices:[{message:{content:'Done'}}]}))));
  const result=await generateServerTextWithMetrics(options);
  expect(result.attempts).toMatchObject([{billingRequestId:null,completionId:'body-only',providerRequestId:'body-only'}]);
 });
 it('keeps billing identity through a stream body failure without buying another call',async()=>{
  let reads=0;const encoder=new TextEncoder(),headers:ServerGenerationResponseHeaders[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init?:RequestInit)=>{
   const body=JSON.parse(String(init?.body));expect(body).toMatchObject({stream:true,stream_options:{include_usage:true}});expect(body).not.toHaveProperty('include_usage');
   return new Response(new ReadableStream({pull(controller){if(reads++===0)controller.enqueue(encoder.encode('data: '+JSON.stringify({id:'stream-completion',choices:[{delta:{content:'Partial'}}],usage:{prompt_tokens:8,completion_tokens:2,cost:0.0001}})+'\n\n'));else controller.error(Error('Fixture stream disconnected'));}}),{headers:{'x-request-id':'stream-billing'}});
  }));
  const error=await generateServerTextWithMetrics({...options,maxRetries:1,onTextDelta:()=>undefined,onResponseHeaders:r=>{headers.push(r);}}).catch(error=>error);
  expect(headers).toHaveLength(1);expect(error.result.attempts).toMatchObject([{billingRequestId:'stream-billing',completionId:'stream-completion',providerRequestId:'stream-billing',responseChars:7,status:'error',usage:{providerCostUsd:0.0001}}]);
  expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('does not read the body or retry when durable header persistence fails',async()=>{
  const read=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>{const response=new Response('{}',{status:503,headers:{'x-request-id':'retain-on-failure'}});response.text=read;response.json=read;return response;}));
  const error=await generateServerTextWithMetrics({...options,maxRetries:1,onResponseHeaders:()=>{throw Error('Fixture database unavailable');}}).catch(error=>error);
  expect(error).toBeInstanceOf(ServerGenerationError);expect(error.message).toContain('response headers could not be persisted');
  expect(error.result.attempts).toMatchObject([{billingRequestId:'retain-on-failure',completionId:null,statusCode:503,status:'error'}]);
  expect(read).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1);
 });
});
