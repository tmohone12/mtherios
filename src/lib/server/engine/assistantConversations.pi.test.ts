import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { NativeToolCall, ServerGenerationOptions, ServerGenerationResult } from '$lib/server/turn/provider';
import { shippedAgentSettings } from '$lib/contracts/agentTools';

const mocks = vi.hoisted(() => ({ db: { execute: vi.fn(), transaction: vi.fn() }, provider: vi.fn(), tool: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.db }));
vi.mock('$lib/server/turn/provider', async original => ({ ...await original<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: mocks.provider }));
vi.mock('./agentSettings', () => ({ getAgentSettings: async () => ({ effective: shippedAgentSettings }) }));
vi.mock('./llmSettings', () => ({
  resolveServiceGeneration: async () => ({ setting: { metadata: {} }, generation: { model: 'scripted-assistant', maxTokens: 1024 }, systemPromptOverride: null,
    profile: { providerType: 'openai', apiKey: 'fixture', contextWindowTokens: 128000 } }),
  requireResolvedServiceProfile: (_service: string, resolved: { profile: unknown }) => resolved.profile,
}));
vi.mock('./assistantContextDigest', () => ({ prepareAssistantConversationContext: async () => ({ recent: [], historical: '', sources: [] }) }));
vi.mock('./assistantTools', async original => ({ ...await original<typeof import('./assistantTools')>(), executeAssistantTool: mocks.tool }));
vi.mock('./assistantBatchPlan', async original => ({ ...await original<typeof import('./assistantBatchPlan')>(), reconcileAssistantBatchFailures: async () => undefined }));
vi.mock('./assistantBatchReport', () => ({ publishAssistantBatchReports: async () => undefined }));

import { answerAssistantQuestion, cancelAssistantRun, reconcileAssistantRuntimeMessages, resumeAssistantRun, sendAssistantMessage } from './assistantConversations';
import { createAgentRuntimeBudget } from './agentRuntime';

const scope = { projectId: 'project', conversationId: 'conversation' };
let run: Record<string, any> | null;
let messages: Array<Record<string, any>>;
let tools: Array<Record<string, any>>;
let question: Record<string, any> | null;
const dialect = new PgDialect();
const call = (id: string, name: string, args: Record<string, unknown>): NativeToolCall => ({ id, name, arguments: args });
const decision = (text: string, toolCalls?: NativeToolCall[]): ServerGenerationResult => ({
  text, toolCalls, model: 'scripted-assistant', endpoint: 'fixture', durationMs: 1, finishReason: toolCalls?.length ? 'tool_calls' : 'stop', promptChars: 1, responseChars: text.length,
  usage: { requestTokens: 100, responseTokens: 20, totalTokens: 120, inputTokens: 100, outputTokens: 20,
    cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, providerCostUsd: null, estimatedCostUsd: null },
});
const scripted = (...responses: ServerGenerationResult[]) => mocks.provider.mockImplementation(async (options: ServerGenerationOptions) => {
  await options.onBeforeRequest?.({ body: { messages: options.messages }, serializedBody: JSON.stringify({ messages: options.messages }), inputTokens: 100, reservedOutputTokens: 1024, contextWindowTokens: 128000 });
  const response = responses.shift();
  if (!response) throw new Error('Unexpected extra provider request.');
  return response;
});

