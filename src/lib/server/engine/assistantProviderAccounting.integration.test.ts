import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, expect, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';

let baseUrl = '';
vi.mock('./llmSettings', async importOriginal => ({
  ...await importOriginal<typeof import('./llmSettings')>(),
  resolveServiceGeneration: async () => ({
    setting: null,
    profile: { providerType: 'openai', apiKey: 'local-fixture', baseUrl, contextWindowTokens: 128_000 },
    generation: { model: 'local-accounting-fixture', maxTokens: 1024 },
    systemPromptOverride: null,
    missingReason: null,
  }),
}));

import { createAssistantConversation, sendAssistantMessage } from './assistantConversations';

const integration = process.env.MYTHENGINE_ASSISTANT_ACCOUNTING_INTEGRATION === '1' ? test : test.skip;

integration('persists mixed provider cost and a real timed-out attempt without inventing totals', async () => {
  const db = getDb();
  const projectId = `shelf_assistant_accounting_${randomUUID()}`;
  let server: Server | undefined;
  let requests = 0;
  try {
    server = createServer((_request, response) => {
      requests += 1;
      if (requests === 3) return; // Hold the local request open for the Assistant's real 60-second timeout.
      const toolCall = requests === 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        model: 'local-accounting-fixture',
        choices: [{ finish_reason: toolCall ? 'tool_calls' : 'stop', message: toolCall
          ? { content: null, tool_calls: [{ id: 'list-fixture', type: 'function', function: { name: 'list', arguments: '{"kind":"item"}' } }] }
          : { content: 'No documents are available.' } }],
        usage: toolCall
          ? { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.01 }
          : { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
      }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Assistant accounting fixture',${projectId})`);

    const mixed = await createAssistantConversation({ projectId });
    const mixedResult = await sendAssistantMessage({ projectId, conversationId: String(mixed.conversation.id),
      clientMessageId: `assistant_message_${randomUUID()}`, content: 'List the available documents.' });
    expect(requests).toBe(2);
    expect(mixedResult.run).toMatchObject({ status: 'completed', usage: {
      attemptedCalls: 2, completedCalls: 2, unaccountedCalls: 0,
      totalTokens: 210, providerCostUsd: null,
    } });
    expect(mixedResult.costBreakdowns[0].assistant.providerCostUsd).toBeNull();
    expect(mixedResult.messages.filter(message => message.role === 'assistant')).toHaveLength(1);

    const timedOut = await createAssistantConversation({ projectId });
    const started = Date.now();
    const timeoutResult = await sendAssistantMessage({ projectId, conversationId: String(timedOut.conversation.id),
      clientMessageId: `assistant_message_${randomUUID()}`, content: 'Say hello.' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(55_000);
    expect(requests).toBe(3);
    expect(timeoutResult.run).toMatchObject({ status: 'failed', usage: {
      attemptedCalls: 1, completedCalls: 0, unaccountedCalls: 1,
      totalTokens: null, providerCostUsd: null,
    } });
    expect(String(timeoutResult.run?.error)).toContain('timed out after 60000ms');
    expect(timeoutResult.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    await db.execute(sql`delete from shelves where id=${projectId}`);
  }
}, 120_000);

afterAll(async () => { if (process.env.MYTHENGINE_ASSISTANT_ACCOUNTING_INTEGRATION === '1') await closeDb(); });
