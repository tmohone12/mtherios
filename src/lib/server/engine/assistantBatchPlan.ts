import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { contentDefinitionSchema } from '$lib/contracts/content';
import { getDb } from '$lib/server/db/client';
import { enqueueBackendJob } from '$lib/server/jobs/outbox';
import { agentRunHash } from './agentRunHash';
import { assertAgentToolAllowed } from './agentPolicy';
import { getAgentSettings } from './agentSettings';
import { resolveServiceGeneration, requireResolvedServiceProfile } from './llmSettings';
import { MutationError } from './mutationSafety';
import { configuredAssistantBatchBudget } from './assistantBatchBudget';

const id = z.string().min(1).max(200);
export const assistantBatchPlanSchema = z.object({
  runId: id,
  callId: id,
  conversationId: id,
  projectId: id,
  gameId: id.optional(),
  typeId: id,
  expectedTypeRevision: z.number().int().positive(),
  objective: z.string().trim().min(10).max(2000),
  instructions: z.string().trim().min(10).max(4000),
  allowedFields: z.array(z.string().min(1).max(100)).min(1).max(32),
  maxTargets: z.number().int().min(1).max(500).default(500),
}).strict();

type BatchPlanRequest = z.infer<typeof assistantBatchPlanSchema>;
type BatchDb = ReturnType<typeof getDb>;
type BatchTx = Parameters<Parameters<BatchDb['transaction']>[0]>[0];

export async function readAssistantBatchPlan(batchId: string, scope: { projectId: string; gameId?: string }) {
  const [batch] = await getDb().execute(sql`select id,run_id,call_id,project_id,game_id,type_id,type_revision,objective,instructions,
    allowed_fields,sample,model,budget,status,created_at,updated_at from assistant_batches
    where id=${batchId} and project_id=${scope.projectId} and game_id is not distinct from ${scope.gameId ?? null}`);
  if (!batch) throw new MutationError('SCOPE_DENIED', 'Assistant batch not found in this scope.');
  const children = await getDb().execute(sql`select id,ordinal,status,usage,report,error,started_at,finished_at from assistant_batch_children where batch_id=${batchId} order by ordinal`);
  const targets = await getDb().execute(sql`select item_id,child_id,expected_revision,status,committed_revision,result,error from assistant_batch_targets where batch_id=${batchId} order by item_id`);
  return { batch, children, targets };
}

export async function createAssistantBatchPlan(input: unknown) {
  const args = assistantBatchPlanSchema.parse(input);
  const planned = await getDb().transaction(tx => createAssistantBatchPlanInTransaction(tx, args));
  return readAssistantBatchPlan(planned.batchId, { projectId: args.projectId, ...(args.gameId ? { gameId: args.gameId } : {}) });
}