beforeEach(() => {
  vi.clearAllMocks(); run = null; messages = []; tools = []; question = null;
  mocks.db.transaction.mockImplementation((fn: (tx: typeof mocks.db) => Promise<unknown>) => fn(mocks.db));
  mocks.db.execute.mockImplementation(async (statement: SQL) => {
    const { sql, params } = dialect.sqlToQuery(statement);
    const query = sql.replace(/\s+/g, ' ');
    if (query.startsWith('select * from assistant_conversations')) return [{ id: 'conversation', project_id: 'project', game_id: null }];
    if (query.startsWith('select conversation_id from assistant_messages')) return [];
    if (query.startsWith('select r.id,r.request_fingerprint')) return run?.user_message_id === params[0] ? [run] : [];
    if (query.startsWith('select id from assistant_runs')) return run && ['running', 'awaiting_input', 'committing'].includes(run.status) ? [run] : [];
    if (query.startsWith('insert into assistant_messages')) {
      const assistant = query.includes("'assistant'");
      messages.push({ id: params[0], conversation_id: params[1], role: assistant ? 'assistant' : 'user', content: params[2], status: 'committed', source_refs: assistant ? JSON.parse(String(params[3])) : [], usage: assistant ? JSON.parse(String(params[4])) : null });
      return [];
    }
    if (query.startsWith('insert into assistant_runs')) {
      run = { id: params[0], conversation_id: params[1], user_message_id: params[2], request_fingerprint: params[3], result: JSON.parse(String(params.find(value => typeof value === 'string' && value.startsWith('{')))), status: 'running', lease_until: new Date(Date.now() + 30000).toISOString() };
      return [];
    }
    if (query.startsWith('update assistant_runs')) {
      if (!run) return [];
      if (/result->>'leaseOwner'=\$\d/.test(query) && params.at(-1) !== null && run.result.leaseOwner !== params.at(-1)) return [];
      if (query.includes("status='failed'")) {
        if (!query.includes("error='Assistant reply was interrupted") && run.status === 'running') { run.status = 'failed'; run.error = params[0]; }
        return [];
      }
      if (query.includes("status='cancelled'")) { run.status = 'cancelled'; return [{ id: run.id }]; }
      if (query.includes("set status='running'")) run.status = 'running';
      if (query.includes("status='completed'")) run.status = 'completed';
      if (query.includes("'{leaseOwner}'")) run.result.leaseOwner = params[0];
      if (query.includes('result=')) {
        if (run.status === 'cancelled') return [];
        const result = params.find(value => typeof value === 'string' && value.startsWith('{'));
        if (result) run.result = JSON.parse(String(result));
      }
      if (query.includes('returning user_message_id')) { run.lease_until = new Date(Date.now() + 120000).toISOString(); return [{ user_message_id: run.user_message_id }]; }
      return query.includes('returning id') ? [{ id: run.id }] : [];
    }
    if (query.startsWith('select result from assistant_runs')) return run ? [{ result: run.result }] : [];
    if (query.startsWith('select status,result from assistant_runs')) return run ? [{ status: run.status, result: run.result }] : [];
    if (query.startsWith('select id,status,error,result') || query.startsWith('select id,user_message_id,result') || query.startsWith('select id,status,user_message_id,result')) return run ? [structuredClone(run)] : [];
    if (query.startsWith('select * from assistant_questions')) return question ? [structuredClone(question)] : [];
    if (query.startsWith('update assistant_questions')) { if (question) { question.status = 'answered'; question.response = JSON.parse(String(params[0])); question.revision++; } return []; }
    if (query.startsWith('update assistant_tool_calls set status')) {
      const ledger = tools.find(tool => tool.call_id === params.at(-1));
      if (!ledger || ledger.status !== 'reserved') return [];
      ledger.status = 'completed'; ledger.result = JSON.parse(String(params[0])); return [{ call_id: ledger.call_id }];
    }
    if (query.startsWith('select content from assistant_messages')) return messages.filter(message => message.id === params[0]);
    if (query.startsWith('select * from (select id,role,content')) return messages;
    if (query.startsWith('select tool,call_id,args,result')) return tools.filter(tool => tool.status === 'completed');
    if (query.startsWith('select * from (select t.run_id')) return tools;
    if (query.startsWith('select revision from content_items')) return [{ revision: 3 }];
    return [];
  });
  mocks.tool.mockImplementation(async (authority: { runId: string }, value: { tool: string; callId: string; args: unknown }) => {
    const prior = tools.find(tool => tool.call_id === value.callId);
    if (prior) return prior.result;
    const result = value.tool === 'update' ? { applied: true, itemId: 'bridge', afterRevision: 3, beforeRevision: 2 }
      : value.tool === 'askUserQuestion' ? { pendingQuestionId: 'question' }
      : { id: 'bridge', type_id: 'rules', revision: 3, data: { notes: 'The elected keeper guards the bridge.' } };
    tools.push({ run_id: authority.runId, call_id: value.callId, tool: value.tool, args: value.args, result, status: 'completed' });
    if (value.tool === 'askUserQuestion' && run) run.status = 'awaiting_input';
    return result;
  });
});

