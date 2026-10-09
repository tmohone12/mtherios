import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterAll, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { gearExample } from '$lib/contracts/content';
import { closeDb, getDb } from '$lib/server/db/client';
import { createAssistantBatchPlan, queueAssistantBatch, readAssistantBatchPlan } from './assistantBatchPlan';
import { processAssistantBatchJob } from './assistantBatchWorker';

const benchmark = process.env.MYTHENGINE_BATCH_PROVIDER_BENCH === '1' ? test : test.skip;
const itemCount = 97;

async function fixture(label: string, created: string[], targetCount = itemCount) {
  const db = getDb();
  const suffix = randomUUID();
  const projectId = `shelf_batch_bench_${suffix}`;
  const typeId = `type_batch_bench_${suffix}`;
  const conversationId = `assistant_conversation_bench_${suffix}`;
  const messageId = `assistant_message_bench_${suffix}`;
  const runId = `assistant_run_bench_${suffix}`;
  await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},${`Batch ${label} benchmark`},${projectId})`);
  created.push(projectId);
  await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition)
    values(${typeId},${projectId},'gear','gear','Gear',${JSON.stringify(gearExample)}::jsonb)`);
  await db.execute(sql`insert into content_items(id,project_id,type_id,title,slug,data)
    select ${`item_batch_bench_${suffix}_`} || n,${projectId},${typeId},'Gear ' || n,'gear-' || n,
      '{"notes":"original"}'::jsonb from generate_series(1,${targetCount}) n`);
  await db.execute(sql`insert into assistant_conversations(id,project_id) values(${conversationId},${projectId})`);
  await db.execute(sql`insert into assistant_messages(id,conversation_id,role,content,status)
    values(${messageId},${conversationId},'user','Set every Gear note to the benchmark value.','committed')`);
  await db.execute(sql`insert into assistant_runs(id,conversation_id,user_message_id,status,request_fingerprint,lease_until)
    values(${runId},${conversationId},${messageId},'running','provider-benchmark',now()+interval '10 minutes')`);
  const planned = await createAssistantBatchPlan({ runId, callId: `bench-${label}`, conversationId, projectId,
    typeId, expectedTypeRevision: 1, objective: 'Set the notes field on every assigned Gear item to Benchmark complete.',
    instructions: 'Return one update for each assigned item. Set notes to exactly Benchmark complete. Keep every other field unchanged.',
    allowedFields: ['notes'], maxTargets: targetCount });
  if (planned.targets.length !== targetCount || planned.children.length !== Math.ceil(targetCount / 10)) throw new Error('Benchmark target partition is incomplete.');
  await queueAssistantBatch(String(planned.batch.id), { projectId });
  return { projectId, batchId: String(planned.batch.id), children: planned.children.map(child => String(child.id)) };
}

function summarize(view: Awaited<ReturnType<typeof readAssistantBatchPlan>>) {
  const outcomes = Object.fromEntries(['applied', 'conflict', 'failed', 'skipped', 'cancelled', 'pending', 'running']
    .map(status => [status, view.targets.filter(target => target.status === status).length]));
  const usage = view.children.map(child => child.usage as Record<string, unknown> | null);
  const numbers = (field: string) => usage.map(row => row?.[field]).filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const provider = numbers('providerCostUsd');
  const estimated = numbers('estimatedCostUsd');
  return { outcomes, children: view.children.length,
    providerAttempts: view.children.filter(child => (child.report as { providerAttempted?: boolean } | null)?.providerAttempted).length,
    providerReportedCostUsd: provider.length === usage.length ? provider.reduce((sum, value) => sum + value, 0) : null,
    conservativeEstimatedCostUsd: estimated.length === usage.length ? estimated.reduce((sum, value) => sum + value, 0) : null,
    inputTokens: numbers('inputTokens').reduce((sum, value) => sum + value, 0),
    outputTokens: numbers('outputTokens').reduce((sum, value) => sum + value, 0) };
}