export async function createAssistantBatchPlanInTransaction(tx: BatchTx, input: unknown) {
  const args = assistantBatchPlanSchema.parse(input);
  const settings = await getAgentSettings({ projectId: args.projectId, ...(args.gameId ? { gameId: args.gameId } : {}) });
  assertAgentToolAllowed({ role: 'assistant', projectId: args.projectId, gameId: args.gameId ?? null }, 'subagent',
    { projectId: args.projectId, gameId: args.gameId ?? null }, settings.effective, ['subagent']);
  const inputHash = agentRunHash(args);
    const [existing] = await tx.execute(sql`select id,sample,budget from assistant_batches where run_id=${args.runId} and call_id=${args.callId}`);
    if (existing) {
      if ((existing.sample as { inputHash?: string })?.inputHash !== inputHash)
        throw new MutationError('REVISION_CONFLICT', 'Batch call ID was reused with different instructions.');
      const [count] = await tx.execute(sql`select count(*)::integer as count from assistant_batch_targets where batch_id=${existing.id}`);
      return { batchId: String(existing.id), targetCount: Number(count.count), childCount: Math.ceil(Number(count.count) / 10), sample: (existing.sample as { records?: unknown[] }).records ?? [], budget: existing.budget };
    }
    const service = await resolveServiceGeneration('batchAuthoring');
    requireResolvedServiceProfile('batchAuthoring', service);
    if (!service.generation.model) throw new MutationError('INVALID_FIELD', 'Batch Authoring needs a configured model.');
    const budget = configuredAssistantBatchBudget(service.setting?.metadata,
      Math.min(service.generation.maxTokens ?? 4096, 4096));
    const [run] = await tx.execute(sql`select r.status,c.project_id,c.game_id from assistant_runs r
      join assistant_conversations c on c.id=r.conversation_id
      where r.id=${args.runId} and r.conversation_id=${args.conversationId} for update of r`);
    if (!run || run.status !== 'running' || run.project_id !== args.projectId || run.game_id !== (args.gameId ?? null))
      throw new MutationError('SCOPE_DENIED', 'Assistant run is not active in this project and game.');
    await tx.execute(sql`select id from shelves where id=${args.projectId} for update`);
    const [type] = await tx.execute(sql`select id,revision,definition from content_types where id=${args.typeId} and project_id=${args.projectId} for update`);
    if (!type) throw new MutationError('SCOPE_DENIED', 'Batch type is not in this project.');
    if (type.revision !== args.expectedTypeRevision) throw new MutationError('REVISION_CONFLICT', 'Batch type changed; reread it before planning.');
    const definition = contentDefinitionSchema.parse(type.definition);
    if (new Set(args.allowedFields).size !== args.allowedFields.length || args.allowedFields.some(field => !(field in definition.fields)))
      throw new MutationError('INVALID_FIELD', 'Batch allowed fields must be distinct fields in the current type.');
    const gameFilter = args.gameId ? sql`i.game_id=${args.gameId}` : sql`i.game_id is null`;
    const targets = await tx.execute(sql`select i.id,i.title,i.revision,i.data from content_items i
      where i.project_id=${args.projectId} and i.type_id=${args.typeId} and ${gameFilter} and i.deleted_at is null
      order by i.id limit ${args.maxTargets + 1}`);
    if (!targets.length) throw new MutationError('INVALID_FIELD', 'This type has no active documents in the selected scope.');
    if (targets.length > args.maxTargets) throw new MutationError('INVALID_FIELD', 'Batch target count exceeds maxTargets; narrow the selection before dispatch.');
    const sampleIndexes = [...new Set([0, Math.floor(targets.length / 2), targets.length - 1])];
    const sample = sampleIndexes.map(index => {
      const row = targets[index];
      return { id: row.id, title: row.title, revision: row.revision, dataExcerpt: JSON.stringify(row.data).slice(0, 1200) };
    });
    const id = `assistant_batch_${randomUUID()}`;
    await tx.execute(sql`insert into assistant_batches(id,run_id,call_id,project_id,game_id,type_id,type_revision,objective,instructions,allowed_fields,sample,model,budget)
      values(${id},${args.runId},${args.callId},${args.projectId},${args.gameId ?? null},${args.typeId},${args.expectedTypeRevision},
        ${args.objective},${args.instructions},${JSON.stringify(args.allowedFields)}::jsonb,${JSON.stringify({ inputHash, records: sample })}::jsonb,${service.generation.model},${JSON.stringify(budget)}::jsonb)`);
    for (let start = 0, ordinal = 0; start < targets.length; start += 10, ordinal += 1) {
      const childId = `assistant_batch_child_${randomUUID()}`;
      await tx.execute(sql`insert into assistant_batch_children(id,batch_id,ordinal) values(${childId},${id},${ordinal})`);
      for (const row of targets.slice(start, start + 10))
        await tx.execute(sql`insert into assistant_batch_targets(batch_id,item_id,child_id,expected_revision)
          values(${id},${row.id},${childId},${row.revision})`);
    }
    return { batchId: id, targetCount: targets.length, childCount: Math.ceil(targets.length / 10), sample, budget };
}

export async function queueAssistantBatch(batchId: string, scope: { projectId: string; gameId?: string }) {
  await getDb().transaction(tx => queueAssistantBatchInTransaction(tx, batchId, scope));
  return readAssistantBatchPlan(batchId, scope);
}

