import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,afterAll,expect,test,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {getDb,closeDb} from '$lib/server/db/client';
import {ChatgptSessions,browserOwnerContext,scopeKey} from '$lib/server/chatgpt/session';
import type {ChatgptRecords} from '$lib/server/chatgpt/storage';
import {createCanonicalWorkspace,readCanonicalWorkspace} from './canonicalContent';
import type {CanonicalView} from '$lib/contracts/canonicalContent';
let sessions:ChatgptSessions;
vi.mock('$lib/server/chatgpt/owner',()=>({
 chatgptSessions:()=>sessions,
 currentChatgptBinding:(project:string,story:string)=>sessions.binding(browserOwnerContext.getStore(),project,story),
 assertCurrentChatgptBinding:async(expected:unknown)=>{const e=expected as {projectId:string;gameId:string};const current=await sessions.binding(browserOwnerContext.getStore(),e.projectId,e.gameId);if(!current||Object.entries(expected as Record<string,unknown>).some(([key,value])=>current[key as keyof typeof current]!==value))throw Error('ChatGPT account changed');},
 assertChatgptConversationAccess:async(c:Record<string,unknown>)=>{if(c.chatgpt_owner_hash){const binding=await sessions.binding(browserOwnerContext.getStore(),String(c.project_id),String(c.game_id));if(c.chatgpt_owner_hash!==browserOwnerContext.getStore()||binding?.accountKey!==c.chatgpt_account_key)throw Error('Conversation account scope denied');}}
}));
import {createAssistantConversation,sendAssistantMessage,readAssistantConversation,reviewAssistantApproval,undoAssistantStoryApproval,listAssistantConversations} from './assistantConversations';
import {executeAssistantTool} from './assistantTools';
const enabled=process.env.MYTHENGINE_ASSISTANT_STORY_INTEGRATION==='1',integration=enabled?test:test.skip,owner='mock-runtime-browser';
let projectId:string,gameId:string,foreign:string,entry:CanonicalView,records:ChatgptRecords,calls:Record<string,unknown>[],mode:string;
const owned=<T>(work:()=>Promise<T>)=>browserOwnerContext.run(owner,work);
beforeEach(async()=>{
 if(!enabled)return;if(!['/mythengine_identity_candidate_20261006','/mythengine_summary_repair_recovery_20261006_aggregate'].includes(new URL(process.env.DATABASE_URL!).pathname))throw Error('Disposable database required');
 const suffix=randomUUID();projectId='siwc_fixture_'+suffix;gameId='siwc_story_'+suffix;foreign='siwc_other_'+suffix;calls=[];mode='proposal';
 await getDb().execute(sql`insert into shelves(id,name,slug) values(${projectId},'Mock SIWC project',${projectId})`);await getDb().execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Mock SIWC story'),(${foreign},${projectId},'Other fixture')`);
 entry=await createCanonicalWorkspace({projectId,gameId,kind:'characters',fields:{name:'Mira',description:'Original fixture prose.'}}) as CanonicalView;
 records={version:1,accounts:[{key:'fixture-account',owner,clientId:'fixture-client',subject:'fixture-subject',email:'fixture@example.invalid',epoch:1,accessToken:'FAKE MOCK ACCESS',refreshToken:'FAKE MOCK REFRESH',scopes:['chatgpt.tokens.use.direct'],expiresAt:Date.now()+3600000,savedAt:Date.now(),state:'connected'}],selections:{[scopeKey(owner,projectId,gameId)]:{accountKey:'fixture-account',model:'fixture-model'}}};let queue:Promise<unknown>=Promise.resolve();
 sessions=new ChatgptSessions({store:{supported:true,read:async()=>structuredClone(records),change:work=>{const task=queue.then(async()=>{const next=structuredClone(records),result=await work(next);records=next;return result;});queue=task.catch(()=>{});return task;}},fetch:async(url,init)=>{
  expect(url).toBe('https://api.openai.com/v1/responses');expect((init!.headers as Record<string,string>).Authorization).toBe('Bearer FAKE MOCK ACCESS');const body=JSON.parse(String(init?.body));calls.push(body);
  expect(body).toMatchObject({store:false,stream:true,model:'fixture-model'});expect(body.tools[0].tools.map((t:{name:string})=>t.name)).toEqual(['storyContent']);expect(body).not.toHaveProperty('max_output_tokens');expect(body).not.toHaveProperty('temperature');expect(body.input.some((m:{role:string})=>m.role==='system')).toBe(false);
  const count=calls.length;const args=count===1?{action:'list',kind:'characters'}:count===2?{action:'read',kind:'characters',id:entry.record.id}:{action:'propose',kind:'characters',id:entry.record.id,expected:entry.revision,changes:{description:'Reviewed mock edit.'},reason:'Clarify fixture prose.'};
  const output=[{type:'reasoning',id:'reasoning-'+count,encrypted_content:'mock-encrypted-reasoning'},{type:'function_call',call_id:'mock-call-'+count,namespace:'mythengine',name:mode==='forbidden'?'write': 'storyContent',arguments:JSON.stringify(args)}];
  const event=mode==='late-error'?{type:'response.failed',response:{status:'failed',error:{code:'rate_limit_exceeded'}}}:{type:'response.completed',response:{status:'completed',output,usage:{input_tokens:20,output_tokens:10,total_tokens:30}}};
  const frames:unknown[]=mode==='streamed-proposal'?[...output.map((item,output_index)=>({type:'response.output_item.done',output_index,item})),{...event,response:{...event.response,output:[]}}]:mode==='empty'?[{type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:20,output_tokens:10,total_tokens:30}}}]:[event];
  return new Response(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join(''), {headers:{'Content-Type':'text/event-stream'}});
 }});
});
afterEach(async()=>{if(enabled)await getDb().execute(sql`delete from shelves where id=${projectId}`);});afterAll(async()=>{if(enabled)await closeDb();});
integration.each(['proposal','streamed-proposal'])('actual Pi assistant uses public Responses, full history and reviewed canonical editing without a configured key (%s)',async value=>owned(async()=>{mode=value;
 const conversation=await createAssistantConversation({projectId,gameId}),conversationId=String(conversation.conversation.id),scope={projectId,gameId,conversationId};
 const pending=await sendAssistantMessage({...scope,clientMessageId:'mock-message-'+randomUUID(),content:'Read Mira and propose clearer biography prose.'});expect(pending.run?.status, String(pending.run?.error)).toBe('awaiting_input');expect(calls).toHaveLength(3);
 expect(JSON.stringify(calls[1].input)).toContain('mock-encrypted-reasoning');expect(JSON.stringify(calls[1].input)).toContain('function_call_output');
 const read=()=>readCanonicalWorkspace({projectId,gameId,kind:'characters',id:String(entry.record.id)});expect((await read() as CanonicalView).record.description).toBe('Original fixture prose.');
 const approval=pending.approvals.find(a=>a.kind==='story_edit')!;expect(approval.status).toBe('pending');const saved=await reviewAssistantApproval({...scope,runId:pending.run!.id,approvalId:approval.id,expectedRevision:approval.revision,decision:'approve'});expect(saved.run?.status).toBe('completed');expect(calls).toHaveLength(3);expect((await read() as CanonicalView).record.description).toBe('Reviewed mock edit.');
 await undoAssistantStoryApproval({...scope,approvalId:approval.id,expectedRevision:saved.approvals.find(a=>a.id===approval.id)!.revision});expect((await read() as CanonicalView).record.description).toBe('Original fixture prose.');
 const [run]=await getDb().execute(sql`select result from assistant_runs where id=${pending.run!.id}`);expect(JSON.stringify(run.result)).not.toContain('FAKE MOCK');expect((run.result as {requestReceipts:unknown[]}).requestReceipts).toHaveLength(3);
 await expect(browserOwnerContext.run('foreign-browser',()=>readAssistantConversation(scope))).rejects.toThrow('scope');await expect(readAssistantConversation({...scope,gameId:foreign})).rejects.toMatchObject({code:'SCOPE_DENIED'});
 expect(await listAssistantConversations({projectId,gameId:foreign})).toEqual([]);
 await expect(executeAssistantTool({...scope,runId:String(pending.run!.id)},{tool:'write',callId:'bypass',args:{}})).rejects.toThrow();
}));
integration.each(['forbidden','late-error','empty'])('denies %s output without executing tools or mutating canon',async value=>owned(async()=>{mode=value;const conversation=await createAssistantConversation({projectId,gameId});const result=await sendAssistantMessage({projectId,gameId,conversationId:conversation.conversation.id,clientMessageId:'mock-message-'+randomUUID(),content:'Propose an edit.'});expect(result.run?.status).toBe('failed');if(value==='empty'){expect(result.run?.error).toContain('completed without an answer');const [saved]=await getDb().execute(sql`select result from assistant_runs where id=${result.run!.id}`);expect((saved.result as {usageRows:unknown[]}).usageRows).toEqual([expect.objectContaining({usage:expect.objectContaining({inputTokens:20,outputTokens:10,totalTokens:30,estimatedCostUsd:null,providerCostUsd:null})})]);}expect(result.approvals).toEqual([]);expect((await readCanonicalWorkspace({projectId,gameId,kind:'characters',id:String(entry.record.id)}) as CanonicalView).record.description).toBe('Original fixture prose.');expect(calls, String(result.run?.error)).toHaveLength(1);}));
