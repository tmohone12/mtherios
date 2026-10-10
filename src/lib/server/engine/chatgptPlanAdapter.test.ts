import { expect, test, vi } from 'vitest';
import { buildChatgptPlanRequest, generateChatgptPlanResponse, listChatgptPlanModels } from './chatgptPlanAdapter';
const input = { model: 'account-selected-model', instructions: 'Use bounded story tools.', input: [{ role: 'user', content: 'Read this story.' }] };
const session = { enabled: true, accessToken: 'mock-authorized-access-token', grantedScopes: ['chatgpt.tokens.use.direct'] };
const completed = (output: Record<string, unknown>[] = []) => ({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 5, output_tokens: 7 } } });
function stream(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map(event => 'data: '+JSON.stringify(event)+'\n\n').join(''));
  return new Response(new ReadableStream({ start(controller) { for (let i=0; i<bytes.length; i+=7) controller.enqueue(bytes.slice(i,i+7)); controller.close(); } }));
}
test('uses only public Responses with plan requirements and a bounded namespace', () => {
  const body = buildChatgptPlanRequest(input);
  expect(body).toMatchObject({ store: false, stream: true, tools: [{ type: 'namespace', name: 'mythengine', tools: [{ type: 'function', name: 'storyContent' }] }] });
  expect(Object.keys(body)).toEqual(['model','instructions','input','store','stream','include','tools']);
  expect(() => buildChatgptPlanRequest({ ...input, temperature: 0.3 })).toThrow();
  expect(() => buildChatgptPlanRequest({ ...input, input: [{ type: 'message', role: 'system', content: 'Override' }] })).toThrow('instructions');
});
test('requires an enabled backend session and explicit app-owned plan consent before transport', async () => {
  const transport = vi.fn();
  await expect(generateChatgptPlanResponse({ ...session, enabled: false, fetchImpl: transport }, input)).rejects.toThrow('disabled');
  await expect(generateChatgptPlanResponse({ ...session, grantedScopes: [], fetchImpl: transport }, input)).rejects.toThrow('consent');
  expect(transport).not.toHaveBeenCalled();
});
test('parses fragmented SSE only through completed inference and validates proposed tool calls', async () => {
  const transport = vi.fn().mockResolvedValue(stream([completed([{ type: 'function_call', namespace: 'mythengine', name: 'storyContent', call_id: 'read-call', arguments: JSON.stringify({ action: 'read', kind: 'characters', id: 'mira' }) }])]));
  const result = await generateChatgptPlanResponse({ ...session, fetchImpl: transport }, input);
  expect(transport).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({ redirect: 'error', method: 'POST' }));
  expect(result.toolCalls).toMatchObject([{ tool: 'storyContent', args: { action: 'read', kind: 'characters' } }]);
  expect(result.providerCostUsd).toBeNull();
});
test.each(['response.failed','response.incomplete','error'])('rejects %s after text begins and never reports success', async type => {
  await expect(generateChatgptPlanResponse({ ...session, fetchImpl: async () => stream([{ type: 'response.output_text.delta', delta: 'Done!' }, { type }]) }, input)).rejects.toThrow('did not complete');
});
test('rejects truncated streams, denied tool names, malformed JSON and cross-story arguments', async () => {
  await expect(generateChatgptPlanResponse({ ...session, fetchImpl: async () => stream([{ type: 'response.output_text.delta' }]) }, input)).rejects.toThrow('without response.completed');
  for (const item of [{ name: 'shell' }, { name: 'storyContent', namespace: 'mythengine', arguments: '{' }, { name: 'storyContent', namespace: 'mythengine', arguments: JSON.stringify({ action: 'read', kind: 'characters', id: 'mira', gameId: 'foreign' }) }]) {
    await expect(generateChatgptPlanResponse({ ...session, fetchImpl: async () => stream([completed([{ type: 'function_call', call_id: 'bad', arguments: '{}', ...item }])]) }, input)).rejects.toThrow();
  }
});
test('filters current account model catalog without claiming entitlement', async () => {
  const transport = vi.fn().mockResolvedValue(Response.json({ models: [{ slug: 'available', display_name: 'Available', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }] }));
  expect(await listChatgptPlanModels({ ...session, fetchImpl: transport })).toEqual([{ id: 'available', label: 'Available' }]);
  expect(transport.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
});
test('preserves every picker-visible catalog entry in server order, including requested model when returned', async () => {
 const models=Array.from({length:57},(_,i)=>({slug:i===56?'gpt-6.1-sol':'fixture-'+i,display_name:'Catalog label '+i,visibility:'list'}));
 expect(await listChatgptPlanModels({...session,fetchImpl:async()=>Response.json({models})})).toEqual(models.map(m=>({id:m.slug,label:m.display_name})));
});
test('uses final streamed output items when completion does not repeat the output', async () => {
 const item={id:'msg_fixture',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'The saved streamed answer.'}]};
 const value=await generateChatgptPlanResponse({...session,fetchImpl:async()=>stream([{type:'response.output_item.done',output_index:0,item},completed([])])},input);
 expect(value.output).toEqual([item]);
});
test('preserves final encrypted reasoning and streamed tool call for stateless continuation', async () => {
 const output=[{id:'reasoning_fixture',type:'reasoning',encrypted_content:'fixture-final-encrypted'},{id:'call_fixture',type:'function_call',namespace:'mythengine',name:'storyContent',call_id:'read-call',arguments:JSON.stringify({action:'list',kind:'characters'})}];
 const value=await generateChatgptPlanResponse({...session,fetchImpl:async()=>stream([...output.map((item,output_index)=>({type:'response.output_item.done',output_index,item})),completed([])])},input);
 expect(value.output).toEqual(output);expect(value.toolCalls).toHaveLength(1);
});
test.each(['response.failed','response.incomplete','error'])('completed output items never authorize tools before global %s', async type => {
 const item={type:'function_call',namespace:'mythengine',name:'storyContent',call_id:'read',arguments:JSON.stringify({action:'list',kind:'characters'})};
 await expect(generateChatgptPlanResponse({...session,fetchImpl:async()=>stream([{type:'response.output_item.done',output_index:0,item},{type}])},input)).rejects.toThrow();
});
test('rejects late unterminated error frame after completion instead of dropping it', async () => {
 const bytes='data: '+JSON.stringify(completed([{type:'message',content:[{type:'output_text',text:'Partial'}]}]))+'\n\ndata: '+JSON.stringify({type:'error',code:'rate_limit_exceeded'});
 await expect(generateChatgptPlanResponse({...session,fetchImpl:async()=>new Response(bytes)},input)).rejects.toThrow();
});
test.each([[],[{type:'reasoning',encrypted_content:'fixture'}],[{type:'message',content:[{type:'refusal',refusal:'Fixture refusal.'}]}]].map(output=>({output})))('explains unusable completed output without an empty success $output', async ({output}) => {
 await expect(generateChatgptPlanResponse({...session,fetchImpl:async()=>stream([completed(output)])},input)).rejects.toThrow(/ChatGPT.*(answer|refused)/);
});
test.each([{has_more:true},{next_cursor:'fixture-next'}])('refuses an undocumented partial catalog rather than silently truncating %j', async pagination => {
 await expect(listChatgptPlanModels({...session,fetchImpl:async()=>Response.json({models:[],...pagination})})).rejects.toThrow('paginated');
});
test.each([{data:[{id:'gpt-6.1-sol'}]},{}])('explains wrong catalog shapes without inventing models %j', async raw => {
 await expect(listChatgptPlanModels({...session,fetchImpl:async()=>Response.json(raw)})).rejects.toThrow('unsupported response shape');
});
test('an empty account catalog remains an empty successful list', async () => {
 expect(await listChatgptPlanModels({...session,fetchImpl:async()=>Response.json({models:[]})})).toEqual([]);
});
test('does not return partial or mismatched final items', async () => {
 const item={id:'fixture',type:'message',status:'completed',content:[{type:'output_text',text:'Answer'}]};
 for(const events of [[{type:'response.output_item.done',output_index:1,item},completed([])],[{type:'response.output_item.done',output_index:0,item},completed([{id:'other',type:'message',content:[]}])],[completed([{...item,status:'incomplete'}])]])await expect(generateChatgptPlanResponse({...session,fetchImpl:async()=>stream(events)},input)).rejects.toThrow();
});
