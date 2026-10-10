import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { NativeToolCall, ServerGenerationOptions, ServerGenerationResult } from '$lib/server/turn/provider';
import { shippedAgentSettings } from '$lib/contracts/agentTools';

const mocks = vi.hoisted(() => ({ db: { execute: vi.fn(), transaction: vi.fn() }, provider: vi.fn(), prepare: vi.fn(), process: vi.fn(), settings: vi.fn(), sources: vi.fn(), command: vi.fn(), resolveService: vi.fn(), logs: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => mocks.db }));
vi.mock('$lib/server/turn/provider', async original => ({ ...await original<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: mocks.provider }));
vi.mock('$lib/server/turn/orchestrator', async original => ({ ...await original<typeof import('$lib/server/turn/orchestrator')>(), prepareServerTurnContext: mocks.prepare, processServerTurn: mocks.process }));
vi.mock('./agentSettings', () => ({ getAgentSettings: mocks.settings }));
vi.mock('./sourceFiles', () => ({ listSourceFiles: mocks.sources, searchSourceFiles: mocks.sources, readSourceFile: mocks.sources }));
vi.mock('./command', () => ({ executeEngineCommand: mocks.command }));
vi.mock('./apiCallLogs', () => ({ recordApiCallLog: mocks.logs }));
vi.mock('./llmSettings', () => ({ resolveServiceGeneration: mocks.resolveService, requireResolvedServiceProfile: () => { throw new Error('Legacy planner should use its recorded decision.'); } }));

import { cancelAgentRun, getAgentRun, respondAgentRun, retryFailedAgentRun, startAgentRun } from './agentRuns';
import { createAgentRuntimeBudget } from './agentRuntime';
import { agentRunHash } from './agentRunHash';
import { recordGenerationApiCalls } from './generationAccounting';
import { embedMemoryText } from '$lib/server/memory/embeddings';

type Row = Record<string, any>;
const dialect = new PgDialect();
const turn = { storyId: 'game', clientTurnId: 'turn', playerText: 'Find the bridge promise and the current city rule.', localVersion: 0 };
const profile = { providerType: 'openai' as const, apiKey: 'fixture', contextWindowTokens: 128000, customModels: [], fetchedModels: [], reasoningModels: [], hiddenModels: [], favoriteModels: [] };
const narration = { profile, system: 'Write the public scene.', prompt: 'The bridge keeper checks the permitted city rule.', model: 'scripted-gm', maxTokens: 1024 };
let run: Row | null, tools: Row[], interactions: Row[], events: Row[], canonicalCommits: number, piEnabled: boolean;
const call = (id: string, name: string, args: Record<string, unknown>): NativeToolCall => ({ id, name, arguments: args });
const response = (text: string, toolCalls?: NativeToolCall[]): ServerGenerationResult => ({ text, toolCalls, model: 'scripted-gm', endpoint: 'fixture', durationMs: 1, finishReason: toolCalls?.length ? 'tool_calls' : 'stop', promptChars: 100, responseChars: text.length,
  usage: { requestTokens: 100, responseTokens: 20, totalTokens: 120, inputTokens: 100, outputTokens: 20, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, providerCostUsd: null, estimatedCostUsd: null } });
const scripted = (...responses: ServerGenerationResult[]) => mocks.provider.mockImplementation(async (options: ServerGenerationOptions) => {
  await options.onBeforeRequest?.({ body: { messages: options.messages }, serializedBody: JSON.stringify({ messages: options.messages }), inputTokens: 100, reservedOutputTokens: 1024, contextWindowTokens: 128000 });
  const result = responses.shift();
  if (!result) throw new Error('Unexpected extra provider request.');
  return result;
});
function savedRun(messages: unknown[] = []) {
  run = { id: 'saved', project_id: 'project', game_id: 'game', client_turn_id: 'turn', request: { ...turn }, status: 'running', observations: [], usage: [], revision: 1, expires_at: new Date(Date.now() + 86400000).toISOString(), lease_until: new Date(0).toISOString(),
    continuation: { runtime: 'pi-v1', receipts: [], state: { messages, budget: createAgentRuntimeBudget() } }, result: null };
  return run;
}
async function recovered() {
  await getAgentRun({ runId: run!.id, storyId: 'game' });
  await vi.waitFor(() => expect(run?.status).not.toBe('running'), { timeout: 2000, interval: 10 });
  if (run?.status === 'committing') await vi.waitFor(() => expect(run?.status).not.toBe('committing'), { timeout: 2000, interval: 10 });
  return getAgentRun({ runId: run!.id, storyId: 'game' });
}

