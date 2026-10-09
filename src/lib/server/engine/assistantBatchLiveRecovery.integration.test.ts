import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { gearExample } from '$lib/contracts/content';
import { closeDb, getDb } from '$lib/server/db/client';
import { createAssistantBatchPlan, queueAssistantBatch, readAssistantBatchPlan } from './assistantBatchPlan';

const live = process.env.MYTHENGINE_BATCH_LIVE_RECOVERY === '1' ? test : test.skip;

live('resumes real-provider work after a worker dies during a partial commit', async () => {
  const db = getDb();
  const suffix = randomUUID();
  const projectId = `shelf_batch_live_${suffix}`;
  const typeId = `type_batch_live_${suffix}`;
  const conversationId = `assistant_conversation_${suffix}`;
  const messageId = `assistant_message_${suffix}`;
  const runId = `assistant_run_${suffix}`;
  let worker: ChildProcess | null = null;
  let triggerInstalled = false;
  let functionInstalled = false;
  let evidence: Record<string, unknown> | null = null;
  const startWorker = (batchId: string, childId: string, resume = false) => {
    const process = spawn(globalThis.process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run',
      'src/lib/server/engine/assistantBatchLiveWorker.test.ts'], {
      cwd: globalThis.process.cwd(), env: { ...globalThis.process.env, MYTHENGINE_BATCH_LIVE_WORKER: '1',
        ...(resume ? { MYTHENGINE_BATCH_LIVE_RESUME: '1' } : {}),
        MYTHENGINE_BATCH_LIVE_PROJECT_ID: projectId, MYTHENGINE_BATCH_LIVE_BATCH_ID: batchId,
        MYTHENGINE_BATCH_LIVE_CHILD_ID: childId }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    process.stdout?.on('data', chunk => { output += String(chunk); });
    process.stderr?.on('data', chunk => { output += String(chunk); });
    return { process, output: () => output };
  };
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Live batch recovery fixture',${projectId})`);
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition)
      values(${typeId},${projectId},'gear','gear','Gear',${JSON.stringify(gearExample)}::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,type_id,title,slug,data)
      select ${`item_batch_live_${suffix}_`} || n,${projectId},${typeId},'Gear ' || n,'gear-' || n,'{"notes":"original"}'::jsonb
      from generate_series(1,3) n`);
    await db.execute(sql`insert into assistant_conversations(id,project_id) values(${conversationId},${projectId})`);
    await db.execute(sql`insert into assistant_messages(id,conversation_id,role,content,status)
      values(${messageId},${conversationId},'user','Update three fixture notes.','committed')`);
    await db.execute(sql`insert into assistant_runs(id,conversation_id,user_message_id,status,request_fingerprint,lease_until)
      values(${runId},${conversationId},${messageId},'running','fixture',now()+interval '10 minutes')`);
    const plan = await createAssistantBatchPlan({ runId, callId: 'live-plan', conversationId, projectId,
      typeId, expectedTypeRevision: 1, objective: 'Update the three fixture Gear notes.',
      instructions: 'Set notes to exactly "Live recovery trial" for every assigned record. Keep all other fields unchanged.',
      allowedFields: ['notes'], maxTargets: 3 });
    expect(plan.children).toHaveLength(1);
    const batchId = String(plan.batch.id);
    const childId = String(plan.children[0].id);
    await queueAssistantBatch(batchId, { projectId });

    await db.execute(sql`create or replace function assistant_batch_live_recovery_delay() returns trigger as $$
      begin if new.project_id like 'shelf_batch_live_%' then perform pg_sleep(0.8); end if; return new; end $$ language plpgsql`);
    functionInstalled = true;
    await db.execute(sql`create trigger assistant_batch_live_recovery_delay_trigger before update on content_items
      for each row execute function assistant_batch_live_recovery_delay()`);
    triggerInstalled = true;
    const first = startWorker(batchId, childId);
    worker = first.process;
    let partial = 0;
    for (let attempt = 0; attempt < 1_700; attempt += 1) {
      const [row] = await db.execute(sql`select count(*)::integer as count from assistant_batch_targets
        where child_id=${childId} and status='applied'`);
      partial = Number(row.count);
      if (partial > 0) break;
      if (worker.exitCode !== null) throw new Error(`Real-provider worker exited before a partial commit: ${first.output()}`);
      await delay(50);
    }
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(3);
    worker.kill('SIGKILL');
    if (worker.exitCode === null) await new Promise<void>(done => worker!.once('exit', () => done()));
    worker = null;
    const [interrupted] = await db.execute(sql`select report,usage from assistant_batch_children where id=${childId}`);
    expect(interrupted.report).toMatchObject({ providerAttempted: true, proposal: { edits: expect.any(Array) } });
    expect(interrupted.usage).toMatchObject({ model: String(plan.batch.model), inputTokens: expect.any(Number), outputTokens: expect.any(Number) });
    const firstUsage = interrupted.usage;
    await db.execute(sql`drop trigger assistant_batch_live_recovery_delay_trigger on content_items`);
    triggerInstalled = false;
    await db.execute(sql`drop function assistant_batch_live_recovery_delay()`);
    functionInstalled = false;

    const second = startWorker(batchId, childId, true);
    worker = second.process;
    const secondExit = await new Promise<number>(done => worker!.once('exit', code => done(code ?? -1)));
    expect(secondExit, second.output()).toBe(0);
    worker = null;
    const finished = await readAssistantBatchPlan(batchId, { projectId });
    expect(finished.batch.status).toBe('completed');
    expect(finished.children[0].status).toBe('completed');
    expect(finished.children[0].usage).toEqual(firstUsage);
    expect(finished.targets).toHaveLength(3);
    expect(finished.targets.every(target => target.status === 'applied' && target.committed_revision === 2)).toBe(true);
    const [history] = await db.execute(sql`select count(*)::integer as count from content_revisions where project_id=${projectId}
      and target_kind='item' and actor->>'batchId'=${batchId}`);
    expect(history.count).toBe(3);
    const contents = await db.execute(sql`select data from content_items where project_id=${projectId} order by id`);
    expect(contents.every(row => (row.data as { notes?: string }).notes === 'Live recovery trial')).toBe(true);
    evidence = { observedAt: new Date().toISOString(), batchId, childId, model: plan.batch.model,
      targetCount: 3, partialBeforeRestart: partial, finalApplied: history.count,
      providerAttemptedAt: (interrupted.report as { providerAttemptedAt?: string }).providerAttemptedAt,
      providerCalls: 1, usage: firstUsage, secondWorkerReusedSavedUsage: true,
      secondWorkerProviderCallForbidden: true };
  } finally {
    if (worker?.exitCode === null) worker.kill('SIGKILL');
    if (triggerInstalled) await db.execute(sql`drop trigger if exists assistant_batch_live_recovery_delay_trigger on content_items`);
    if (functionInstalled) await db.execute(sql`drop function if exists assistant_batch_live_recovery_delay()`);
    await db.execute(sql`delete from shelves where id=${projectId}`);
    if (evidence) {
      const [remaining] = await db.execute(sql`select count(*)::integer as count from shelves where id=${projectId}`);
      expect(remaining.count).toBe(0);
      writeFileSync(resolve('docs/evidence/mythengine-overhaul/phase9-live-recovery-2026-09-23.json'),
        `${JSON.stringify({ ...evidence, fixtureDeleted: true }, null, 2)}\n`);
    }
  }
}, 180_000);

afterAll(async () => { if (process.env.MYTHENGINE_BATCH_LIVE_RECOVERY === '1') await closeDb(); });
