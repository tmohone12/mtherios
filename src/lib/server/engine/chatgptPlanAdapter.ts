import { z } from 'zod';
import { assistantToolDefinitions, assistantToolSchema } from './assistantTools';

/** Supported public SIWC transport, supplied by MythEngine's protected session owner.
 * Never reads Codex auth files, environment tokens or browser storage. No shell/MCP/hosted tools.
 */
type Transport = (url: string, init: RequestInit) => Promise<Response>;
const requestSchema = z.object({
  model: z.string().min(1).max(200), instructions: z.string().max(32000),
  input: z.array(z.record(z.string(), z.unknown())).max(500),
}).strict();
export function buildChatgptPlanRequest(input: unknown) {
  const request = requestSchema.parse(input);
  if (request.input.some(item => item.role === 'system')) throw new Error('Use instructions or developer messages for ChatGPT plan requests.');
  const tool = assistantToolDefinitions.storyContent;
  const body = { ...request, store: false, stream: true, include: ['reasoning.encrypted_content'], tools: [{ type: 'namespace', name: 'mythengine', description: 'Selected-story reads and proposed authored edits. The author applies changes in MythEngine.', tools: [{ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }] }] };
  if (JSON.stringify(body).length > 250000) throw new Error('ChatGPT plan request exceeds the bounded context allowance.');
  return body;
}

