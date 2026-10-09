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