describe('Assistant shared Pi scheduling', () => {
  it('keeps native dependent calls/results through exploration, a revisioned update and verification', async () => {
    scripted(decision('', [call('list', 'list', { kind: 'item' })]),
      decision('', [call('first', 'read', { kind: 'item', id: 'bridge' })]),
      decision('', [call('follow', 'read', { kind: 'type', id: 'rules' })]),
      decision('', [call('verify-rule', 'read', { kind: 'item', id: 'keeper' })]),
      decision('', [call('update', 'update', { id: 'bridge', expectedRevision: 2, expectedTypeRevision: 1, changes: { data: { notes: 'Updated' } } })]),
      decision('', [call('verify', 'read', { kind: 'item', id: 'bridge' })]), decision('Successfully updated bridge to revision 3.'));
    const result = await sendAssistantMessage({ ...scope, clientMessageId: 'user', content: 'Read the rules and update bridge.' });
    expect(result.run?.status).toBe('completed');
    expect(mocks.provider).toHaveBeenCalledTimes(7);
    const finalRequest = mocks.provider.mock.calls[6][0] as ServerGenerationOptions;
    expect(finalRequest.messages?.filter(message => message.role === 'tool')).toHaveLength(6);
    expect(finalRequest.messages?.filter(message => message.role === 'assistant').flatMap(message => message.toolCalls ?? []).map(call => call.id)).toEqual(['list', 'first', 'follow', 'verify-rule', 'update', 'verify']);
    expect(run?.result.requestReceipts).toHaveLength(7);
    expect(result.run?.requestReceipts.every(receipt => receipt.serializedBody === undefined)).toBe(true);
    expect(run?.result.runtime.budget).toMatchObject({ modelRequests: 7, toolCalls: 6, unknownUsage: true });
    expect(result.run?.usage.providerCostUsd).toBeNull();
  });

  it('pauses a multi-call response before later mutations', async () => {
    scripted(decision('', [call('ask', 'askUserQuestion', { prompt: 'Choose?', options: [{ id: 'yes', label: 'Yes' }] }),
      call('later', 'update', { id: 'bridge', expectedRevision: 2, expectedTypeRevision: 1, changes: { title: 'Late edit' } })]));
    const result = await sendAssistantMessage({ ...scope, clientMessageId: 'user', content: 'Ask before editing.' });
    expect(result.run?.status).toBe('awaiting_input');
    expect(mocks.tool).toHaveBeenCalledTimes(1);
    expect(run?.result.runtime.messages.find((message: any) => message.toolCallId === 'later')).toMatchObject({ isError: true });
  });

  it('waits for the pause checkpoint before accepting an early answer and resumes immediately', async () => {
    scripted(decision('', [call('ask', 'askUserQuestion', { prompt: 'Choose?', options: [{ id: 'yes', label: 'Yes' }] }),
      call('later', 'update', { id: 'bridge', expectedRevision: 2, expectedTypeRevision: 1, changes: { title: 'Late edit' } })]),
      decision('You chose Yes.'));
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    mocks.tool.mockImplementation(async (authority: { runId: string }, value: { callId: string; tool: string; args: unknown }) => {
      question = { id: 'question', run_id: authority.runId, call_id: value.callId, prompt: 'Choose?', options: [{ id: 'yes', label: 'Yes' }], status: 'pending', revision: 1, allow_custom: false };
      tools.push({ run_id: authority.runId, call_id: value.callId, tool: value.tool, args: value.args, result: null, status: 'reserved' });
      run!.status = 'awaiting_input';
      await blocked;
      return { pendingQuestionId: 'question' };
    });
    const sent = sendAssistantMessage({ ...scope, clientMessageId: 'user', content: 'Ask before editing.' });
    await vi.waitFor(() => expect(run?.status).toBe('awaiting_input'));
    const oldOwner = run!.result.leaseOwner;
    const answered = answerAssistantQuestion({ ...scope, runId: run!.id, questionId: 'question', expectedRevision: 1, response: { optionId: 'yes' } });
    await Promise.resolve(); await Promise.resolve();
    expect(question?.status).toBe('pending');
    expect(tools[0].status).toBe('reserved');
    release();
    await sent;
    const result = await answered;
    expect(result.run?.status).toBe('completed');
    expect(run!.result.leaseOwner).not.toBe(oldOwner);
    expect(mocks.provider).toHaveBeenCalledTimes(2);
    expect(mocks.tool).toHaveBeenCalledOnce();
    const resumed = mocks.provider.mock.calls[1][0] as ServerGenerationOptions;
    expect(resumed.messages?.find(message => message.role === 'tool' && message.toolCallId === 'ask')?.content).toContain('"answer":{"optionId":"yes","label":"Yes"}');
    expect(resumed.messages?.find(message => message.role === 'tool' && message.toolCallId === 'later')).toMatchObject({ isError: true });
  });

  it('reconstructs an accepted pause result and skipped tail after a crash before the tool checkpoint', () => {
    const native: import('$lib/server/turn/provider').ServerGenerationMessage[] = [{ role: 'assistant', content: '',
      toolCalls: [call('ask', 'askUserQuestion', {}), call('later', 'update', {})], providerContinuation: { anthropicContent: [{ type: 'thinking', thinking: 'Reasoned choice', signature: 'signed' }] } }];
    const resumed = reconcileAssistantRuntimeMessages(native, [{ call_id: 'ask', result: { answer: { optionId: 'yes' } } }]);
    expect(resumed[0]).toEqual(native[0]);
    expect(resumed[1]).toMatchObject({ role: 'tool', toolCallId: 'ask', isError: false });
    expect(resumed[2]).toMatchObject({ role: 'tool', toolCallId: 'later', isError: true });
  });

  it('validates the latest applied revision when a task makes two edits to one document', async () => {
    scripted(decision('', [call('first-edit', 'update', { id: 'bridge', expectedRevision: 1, expectedTypeRevision: 1, changes: { title: 'Bridge' } })]),
      decision('', [call('second-edit', 'update', { id: 'bridge', expectedRevision: 2, expectedTypeRevision: 1, changes: { description: 'Keeper oath' } })]),
      decision('Successfully updated bridge to revision 3.'));
    mocks.tool.mockImplementation(async (authority: { runId: string }, value: { tool: string; callId: string; args: unknown }) => {
      const result = { applied: true, itemId: 'bridge', afterRevision: value.callId === 'first-edit' ? 2 : 3 };
      tools.push({ run_id: authority.runId, call_id: value.callId, tool: value.tool, args: value.args, result, status: 'completed' });
      return result;
    });
    const result = await sendAssistantMessage({ ...scope, clientMessageId: 'user', content: 'Update bridge title and description.' });
    expect(result.run?.status).toBe('completed');
    expect(result.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
  });

  it('cannot publish or fail a replacement execution after losing its lease', async () => {
    mocks.provider.mockImplementation(async (options: ServerGenerationOptions) => {
      await options.onBeforeRequest?.({ body: {}, serializedBody: '{}', inputTokens: 100, reservedOutputTokens: 1024, contextWindowTokens: 128000 });
      run!.result.leaseOwner = 'replacement-execution';
      return decision('A late answer from the previous worker.');
    });
    const result = await sendAssistantMessage({ ...scope, clientMessageId: 'user', content: 'Explain the bridge.' });
    expect(result.run?.status).toBe('running');
    expect(run?.result.leaseOwner).toBe('replacement-execution');
    expect(result.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
  });

  it('recovers a recorded decision from its completed mutation receipt and preserves the budget', async () => {
    const update = call('update', 'update', { id: 'bridge', expectedRevision: 2, expectedTypeRevision: 1, changes: { title: 'Bridge' } });
    messages.push({ id: 'user', content: 'Update bridge.', conversation_id: 'conversation', role: 'user' });
    tools.push({ run_id: 'saved', call_id: 'update', tool: 'update', status: 'completed', result: { applied: true, itemId: 'bridge', afterRevision: 3 } });
    run = { id: 'saved', status: 'running', user_message_id: 'user', lease_until: new Date(0).toISOString(), result: {
      runtimeVersion: 'pi-v1', usageRows: [], attemptedCalls: 1, requestReceipts: [], runtime: {
        messages: [{ role: 'user', content: 'Update bridge.' }, { role: 'assistant', content: '', toolCalls: [update] }],
        budget: { ...createAgentRuntimeBudget(), modelRequests: 1, toolCalls: 1 },
      },
    } };
    scripted(decision('Successfully updated bridge to revision 3.'));
    const result = await resumeAssistantRun({ ...scope, runId: 'saved' });
    expect(result.run?.status).toBe('completed');
    expect(tools.filter(tool => tool.call_id === 'update')).toHaveLength(1);
    expect(run.result.runtime.budget.modelRequests).toBe(2);
    expect(run.result.runtime.messages.find((message: any) => message.toolCallId === 'update').content).toContain('"afterRevision":3');
    expect(reconcileAssistantRuntimeMessages([{ role: 'tool', toolCallId: 'ask', content: '{"pendingQuestionId":"q"}' }],
      [{ call_id: 'ask', result: { answer: { label: 'Yes' } } }])[0].content).toContain('"label":"Yes"');
  });

  it('stops a restarted exhausted run before dispatch and rejects an unverified edit claim', async () => {
    messages.push({ id: 'user', content: 'Update bridge.', conversation_id: 'conversation', role: 'user' });
    run = { id: 'saved', status: 'running', user_message_id: 'user', lease_until: new Date(0).toISOString(), result: { runtimeVersion: 'pi-v1', usageRows: [], runtime: {
      messages: [{ role: 'user', content: 'Update bridge.' }], budget: { ...createAgentRuntimeBudget(), modelRequests: 8 },
    } } };
    const exhausted = await resumeAssistantRun({ ...scope, runId: 'saved' });
    expect(exhausted.run?.status).toBe('failed');
    expect(mocks.provider).not.toHaveBeenCalled();
    run = null; messages = [];
    scripted(decision('Successfully updated bridge.'));
    const unverified = await sendAssistantMessage({ ...scope, clientMessageId: 'other', content: 'Update bridge.' });
    expect(unverified.run?.status).toBe('failed');
    expect(unverified.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
  });

  it('refuses a resumed run before tools or inference when its saved provider settings changed', async () => {
    messages.push({ id: 'user', content: 'Read bridge.', conversation_id: 'conversation', role: 'user' });
    run = { id: 'saved', status: 'running', user_message_id: 'user', lease_until: new Date(0).toISOString(), result: {
      runtimeVersion: 'pi-v1', providerFingerprint: 'old-provider-settings', runtime: {
        messages: [{ role: 'assistant', content: '', toolCalls: [call('update', 'update', { id: 'bridge' })],
          providerContinuation: { anthropicContent: [{ type: 'thinking', thinking: 'Reasoned edit', signature: 'saved' }] } }], budget: createAgentRuntimeBudget(),
      },
    } };
    const result = await resumeAssistantRun({ ...scope, runId: 'saved' });
    expect(result.run?.status).toBe('failed');
    expect(result.run?.error).toContain('provider/model settings changed');
    expect(mocks.tool).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it('cancels an active provider request without publishing a late reply', async () => {
    let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    mocks.provider.mockImplementation(async (options: ServerGenerationOptions) => {
      await options.onBeforeRequest?.({ body: {}, serializedBody: '{}', inputTokens: 100, reservedOutputTokens: 1024, contextWindowTokens: 128000 });
      started();
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    });
    const sending = sendAssistantMessage({ ...scope, clientMessageId: 'user', content: 'Read bridge.' });
    await dispatched;
    await cancelAssistantRun({ ...scope, runId: run!.id });
    const result = await sending;
    expect(result.run?.status).toBe('cancelled');
    expect(result.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
    expect(run?.result.attemptedCalls).toBe(1);
  });
});
