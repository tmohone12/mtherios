import { afterEach, expect, it, vi } from 'vitest';
import { generateServerTextWithMetrics } from './provider';

afterEach(() => vi.unstubAllGlobals());

const tool = { name: 'read', description: 'Read a bounded record.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } };

it('normalizes a complete OpenAI-compatible native tool call without streaming partial JSON', async () => {
  let request: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"id":"item_1"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }), { status: 200 });
  }));
  const result = await generateServerTextWithMetrics({ profile: { providerType: 'openai', apiKey: 'test' } as any, model: 'gpt-4o-mini', system: 'Tools', prompt: 'Read item', tools: [tool], onTextDelta: () => { throw new Error('Native calls must not stream partial JSON.'); } });
  expect(request.stream).toBeUndefined();
  expect(request.parallel_tool_calls).toBe(false);
  expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read', arguments: { id: 'item_1' } }]);
});

it('normalizes an Anthropic tool-use block', async () => {
  let request: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { id: 'item_2' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 4 } }), { status: 200 });
  }));
  const result = await generateServerTextWithMetrics({ profile: { providerType: 'anthropic', apiKey: 'test', baseUrl: 'https://api.anthropic.com' } as any, model: 'claude-test', system: 'Tools', prompt: 'Read item', tools: [tool] });
  expect(request.tools).toEqual([{ name: 'read', description: tool.description, input_schema: tool.parameters }]);
  expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'read', arguments: { id: 'item_2' } }]);
});

it('enables and preserves multiple native calls for the GM planner', async () => {
  let request: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'call_scene', type: 'function', function: { name: 'read', arguments: '{"id":"scene"}' } },
      { id: 'call_actor', type: 'function', function: { name: 'read', arguments: '{"id":"actor"}' } },
    ] } }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }), { status: 200 });
  }));
  const result = await generateServerTextWithMetrics({ profile: { providerType: 'openai', apiKey: 'test' } as any, model: 'gpt-4o-mini', system: 'Tools', prompt: 'Read both', tools: [tool], parallelToolCalls: true });
  expect(request.parallel_tool_calls).toBe(true);
  expect(result.toolCalls?.map(call => call.id)).toEqual(['call_scene', 'call_actor']);
});

it('round trips native OpenAI tool IDs and private reasoning fields without an extra user prompt', async () => {
  const requests: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(requests.length === 1 ? {
      choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'private planning',
        reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }],
        tool_calls: [{ id: 'call_first', type: 'function', function: { name: 'read', arguments: '{"id":"source"}' } }] } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    } : { choices: [{ finish_reason: 'stop', message: { content: 'Cited answer.' } }], usage: { prompt_tokens: 25, completion_tokens: 5 } }), { status: 200 });
  }));
  const base = { profile: { providerType: 'openrouter', apiKey: 'test' } as any, model: 'deepseek/test', system: 'Tools', prompt: '', appendPrompt: false, tools: [tool], reasoningEffort: 'high' };
  const first = await generateServerTextWithMetrics({ ...base, messages: [{ role: 'user', content: 'Read source.' }] });
  await generateServerTextWithMetrics({ ...base, messages: [{ role: 'user', content: 'Read source.' }, first.message!, { role: 'tool', toolCallId: 'call_first', toolName: 'read', content: 'Exact source lines.' }] });
  expect(requests[1].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_first', content: 'Exact source lines.' });
  expect(requests[1].messages[2]).toMatchObject({ role: 'assistant', reasoning_content: 'private planning',
    reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }], tool_calls: [{ id: 'call_first', function: { name: 'read', arguments: '{"id":"source"}' } }] });
  expect(first.text).toBe(''); expect(first.message?.content).toBe(''); expect(requests[1].reasoning).toEqual({ effort: 'high' });
});

it('round trips Anthropic signed and redacted thinking and combines tool results in source order', async () => {
  const requests: any[] = [];
  const native = [{ type: 'thinking', thinking: 'Private reasoning.', signature: 'signed' }, { type: 'redacted_thinking', data: 'encrypted' },
    { type: 'tool_use', id: 'toolu_a', name: 'read', input: { id: 'a' } }, { type: 'tool_use', id: 'toolu_b', name: 'read', input: { id: 'b' } }];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ content: requests.length === 1 ? native : [{ type: 'text', text: 'Done.' }],
      stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 4 } }), { status: 200 });
  }));
  const base = { profile: { providerType: 'anthropic', apiKey: 'test', baseUrl: 'https://api.anthropic.com' } as any,
    model: 'claude-sonnet-4-6', system: 'Tools', prompt: '', appendPrompt: false, tools: [tool], maxTokens: 4096, reasoningEffort: 'low' };
  const first = await generateServerTextWithMetrics({ ...base, messages: [{ role: 'user', content: 'Read both.' }] });
  await generateServerTextWithMetrics({ ...base, messages: [{ role: 'user', content: 'Read both.' }, first.message!,
    { role: 'tool', toolCallId: 'toolu_a', content: 'a body' }, { role: 'tool', toolCallId: 'toolu_b', content: 'b error', isError: true }] });
  expect(requests[1].messages[1]).toEqual({ role: 'assistant', content: native });
  expect(requests[1].messages[2]).toEqual({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_a', content: 'a body' }, { type: 'tool_result', tool_use_id: 'toolu_b', content: 'b error', is_error: true },
  ] });
  expect(requests[1].thinking).toEqual({ type: 'adaptive' }); expect(requests[1].output_config).toEqual({ effort: 'low' });
  expect(first.text).toBe('');
});

it('awaits the exact request checkpoint and cancellation before dispatch', async () => {
  const abort = new AbortController();
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  await expect(generateServerTextWithMetrics({ profile: { providerType: 'openai', apiKey: 'test' } as any,
    model: 'gpt-4o-mini', system: 'Stable', prompt: 'Hello', maxRetries: 0, signal: abort.signal,
    onBeforeRequest: request => { expect(request.inputTokens).toBeGreaterThan(0); expect(request.body.messages).toHaveLength(2); abort.abort(new Error('Stopped before HTTP.')); },
  })).rejects.toThrow('Stopped before HTTP.');
  expect(fetchMock).not.toHaveBeenCalled();
});
