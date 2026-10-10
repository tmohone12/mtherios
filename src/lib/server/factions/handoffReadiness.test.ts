import fs from 'node:fs';
import {afterEach,expect,test,vi} from 'vitest';
import {runHandoffQualification,handoffFixture,handoffCaps,handoffMarkers,type HandoffProfiles} from './fixtures/handoffQualification';
import {generateServerTextWithMetrics} from '$lib/server/turn/provider';
import {buildServerTurnPrompt} from '$lib/server/turn/promptPacket';

const profile=(providerType:string,baseUrl:string)=>({providerType,baseUrl,apiKey:'synthetic-readiness-key',customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]});
const profiles:HandoffProfiles={background:{profile:profile('nanogpt','https://nano-gpt.com/api/v1'),model:'z-ai/glm-5.3',reasoningEffort:'high'},decision:{profile:profile('openrouter','https://openrouter.ai/api/v1'),model:'typesafe/jev-1.13'},gm:{profile:profile('openrouter','https://openrouter.ai/api/v1'),model:'z-ai/glm-5.3-flash'}};
let old:string|undefined;
afterEach(()=>{vi.unstubAllGlobals();if(old===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=old;});
function response(content:string,reasoning=100){return Response.json({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:500,completion_tokens:reasoning+60,completion_tokens_details:{reasoning_tokens:reasoning}}});}
test.each(['accepted','abstained','invalid_basis'])('actual serialized planner/Jev/gardener/GM handoff holds canon and secrets (%s)',async mode=>{
 old=process.env.MYTHENGINE_TEST_LOCAL_ONLY;process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';
 let stage='';const calls:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{
  const body=JSON.parse(init.body);calls.push({stage,url,body,bytes:Buffer.byteLength(init.body,'utf8')+512});
  expect(init.body).not.toMatch(/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/);
  if(stage.startsWith('planner')){
   expect(url).toBe('https://nano-gpt.com/api/v1/chat/completions');expect(body.max_tokens).toBe(1600);expect(body.reasoning_effort).toBe('high');expect(body.response_format).toEqual({type:'json_object'});
   expect(calls.at(-1).bytes).toBeLessThanOrEqual(handoffCaps.backgroundInputBytes);
   const packet=JSON.parse(body.messages.at(-1).content),source=packet.evidence[0].id;
   expect(body.messages[0].content).toContain('"options"');expect(body.messages[0].content).toContain('"enum":'+JSON.stringify(packet.sourceIds));
   if(stage==='planner_after_material'){expect(packet.evidence.some((row:any)=>row.id==='known_request_day3'&&row.claim.includes('request five grain'))).toBe(true);if(mode==='accepted')expect(packet.actor.currentPlan.id).toBe('relief_offer');}
   return response(JSON.stringify({options:[{id:'relief_offer',action:'Offer a relief discussion; ask consent before moving grain.',motive:'Return kindness without imposing an obligation.',manner:'Warm and lightly humorous.',family:'aid',basis:[mode==='invalid_basis'?'Paraphrased evidence':source],costs:[],limits:['Consent is required.'],opposition:'Rowan may refuse.',earliestWorldTime:'Day 2'}]}));
  }
  if(stage.startsWith('decision')){
   expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
   return Response.json({model:'typesafe/jev-1.13-test',answers:{selection:{type:'choice',choice:'relief_offer',confidence:mode==='abstained'?.4:.9,probabilities:{wait:.02,investigate:.03,relief_offer:.95}}}});
  }
  if(stage==='gardener'){
   expect(body.messages[0].content).toContain('No faction orders');const input=JSON.parse(body.messages.at(-1).content);
   expect(init.body).not.toContain(handoffMarkers.privateMotive);
   return response(JSON.stringify({forecasts:[{id:'conditional_relief',if:'Rowan accepts an offer',unless:'Either side withdraws',development:handoffMarkers.futureMarker+': relief may ease pressure.',earliest:'Day 3',evidence:[input.unresolved[0].id],uncertainty:'Consent and transit remain unresolved.',invalidateWhen:'The offer is declined.'}]}));
  }
  expect(stage).toBe('gm');expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(body.max_tokens).toBe(8192);expect(body.reasoning).toEqual({effort:'low'});
  expect(calls.at(-1).bytes).toBeLessThanOrEqual(handoffCaps.gmInputBytes);
  const latest=body.messages.at(-1).content,stable=JSON.stringify(body.messages[0]);
  expect(latest).toContain('Current turn context');expect(latest).toContain('does not settle');expect(latest).toContain('GM ONLY');expect(latest).toContain('Private motive (do not automatically voice)');
  expect(latest).toContain('Relief grain=30 available (40 held; 10 reserved)');expect(latest).toContain('Do not invent vehicles');expect(stable).toContain('Elian');
  expect(stable).not.toContain(mode==='accepted'?'Offer a relief discussion; ask consent before moving grain.':handoffMarkers.privateMotive);
  expect(init.body).not.toContain(handoffMarkers.futureMarker);
  expect(JSON.stringify(body.messages.slice(1,-1))).toContain('decline supper because he is tending the wounded');
  return response('Maera rests a hand on the table. "We could talk about what would help. No grain moves until you agree." She leaves room for your answer.',1800);
 }));
 const result=await runHandoffQualification(profiles,value=>stage=value);
 expect(calls.length).toBe(mode==='invalid_basis'?4:6);expect(result.canonUnchangedThroughGM).toBe(true);expect(result.campaignWrites).toBe(0);
 expect(result.handoff.selectedCueIsModelIntent).toBe(mode==='accepted');expect(result.handoff.forecastTextAbsent).toBe(true);expect(result.handoff.latestKnownClaimIncluded).toBe(true);
 expect(result.stages.at(-1).packet.evidence.map((row:any)=>row.id)).toEqual(expect.arrayContaining(['known_request_day3','known_response']));
 if(mode==='accepted')expect(result.stages[0].attempt.reason).toBeNull();
 expect(result.gm).toMatchObject({narrationProduced:true,privateMarkerLeaked:false,futureMarkerLeaked:false,retryCount:0});
 if(mode==='invalid_basis')expect(result.stages[0].attempt.reason).toBe('Unknown evidence basis.');
 if(process.env.MYTHENGINE_PREPARE_HANDOFF==='1'&&mode==='accepted'){
  const prices=JSON.parse(fs.readFileSync('.codex-run/faction-handoff-pricing.json','utf8'));
  expect(prices.maximumRequestedTokenCostUsd).toBeLessThanOrEqual(.1);
  fs.writeFileSync('.codex-run/faction-handoff-proposal.json',JSON.stringify({preparedAt:new Date().toISOString(),status:'awaiting explicit six-call budget approval',requestCap:6,budgetUsd:.1,retries:0,concurrency:1,paidCalls:0,campaignWrites:0,tokenCaps:handoffCaps,prices,calls,result,limits:'Real production packet/validation/provider/Jev/prompt owners, in-memory synthetic handoff; persistent workflow/extractor/job lifecycle not exercised. Strict IDs stay in textual schema, JSON object mode is not schema enforcement. No saved settings changes.'},null,2));
 }
});
test.each([Infinity,NaN,-1])('nonfinite/negative stock %s cannot become a spendable planner or GM quantity',amount=>{
 const fixture=handoffFixture();fixture.resources[0].amount=amount;
 expect(()=>fixture.packet()).toThrow('Unsupported resource reservation.');
 const action='I ask Maera what help is available.';
 const prompt=buildServerTurnPrompt(fixture.ctx,{storyId:fixture.id,query:action,packet:'',nodes:[],tokenEstimate:0,retrievalDebug:[],retrievalTrace:[]} as any,'corrupt-stock',{playerAction:action,presentNpcIds:[fixture.actor]});
 expect(prompt.dynamicPrompt).toContain('Relief grain (availability unknown; no commitment permitted)');
 expect(prompt.dynamicPrompt).not.toMatch(/Relief grain=(?:Infinity|NaN|-1)/);
});
test('reasoning-only exhausted GM response is held, never promoted to narration or automatically retried',async()=>{
 old=process.env.MYTHENGINE_TEST_LOCAL_ONLY;process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';
 const mock=vi.fn(async()=>Response.json({choices:[{message:{content:'',reasoning:'Synthetic hidden reasoning'},finish_reason:'length'}],usage:{prompt_tokens:100,completion_tokens:1600,completion_tokens_details:{reasoning_tokens:1600}}}));vi.stubGlobal('fetch',mock);
 const result=await generateServerTextWithMetrics({profile:profiles.gm.profile,model:profiles.gm.model,system:'GM rules.',prompt:'Listen.',maxTokens:1600,reasoningEffort:'low',maxRetries:0});
 expect(result.text).toBe('');expect(result.finishReason).toBe('length');expect(result.usage?.reasoningTokens).toBe(1600);expect(mock).toHaveBeenCalledTimes(1);
});