export async function queueAssistantBatchInTransaction(tx: BatchTx, batchId: string, scope: { projectId: string; gameId?: string }, expectedRunId?: string) {
    await tx.execute(sql`select id from shelves where id=${scope.projectId} for update`);
    const [batch] = await tx.execute(sql`select id,status,run_id from assistant_batches where id=${batchId} and project_id=${scope.projectId}
      and game_id is not distinct from ${scope.gameId ?? null} for update`);
    if (!batch) throw new MutationError('SCOPE_DENIED', 'Assistant batch not found in this scope.');
    if (expectedRunId && batch.run_id !== expectedRunId) throw new MutationError('SCOPE_DENIED', 'Assistant batch belongs to another run.');
    if (batch.status === 'running' || batch.status === 'completed') return;
    if (batch.status !== 'planned') throw new MutationError('REVISION_CONFLICT', 'Assistant batch cannot be queued in this state.');
    const children = await tx.execute(sql`select id from assistant_batch_children where batch_id=${batchId} order by ordinal`);
    for (const child of children) await enqueueBackendJob({ projectId: scope.projectId, type: 'assistant_batch_child',
      dedupeKey: String(child.id), requeueExisting: false, maxAttempts: 3,
      payload: { batchId, childId: child.id }, metadata: { assistantBatchId: batchId, childId: child.id } }, tx);
    await tx.execute(sql`update assistant_batches set status='running',updated_at=now() where id=${batchId}`);
}

export async function cancelAssistantBatch(batchId: string, scope: { projectId: string; gameId?: string }) {
  await getDb().transaction(tx => cancelAssistantBatchInTransaction(tx, batchId, scope));
  return readAssistantBatchPlan(batchId, scope);
}

export async function cancelAssistantBatchInTransaction(tx: BatchTx, batchId: string, scope: { projectId: string; gameId?: string }) {
    await tx.execute(sql`select id from shelves where id=${scope.projectId} for update`);
    const [batch] = await tx.execute(sql`select status from assistant_batches where id=${batchId} and project_id=${scope.projectId}
      and game_id is not distinct from ${scope.gameId ?? null} for update`);
    if (!batch) throw new MutationError('SCOPE_DENIED', 'Assistant batch not found in this scope.');
    if (batch.status === 'cancelled' || batch.status === 'completed') return;
    if (batch.status !== 'planned' && batch.status !== 'running')
      throw new MutationError('REVISION_CONFLICT', 'Assistant batch cannot be cancelled in this state.');
    await tx.execute(sql`update assistant_batches set status='cancelled',updated_at=now() where id=${batchId}`);
    await tx.execute(sql`update assistant_batch_children set status='cancelled',finished_at=now(),updated_at=now()
      where batch_id=${batchId} and status in ('pending','running')`);
    await tx.execute(sql`update assistant_batch_targets set status='cancelled',updated_at=now()
      where batch_id=${batchId} and status in ('pending','running')`);
    await tx.execute(sql`update backend_jobs set status='failed',last_error='Assistant batch cancelled.',updated_at=now()
      where project_id=${scope.projectId} and type='assistant_batch_child'
        and payload->>'batchId'=${batchId} and status in ('queued','retry')`);
}

export async function reconcileAssistantBatchFailures(scope: { projectId: string; gameId?: string; conversationId: string }) {
  await getDb().transaction(async tx => {
    const failed = await tx.execute(sql`select b.id as batch_id,c.id as child_id,j.last_error
      from assistant_batches b join assistant_runs r on r.id=b.run_id
      join assistant_batch_children c on c.batch_id=b.id
      join backend_jobs j on j.project_id=b.project_id and j.type='assistant_batch_child'
        and j.payload->>'batchId'=b.id and j.payload->>'childId'=c.id
      where r.conversation_id=${scope.conversationId} and b.project_id=${scope.projectId}
        and b.game_id is not distinct from ${scope.gameId ?? null} and b.status='running'
        and c.status in ('pending','running') and j.status='failed'`);
    if (!failed.length) return;
    await tx.execute(sql`select id from shelves where id=${scope.projectId} for update`);
    for (const row of failed) {
      await tx.execute(sql`update assistant_batch_children set status='failed',error=${row.last_error ?? 'Batch worker stopped.'},
        finished_at=now(),updated_at=now() where id=${row.child_id} and status in ('pending','running')`);
      await tx.execute(sql`update assistant_batch_targets set status='failed',error=${row.last_error ?? 'Batch worker stopped.'},updated_at=now()
        where child_id=${row.child_id} and status in ('pending','running')`);
      const [unfinished] = await tx.execute(sql`select count(*)::integer as count from assistant_batch_children
        where batch_id=${row.batch_id} and status in ('pending','running')`);
      if (Number(unfinished.count) === 0) await tx.execute(sql`update assistant_batches set status='failed',updated_at=now()
        where id=${row.batch_id} and status='running'`);
    }
  });
}
