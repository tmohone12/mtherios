import { Agent, type AgentEvent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { createHash } from 'node:crypto';
import { createAssistantMessageEventStream, validateToolArguments, type AssistantMessage, type Message, type Model, type Api } from '@earendil-works/pi-ai';
import { countTokens } from '$lib/utils/tokens';
import { memoryRecallEvidence } from './memoryRecallEvidence';
import {
  generateServerTextWithMetrics, getProviderCapabilities,
  withServerProviderHooks,
  type NativeToolCall, type NativeToolDefinition, type ServerGenerationMessage,
  type ServerGenerationOptions, type ServerGenerationRequest, type ServerGenerationResult,
} from '$lib/server/turn/provider';

export const AGENT_RUNTIME_VERSION = 'pi-v1';
export interface AgentRuntimeLimits {
  maxRequests: number;
  maxToolCalls: number;
  maxTokens: number;
  timeoutMs: number;
  contextTokens?: number;
  maxCostUsd?: number;
  reservedCostPerRequestUsd?: number;
}
export const DEFAULT_AGENT_RUNTIME_LIMITS: AgentRuntimeLimits = {
  maxRequests: 8, maxToolCalls: 16, maxTokens: 120_000, timeoutMs: 120_000,
};
export interface AgentRuntimeBudgetState {
  modelRequests: number;
  toolCalls: number;
  consumedTokens: number;
  reservedTokens: number;
  consumedCostUsd: number;
  reservedCostUsd: number;
  unknownUsage: boolean;
  startedAt: number;
  deadlineAt: number;
  elapsedMs: number;
  pausedAt?: number;
  /** Terminal refusal survives restart; a truncated decision must never become executable. */
  stopReason?: string;
  /** Durable reservations prevent charging the same recorded decision twice on recovery. */
  toolReservations?: Record<string, string>;
}
export interface AgentRuntimeState { messages: ServerGenerationMessage[]; budget: AgentRuntimeBudgetState }
export function createAgentRuntimeBudget(overrides: Partial<AgentRuntimeLimits> = {}): AgentRuntimeBudgetState {
  const limits = { ...DEFAULT_AGENT_RUNTIME_LIMITS, ...overrides };
  return { modelRequests: 0, toolCalls: 0, consumedTokens: 0, reservedTokens: 0,
    consumedCostUsd: 0, reservedCostUsd: 0, unknownUsage: false,
    startedAt: Date.now(), deadlineAt: Date.now() + limits.timeoutMs, elapsedMs: 0 };
}
/** Saved service metadata is optional; reject malformed budgets instead of expanding them. */
export function configuredAgentRuntimeLimits(metadata: unknown): AgentRuntimeLimits {
  const value = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).agentBudget : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_AGENT_RUNTIME_LIMITS };
  const limits = { ...DEFAULT_AGENT_RUNTIME_LIMITS };
  for (const key of ['maxRequests', 'maxToolCalls', 'maxTokens', 'timeoutMs', 'contextTokens', 'maxCostUsd', 'reservedCostPerRequestUsd'] as const) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) continue;
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0 || (!['maxCostUsd', 'reservedCostPerRequestUsd'].includes(key) && !Number.isInteger(entry))) throw new Error(`Invalid agent budget: ${key}.`);
    limits[key] = entry;
  }
  return limits;
}

export interface AgentRuntimeToolResult { content: string; isError?: boolean; pause?: boolean; stopReason?: string; details?: unknown }
export interface AgentRuntimeOptions extends Partial<AgentRuntimeState> {
  system: string;
  tools: NativeToolDefinition[];
  generation: Omit<ServerGenerationOptions, 'system' | 'messages' | 'prompt' | 'tools'>;
  limits?: Partial<AgentRuntimeLimits>;
  signal?: AbortSignal;
  transport?: typeof generateServerTextWithMetrics;
  executeTool: (call: NativeToolCall, signal: AbortSignal) => Promise<AgentRuntimeToolResult>;
  onSave: (state: AgentRuntimeState, reason: 'request' | 'assistant' | 'tool' | 'stopped') => Promise<void>;
  onRequest?: (options: ServerGenerationOptions, index: number, request: ServerGenerationRequest) => Promise<void> | void;
  onGeneration?: (result: ServerGenerationResult, index: number, options: ServerGenerationOptions) => Promise<void> | void;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
  onContext?: (projection: AgentRuntimeContextProjection) => Promise<void> | void;
  prepareContext?: (state: AgentRuntimeState) => Promise<{ system?: string; systemDynamic?: string; systemCacheBoundaries?: number[]; messages?: ServerGenerationMessage[] }>;
  /** Investigation may finish after recorded tools to preserve one final, validated completion. */
  completionReserve?: () => { tokens: number; requests: number };
}
export interface AgentRuntimeResult extends AgentRuntimeState {
  status: 'completed' | 'paused' | 'stopped' | 'cancelled';
  reason: string | null;
  text: string;
  generations: ServerGenerationResult[];
}
export interface AgentRuntimeContextProjection {
  messages: ServerGenerationMessage[];
  omitted: Array<{ index: number; sourceRefs: Array<Record<string, unknown>> }>;
  inputTokens: number;
  fits: boolean;
}

