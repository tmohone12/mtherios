import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, expect, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { gearExample } from '$lib/contracts/content';
import { getDb, closeDb } from '$lib/server/db/client';
import { cancelAssistantBatch, createAssistantBatchPlan, queueAssistantBatch, readAssistantBatchPlan } from './assistantBatchPlan';
import { applyAssistantBatchChild } from './assistantBatchApply';
import { updateContent } from './content';
import { executeAssistantTool } from './assistantTools';
import { processAssistantBatchJob } from './assistantBatchWorker';
import { generateServerTextWithMetrics } from '$lib/server/turn/provider';
import { cancelAssistantConversationBatch, cancelAssistantRun, readAssistantConversation } from './assistantConversations';
import { agentRunHash } from './agentRunHash';

vi.mock('$lib/server/turn/provider', async importOriginal => ({ ...(await importOriginal<typeof import('$lib/server/turn/provider')>()),
  generateServerTextWithMetrics: vi.fn() }));

const integration = process.env.MYTHENGINE_BATCH_PLAN_INTEGRATION === '1' ? test : test.skip;
if (process.env.MYTHENGINE_BATCH_PLAN_INTEGRATION === '1') {
  vi.stubEnv('MYTHENGINE_BATCH_MAX_COST_USD', '10');
  vi.stubEnv('MYTHENGINE_BATCH_INPUT_USD_PER_MILLION', '1');
  vi.stubEnv('MYTHENGINE_BATCH_OUTPUT_USD_PER_MILLION', '2');
}

