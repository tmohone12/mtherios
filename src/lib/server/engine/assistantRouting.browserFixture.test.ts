import {test} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {sql} from 'drizzle-orm';
import {getDb,closeDb} from '$lib/server/db/client';
import {createCanonicalWorkspace} from './canonicalContent';
import {createChatgptFileStore,windowsCredentialProtection} from '$lib/server/chatgpt/storage';
import {ownerHash} from '$lib/server/chatgpt/session';
const fixtureTest=process.env.MYTHENGINE_ROUTING_BROWSER_FIXTURE==='1'?test:test.skip;
fixtureTest('prepare disposable routing browser data and fake app-owned sessions',async()=>{
 if(process.env.MYTHENGINE_ROUTING_BROWSER_FIXTURE!=='1')throw Error('Explicit fixture flag required');
 if(new URL(process.env.DATABASE_URL!).pathname!=='/mythengine_assistant_candidate_20261004')throw Error('Disposable database required');
 const suffix=Date.now(),projectId='routing_browser_'+suffix,rows=[];
 await getDb().execute(sql`insert into shelves(id,name,slug) values(${projectId},'Routing browser fixture',${projectId})`);
 for(const size of ['desktop','mobile']){const gameId='routing_'+size+'_'+suffix;await getDb().execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},${'Routing '+size+' fixture'})`);const entry=await createCanonicalWorkspace({projectId,gameId,kind:'characters',fields:{name:'Mira',description:'Original disposable biography.'}});rows.push({size,projectId,gameId,entry});}
 await getDb().execute(sql`insert into llm_service_settings(service_id,provider_type,base_url,model,enabled,api_key_ref) values('assistant','nanogpt','https://nano-gpt.com/api/v1','routing-configured-model',true,'env:NANOGPT_API_KEY') on conflict(service_id) do update set provider_type=excluded.provider_type,base_url=excluded.base_url,model=excluded.model,enabled=true,api_key_ref=excluded.api_key_ref`);
 const cookie='A'.repeat(43),owner=ownerHash(cookie),store=createChatgptFileStore(path.resolve('test-data/private/chatgpt'),windowsCredentialProtection());
 await store.change(records=>{records.accounts=['a','b'].map(suffix=>({key:'routing-account-'+suffix,owner,clientId:'routing-fake-client-'+suffix,subject:'routing-fake-subject-'+suffix,email:'routing-'+suffix+'@example.invalid',epoch:1,accessToken:'FAKE ROUTING ACCESS '+suffix,scopes:['chatgpt.tokens.use.direct'],expiresAt:Date.now()+7200000,savedAt:Date.now(),state:'connected'}));records.selections={};});
 fs.writeFileSync('../assistant-routing-browser-fixtures.json',JSON.stringify({fixtureOnly:true,database:'mythengine_assistant_candidate_20261004',cookie,rows},null,2));await closeDb();
},30000);