function sourceHandles(value: unknown, output: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) { for (const item of value) sourceHandles(item, output); return output; }
  const record = value as Record<string, unknown>;
  const keys = ['sourceRef', 'sourceId', 'sourceIds', 'sourceHash', 'sha256', 'hash', 'path', 'relativePath', 'mountId', 'itemId', 'typeId', 'revision', 'afterRevision', 'receiptId', 'appliedReceiptId', 'applied', 'changedFields', 'answer', 'approvalId', 'lineStart', 'lineEnd', 'startLine', 'endLine', 'visibility', 'povId'];
  if (keys.some(key => record[key] !== undefined)) output.push(Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]])));
  for (const item of Object.values(record)) sourceHandles(item, output);
  return output;
}

/** Model-only projection; raw history, current questions and recent call/result pairs remain intact. */
export function compactAgentRuntimeMessages(messages: ServerGenerationMessage[], allowance: number): AgentRuntimeContextProjection {
  const projected = structuredClone(messages);
  const omitted: AgentRuntimeContextProjection['omitted'] = [];
  // Apply to recent and recovered memory recalls too. Durable history remains untouched.
  for (let index = 0; index < projected.length; index++) {
    const message = projected[index];
    if (message.role !== 'tool' || message.toolName !== 'recall') continue;
    try {
      const evidence = memoryRecallEvidence(JSON.parse(message.content));
      if (!evidence) continue;
      message.content = evidence.content;
      omitted.push({ index, sourceRefs: evidence.sourceRefs });
    } catch { /* Unrecognized receipts keep their existing admission/compaction rules. */ }
  }
  const tokens = () => countTokens(JSON.stringify(projected));
  const recentUser = messages.findLastIndex(message => message.role === 'user');
  const lastAssistant = messages.findLastIndex(message => message.role === 'assistant');
  // Compact old tool bodies only. Authoritative context and unresolved human decisions are never inferred away.
  for (let index = 0; index < projected.length && tokens() > allowance; index++) {
    const message = projected[index];
    if (message.role !== 'tool' || index >= Math.max(recentUser, lastAssistant - 3)) continue;
    let sourceRefs: Array<Record<string, unknown>> = [];
    try { sourceRefs = sourceHandles(JSON.parse(message.content)); } catch { continue; }
    const compacted = JSON.stringify({ omitted: 'Older tool body omitted from this request. Re-read the exact source before claiming details.', sourceRefs, toolCallId: message.toolCallId });
    if (compacted.length >= message.content.length) continue;
    message.content = compacted;
    omitted.push({ index, sourceRefs });
  }
  const inputTokens = tokens();
  return { messages: projected, omitted, inputTokens, fits: inputTokens <= allowance };
}

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type NativeAssistant = Extract<ServerGenerationMessage, { role: 'assistant' }>;
type BridgedAssistant = AssistantMessage & { nativeMessage?: NativeAssistant };

function piMessage(message: ServerGenerationMessage, model: Model<Api>): Message {
  if (message.role === 'user') return { ...message, timestamp: Date.now() };
  if (message.role === 'tool') return { role: 'toolResult', toolCallId: message.toolCallId, toolName: message.toolName ?? '',
    content: [{ type: 'text', text: message.content }], isError: message.isError === true, timestamp: Date.now() };
  return { role: 'assistant', content: [
    ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
    ...(message.toolCalls ?? []).map(call => ({ type: 'toolCall' as const, ...call, arguments: call.arguments as any })),
  ], api: model.api, provider: model.provider, model: model.id, usage: EMPTY_USAGE,
    stopReason: message.toolCalls?.length ? 'toolUse' : 'stop', timestamp: Date.now(), nativeMessage: message } as BridgedAssistant;
}

