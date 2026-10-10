import fs from 'node:fs';
import { expect,test,vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb,closeDb } from '$lib/server/db/client';
import { resolveServiceGeneration } from '$lib/server/engine/llmSettings';
const verify=process.env.MYTHENGINE_OPENROUTER_CONFIG_ONLY==='1'?test:test.skip;
verify('actual COPY OpenRouter actor setting resolves without any provider request',async()=>{
 const config=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
 expect(config).toMatchObject({port:5174,jobWorker:false,testLocalInferenceOnly:true,isolatedTestCopy:true});
 expect((await getDb().execute(sql`select current_database() as name`))[0].name).toBe('mythengine_faction_copy_20261001');
 const mock=vi.fn(()=>{throw new Error('No provider request authorized');});vi.stubGlobal('fetch',mock);
 try{const resolved=await resolveServiceGeneration('actorDecision');
  expect(resolved.setting).toMatchObject({providerType:'openrouter',model:'typesafe/jev-1.13',apiKeyRef:'env:OPENROUTER_API_KEY',baseUrl:'https://openrouter.ai/api/v1',enabled:true});
  const receipt={verifiedAt:new Date().toISOString(),provider:resolved.setting!.providerType,model:resolved.setting!.model,credentialReference:resolved.setting!.apiKeyRef,profileAvailable:!!resolved.profile,keyResolvable:!!resolved.profile?.apiKey,missingReason:resolved.missingReason,providerRequests:mock.mock.calls.length,cloudPaused:true,workerPaused:true};
  fs.writeFileSync('.codex-run/openrouter-jev-resolution.json',JSON.stringify(receipt,null,2));
  expect(mock).not.toHaveBeenCalled();if(!resolved.profile)expect(resolved.missingReason).toContain('needs an API key');
 }finally{vi.unstubAllGlobals();await closeDb();}
},30000);