benchmark(process.env.MYTHENGINE_BATCH_BENCH_TRIAL === '1'
  ? 'trials one bounded real provider child before the full comparison'
  : process.env.MYTHENGINE_BATCH_BENCH_BASELINE === '1'
    ? 'compares one ten-item child with ten one-item provider requests'
  : 'compares serial and two-lane real provider execution of the same 97-item task', async () => {
  vi.stubEnv('MYTHENGINE_BATCH_MAX_COST_USD', '1');
  vi.stubEnv('MYTHENGINE_BATCH_INPUT_USD_PER_MILLION', '5');
  vi.stubEnv('MYTHENGINE_BATCH_OUTPUT_USD_PER_MILLION', '10');
  const db = getDb();
  const created: string[] = [];
  try {
    if (process.env.MYTHENGINE_BATCH_BENCH_BASELINE === '1') {
      const group = await fixture('ten-item-group', created, 10);
      const groupStart = performance.now();
      await processAssistantBatchJob({ projectId: group.projectId,
        payload: { batchId: group.batchId, childId: group.children[0] } });
      const groupMs = Math.round(performance.now() - groupStart);
      const groupView = await readAssistantBatchPlan(group.batchId, { projectId: group.projectId });
      const grouped = summarize(groupView);
      if (grouped.outcomes.applied !== 10) throw new Error(`Grouped baseline incomplete: ${JSON.stringify(grouped)}`);
      const individualStart = performance.now();
      const individualRuns: Array<ReturnType<typeof summarize>> = [];
      for (let index = 0; index < 10; index += 1) {
        const single = await fixture(`one-item-${index + 1}`, created, 1);
        try {
          await processAssistantBatchJob({ projectId: single.projectId,
            payload: { batchId: single.batchId, childId: single.children[0] } });
        } catch {
          // Record a failed provider decision as a failed target; never retry the marked request.
        }
        const result = summarize(await readAssistantBatchPlan(single.batchId, { projectId: single.projectId }));
        if (result.providerAttempts !== 1 || result.outcomes.applied + result.outcomes.failed !== 1)
          throw new Error(`Individual baseline item ${index + 1} has an unclassified outcome: ${JSON.stringify(result)}`);
        individualRuns.push(result);
      }
      const individualMs = Math.round(performance.now() - individualStart);
      const sum = (field: 'providerAttempts' | 'inputTokens' | 'outputTokens' | 'conservativeEstimatedCostUsd') =>
        individualRuns.reduce((total, row) => total + (row[field] ?? 0), 0);
      const result = { model: groupView.batch.model, targetCount: 10,
        priceUpperBoundsUsdPerMillion: { input: 5, output: 10 }, maxCostUsdPerBatch: 1,
        grouped: { elapsedMs: groupMs, ...grouped },
        oneFileAtATime: { elapsedMs: individualMs,
          applied: individualRuns.reduce((total, row) => total + row.outcomes.applied, 0),
          failed: individualRuns.reduce((total, row) => total + row.outcomes.failed, 0),
          providerAttempts: sum('providerAttempts'),
          inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
          conservativeEstimatedCostUsd: sum('conservativeEstimatedCostUsd'),
          providerReportedCostUsd: individualRuns.every(row => row.providerReportedCostUsd != null)
            ? individualRuns.reduce((total, row) => total + Number(row.providerReportedCostUsd), 0) : null } };
      if (process.env.MYTHENGINE_BATCH_BENCH_REPORT) writeFileSync(process.env.MYTHENGINE_BATCH_BENCH_REPORT, `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`MYTHENGINE_BATCH_PROVIDER_BASELINE ${JSON.stringify(result)}\n`);
      return;
    }
    const serial = await fixture('serial', created);
    const serialStart = performance.now();
    const firstChildId = serial.children[0];
    await processAssistantBatchJob({ projectId: serial.projectId,
      payload: { batchId: serial.batchId, childId: firstChildId } });
    const firstView = await readAssistantBatchPlan(serial.batchId, { projectId: serial.projectId });
    const firstApplied = firstView.targets.filter(target => target.child_id === firstChildId && target.status === 'applied').length;
    if (firstApplied !== 10) throw new Error(`First real provider child applied ${firstApplied}/10 targets; stopping comparison.`);
    if (process.env.MYTHENGINE_BATCH_BENCH_TRIAL === '1') {
      process.stdout.write(`MYTHENGINE_BATCH_PROVIDER_TRIAL ${JSON.stringify({ model: firstView.batch.model,
        elapsedMs: Math.round(performance.now() - serialStart), firstChild: firstView.children[0].usage,
        budget: firstView.batch.budget })}\n`);
      return;
    }
    for (const childId of serial.children.slice(1)) await processAssistantBatchJob({ projectId: serial.projectId,
      payload: { batchId: serial.batchId, childId } });
    const serialMs = Math.round(performance.now() - serialStart);
    const serialView = await readAssistantBatchPlan(serial.batchId, { projectId: serial.projectId });
    const serialResult = summarize(serialView);
    if (serialResult.outcomes.applied !== itemCount) throw new Error(`Serial batch incomplete: ${JSON.stringify(serialResult)}`);

    const parallel = await fixture('two-lane', created);
    const parallelStart = performance.now();
    for (let index = 0; index < parallel.children.length; index += 2) await Promise.all(parallel.children.slice(index, index + 2)
      .map(childId => processAssistantBatchJob({ projectId: parallel.projectId,
        payload: { batchId: parallel.batchId, childId } })));
    const parallelMs = Math.round(performance.now() - parallelStart);
    const parallelView = await readAssistantBatchPlan(parallel.batchId, { projectId: parallel.projectId });
    const parallelResult = summarize(parallelView);
    if (parallelResult.outcomes.applied !== itemCount) throw new Error(`Two-lane batch incomplete: ${JSON.stringify(parallelResult)}`);
    const result = { model: serialView.batch.model, priceUpperBoundsUsdPerMillion: { input: 5, output: 10 },
      maxCostUsdPerBatch: 1, targetCount: itemCount,
      serial: { elapsedMs: serialMs, ...serialResult }, parallel: { elapsedMs: parallelMs, ...parallelResult } };
    if (process.env.MYTHENGINE_BATCH_BENCH_REPORT) writeFileSync(process.env.MYTHENGINE_BATCH_BENCH_REPORT, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`MYTHENGINE_BATCH_PROVIDER_BENCHMARK ${JSON.stringify(result)}\n`);
  } finally {
    for (const projectId of created) await db.execute(sql`delete from shelves where id=${projectId}`);
    vi.unstubAllEnvs();
  }
}, 900_000);

afterAll(async () => { if (process.env.MYTHENGINE_BATCH_PROVIDER_BENCH === '1') await closeDb(); });