function nativeMessage(message: Message): ServerGenerationMessage | null {
  if (message.role === 'system') return null;
  if (message.role === 'user') return { role: 'user', content: typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('') };
  if (message.role === 'toolResult') return { role: 'tool', toolCallId: message.toolCallId, toolName: message.toolName,
    content: message.content.filter(block => block.type === 'text').map(block => block.text).join(''), isError: message.isError };
  if ((message as BridgedAssistant).nativeMessage) return (message as BridgedAssistant).nativeMessage!;
  return { role: 'assistant', content: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    toolCalls: message.content.filter(block => block.type === 'toolCall').map(call => ({ id: call.id, name: call.name, arguments: call.arguments })) };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function callSignature(call: NativeToolCall): string {
  return createHash('sha256').update(JSON.stringify({ name: call.name, arguments: call.arguments }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value)).digest('hex');
}

export interface AgentRuntimeBudgetScopeOptions {
  state: AgentRuntimeState;
  limits?: Partial<AgentRuntimeLimits>;
  signal?: AbortSignal;
  /** Outer turn stages reload after a nested narration runtime checkpoint. */
  reloadState?: () => Promise<AgentRuntimeState>;
  onSave: AgentRuntimeOptions['onSave'];
  onRequest?: AgentRuntimeOptions['onRequest'];
  onGeneration?: AgentRuntimeOptions['onGeneration'];
}
/** Account for existing specialist calls without introducing a second model/tool scheduler. */
export function withAgentRuntimeBudget<T>(input: AgentRuntimeBudgetScopeOptions, work: () => Promise<T>): Promise<T> {
  const limits = { ...DEFAULT_AGENT_RUNTIME_LIMITS, ...input.limits };
  // Parallel retrieval/specialist transports share one durable ledger. Only bookkeeping is serialized.
  let ledger: Promise<unknown> = Promise.resolve();
  const update = <R>(operation: () => Promise<R>): Promise<R> => {
    const pending = ledger.then(operation, operation);
    ledger = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const refresh = async () => {
    if (input.reloadState) {
      const fresh = await input.reloadState();
      input.state.messages = fresh.messages; input.state.budget = fresh.budget;
    }
  };
  const reject = async (reason: string): Promise<never> => {
    input.state.budget.stopReason ??= reason;
    await input.onSave(structuredClone(input.state), 'stopped');
    throw new Error(input.state.budget.stopReason);
  };
  return withServerProviderHooks({ signal: input.signal, beforeRequest: async (options, request) => {
    const reservation = await update(async () => {
    await refresh();
    const state = input.state, budget = state.budget;
    if (input.signal?.aborted) return reject('cancelled');
    if (budget.stopReason) return reject(budget.stopReason);
    if (Date.now() >= budget.deadlineAt) return reject('deadline_exceeded');
    if (budget.modelRequests >= limits.maxRequests) return reject('request_budget_exhausted');
    const tokens = request.inputTokens + request.reservedOutputTokens;
    const cost = request.reservedCostUsd ?? limits.reservedCostPerRequestUsd ?? 0;
    if (tokens + 512 > (limits.contextTokens ?? request.contextWindowTokens)) return reject('context_budget_exhausted');
    if (budget.consumedTokens + budget.reservedTokens + tokens > limits.maxTokens) return reject('token_budget_exhausted');
    const knownCost = request.reservedCostUsd != null || limits.reservedCostPerRequestUsd != null;
    if (limits.maxCostUsd != null && (!knownCost || budget.consumedCostUsd + budget.reservedCostUsd + cost > limits.maxCostUsd)) return reject(knownCost ? 'cost_budget_exhausted' : 'cost_reservation_unknown');
    budget.modelRequests++; budget.reservedTokens += tokens; budget.reservedCostUsd += cost;
    await input.onSave(structuredClone(state), 'request');
    await input.onRequest?.(options, budget.modelRequests, request);
    if (input.signal?.aborted) throw new Error('cancelled');
    return { tokens, cost, index: budget.modelRequests };
    });
    return async result => {
      await update(async () => {
      await refresh();
      const state = input.state, budget = state.budget;
      const { tokens, cost } = reservation;
      if (input.signal?.aborted) throw new Error('cancelled');
      budget.reservedTokens -= tokens; budget.reservedCostUsd -= cost;
      budget.consumedTokens += result.usage.totalTokens ?? tokens;
      budget.consumedCostUsd += result.usage.providerCostUsd ?? result.usage.estimatedCostUsd ?? cost;
      budget.unknownUsage ||= result.usage.totalTokens == null || (result.usage.providerCostUsd == null && result.usage.estimatedCostUsd == null);
      await input.onSave(structuredClone(state), 'request');
      await input.onGeneration?.(result, reservation.index, options);
      if (budget.consumedTokens + budget.reservedTokens > limits.maxTokens) await reject('token_budget_exhausted');
      if (limits.maxCostUsd != null && budget.consumedCostUsd + budget.reservedCostUsd > limits.maxCostUsd) await reject('cost_budget_exhausted');
      });
    };
  } }, work);
}

/** Pi owns scheduling; the caller owns durable effects, leases, revisions and domain permissions. */
export async function runAgentRuntime(input: AgentRuntimeOptions): Promise<AgentRuntimeResult> {
  const limits = { ...DEFAULT_AGENT_RUNTIME_LIMITS, ...input.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (!['maxCostUsd', 'reservedCostPerRequestUsd'].includes(name) && !Number.isInteger(value)))) throw new Error(`Invalid agent limit: ${name}.`);
  }
  const state: AgentRuntimeState = { messages: structuredClone(input.messages ?? []), budget: structuredClone(input.budget ?? createAgentRuntimeBudget(limits)) };
  const budget = state.budget;
  for (const key of ['modelRequests', 'toolCalls', 'consumedTokens', 'reservedTokens', 'consumedCostUsd', 'reservedCostUsd', 'elapsedMs'] as const) {
    if (!Number.isFinite(budget[key]) || budget[key] < 0) throw new Error(`Invalid saved agent budget: ${key}.`);
  }
  if (!Number.isFinite(budget.deadlineAt)) throw new Error('Invalid saved agent deadline.');
  const invocationStarted = Date.now();
  const priorElapsed = budget.elapsedMs;
  if (budget.pausedAt != null) { budget.deadlineAt = Date.now() + Math.max(0, limits.timeoutMs - budget.elapsedMs); delete budget.pausedAt; }
  let reason: string | null = budget.stopReason ?? null, paused = false, handedOff = false, persistenceError: unknown;
  let system = input.system, systemDynamic = input.generation.systemDynamic;
  let systemCacheBoundaries = input.generation.systemCacheBoundaries;
  let preparedMessages: ServerGenerationMessage[] | undefined;
  const generations: ServerGenerationResult[] = [];
  const lifecycle = new AbortController();
  const fail = (code: string) => { reason ??= budget.stopReason ?? code; budget.stopReason = reason; };
  const guard = () => {
    reason ??= budget.stopReason ?? null;
    if (input.signal?.aborted || lifecycle.signal.aborted) throw new Error(reason ?? 'cancelled');
    if (Date.now() >= budget.deadlineAt) { fail('deadline_exceeded'); throw new Error(reason!); }
    if (reason || paused) throw new Error(reason ?? 'paused');
  };
  const save = async (kind: Parameters<AgentRuntimeOptions['onSave']>[1]) => {
    budget.elapsedMs = Math.min(limits.timeoutMs, priorElapsed + Date.now() - invocationStarted);
    try { await input.onSave(structuredClone(state), kind); } catch (error) { persistenceError = error; fail('checkpoint_failed'); throw error; }
  };
  const model: Model<Api> = { id: input.generation.model ?? 'configured-agent', name: 'MythEngine agent',
    api: ['anthropic', 'anthropic-proxy'].includes(input.generation.profile.providerType) ? 'anthropic-messages' : 'openai-completions', provider: input.generation.profile.providerType, baseUrl: '', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: getProviderCapabilities(input.generation.profile, input.generation.model).maxContextTokens,
    maxTokens: input.generation.maxTokens ?? 4096 };
  const execute = async (call: NativeToolCall): Promise<AgentRuntimeToolResult> => {
    guard();
    if (!input.tools.some(tool => tool.name === call.name)) { fail('unknown_tool'); throw new Error(reason!); }
    const reservations = budget.toolReservations ?? {};
    const signature = callSignature(call);
    if (Object.hasOwn(reservations, call.id)) {
      if (reservations[call.id] !== signature) { fail('tool_call_identity_conflict'); throw new Error(reason!); }
    } else {
      if (budget.toolCalls >= limits.maxToolCalls) { fail('tool_budget_exhausted'); throw new Error(reason!); }
      budget.toolCalls++;
      budget.toolReservations = { ...reservations, [call.id]: signature };
    }
    await save('tool');
    guard();
    let result: AgentRuntimeToolResult;
    try { result = await abortable(input.executeTool(call, lifecycle.signal), lifecycle.signal); }
    catch (error) { fail(lifecycle.signal.aborted ? reason ?? 'cancelled' : 'tool_execution_failed'); throw error; }
    guard();
    if (result.stopReason) fail(result.stopReason);
    paused = result.pause === true;
    if (paused) budget.pausedAt = Date.now();
    return result;
  };
  const recordTool = async (message: Extract<ServerGenerationMessage, { role: 'tool' }>) => {
    state.messages.push(message);
    await save('tool');
  };
  const tools: AgentTool[] = input.tools.map(tool => ({ ...tool, label: tool.name, parameters: tool.parameters as AgentTool['parameters'],
    executionMode: 'sequential', execute: async (id, args) => {
      const result = await execute({ id, name: tool.name, arguments: args as Record<string, unknown> });
      return { content: [{ type: 'text', text: result.content }], details: result.details, isError: result.isError, terminate: result.pause };
    } }));
  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const stopped = (code: string) => {
      const error: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider,
        model: model.id, usage: EMPTY_USAGE, stopReason: lifecycle.signal.aborted ? 'aborted' : 'error', errorMessage: code, timestamp: Date.now() };
      stream.push({ type: 'error', reason: error.stopReason as 'error' | 'aborted', error });
    };
    void (async () => {
      let reservedTokens = 0, reservedCost = 0;
      try {
        guard();
        if (budget.modelRequests >= limits.maxRequests) { fail('request_budget_exhausted'); throw new Error(reason!); }
        const messages = context.messages.flatMap(message => { const native = nativeMessage(message); return native ? [native] : []; });
        const generation: ServerGenerationOptions = { ...input.generation, system, systemDynamic, systemCacheBoundaries, messages, prompt: '', appendPrompt: false,
          tools: input.tools, parallelToolCalls: false, maxRetries: 0, providerOutputLimit: false, agentBudgetManaged: true,
          signal: lifecycle.signal, timeoutMs: Math.max(1, Math.min(input.generation.timeoutMs ?? limits.timeoutMs, budget.deadlineAt - Date.now())), onTextDelta: input.tools.length ? undefined : input.generation.onTextDelta,
          onBeforeRequest: async request => {
            guard();
            const tokens = request.inputTokens + request.reservedOutputTokens;
            if (tokens + 512 > (limits.contextTokens ?? request.contextWindowTokens)) { fail('context_budget_exhausted'); throw new Error(reason!); }
            const completion = input.completionReserve?.();
            if (completion && state.messages.at(-1)?.role === 'tool' && budget.modelRequests > 0
              && budget.consumedTokens + budget.reservedTokens + completion.tokens <= limits.maxTokens
              && budget.modelRequests + completion.requests <= limits.maxRequests
              && (budget.consumedTokens + budget.reservedTokens + tokens + completion.tokens > limits.maxTokens
                || budget.modelRequests + 1 + completion.requests > limits.maxRequests)) {
              handedOff = true;
              throw new Error('completion_budget_reserved');
            }
            if (budget.modelRequests >= limits.maxRequests) { fail('request_budget_exhausted'); throw new Error(reason!); }
            const cost = limits.reservedCostPerRequestUsd ?? 0;
            if (budget.consumedTokens + budget.reservedTokens + tokens > limits.maxTokens) { fail('token_budget_exhausted'); throw new Error(reason!); }
            if (limits.maxCostUsd != null && (!cost || budget.consumedCostUsd + budget.reservedCostUsd + cost > limits.maxCostUsd)) {
              fail(cost ? 'cost_budget_exhausted' : 'cost_reservation_unknown'); throw new Error(reason!);
            }
            reservedTokens = tokens; reservedCost = cost;
            budget.modelRequests++;
            budget.reservedTokens += tokens; budget.reservedCostUsd += cost;
            await save('request');
            await input.onRequest?.(generation, budget.modelRequests, request);
            await input.generation.onBeforeRequest?.(request);
            guard();
          },
        };
        guard();
        const result = await abortable((input.transport ?? generateServerTextWithMetrics)(generation), lifecycle.signal);
        guard();
        if (reservedTokens === 0) throw new Error('Agent transport omitted its pre-dispatch budget checkpoint.');
        budget.reservedTokens -= reservedTokens; budget.reservedCostUsd -= reservedCost;
        budget.consumedTokens += result.usage.totalTokens ?? reservedTokens;
        budget.consumedCostUsd += result.usage.providerCostUsd ?? result.usage.estimatedCostUsd ?? reservedCost;
        budget.unknownUsage ||= result.usage.totalTokens == null || (result.usage.providerCostUsd == null && result.usage.estimatedCostUsd == null);
        const native = result.message ?? { role: 'assistant' as const, content: result.text, ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}) };
        const callCount = native.toolCalls?.length ?? 0;
        const identities = new Map(Object.entries(budget.toolReservations ?? {}));
        for (const call of native.toolCalls ?? []) {
          const definition = tools.find(tool => tool.name === call.name);
          if (!definition) { fail('unknown_tool'); continue; }
          try {
            const args = validateToolArguments(definition, { type: 'toolCall', ...call, arguments: call.arguments as any });
            const signature = callSignature({ ...call, arguments: args });
            if (identities.has(call.id) && identities.get(call.id) !== signature) fail('tool_call_identity_conflict');
            identities.set(call.id, signature);
          } catch { fail('invalid_tool_arguments'); }
        }
        const newCallIds = new Set((native.toolCalls ?? []).filter(call => !Object.hasOwn(budget.toolReservations ?? {}, call.id)).map(call => call.id));
        if (budget.toolCalls + newCallIds.size > limits.maxToolCalls) fail('tool_budget_exhausted');
        if (native.toolCalls?.some(call => !input.tools.some(tool => tool.name === call.name))) fail('unknown_tool');
        const completedPlanError=result.finishReason==='error'&&typeof native.providerContinuation?.chatgptError==='string'?native.providerContinuation.chatgptError:null;
        if(completedPlanError)fail(completedPlanError);
        if (!callCount && !native.content.trim()) fail('empty_assistant_response');
        if (budget.consumedTokens > limits.maxTokens) fail('token_budget_exhausted');
        if (limits.maxCostUsd != null && budget.consumedCostUsd > limits.maxCostUsd) fail('cost_budget_exhausted');
        const stopReason = result.finishReason === 'length' || result.finishReason === 'max_tokens' ? 'length'
          : result.finishReason === 'error' ? 'error' : callCount ? 'toolUse' : 'stop';
        if (stopReason === 'length' || stopReason === 'error') fail(`provider_${stopReason}`);
        if (result.finishReason && !['stop', 'end_turn', 'tool_calls', 'tool_use', 'function_call', 'length', 'max_tokens', 'error'].includes(result.finishReason)) fail(`provider_${result.finishReason}`);
        generations.push(result);
        state.messages.push(native);
        await save('assistant');
        await input.onGeneration?.(result, budget.modelRequests, generation);
        guard();
        const message = piMessage(native, model) as AssistantMessage;
        message.stopReason = stopReason;
        message.usage = { ...EMPTY_USAGE, input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0,
          cacheRead: result.usage.cachedInputTokens ?? 0, cacheWrite: result.usage.cacheWriteTokens ?? 0, totalTokens: result.usage.totalTokens ?? 0,
          cost: { ...EMPTY_USAGE.cost, total: result.usage.providerCostUsd ?? result.usage.estimatedCostUsd ?? 0 } };
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: stopReason as 'stop' | 'toolUse' | 'length', message });
      } catch (error) {
        if (handedOff) { stopped('completion_budget_reserved'); return; }
        fail(lifecycle.signal.aborted ? reason ?? 'cancelled' : error instanceof Error ? error.message : 'provider_failed');
        stopped(reason!);
      }
    })();
    return stream;
  };
  const agent = new Agent({ streamFn, toolExecution: 'sequential', initialState: { model, systemPrompt: system, tools,
    messages: state.messages.map(message => piMessage(message, model)) },
    prepareRequest: async () => {
      guard();
      const prepared = await input.prepareContext?.(structuredClone(state));
      guard();
      if (prepared?.system !== undefined) system = prepared.system;
      if (prepared?.systemDynamic !== undefined) systemDynamic = prepared.systemDynamic;
      if (prepared?.systemCacheBoundaries !== undefined) systemCacheBoundaries = prepared.systemCacheBoundaries;
      preparedMessages = prepared?.messages;
      return undefined;
    },
    transformContext: async messages => {
      const native = preparedMessages ?? messages.flatMap(message => { const converted = nativeMessage(message); return converted ? [converted] : []; });
      const contextBudget = limits.contextTokens ?? model.contextWindow;
      const framing = countTokens(JSON.stringify({ system, systemDynamic, tools: input.tools })) + model.maxTokens + 1024;
      const projection = compactAgentRuntimeMessages(native, Math.max(0, contextBudget - framing));
      await input.onContext?.(projection);
      if (!projection.fits) fail('context_budget_exhausted');
      return [...messages.filter(message => message.role === 'system'), ...projection.messages.map(message => piMessage(message, model))];
    },
    beforeToolCall: async () => reason || paused || lifecycle.signal.aborted
      ? { block: true, reason: paused ? 'Skipped after an interaction paused this batch.' : reason ?? 'cancelled', terminate: true } : undefined,
    finishTurn: async ({ message }) => {
      if (reason || paused || message.stopReason === 'error' || message.stopReason === 'aborted' || !message.content.some(block => block.type === 'toolCall')) return { action: 'end' };
      return undefined;
    },
  });
  agent.subscribe(async event => {
    if (event.type === 'message_end' && event.message.role === 'toolResult' && !lifecycle.signal.aborted) {
      await recordTool(nativeMessage(event.message) as Extract<ServerGenerationMessage, { role: 'tool' }>);
    }
    await input.onEvent?.(event);
  });
  const abort = () => { fail('cancelled'); lifecycle.abort(input.signal?.reason); agent.abort(); };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timer = setTimeout(() => { fail('deadline_exceeded'); lifecycle.abort(new Error(reason!)); agent.abort(); }, Math.max(0, budget.deadlineAt - Date.now()));
  try {
    await withAgentRuntimeBudget({ state, limits, signal: lifecycle.signal, onSave: async (_state, kind) => save(kind),
      onRequest: input.onRequest, onGeneration: input.onGeneration }, async () => {
    guard();
    // Recovery finishes the recorded assistant decision, rather than asking the model for it again.
    const lastAssistant = state.messages.findLastIndex(message => message.role === 'assistant');
    const pending = lastAssistant >= 0 ? (state.messages[lastAssistant] as NativeAssistant).toolCalls ?? [] : [];
    for (const call of pending) {
      if (state.messages.slice(lastAssistant + 1).some(message => message.role === 'tool' && message.toolCallId === call.id)) continue;
      if (paused) { await recordTool({ role: 'tool', toolCallId: call.id, toolName: call.name, content: 'Skipped after an interaction paused this batch.', isError: true }); continue; }
      const definition = tools.find(tool => tool.name === call.name);
      if (!definition) throw new Error('unknown_tool');
      const arguments_ = validateToolArguments(definition, { type: 'toolCall', ...call, arguments: call.arguments as any });
      const result = await execute({ ...call, arguments: arguments_ });
      await recordTool({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result.content, isError: result.isError });
    }
    if (!paused) {
      agent.state.messages = state.messages.map(message => piMessage(message, model));
      const last = state.messages.at(-1);
      if (last?.role === 'assistant') { /* Already completed checkpoint: no duplicate provider request. */ }
      else if (last) await agent.continue();
      else fail('missing_user_message');
    }
    });
  } catch (error) { fail(lifecycle.signal.aborted ? reason ?? 'cancelled' : error instanceof Error ? error.message : 'runtime_failed'); }
  finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); agent.clearAllQueues(); }
  if (!persistenceError) await save('stopped');
  if (persistenceError) throw persistenceError;
  const last = state.messages.findLast(message => message.role === 'assistant') as NativeAssistant | undefined;
  return { ...state, status: reason ? reason === 'cancelled' ? 'cancelled' : 'stopped' : paused ? 'paused' : 'completed',
    reason: reason ?? (handedOff ? 'completion_budget_reserved' : null), text: reason || paused || handedOff || last?.toolCalls?.length ? '' : last?.content ?? '', generations };
}