export interface ChatgptPlanSession {
  enabled: boolean;
  /** Supplied only by the backend's separately authorized SIWC owner. */
  accessToken: string;
  grantedScopes: readonly string[];
  fetchImpl?: Transport;
}
function credential(session: ChatgptPlanSession) {
  if (!session.enabled) throw new Error('ChatGPT plan connection is disabled.');
  if (!session.grantedScopes.includes('chatgpt.tokens.use.direct') || !session.accessToken || /[\r\n]/.test(session.accessToken)) throw new Error('An app-owned SIWC session with ChatGPT plan consent is required.');
  return session.accessToken;
}
export async function listChatgptPlanModels(session: ChatgptPlanSession, signal?: AbortSignal) {
  const token = credential(session);
  const response = await (session.fetchImpl ?? fetch)('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${token}` }, signal: signal ?? AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error(`ChatGPT model catalog failed (HTTP ${response.status}).`);
  let raw:unknown;try{raw=await response.json();}catch{throw new Error('ChatGPT model catalog returned an invalid response. No model choices were changed.');}
  const page=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
  if(page.has_more===true||(typeof page.next_cursor==='string'&&page.next_cursor)||(typeof page.nextCursor==='string'&&page.nextCursor))throw new Error('ChatGPT model catalog returned an undocumented paginated response. No incomplete model list was loaded.');
  const parsed = z.object({ models: z.array(z.object({ slug: z.string().min(1), display_name: z.string().min(1), visibility: z.string() })) }).safeParse(raw);
  if(!parsed.success)throw new Error('ChatGPT model catalog has an unsupported response shape. This picker requires the signed-in account catalog, not an API-key or Codex bundled catalog.');
  const body=parsed.data;
  return body.models.filter(model => model.visibility === 'list').map(model => ({ id: model.slug, label: model.display_name }));
}

type Diagnostic={status?:number;code?:string;param?:string;requestId?:string;bodyShape?:Record<string,string>;outputTypes?:string[];completedOutputItems?:number;streamedOutputItems?:number};
export class ChatgptPlanError extends Error { constructor(public kind:'limit'|'unsupported'|'revoked'|'network',message:string,public diagnostic:Diagnostic={},public completedUsage?:unknown){super(message);} }
const safeDiagnostic=(value:unknown)=>typeof value==='string'&&/^[\w.\[\]-]{1,200}$/.test(value)?value:undefined;
function inferenceError(value:unknown,status?:number,requestId?:string){
 const body=value&&typeof value==='object'?value as Record<string,unknown>:{},error=(body.error??(body.response as Record<string,unknown>|undefined)?.error??body) as Record<string,unknown>;
 const code=safeDiagnostic(error?.code),param=safeDiagnostic(error?.param);
 const kind=status===429||code==='subscription_sharing_usage_limit_exceeded'||code==='rate_limit_exceeded'?'limit':status===401||[400,403,404].includes(status??0)||code?.includes('unsupported')||code?.includes('not_eligible')?'unsupported':'network';
 return new ChatgptPlanError(kind,'ChatGPT plan inference did not complete'+(status?` (HTTP ${status})`:'')+(code?` [${code}]`:'')+'. '+(kind==='limit'?'Review your app limits in ChatGPT Settings > Usage.':kind==='unsupported'?'Check the account permission and eligible model; reauthorize if needed.':'Try again later.'),{status,code,param,requestId:safeDiagnostic(requestId),bodyShape:Object.fromEntries(Object.entries(body).slice(0,20).map(([key,v])=>[key.slice(0,80),Array.isArray(v)?'array':typeof v]))});
}
export async function generateChatgptPlanResponse(session: ChatgptPlanSession, input: unknown, signal?: AbortSignal, beforeRequest?: (body: Record<string,unknown>)=>Promise<void>) {
  const token = credential(session), body = buildChatgptPlanRequest(input);
  await beforeRequest?.(body);
  const response = await (session.fetchImpl ?? fetch)('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000), redirect: 'error' });
  if (!response.ok || !response.body) {let diagnostic:unknown;try{diagnostic=await response.json();}catch{}throw inferenceError(diagnostic,response.status,response.headers.get('x-request-id')??undefined);}
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', bytes = 0, completed: Record<string, unknown> | null = null;
  const doneItems=new Map<number,Record<string,unknown>>();
  const consume=(frame:string)=>{
    const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')return;
    let event:{type:string;response?:Record<string,unknown>;output_index?:number;item?:Record<string,unknown>};
    try{event=JSON.parse(data);}catch{throw new Error('ChatGPT returned a malformed stream. No tools were executed.');}
    if(['error','response.failed','response.incomplete'].includes(event.type))throw inferenceError(event,undefined,response.headers.get('x-request-id')??undefined);
    if(event.type==='response.output_item.done'){
      const index=event.output_index,item=event.item;
      if(!Number.isInteger(index)||index!<0||index!>=500||!item||typeof item!=='object'||Array.isArray(item))throw new Error('ChatGPT returned an invalid final output item. No tools were executed.');
      if(doneItems.has(index!)&&JSON.stringify(doneItems.get(index!))!==JSON.stringify(item))throw new Error('ChatGPT returned conflicting final output items. No tools were executed.');
      doneItems.set(index!,item);
    }
    if(event.type==='response.completed'){
      if(completed)throw new Error('ChatGPT returned duplicate completion events. No tools were executed.');
      if(event.response?.status!=='completed'||event.response.error)throw inferenceError(event,undefined,response.headers.get('x-request-id')??undefined);
      completed=event.response;
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2000000) throw new Error('ChatGPT plan stream exceeded the response allowance.');
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replaceAll('\r\n', '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);consume(frame);
      }
    }
    buffer+=decoder.decode();if(buffer.trim())consume(buffer.replaceAll('\r\n','\n'));
  } finally { await reader.cancel().catch(() => {}); }
  if (!completed) throw new Error('ChatGPT plan stream ended without response.completed.');
  const completion=completed as Record<string,unknown>;
  const repeated=z.array(z.record(z.string(),z.unknown())).parse(completion.output);
  let output=repeated;
  if(doneItems.size){
    const sorted=[...doneItems].sort(([a],[b])=>a-b);
    if(!repeated.length){if(sorted.some(([index],position)=>index!==position))throw new Error('ChatGPT final output has missing items. No tools were executed.');output=sorted.map(([,item])=>item);}
    else {output=[...repeated];for(const [index,item] of sorted){const prior=repeated[index];if(!prior||prior.type!==item.type||(prior.id&&item.id&&prior.id!==item.id))throw new Error('ChatGPT final output does not match its completion. No tools were executed.');output[index]=item;}}
  }
  if(output.some(item=>!['message','reasoning','function_call'].includes(String(item.type))))throw new Error('ChatGPT returned an unsupported output type. No tools were executed.');
  if(output.some(item=>item.status!=null&&item.status!=='completed'))throw new Error('ChatGPT returned incomplete output. No tools were executed.');
  const diagnostic:Diagnostic={requestId:safeDiagnostic(response.headers.get('x-request-id')),outputTypes:output.map(item=>String(item.type)),completedOutputItems:repeated.length,streamedOutputItems:doneItems.size};
  const refuse=(code:string,message:string):never=>{throw new ChatgptPlanError(code==='provider_refusal'?'unsupported':'network',message+` [${code}]`+(diagnostic.requestId?` Request ID: ${diagnostic.requestId}`:''),{...diagnostic,code},completion.usage??null);};
  const parts=output.filter(item=>item.type==='message').flatMap(item=>Array.isArray(item.content)?item.content:[]);
  if(parts.some(item=>item.type==='refusal'))refuse('provider_refusal','ChatGPT refused this request. No tools were executed.');
  const toolCalls = output.filter(item => item.type === 'function_call').map(item => {
    if (!(item.name === 'storyContent' && (!item.namespace||item.namespace === 'mythengine')) && item.name !== 'mythengine.storyContent') throw new Error('ChatGPT plan requested a tool outside the selected-story adapter.');
    try{return assistantToolSchema.parse({ tool: 'storyContent', callId: item.call_id, args: JSON.parse(String(item.arguments)) });}catch{throw new Error('ChatGPT returned invalid selected-story tool arguments. No tools were executed.');}
  });
  if(!toolCalls.length&&!parts.some(item=>item.type==='output_text'&&typeof item.text==='string'&&item.text.trim()))refuse(output.length?'reasoning_only_output':'empty_completed_output','ChatGPT completed without an answer or supported tool call. No changes were applied and no automatic retry was made.');
  return { output, toolCalls, diagnostic, usage: completion.usage ?? null, providerCostUsd: null, billing: 'chatgpt-plan' as const };
}
