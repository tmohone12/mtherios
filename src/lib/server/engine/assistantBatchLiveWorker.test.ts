import { afterAll, test, vi } from 'vitest';
import { closeDb } from '$lib/server/db/client';
import { processAssistantBatchJob } from './assistantBatchWorker';

vi.mock('$lib/server/turn/provider', async importOriginal => {
  const original = await importOriginal<typeof import('$lib/server/turn/provider')>();
  return { ...original, generateServerTextWithMetrics: (request: Parameters<typeof original.generateServerTextWithMetrics>[0]) => {
    if (process.env.MYTHENGINE_BATCH_LIVE_RESUME === '1') throw new Error('Resumed worker attempted a second provider request.');
    return original.generateServerTextWithMetrics(request);
  } };
});

const live = process.env.MYTHENGINE_BATCH_LIVE_WORKER === '1' ? test : test.skip;

live('runs one real-provider child or resumes its saved proposal', async () => {
  const projectId = process.env.MYTHENGINE_BATCH_LIVE_PROJECT_ID;
  const batchId = process.env.MYTHENGINE_BATCH_LIVE_BATCH_ID;
  const childId = process.env.MYTHENGINE_BATCH_LIVE_CHILD_ID;
  if (!projectId || !batchId || !childId) throw new Error('Live worker fixture IDs are missing.');
  await processAssistantBatchJob({ projectId, payload: { batchId, childId }, attemptCount: 1, maxAttempts: 3 });
}, 120_000);

afterAll(async () => { if (process.env.MYTHENGINE_BATCH_LIVE_WORKER === '1') await closeDb(); });
