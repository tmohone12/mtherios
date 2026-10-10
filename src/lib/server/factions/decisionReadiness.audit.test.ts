import fs from 'node:fs';
import { expect,test,vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb,closeDb } from '$lib/server/db/client';
import { resolveServiceGeneration } from '$lib/server/engine/llmSettings';
import { generateServerTextWithMetrics } from '$lib/server/turn/provider';
import { chooseJevOption } from '$lib/server/turn/jev';

const audit=process.env.MYTHENGINE_DECISION_READINESS_AUDIT==='1'?test:test.skip;
audit('current COPY reply/decision settings reach real request assembly without inference',async()=>{
 const policy=process.env.MYTHENGINE_TEST_LOCAL_ONLY;
 try {
  const config=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
  expect(config).toMatchObject({port:5174,jobWorker:false,testLocalInferenceOnly:true,isolatedTestCopy:true});
  expect((await getDb().execute(sql.raw('select current_database() as name')))[0].name).toBe('mythengine_faction_copy_20261001');
  const response=await fetch('http://127.0.0.1:5174/api/settings/llm');
  expect(response.ok).toBe(true);
  const hotSettings=await response.json();
  const [gm,decision]=await Promise.all([resolveServiceGeneration('narrative'),resolveServiceGeneration('actorDecision')]);
  expect(gm.setting).toMatchObject({providerType:'openrouter',model:'z-ai/glm-5.3-flash',reasoningEffort:'high',maxTokens:8192});
  expect(decision.setting).toMatchObject({providerType:'openrouter',model:'typesafe/jev-1.13'});
  expect(gm.profile?.apiKey).toBeTruthy();expect(decision.profile?.apiKey).toBeTruthy();
  const services=Array.isArray(hotSettings)?hotSettings:hotSettings.services??hotSettings.settings;
  expect(Array.isArray(services)).toBe(true);
  const hotNarrative=services.find((row:{serviceId?:string})=>row.serviceId==='narrative');
  expect(hotNarrative).toMatchObject({model:gm.setting!.model,reasoningEffort:gm.generation.reasoningEffort});
  const serialized:Array<{requested:string;wire:string;maxTokensPresent:boolean;historyBeforeTail:boolean}>=[];
  // Every model fetch below is mocked; real credentials never leave this process.
  const mock=vi.fn().mockImplementation(async()=>Response.json({choices:[{message:{content:'Synthetic narration.'},finish_reason:'stop'}]}));
  vi.stubGlobal('fetch',mock);
  process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';
  for(const requested of [gm.generation.reasoningEffort!,'low','off']){
   await generateServerTextWithMetrics({profile:gm.profile!,model:gm.generation.model!,reasoningEffort:requested,maxTokens:gm.generation.maxTokens,
    providerOutputLimit:true,maxRetries:0,system:'Stable rules.',messages:[{role:'assistant',content:'Earlier dialogue.'}],systemDynamic:'Current intention.',contextAfterDialogue:true,prompt:'I listen.'});
   const body=JSON.parse(mock.mock.calls.at(-1)![1].body);
   const history=body.messages.findIndex((row:{role:string;content:unknown})=>row.role==='assistant'&&row.content==='Earlier dialogue.');
   const tail=body.messages.findIndex((row:{content:unknown})=>JSON.stringify(row.content).includes('Current intention.'));
   expect(body.reasoning).toEqual({effort:requested==='off'?'low':requested});
   expect(body).not.toHaveProperty('max_tokens');expect(history).toBeGreaterThan(-1);expect(tail).toBeGreaterThan(history);
   serialized.push({requested,wire:body.reasoning.effort,maxTokensPresent:'max_tokens' in body,historyBeforeTail:tail>history});
  }
  process.env.MYTHENGINE_TEST_LOCAL_ONLY='true';mock.mockClear();
  await expect(chooseJevOption({profile:decision.profile!,model:decision.generation.model!,evidence:{known:'Synthetic source only.'},sourceIds:['synthetic'],
   options:[{id:'wait',description:'Hold.'},{id:'talk',description:'Offer a discussion.'}]})).rejects.toThrow('local Kev decisions only');
  expect(mock).not.toHaveBeenCalled();
  fs.writeFileSync('.codex-run/decision-readiness-config-audit.json',JSON.stringify({verifiedAt:new Date().toISOString(),providerRequests:0,
   copyUrl:'http://localhost:5174',reply:{provider:gm.setting!.providerType,model:gm.generation.model,savedReasoning:gm.generation.reasoningEffort,
    offSupported:false,recommendedFastestSupported:'low',settingsChanged:false,hotReadMatches:true,serialized},decision:{provider:decision.setting!.providerType,
    model:decision.generation.model,keyResolvable:true,pausedGuardBeforeFetch:true},source:'current COPY DB, served settings API, mocked actual provider assembly'},null,2)+'\n');
 }finally{vi.unstubAllGlobals();if(policy===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=policy;await closeDb();}
},30000);