beforeEach(() => {
  vi.clearAllMocks(); run = null; tools = []; interactions = []; events = []; canonicalCommits = 0; piEnabled = true;
  mocks.logs.mockResolvedValue({ id: 'saved' });
  mocks.resolveService.mockResolvedValue({ profile: null, setting: {}, generation: {} });
  mocks.settings.mockImplementation(async () => ({ effective: { ...shippedAgentSettings, gmPiRuntime: piEnabled, gmQuestions: true }, sources: {} }));
  mocks.prepare.mockResolvedValue({ ctxWithTimeline: { story: { id: 'game', currentTurn: 0, currentLocationId: 'bridge' }, recentEntries: [], scenePov: null }, authoredContext: { fingerprint: 'authored-fixture' },
    prompt: { messages: [], contextRecords: [], stableContextRecords: [], dialogueSourceIds: [] }, narrativeContextRecords: [], narrativeContextSource: '', stableContextSent: '', narrativeService: { setting: { metadata: {} } }, narrativeGeneration: { model: 'scripted-gm', maxTokens: 1024 }, narrativeProfile: profile, narrativePrompt: turn.playerText, narrativeSystem: 'GM fixture', narrativeSystemDynamic: '', narrativePromptCacheKey: 'fixture' });
  mocks.sources.mockImplementation(async (_authority: unknown, args: Row) => ({ sourceRef: args.sourceRef ?? 'content:promise', text: args.sourceRef === 'content:rule' ? 'Current city rule permits the promise.' : 'The promise refers to content:rule.', visibility: 'public', revision: '1:1', sha256: 'a'.repeat(64), startLine: 1, endLine: 1, truncated: false }));
  mocks.process.mockImplementation(async (_request: unknown, options: Row) => {
    const generated = options.generateNarration ? await options.generateNarration(narration) : response('Legacy completed scene.');
    options.signal?.throwIfAborted();
    if (run?.status !== 'committing' || options.agentRunId !== run.id) throw new Error('Canonical admission rejected stopped run.');
    canonicalCommits++;
    return { narration: generated.text, serverVersion: 1 };
  });
  mocks.db.transaction.mockImplementation((callback: (db: typeof mocks.db) => Promise<unknown>) => callback(mocks.db));
  mocks.db.execute.mockImplementation(async (statement: SQL) => {
    const { sql, params } = dialect.sqlToQuery(statement), query = sql.replace(/\s+/g, ' ');
    if (query.includes('as embedding_revision')) return [{ embedding_revision: 'fixture-revision' }];
    if (query.startsWith('select id,shelf_id from stories')) return [{ id: 'game', shelf_id: 'project' }];
    if (query.startsWith('select id,request from agent_runs')) return run?.client_turn_id === params[1] ? [structuredClone(run)] : [];
    if (query.startsWith('select * from agent_runs')) return run ? [structuredClone(run)] : [];
    if (query.startsWith('select id from agent_runs')) return run && ['running', 'awaiting_input', 'committing'].includes(run.status) ? [{ id: run.id }] : [];
    if (query.startsWith('select id from story_entries')) return canonicalCommits ? [{ id: 'narration_turn' }] : [];
    if (query.startsWith('insert into agent_runs')) {
      run = { ...savedRun(), id: params[0], project_id: params[1], game_id: params[2], client_turn_id: params[3], request: JSON.parse(String(params[4])), continuation: JSON.parse(String(params[5])), lease_until: new Date(Date.now() + 30000).toISOString() };
      return [];
    }
    if (query.startsWith('update agent_runs')) {
      if (!run) return [];
      if (query.includes('lease_until < now()') && new Date(run.lease_until).getTime() >= Date.now()) return [];
      const set = query.split(' where ')[0];
      for (const [_, column, index] of set.matchAll(/([a-z_]+)=\$(\d+)(?:::jsonb)?/g)) {
        const value = params[Number(index) - 1];
        run[column] = ['continuation', 'pending_decision', 'result', 'observations', 'usage'].includes(column) && value !== null ? JSON.parse(String(value)) : value;
      }
      const status = set.match(/status='([^']+)'/); if (status) run.status = status[1];
      if (set.includes('revision=revision+1')) run.revision++;
      if (set.includes('lease_until=now()')) run.lease_until = new Date(Date.now() + 30000).toISOString();
      return query.includes('returning id') ? [{ id: run.id }] : [];
    }
    if (query.startsWith('insert into agent_run_events')) { events.push({ seq: events.length + 1, event_type: params[1], data: JSON.parse(String(params[2])) }); return []; }
    if (query.startsWith('select seq,event_type,data')) return structuredClone(events).reverse();
    if (query.startsWith('select count(*)::int as count from agent_tool_calls')) return [{ count: tools.length }];
    if (query.startsWith('insert into agent_tool_calls')) {
      const tool = { run_id: params[0], call_id: params[1], tool: params[2], args_hash: params[3], args: JSON.parse(String(params[4])), status: 'reserved' }; tools.push(tool); return [structuredClone(tool)];
    }
    if (query.startsWith('update agent_tool_calls')) {
      const tool = tools.find(value => value.call_id === params.at(-1));
      if (tool) { tool.status = 'completed'; tool.result = JSON.parse(String(params[0])); }
      return [];
    }
    if (query.startsWith('select * from agent_tool_calls') || query.startsWith('select status,result,error from agent_tool_calls')) return structuredClone(tools.filter(value => value.call_id === params[1]));
    if (query.startsWith('select status from agent_tool_calls')) return structuredClone(tools.filter(value => value.call_id === params[1]));
    if (query.startsWith('select tool,call_id')) return structuredClone(tools);
    if (query.startsWith('select call_id,result')) return query.includes("tool='read'") ? structuredClone(tools.filter(value => value.tool === 'read' && value.status === 'completed' && value.result?.visibility === 'public')) : [];
    if (query.startsWith('insert into agent_interactions')) { const roll = query.includes("'roll'"); interactions.push({ id: params[0], run_id: params[1], call_id: params[2], kind: roll ? 'roll' : 'question', prompt: params[3], options: roll ? [] : JSON.parse(String(params[4])), options_meta: JSON.parse(String(params[roll ? 4 : 5])), status: 'pending', revision: 1, expires_at: new Date(Date.now() + 86400000).toISOString() }); return []; }
    if (query.startsWith('select * from agent_interactions')) return structuredClone(interactions.filter(value => value.id === params[0]));
    if (query.startsWith('select id from agent_interactions')) return structuredClone(interactions.filter(value => value.call_id === params[1]));
    if (query.startsWith('select prompt,options')) return structuredClone(interactions.filter(value => value.status === 'answered'));
    if (query.startsWith('select id,kind,prompt')) return structuredClone(interactions);
    if (query.startsWith('update agent_interactions')) {
      if (query.includes("status='answered'")) { const interaction = interactions.find(value => value.id === params[1]); if (interaction) { interaction.status = 'answered'; interaction.response = JSON.parse(String(params[0])); interaction.revision++; } }
      else for (const interaction of interactions) if (interaction.status === 'pending') interaction.status = 'cancelled';
      return [];
    }
    if (query.startsWith('select t.call_id')) return [];
    throw new Error(`Unimplemented fixture SQL: ${query}`);
  });
});