integration('enumerates all 97 scoped records into durable nonoverlapping child assignments', async () => {
  const db = getDb();
  const suffix = randomUUID();
  const projectId = `shelf_batch_${suffix}`;
  const gameId = `story_batch_${suffix}`;
  const typeId = `type_batch_${suffix}`;
  const conversationId = `assistant_conversation_${suffix}`;
  const messageId = `assistant_message_${suffix}`;
  const runId = `assistant_run_${suffix}`;
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Batch plan fixture',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Other game')`);
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition)
      values(${typeId},${projectId},'gear','gear','Gear',${JSON.stringify(gearExample)}::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,type_id,title,slug,data)
      select ${`item_batch_${suffix}_`} || n,${projectId},${typeId},'Gear ' || n,'gear-' || n,'{"notes":"original"}'::jsonb
      from generate_series(1,97) n`);
    await db.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,slug,data)
      values(${`item_other_${suffix}`},${projectId},${gameId},${typeId},'Other game gear','other-gear','{"notes":"other"}'::jsonb)`);
    await db.execute(sql`insert into assistant_conversations(id,project_id) values(${conversationId},${projectId})`);
    await db.execute(sql`insert into assistant_messages(id,conversation_id,role,content,status)
      values(${messageId},${conversationId},'user','Update all shared Gear notes.','committed')`);
    await db.execute(sql`insert into assistant_runs(id,conversation_id,user_message_id,status,request_fingerprint,lease_until)
      values(${runId},${conversationId},${messageId},'running','fixture',now()+interval '10 minutes')`);
    const request = { runId, callId: 'batch-1', conversationId, projectId, typeId, expectedTypeRevision: 1,
      objective: 'Update all shared Gear notes for the new catalog.',
      instructions: 'Keep every existing field except notes unchanged.', allowedFields: ['notes'], maxTargets: 100 };
    const planned = await createAssistantBatchPlan(request);
    expect(planned.batch).toMatchObject({ project_id: projectId, game_id: null, type_id: typeId, status: 'planned', type_revision: 1 });
    expect(planned.batch.budget).toMatchObject({ maxCostUsd: 10, inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxOutputTokens: 4096 });
    expect(planned.targets).toHaveLength(97);
    expect(planned.children).toHaveLength(10);
    expect(new Set(planned.targets.map(row => row.item_id)).size).toBe(97);
    expect(new Set(planned.targets.map(row => row.child_id)).size).toBe(10);
    expect(planned.targets.every(row => row.status === 'pending' && row.expected_revision === 1)).toBe(true);
    expect((planned.batch.sample as { records: unknown[] }).records).toHaveLength(3);
    const repeated = await createAssistantBatchPlan(request);
    expect(repeated.batch.id).toBe(planned.batch.id);
    await expect(createAssistantBatchPlan({ ...request, instructions: 'Use different instructions on the same call ID.' })).rejects.toThrow('reused with different instructions');
    await expect(createAssistantBatchPlan({ ...request, callId: 'batch-too-small', maxTargets: 96 })).rejects.toThrow('exceeds maxTargets');
    await expect(createAssistantBatchPlan({ ...request, callId: 'batch-stale', expectedTypeRevision: 2 })).rejects.toThrow('Batch type changed');
    const [count] = await db.execute(sql`select count(*)::integer as count from assistant_batches where run_id=${runId}`);
    expect(count.count).toBe(1);

    const queued = await queueAssistantBatch(String(planned.batch.id), { projectId });
    expect(queued.batch.status).toBe('running');
    await queueAssistantBatch(String(planned.batch.id), { projectId });
    const [jobs] = await db.execute(sql`select count(*)::integer as count from backend_jobs where project_id=${projectId} and type='assistant_batch_child'`);
    expect(jobs.count).toBe(10);
    await expect(queueAssistantBatch(String(planned.batch.id), { projectId: 'wrong-project' })).rejects.toThrow('not found in this scope');

    const conflictId = String(planned.targets[0].item_id);
    const skippedId = String(planned.targets.at(-1)?.item_id);
    await updateContent({ projectId, id: conflictId, expectedRevision: 1, expectedTypeRevision: 1,
      changes: { data: { notes: 'Human edit after batch planning.' } } });
    for (const child of planned.children) {
      const assigned = planned.targets.filter(target => target.child_id === child.id);
      const edits = assigned.map(target => target.item_id === skippedId
        ? { action: 'skip' as const, itemId: String(target.item_id), reason: 'Ambiguous specimen.' }
        : { action: 'update' as const, itemId: String(target.item_id), data: { notes: 'Batch edit.' } });
      const receipt = await applyAssistantBatchChild({ batchId: planned.batch.id, childId: child.id, projectId, edits });
      expect(receipt.child.status).toBe('completed');
      if (child.id === planned.children[0].id) {
        const repeated = await applyAssistantBatchChild({ batchId: planned.batch.id, childId: child.id, projectId, edits });
        expect(repeated.targets).toEqual(receipt.targets);
      }
    }
    const outcomes = await db.execute(sql`select status,count(*)::integer as count from assistant_batch_targets where batch_id=${planned.batch.id} group by status order by status`);
    expect(Object.fromEntries(outcomes.map(row => [row.status, row.count]))).toEqual({ applied: 95, conflict: 1, skipped: 1 });
    const [finished] = await db.execute(sql`select status from assistant_batches where id=${planned.batch.id}`);
    expect(finished.status).toBe('completed');
    expect(await processAssistantBatchJob({ projectId, attemptCount: 2, maxAttempts: 3,
      payload: { batchId: planned.batch.id, childId: planned.children[0].id } })).toMatchObject({ status: 'completed', replayed: true });
    const firstChild = planned.children[0];
    const firstEdits = planned.targets.filter(target => target.child_id === firstChild.id).map(target => ({ action: 'update' as const,
      itemId: String(target.item_id), data: { notes: 'Batch edit.' } }));
    expect((await applyAssistantBatchChild({ batchId: planned.batch.id, childId: firstChild.id, projectId, edits: firstEdits })).child.status).toBe('completed');
    const [human] = await db.execute(sql`select data,revision from content_items where id=${conflictId}`);
    expect(human).toMatchObject({ data: { notes: 'Human edit after batch planning.' }, revision: 2 });
    const [untouched] = await db.execute(sql`select data,revision from content_items where id=${skippedId}`);
    expect(untouched).toMatchObject({ data: { notes: 'original' }, revision: 1 });
    const [batchHistory] = await db.execute(sql`select count(*)::integer as count from content_revisions where project_id=${projectId}
      and target_kind='item' and actor->>'batchId'=${planned.batch.id}`);
    expect(batchHistory.count).toBe(95);
    const [lateEdited] = await db.execute(sql`select item_id,committed_revision from assistant_batch_targets
      where batch_id=${planned.batch.id} and status='applied' order by item_id limit 1`);
    await updateContent({ projectId, id: String(lateEdited.item_id), expectedRevision: Number(lateEdited.committed_revision),
      expectedTypeRevision: 1, changes: { data: { notes: 'Human edit after batch completion.' } } });

    const another = await createAssistantBatchPlan({ ...request, callId: 'batch-to-cancel' });
    await queueAssistantBatch(String(another.batch.id), { projectId });
    const cancelledView = await cancelAssistantConversationBatch({ projectId, conversationId, batchId: another.batch.id });
    expect(cancelledView.batches.find(batch => batch.id === another.batch.id)?.status).toBe('cancelled');
    const cancelled = await readAssistantBatchPlan(String(another.batch.id), { projectId });
    expect(cancelled.batch.status).toBe('cancelled');
    expect(cancelled.children.every(child => child.status === 'cancelled')).toBe(true);
    expect(cancelled.targets.every(target => target.status === 'cancelled')).toBe(true);
    const [cancelledJobs] = await db.execute(sql`select count(*)::integer as count from backend_jobs where project_id=${projectId}
      and payload->>'batchId'=${another.batch.id} and status='failed'`);
    expect(cancelledJobs.count).toBe(10);
    await expect(applyAssistantBatchChild({ batchId: another.batch.id, childId: another.children[0].id,
      projectId, edits: another.targets.filter(target => target.child_id === another.children[0].id).map(target =>
        ({ action: 'skip' as const, itemId: String(target.item_id), reason: 'Late child result.' })) })).rejects.toThrow('not available');
    expect((await cancelAssistantBatch(String(another.batch.id), { projectId })).batch.status).toBe('cancelled');

    const authority = { runId, conversationId, projectId, gameId: null };
    const toolPlan = { tool: 'subagent', callId: 'tool-plan', args: { action: 'plan', typeId,
      expectedTypeRevision: 1, objective: request.objective, instructions: request.instructions,
      allowedFields: ['notes'], maxTargets: 100 } };
    const toolReceipt = await executeAssistantTool(authority, toolPlan) as { batchId: string; status: string; targetCount: number };
    expect(toolReceipt).toMatchObject({ status: 'planned', targetCount: 97 });
    expect(await executeAssistantTool(authority, toolPlan)).toEqual(toolReceipt);
    await expect(executeAssistantTool(authority, { ...toolPlan, args: { ...toolPlan.args, objective: 'Different instructions for reused call ID.' } })).rejects.toThrow('reused with different arguments');
    expect(await executeAssistantTool(authority, { tool: 'subagent', callId: 'tool-dispatch',
      args: { action: 'dispatch', batchId: toolReceipt.batchId } })).toMatchObject({ batchId: toolReceipt.batchId, status: 'running' });
    const toolQueued = await readAssistantBatchPlan(toolReceipt.batchId, { projectId });
    expect(toolQueued.children).toHaveLength(10);
    await db.execute(sql`update assistant_messages set content='SECRET_PARENT_SENTINEL' where id=${messageId}`);
    const firstAssigned = toolQueued.targets.filter(target => target.child_id === toolQueued.children[0].id);
    vi.mocked(generateServerTextWithMetrics).mockResolvedValueOnce({ text: JSON.stringify({ edits: firstAssigned.map(target =>
      ({ action: 'update', itemId: target.item_id, data: { notes: 'Worker edit.' } })) }),
      model: String(toolQueued.batch.model), endpoint: 'mock', finishReason: 'stop', durationMs: 12,
      promptChars: 100, responseChars: 200,
      usage: { requestTokens: 100, responseTokens: 50, totalTokens: 150,
        inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 50,
        reasoningTokens: 0, estimatedCostUsd: null, providerCostUsd: null } });
    const workerResult = await processAssistantBatchJob({ projectId,
      payload: { batchId: toolReceipt.batchId, childId: String(toolQueued.children[0].id) } });
    expect(workerResult).toMatchObject({ status: 'completed', counts: { applied: firstAssigned.length } });
    const requestPacket = vi.mocked(generateServerTextWithMetrics).mock.calls.at(-1)?.[0];
    expect(requestPacket?.prompt).not.toContain('SECRET_PARENT_SENTINEL');
    expect(requestPacket?.tools).toBeUndefined();
    expect((JSON.parse(String(requestPacket?.prompt)) as { records: Array<{ id: string }> }).records.map(row => row.id))
      .toEqual(firstAssigned.map(row => row.item_id));
    const afterWorker = await readAssistantBatchPlan(toolReceipt.batchId, { projectId });
    expect(afterWorker.children[0].usage).toMatchObject({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.0002 });
    expect(afterWorker.children[0].report).toMatchObject({ providerAttempted: true, reservedOutputTokens: 4096 });
    const conversationView = await readAssistantConversation({ projectId, conversationId });
    const visibleBatch = conversationView.batches.find(batch => batch.id === toolReceipt.batchId);
    expect(visibleBatch?.children).toHaveLength(10);
    expect(visibleBatch?.children[0].targets).toHaveLength(10);
    expect(visibleBatch?.usage).toMatchObject({ totalTokens: 150, completedCalls: 1, unaccountedCalls: 0 });
    expect(conversationView.costBreakdowns.find(row => row.userMessageId === messageId)?.subagents)
      .toMatchObject({ attemptedCalls: 1, completedCalls: 1, totalTokens: 150, estimatedCostUsd: 0.0002 });
    await db.execute(sql`update assistant_batches set budget=jsonb_set(budget,'{maxCostUsd}','0.000001'::jsonb)
      where id=${toolReceipt.batchId}`);
    const callsBeforeCeiling = vi.mocked(generateServerTextWithMetrics).mock.calls.length;
    await expect(processAssistantBatchJob({ projectId,
      payload: { batchId: toolReceipt.batchId, childId: String(toolQueued.children[1].id) } })).rejects.toThrow('cost ceiling');
    expect(vi.mocked(generateServerTextWithMetrics).mock.calls).toHaveLength(callsBeforeCeiling);
    expect((await readAssistantBatchPlan(toolReceipt.batchId, { projectId })).children[1].status).toBe('failed');
    const budgetDenied = await readAssistantConversation({ projectId, conversationId });
    expect(budgetDenied.batches.find(batch => batch.id === toolReceipt.batchId)?.usage)
      .toMatchObject({ attemptedCalls: 1, completedCalls: 1, unaccountedCalls: 0 });
    await cancelAssistantBatch(toolReceipt.batchId, { projectId });

    const restartPlan = await createAssistantBatchPlan({ ...request, callId: 'stale-worker' });
    await queueAssistantBatch(String(restartPlan.batch.id), { projectId });
    const staleChild = restartPlan.children[0];
    await db.execute(sql`update assistant_batch_children set status='running',started_at=now() where id=${staleChild.id}`);
    await db.execute(sql`update backend_jobs set status='failed',last_error='Recovered exhausted worker lock.'
      where project_id=${projectId} and payload->>'childId'=${staleChild.id}`);
    const recovered = await readAssistantConversation({ projectId, conversationId });
    const recoveredBatch = recovered.batches.find(batch => batch.id === restartPlan.batch.id);
    expect(recoveredBatch?.children[0].status).toBe('failed');
    expect(recoveredBatch?.children[0].targets.every(target => target.status === 'failed')).toBe(true);
    expect(recoveredBatch?.usage).toMatchObject({ totalTokens: null, attemptedCalls: 0, unaccountedCalls: 0 });
    await cancelAssistantBatch(String(restartPlan.batch.id), { projectId });

    const uncertain = await createAssistantBatchPlan({ ...request, callId: 'uncertain-provider' });
    await queueAssistantBatch(String(uncertain.batch.id), { projectId });
    await db.execute(sql`update assistant_batch_children set status='running',started_at=now(),report='{"providerAttempted":true}'::jsonb
      where id=${uncertain.children[0].id}`);
    const providerCalls = vi.mocked(generateServerTextWithMetrics).mock.calls.length;
    await expect(processAssistantBatchJob({ projectId, attemptCount: 2, maxAttempts: 3,
      payload: { batchId: uncertain.batch.id, childId: uncertain.children[0].id } })).rejects.toThrow('previous child provider request');
    expect(vi.mocked(generateServerTextWithMetrics).mock.calls).toHaveLength(providerCalls);
    expect((await readAssistantBatchPlan(String(uncertain.batch.id), { projectId })).children[0].status).toBe('failed');
    const uncertainView = await readAssistantConversation({ projectId, conversationId });
    expect(uncertainView.batches.find(batch => batch.id === uncertain.batch.id)?.usage)
      .toMatchObject({ totalTokens: null, attemptedCalls: 1, unaccountedCalls: 1 });
    await cancelAssistantBatch(String(uncertain.batch.id), { projectId });

    const resume = await createAssistantBatchPlan({ ...request, callId: 'resume-proposal' });
    await queueAssistantBatch(String(resume.batch.id), { projectId });
    const resumeEdits = resume.targets.filter(target => target.child_id === resume.children[0].id).map(target =>
      ({ action: 'update' as const, itemId: String(target.item_id), data: { notes: 'Resumed edit.' } }));
    await db.execute(sql`update assistant_batch_children set status='running',started_at=now(),
      report=${JSON.stringify({ providerAttempted: true, proposal: { edits: resumeEdits }, decisionHash: agentRunHash(resumeEdits) })}::jsonb
      where id=${resume.children[0].id}`);
    await db.execute(sql`create or replace function assistant_batch_restart_delay() returns trigger as $$
      begin perform pg_sleep(0.35); return new; end $$ language plpgsql`);
    await db.execute(sql`create trigger assistant_batch_restart_delay_trigger before update on content_items
      for each row when (new.project_id like 'shelf_batch_%') execute function assistant_batch_restart_delay()`);
    let restartWorker: ReturnType<typeof spawn> | null = null;
    try {
      restartWorker = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run',
        'src/lib/server/engine/assistantBatchRestartWorker.test.ts'], {
        cwd: process.cwd(), env: { ...process.env, MYTHENGINE_BATCH_RESTART_WORKER: '1',
          MYTHENGINE_BATCH_RESTART_PROJECT_ID: projectId, MYTHENGINE_BATCH_RESTART_BATCH_ID: String(resume.batch.id),
          MYTHENGINE_BATCH_RESTART_CHILD_ID: String(resume.children[0].id) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      restartWorker.stdout?.on('data', chunk => { output += String(chunk); });
      restartWorker.stderr?.on('data', chunk => { output += String(chunk); });
      let applied = 0;
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const [row] = await db.execute(sql`select count(*)::integer as count from assistant_batch_targets
          where child_id=${resume.children[0].id} and status='applied'`);
        applied = Number(row.count);
        if (applied > 0) break;
        if (restartWorker.exitCode !== null) throw new Error(`Restart worker exited before a partial commit: ${output}`);
        await delay(50);
      }
      expect(applied).toBeGreaterThan(0);
      expect(applied).toBeLessThan(10);
      restartWorker.kill('SIGKILL');
      if (restartWorker.exitCode === null) await new Promise<void>(done => restartWorker!.once('exit', () => done()));
      const [partial] = await db.execute(sql`select count(*)::integer as count from assistant_batch_targets
        where child_id=${resume.children[0].id} and status='applied'`);
      expect(Number(partial.count)).toBeGreaterThan(0);
      expect(Number(partial.count)).toBeLessThan(10);
    } finally {
      if (restartWorker?.exitCode === null) restartWorker.kill('SIGKILL');
      await db.execute(sql`drop trigger if exists assistant_batch_restart_delay_trigger on content_items`);
      await db.execute(sql`drop function if exists assistant_batch_restart_delay()`);
    }
    expect(await processAssistantBatchJob({ projectId, attemptCount: 2, maxAttempts: 3,
      payload: { batchId: resume.batch.id, childId: resume.children[0].id } })).toMatchObject({ status: 'completed', counts: { applied: 10 } });
    expect(vi.mocked(generateServerTextWithMetrics).mock.calls).toHaveLength(providerCalls);
    const [resumeHistory] = await db.execute(sql`select count(*)::integer as count from content_revisions where project_id=${projectId}
      and target_kind='item' and actor->>'childId'=${resume.children[0].id}`);
    expect(resumeHistory.count).toBe(10);
    await cancelAssistantBatch(String(resume.batch.id), { projectId });

    vi.stubEnv('MYTHENGINE_BATCH_MAX_COST_USD', '5');
    vi.stubEnv('MYTHENGINE_BATCH_INPUT_USD_PER_MILLION', '0');
    vi.stubEnv('MYTHENGINE_BATCH_OUTPUT_USD_PER_MILLION', '1000');
    const concurrent = await createAssistantBatchPlan({ ...request, callId: 'concurrent-budget' });
    vi.stubEnv('MYTHENGINE_BATCH_MAX_COST_USD', '10');
    vi.stubEnv('MYTHENGINE_BATCH_INPUT_USD_PER_MILLION', '1');
    vi.stubEnv('MYTHENGINE_BATCH_OUTPUT_USD_PER_MILLION', '2');
    await queueAssistantBatch(String(concurrent.batch.id), { projectId });
    const startAt = String(Date.now() + 5_000);
    const concurrentWorkers = concurrent.children.slice(0, 2).map(child => {
      const worker = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run',
        'src/lib/server/engine/assistantBatchRestartWorker.test.ts'], {
        cwd: process.cwd(), env: { ...process.env, MYTHENGINE_BATCH_RESTART_WORKER: '1',
          MYTHENGINE_BATCH_RESTART_MODE: 'provider', MYTHENGINE_BATCH_START_AT: startAt,
          MYTHENGINE_BATCH_RESTART_PROJECT_ID: projectId, MYTHENGINE_BATCH_RESTART_BATCH_ID: String(concurrent.batch.id),
          MYTHENGINE_BATCH_RESTART_CHILD_ID: String(child.id) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      worker.stdout?.on('data', chunk => { output += String(chunk); });
      worker.stderr?.on('data', chunk => { output += String(chunk); });
      return { worker, output: () => output };
    });
    try {
      const exits = await Promise.all(concurrentWorkers.map(({ worker }) => new Promise<number>(done =>
        worker.once('exit', code => done(code ?? -1)))));
      expect(exits.sort(), concurrentWorkers.map(({ output }) => output()).join('\n--- worker ---\n')).toEqual([0, 1]);
      const completed = await readAssistantBatchPlan(String(concurrent.batch.id), { projectId });
      expect(completed.children.slice(0, 2).map(child => child.status).sort()).toEqual(['completed', 'failed']);
      expect(completed.children.slice(0, 2).filter(child =>
        (child.report as { providerAttempted?: boolean } | null)?.providerAttempted)).toHaveLength(1);
      const failed = completed.children.slice(0, 2).find(child => child.status === 'failed');
      const succeeded = completed.children.slice(0, 2).find(child => child.status === 'completed');
      expect(failed?.error).toContain('cost ceiling');
      expect(new Date(String(failed?.finished_at)).getTime()).toBeLessThan(new Date(String(succeeded?.finished_at)).getTime());
      expect(succeeded?.report).toMatchObject({ reservedCostUsd: 4.096 });
      const [concurrentHistory] = await db.execute(sql`select count(*)::integer as count from content_revisions where project_id=${projectId}
        and target_kind='item' and actor->>'batchId'=${concurrent.batch.id}`);
      expect(concurrentHistory.count).toBe(10);
    } finally {
      for (const { worker } of concurrentWorkers) if (worker.exitCode === null) worker.kill('SIGKILL');
      await cancelAssistantBatch(String(concurrent.batch.id), { projectId });
    }

    const stoppedWithParent = await createAssistantBatchPlan({ ...request, callId: 'parent-stop' });
    await queueAssistantBatch(String(stoppedWithParent.batch.id), { projectId });
    const stoppedView = await cancelAssistantRun({ projectId, conversationId, runId });
    expect(stoppedView.run?.status).toBe('cancelled');
    expect(stoppedView.batches.find(batch => batch.id === stoppedWithParent.batch.id)?.status).toBe('cancelled');
    const finalReport = stoppedView.messages.find(message => message.id === `assistant_batch_report_${planned.batch.id}`);
    expect(finalReport?.content).toContain('95 applied, 1 conflicted, 0 failed, 1 skipped');
    expect(finalReport?.content).toContain('Spot-checked 2 committed revisions');
    expect(finalReport?.content).not.toContain('needs review');
    expect(finalReport?.source_refs).toHaveLength(2);
    expect(stoppedView.batches.find(batch => batch.id === planned.batch.id)?.finalReport).toBe(finalReport?.content);
    const reread = await readAssistantConversation({ projectId, conversationId });
    expect(reread.messages.filter(message => message.id === finalReport?.id)).toHaveLength(1);
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
  }
}, 30_000);

afterAll(async () => { if (process.env.MYTHENGINE_BATCH_PLAN_INTEGRATION === '1') await closeDb(); vi.unstubAllEnvs(); });
