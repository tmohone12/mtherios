import { afterAll, test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { closeDb } from '$lib/server/db/client';
import { processAssistantBatchJob } from './assistantBatchWorker';

vi.mock('$lib/server/turn/provider', async importOriginal => ({ ...(await importOriginal<typeof import('$lib/server/turn/provider')>()),
  generateServerTextWithMetrics: vi.fn(async (request: { prompt: string; model: string }) => {
    if (process.env.MYTHENGINE_BATCH_RESTART_MODE !== 'provider') throw new Error('Saved batch proposal must not call the provider again.');
    await delay(3_000);
    const task = JSON.parse(request.prompt) as { records: Array<{ id: string }> };
    const text = JSON.stringify({ edits: task.records.map(record => ({ action: 'update', itemId: record.id,
      data: { notes: 'Concurrent worker edit.' } })) });
    return { text, model: request.model, endpoint: 'mock', finishReason: 'stop', durationMs: 3_000,
      promptChars: request.prompt.length, responseChars: text.length,
      usage: { requestTokens: 100, responseTokens: 50, totalTokens: 150, inputTokens: 100,
        cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 0,
        estimatedCostUsd: null, providerCostUsd: null } };
  }) }));

const restart = process.env.MYTHENGINE_BATCH_RESTART_WORKER === '1' ? test : test.skip;
restart('continues a saved batch proposal in a separate worker process', async () => {
  const projectId = process.env.MYTHENGINE_BATCH_RESTART_PROJECT_ID;
  const batchId = process.env.MYTHENGINE_BATCH_RESTART_BATCH_ID;
  const childId = process.env.MYTHENGINE_BATCH_RESTART_CHILD_ID;
  if (!projectId || !batchId || !childId) throw new Error('Restart fixture IDs are missing.');
  const startAt = Number(process.env.MYTHENGINE_BATCH_START_AT ?? 0);
  if (startAt > Date.now()) await delay(startAt - Date.now());
  await processAssistantBatchJob({ projectId, payload: { batchId, childId } });
}, 15_000);

afterAll(async () => { if (process.env.MYTHENGINE_BATCH_RESTART_WORKER === '1') await closeDb(); });