describe('durable production GM Pi owner with scripted transport', () => {
  it('completes a large-context dice turn by preserving narration capacity instead of requesting an extra draft', async () => {
    const prepared = await mocks.prepare();
    prepared.narrativePrompt = 'Saved campaign evidence. '.repeat(6500);
    prepared.narrativeGeneration.maxTokens = 8192;
    mocks.prepare.mockResolvedValue(prepared);
    const admitted: string[] = [];
    mocks.provider.mockImplementation(async (options: ServerGenerationOptions) => {
      const investigating = Boolean(options.tools?.length);
      await options.onBeforeRequest?.({body: {}, serializedBody: '{}', inputTokens: investigating ? 43267 : 38000,
        reservedOutputTokens: 8192, contextWindowTokens: 1048576});
      admitted.push(investigating ? 'investigation' : 'narration');
      const result = response(investigating ? '' : 'The saved dice result resolves the crossing.',
        investigating ? [call('roll-once', 'gmRollDice', {reason: 'Resolve the crossing.', diceExpression: '1d1+2'})] : undefined);
      result.usage.totalTokens = investigating ? 41515 : 39000;
      return result;
    });
    const completed = await startAgentRun({turn}, 'game');
    expect(completed.status, String(completed.error)).toBe('completed');
    expect(admitted).toEqual(['investigation', 'narration']);
    expect(run!.continuation.state.budget).toMatchObject({modelRequests: 2, consumedTokens: 80515, reservedTokens: 0});
    expect(run!.continuation.state.budget.stopReason).toBeUndefined();
    expect(run!.continuation.limits.maxTokens).toBe(120000);
    expect(run!.continuation.receipts.map((r: Row) => r.stage)).toEqual(['investigation', 'narration']);
    expect(events.some(event => event.event_type === 'runtime.handoff')).toBe(true);
    expect(tools.filter(t => t.tool === 'gmRollDice')).toHaveLength(1);
    expect(canonicalCommits).toBe(1);
  });
  it('survives the failed recall shape, refreshes preparation, and rereads exact evidence within the original request budget', async () => {
    const prepared = await mocks.prepare(); mocks.prepare.mockClear();
    const fetched = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }], usage: { prompt_tokens: 7, total_tokens: 7 } })));
    vi.stubGlobal('fetch', fetched);
    const config = { provider: 'openai-compatible', model: 'fixture-embedding', baseUrl: 'https://fixture.test', apiKey: 'fixture', customUrl: '', batchSize: 8, dimensions: 2 };
    mocks.prepare.mockImplementation(async () => {
      await embedMemoryText('letter action', config); await embedMemoryText('letter scene', config);
      return structuredClone(prepared);
    });
    const raw = { storyId: 'game', query: 'letter', packet: '[memory-letter] "Escort leaves at dawn." Unverified report.', renderedItems: [{ id: 'memory-letter', text: 'Escort leaves at dawn.' }],
      nodes: Array.from({ length: 5 }, (_, i) => ({ id: i ? 'other-'+i : 'memory-letter', summary: 'Raw summary '.repeat(2500),
        visibility: 'secret', sourceEntryIds: ['entry-letter'], metadata: { sourcePosition: 142 } })),
      retrievalTrace: Array.from({ length: 32 }, (_, i) => ({ included: false, sourceEntryIds: Array.from({ length: 200 }, (_, j) => `excluded_private_source_${i}_${j}`) })) };
    mocks.command.mockImplementation(async (input: Row) => ({ status: 'succeeded', result: input.command === 'memory.retrieve' ? raw : {
      record: { id: 'entry-letter', content: 'Exact quote: "Escort leaves at dawn."', serverVersion: 1 } } }));
    scripted(response('', [call('memory-call', 'recall', { command: 'memory.retrieve', args: { query: 'letter' } })]),
      response('', [call('source-call', 'recall', { command: 'world.record.get', args: { type: 'transcript', recordId: 'entry-letter' } })]),
      response('Evidence ready.'), response('The letter contains the escort report.'));
    try {
      const completed = await startAgentRun({ turn }, 'game');
      expect(completed.status, String(completed.error)).toBe('completed');
      expect(mocks.prepare.mock.calls.length).toBeGreaterThanOrEqual(4); // Fresh state, no cached scene.
      expect(fetched).toHaveBeenCalledTimes(2);
      expect(run!.continuation.state.budget).toMatchObject({ modelRequests: 6, toolCalls: 2, reservedTokens: 0 });
      expect(run!.continuation.limits.maxRequests).toBe(8);
      expect(tools.find(t => t.call_id === 'memory-call')!.result).toEqual(raw);
      expect(run!.continuation.state.messages.find((m: any) => m.toolCallId === 'memory-call').content).toContain('retrievalTrace');
      const research = mocks.provider.mock.calls[1][0] as ServerGenerationOptions;
      const projected = research.messages!.find(m => m.role === 'tool' && m.toolCallId === 'memory-call')!;
      expect(projected.content).toContain(raw.packet.replaceAll('"', '\\"'));
      expect(projected.content).toContain('entry-letter');
      expect(projected.content).not.toContain('excluded_private_source');
      expect(projected.content.length).toBeLessThan(12000);
      expect(mocks.command.mock.calls[1][0]).toMatchObject({ command: 'world.record.get', args: { type: 'transcript', recordId: 'entry-letter' } });
      expect(mocks.provider.mock.calls[2][0].messages.find((m: any) => m.toolCallId === 'source-call').content).toContain('Exact quote');
      expect(canonicalCommits).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(['configured', 'missing_profile', 'other_model'])('sends bounded consequential-choice guidance with Jev %s', async configuration => {
    mocks.resolveService.mockResolvedValue({
      profile: configuration === 'missing_profile' ? null : profile,
      setting: {}, generation: { model: configuration === 'other_model' ? 'scripted-gm' : 'typesafe/jev-1.13' },
    });
    scripted(response('Ready.'), response('The captain considers the offer.'));
    const completed = await startAgentRun({ turn }, 'game');
    expect(completed.status, String(completed.error)).toBe('completed');
    const request = mocks.provider.mock.calls[0][0] as ServerGenerationOptions;
    expect(request.tools?.some(tool => tool.name === 'askJev')).toBe(configuration === 'configured');
    expect(request.system).toContain("When a named NPC's consequential choice is uncertain, use askJev with that actor's ID and two to five concrete plausible actions.");
    expect(request.system).toContain("Set purpose to immediate_response when the options answer this player's immediate action");
    expect(request.system).toContain('A previous offer accepted by the player is settled evidence');
    expect(request.system).toContain("Jev's actor-scoped answer is advice, not canon or a reason to override established behavior.");
    expect(request.system).toContain('Do not ask JEV for routine or already-settled reactions.');
    expect(request.system).toContain('Do not reveal private evidence as player/NPC knowledge.');
  });
  it.each(['running', 'committing'])('retains stream and cancellation callbacks for legacy %s completion', async status => {
    piEnabled = false;
    const execute = mocks.db.execute.getMockImplementation()!;
    mocks.db.execute.mockImplementation(async (statement: SQL) => {
      const result = await execute(statement);
      if (dialect.sqlToQuery(statement).sql.startsWith('insert into agent_runs')) {
        run!.status = status;
        run!.pending_decision = { kind: 'final', text: 'Legacy ready.' };
      }
      return result;
    });
    const callbacks = { onGmActivity: vi.fn(), onNarrationChunk: vi.fn(), signal: new AbortController().signal };
    const completed = await startAgentRun({ turn }, 'game', callbacks);
    expect(completed.status, String(completed.error)).toBe('completed');
    expect(mocks.process.mock.calls[0][1]).toMatchObject(callbacks);
    expect(canonicalCommits).toBe(1);
  });
  it('cannot reset a stopped Pi budget through the legacy planner retry command', async () => {
    savedRun();
    run!.status = 'failed';
    run!.error = 'Server LLM request timed out after 120000ms.';
    run!.continuation.state.budget.stopReason = 'deadline_exceeded';
    await expect(retryFailedAgentRun({ runId: 'saved', storyId: 'game' })).rejects.toThrow('Stopped Pi budgets cannot be reset');
    expect(run!.status).toBe('failed');
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it.each([true, false])('reuses a tool-free draft only when the final context matches: %s', async matches => {
    const draft = response('Buffered player-visible scene.'), fresh = response('Regenerated changed scene.');
    draft.usage.providerCostUsd = 0.02; fresh.usage.providerCostUsd = 0.05;
    scripted(draft, fresh);
    mocks.process.mockImplementation(async (_request: unknown, options: Row) => {
      const generated = await options.generateNarration({ ...narration, system: 'GM fixture', systemDynamic: '', prompt: matches ? turn.playerText : 'The action context changed.' });
      expect(generated.accounting).toMatchObject({ kind: 'reuse', sourceOperation: matches ? 'turn.pi.investigation' : 'turn.pi.narration' });
      expect(generated.usage.providerCostUsd).toBe(matches ? 0.02 : 0.05);
      await recordGenerationApiCalls({ storyId: 'game', serviceId: 'narrative', operation: 'turn.narration', profile, result: generated, status: 'success' });
      options.signal?.throwIfAborted();
      if (run?.status !== 'committing' || options.agentRunId !== run.id) throw new Error('Canonical admission rejected stopped run.');
      canonicalCommits++;
      return { narration: generated.text, serverVersion: 1 };
    });
    const completed = await startAgentRun({ turn }, 'game');
    expect(completed.status, String(completed.error)).toBe('completed');
    expect(mocks.provider).toHaveBeenCalledTimes(matches ? 1 : 2);
    expect(run?.continuation.state.budget.modelRequests).toBe(matches ? 1 : 2);
    expect(mocks.logs).toHaveBeenCalledTimes(matches ? 1 : 2);
    expect(mocks.logs.mock.calls.map(([row]) => row.operation)).toEqual(matches ? ['turn.pi.investigation'] : ['turn.pi.investigation', 'turn.pi.narration']);
    expect(completed.result).toMatchObject({ turn: { narration: matches ? 'Buffered player-visible scene.' : 'Regenerated changed scene.' } });
    expect(canonicalCommits).toBe(1);
  });
  it('follows four dependent source calls and retains native results through final narration', async () => {
    scripted(response('', [call('search', 'search', { kind: 'source', query: 'promise' })]),
      response('', [call('promise', 'read', { kind: 'source', sourceRef: 'content:promise' })]),
      response('', [call('rule', 'read', { kind: 'source', sourceRef: 'content:rule' })]),
      response('', [call('verify', 'read', { kind: 'source', sourceRef: 'content:rule', expectedRevision: '1:1' })]), response('Ready.'), response('The bridge keeper honors the promise.'));
    const completed = await startAgentRun({ turn }, 'game');
    expect(completed.status, String(completed.error)).toBe('completed');
    expect(canonicalCommits).toBe(1);
    expect(mocks.sources).toHaveBeenCalledTimes(4);
    const lastResearch = mocks.provider.mock.calls[4][0] as ServerGenerationOptions;
    expect(lastResearch.messages?.filter(message => message.role === 'tool')).toHaveLength(4);
    expect(lastResearch.messages?.find(message => message.role === 'tool' && message.toolCallId === 'promise')?.content).toContain('content:rule');
    expect(mocks.provider.mock.calls[5][0].tools ?? []).toEqual([]);
    expect(run?.continuation.receipts).toHaveLength(6);
    expect(run?.continuation.state.budget.modelRequests).toBe(6);
    expect(completed.result).toMatchObject({ turn: { narration: 'The bridge keeper honors the promise.' } });
    expect((await startAgentRun({ turn }, 'game')).id).toBe(completed.id);
    expect(canonicalCommits).toBe(1);
  });
  it('pauses a mixed batch before later calls and resumes with the accepted native answer', async () => {
    scripted(response('', [call('ask', 'askUserQuestion', { prompt: 'Cross the bridge?', options: [{ id: 'yes', label: 'Cross' }] }), call('later', 'read', { kind: 'source', sourceRef: 'content:rule' })]));
    const pending = await startAgentRun({ turn }, 'game');
    expect(pending.status, String(pending.error)).toBe('awaiting_input');
    expect(mocks.sources).not.toHaveBeenCalled();
    expect(run?.continuation.state.messages.find((value: Row) => value.toolCallId === 'later')).toMatchObject({ isError: true });
    scripted(response('Ready after the player answer.'), response('You cross the bridge.'));
    const completed = await respondAgentRun({ runId: pending.id, storyId: 'game', interactionId: interactions[0].id, expectedRevision: 1, response: { optionId: 'yes' } });
    expect(completed.status, String(completed.error)).toBe('completed');
    expect(mocks.provider.mock.calls[1][0].messages.find((value: Row) => value.toolCallId === 'ask').content).toBe('{"optionId":"yes"}');
    expect(canonicalCommits).toBe(1);
  });
  it('waits for a persisted player roll before later batch tools and accepts the server roll exactly once', async () => {
    scripted(response('', [call('roll', 'askPlayerToRoll', { reason: 'Test the crossing.', diceExpression: '1d1+2' }),
      call('later', 'read', { kind: 'source', sourceRef: 'content:rule' })]));
    const pending = await startAgentRun({ turn }, 'game');
    expect(pending.status, String(pending.error)).toBe('awaiting_input');
    expect(interactions[0]).toMatchObject({ kind: 'roll', status: 'pending', options_meta: { diceExpression: '1d1+2' } });
    expect(mocks.sources).not.toHaveBeenCalled();
    expect(canonicalCommits).toBe(0);
    expect(run!.continuation.state.messages.find((value: Row) => value.toolCallId === 'later')).toMatchObject({ isError: true });
    const answer = { runId: pending.id, storyId: 'game', interactionId: interactions[0].id, expectedRevision: 1, response: { roll: true } };
    await expect(respondAgentRun({ ...answer, response: { text: 'I rolled 99.' } })).rejects.toThrow('server roll action');
    expect(interactions[0].status).toBe('pending');
    scripted(response('Ready after the accepted server roll.'), response('The crossing check resolves.'));
    const completed = await respondAgentRun(answer);
    expect(completed.status, String(completed.error)).toBe('completed');
    expect(interactions[0]).toMatchObject({ status: 'answered', response: { diceExpression: '1d1+2', total: 3 } });
    const resumed = mocks.provider.mock.calls[1][0] as ServerGenerationOptions;
    expect(JSON.parse(resumed.messages!.find(message => message.role === 'tool' && message.toolCallId === 'roll')!.content)).toMatchObject({ total: 3 });
    expect(resumed.messages!.find(message => message.role === 'tool' && message.toolCallId === 'later')).toMatchObject({ isError: true });
    expect(mocks.sources).not.toHaveBeenCalled();
    const requests = mocks.provider.mock.calls.length;
    expect((await respondAgentRun(answer)).status).toBe('completed');
    expect(mocks.provider).toHaveBeenCalledTimes(requests);
    expect(canonicalCommits).toBe(1);
  });
  it.each([0, 45000])('recovers an early pause answer after wall deadline expiry with %ims active usage and closes the native batch', async elapsedMs => {
    const ask = call('ask', 'askUserQuestion', { prompt: 'Cross the bridge?', options: [{ id: 'yes', label: 'Cross' }] });
    const later = call('later', 'read', { kind: 'source', sourceRef: 'content:rule' });
    savedRun([{ role: 'user', content: turn.playerText }, { role: 'assistant', content: '', toolCalls: [ask, later] }]);
    run!.status = 'awaiting_input';
    run!.continuation.state.budget.modelRequests = 1;
    run!.continuation.state.budget.toolCalls = 2;
    run!.continuation.state.budget.deadlineAt = Date.now() - 3600000;
    run!.continuation.state.budget.elapsedMs = elapsedMs;
    expect(run!.continuation.state.budget.pausedAt).toBeUndefined();
    run!.continuation.state.budget.toolReservations = Object.fromEntries([ask, later].map(call => [call.id, agentRunHash({ name: call.name, arguments: call.arguments })]));
    tools.push({ run_id: 'saved', call_id: 'ask', tool: 'askUserQuestion', args: ask.arguments, status: 'reserved' });
    interactions.push({ id: 'early-question', run_id: 'saved', call_id: 'ask', kind: 'question', prompt: 'Cross the bridge?', options: [{ id: 'yes', label: 'Cross' }], options_meta: {}, status: 'pending', revision: 1, expires_at: new Date(Date.now() + 86400000).toISOString() });
    scripted(response('Ready after the accepted answer.'), response('You cross the bridge.'));
    const completed = await respondAgentRun({ runId: 'saved', storyId: 'game', interactionId: 'early-question', expectedRevision: 1, response: { optionId: 'yes' } });
    expect(completed.status, String(completed.error)).toBe('completed');
    const messages = mocks.provider.mock.calls[0][0].messages;
    expect(messages.find((value: Row) => value.toolCallId === 'ask')).toMatchObject({ content: '{"optionId":"yes"}', isError: false });
    expect(messages.find((value: Row) => value.toolCallId === 'later')).toMatchObject({ isError: true });
    expect(mocks.sources).not.toHaveBeenCalled();
    expect(canonicalCommits).toBe(1);
    expect(run!.continuation.state.budget.deadlineAt).toBeGreaterThan(Date.now());
    expect(run!.continuation.state.budget.deadlineAt).toBeLessThanOrEqual(Date.now() + 120000 - elapsedMs);
    expect(run!.continuation.state.budget.elapsedMs).toBeGreaterThanOrEqual(elapsedMs);
    expect(run!.continuation.state.budget.elapsedMs).toBeLessThan(elapsedMs + 5000);
  });
  it.each(['missing', 'reserved', 'completed'])('recovers a recorded decision from a %s tool receipt without duplicate execution', async status => {
    const read = call('read', 'read', { kind: 'source', sourceRef: 'content:rule' });
    const storedArgs = { ...read.arguments, startLine: 1, lineCount: 100 };
    savedRun([{ role: 'user', content: turn.playerText }, { role: 'assistant', content: '', toolCalls: [read] }]);
    run!.continuation.state.budget.modelRequests = 1;
    if (status !== 'missing') {
      run!.continuation.state.budget.toolCalls = 1;
      run!.continuation.state.budget.toolReservations = { read: agentRunHash({ name: read.name, arguments: read.arguments }) };
      tools.push({ run_id: 'saved', call_id: 'read', tool: 'read', args: storedArgs, args_hash: agentRunHash({ tool: 'read', args: storedArgs }), status,
      ...(status === 'completed' ? { result: { sourceRef: 'content:rule', text: 'Current city rule.', visibility: 'public' } } : {}) });
    }
    scripted(response('Ready.'), response('The keeper applies the current rule.'));
    const completed = await recovered();
    expect(completed.status, String(completed.error)).toBe('completed');
    expect(mocks.sources).toHaveBeenCalledTimes(status === 'completed' ? 0 : 1);
    expect(tools).toHaveLength(1);
    expect(mocks.provider.mock.calls[0][0].messages.find((value: Row) => value.toolCallId === 'read')).toBeTruthy();
    expect(canonicalCommits).toBe(1);
    expect(run!.continuation.state.budget).toMatchObject({ modelRequests: 3, toolCalls: 1 });
  });
  it('recovers a committing run from a cached narration without another provider call', async () => {
    savedRun([{ role: 'user', content: turn.playerText }, { role: 'assistant', content: 'Ready.' }]);
    run!.status = 'committing';
    const key = agentRunHash({ system: narration.system, systemDynamic: undefined, messages: undefined, prompt: narration.prompt, model: narration.model, maxTokens: narration.maxTokens, reasoningEffort: undefined });
    run!.continuation.narrations = { [key]: { result: response('Cached completed scene.') } };
    const completed = await recovered();
    expect(completed.status, String(completed.error)).toBe('completed');
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.logs).not.toHaveBeenCalled();
    expect(events.some(event => event.event_type === 'provider.reused')).toBe(true);
    expect(canonicalCommits).toBe(1);
    expect(completed.result).toMatchObject({ turn: { narration: 'Cached completed scene.' } });
  });
  it('cancels an active request before canonical admission and rejects a late provider completion', async () => {
    let started!: () => void, finish!: (value: ServerGenerationResult) => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    mocks.provider.mockImplementation(async () => { started(); return new Promise<ServerGenerationResult>(resolve => { finish = resolve; }); });
    const sending = startAgentRun({ turn }, 'game');
    await dispatched;
    await cancelAgentRun({ runId: run!.id, storyId: 'game' });
    finish(response('Late readiness.'));
    expect((await sending).status).toBe('cancelled');
    expect(mocks.process).not.toHaveBeenCalled();
    expect(canonicalCommits).toBe(0);
  });
  it('honors an existing legacy marker even after Pi is enabled for new runs', async () => {
    savedRun(); run!.continuation = []; run!.pending_decision = { kind: 'final', text: 'Legacy ready.' };
    const completed = await recovered();
    expect(completed.status, String(completed.error)).toBe('completed');
    expect(completed.continuation).toEqual({ runtime: 'legacy', budget: null, receipts: [] });
    expect(Array.isArray(run!.continuation)).toBe(true);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.process.mock.calls[0][1].generateNarration).toBeUndefined();
    run = null; piEnabled = false;
    const pending = await startAgentRun({ turn: { ...turn, clientTurnId: 'rollback' }, wait: false }, 'game');
    expect(pending.continuation).toEqual({ runtime: 'legacy', budget: null, receipts: [] });
  });
});
