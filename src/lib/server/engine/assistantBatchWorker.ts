import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { contentDefinitionSchema } from '$lib/contracts/content';
import { getDb } from '$lib/server/db/client';
import { backendJobFailureIsRetryable } from '$lib/server/jobs/outbox';
import { generateServerTextWithMetrics, ServerGenerationError } from '$lib/server/turn/provider';
import { applyAssistantBatchChild } from './assistantBatchApply';
import { agentRunHash } from './agentRunHash';
import { requireResolvedServiceProfile, resolveServiceGeneration } from './llmSettings';
import { MutationError } from './mutationSafety';
import { assistantBatchBudgetSchema, batchConsumedCost, childCostReservation, estimatedBatchUsageCost } from './assistantBatchBudget';

const payloadSchema = z.object({ batchId: z.string().min(1).max(200), childId: z.string().min(1).max(200) }).passthrough();
const childSystem = 'You are a bounded MythEngine batch helper. You may edit only the assigned records and allowed data fields. Return one JSON object {"edits":[{"action":"update","itemId":"...","data":{"allowedField":value}},{"action":"skip","itemId":"...","reason":"..."}]}. Include every assigned ID exactly once. Do not use tools, infer other project data, change type settings, or claim an edit was committed. The server validates and applies your proposals.';

export async function processAssistantBatchJob(job: { projectId: string; payload: Record<string, unknown>; attemptCount?: number; maxAttempts?: number }) {
  const { batchId, childId } = payloadSchema.parse(job.payload);
  try {
    return await runAssistantBatchChild(job.projectId, batchId, childId);
  } catch (error) {
    if (error instanceof ServerGenerationError && error.result.usage) {
      const [batch] = await getDb().execute(sql`select budget from assistant_batches where id=${batchId} and project_id=${job.projectId}`);
      const budget = assistantBatchBudgetSchema.safeParse(batch?.budget);
      const usage = { model: error.result.model, durationMs: error.result.durationMs,
        finishReason: error.result.finishReason ?? null, ...error.result.usage,
        ...(budget.success ? { estimatedCostUsd: estimatedBatchUsageCost(budget.data, error.result.usage) } : {}) };
      await getDb().execute(sql`update assistant_batch_children set usage=${JSON.stringify(usage)}::jsonb,updated_at=now()
        where id=${childId} and batch_id=${batchId} and status='running'`);
    }
    const [state] = await getDb().execute(sql`select report from assistant_batch_children where id=${childId} and batch_id=${batchId}`);
    const report = state?.report as { providerAttempted?: boolean; proposal?: unknown } | null;
    const permanent = error instanceof MutationError || error instanceof z.ZodError || error instanceof SyntaxError
      || (report?.providerAttempted === true && !report.proposal);
    if (permanent && error && typeof error === 'object') Object.assign(error, { retryable: false });
    if (permanent || !backendJobFailureIsRetryable(error) || (job.attemptCount ?? 1) >= (job.maxAttempts ?? 1))
      await failChild(job.projectId, batchId, childId, error);
    else await getDb().execute(sql`update assistant_batch_children set error=${error instanceof Error ? error.message : String(error)},updated_at=now()
      where id=${childId} and batch_id=${batchId} and status='running'`);
    throw error;
  }
}

async function runAssistantBatchChild(projectId: string, batchId: string, childId: string) {
  const db = getDb();
  const [batch] = await db.execute(sql`select b.*,c.status as child_status,c.report as child_report
    from assistant_batches b join assistant_batch_children c on c.batch_id=b.id
    where b.id=${batchId} and b.project_id=${projectId} and c.id=${childId}`);
  if (!batch) throw new MutationError('SCOPE_DENIED', 'Batch child is not in this project.');
  if (batch.child_status === 'completed') return { batchId, childId, status: 'completed', replayed: true };
  if (batch.status !== 'running' || !['pending', 'running'].includes(String(batch.child_status)))
    throw new MutationError('SCOPE_DENIED', 'Batch child is not active in this project.');
  await db.execute(sql`update assistant_batch_children set status='running',started_at=coalesce(started_at,now()),updated_at=now()
    where id=${childId} and batch_id=${batchId} and status='pending'`);
  const targets = await db.execute(sql`select t.item_id,t.expected_revision,i.title,i.data,i.revision as current_revision
    from assistant_batch_targets t left join content_items i on i.id=t.item_id and i.project_id=${projectId}
      and i.game_id is not distinct from ${batch.game_id}
    where t.batch_id=${batchId} and t.child_id=${childId} order by t.item_id`);
  if (!targets.length || targets.length > 10) throw new MutationError('SCOPE_DENIED', 'Batch child has an invalid target assignment.');
  const [type] = await db.execute(sql`select definition,revision from content_types where id=${batch.type_id} and project_id=${projectId}`);
  if (!type || type.revision !== batch.type_revision) throw new MutationError('REVISION_CONFLICT', 'Batch type changed before child execution.');
  const allowedFields = batch.allowed_fields as string[];
  const definition = contentDefinitionSchema.parse(type.definition);
  const visibleFields = Object.fromEntries(allowedFields.map(field => [field, definition.fields[field]]));
  const prior = batch.child_report as { proposal?: { edits: unknown[] } } | null;
  let request: { profile: ReturnType<typeof requireResolvedServiceProfile>; model: string; prompt: string;
    budget: z.infer<typeof assistantBatchBudgetSchema>; reservation: ReturnType<typeof childCostReservation> } | null = null;
  if (!prior?.proposal) {
    const service = await resolveServiceGeneration('batchAuthoring');
    const profile = requireResolvedServiceProfile('batchAuthoring', service);
    if (!service.generation.model || service.generation.model !== batch.model) throw new MutationError('REVISION_CONFLICT', 'Batch model changed after planning; review before dispatch.');
    const task = { objective: batch.objective, instructions: batch.instructions, allowedFields,
      fieldSchema: visibleFields, records: targets.map(row => ({ id: row.item_id, title: row.title,
        expectedRevision: row.expected_revision, currentRevision: row.current_revision, data: row.data })) };
    const prompt = JSON.stringify(task);
    if (prompt.length > 24_000) throw new MutationError('INVALID_FIELD', 'Child context exceeds the bounded request size; reduce the assignment.');
    const budget = assistantBatchBudgetSchema.parse(batch.budget);
    request = { profile, model: service.generation.model, prompt, budget,
      reservation: childCostReservation(budget, childSystem, prompt) };
  }
  const ticket = await db.transaction(async tx => {
    await tx.execute(sql`select id from shelves where id=${projectId} for update`);
    const [current] = await tx.execute(sql`select b.status as batch_status,c.status as child_status,c.report
      from assistant_batches b join assistant_batch_children c on c.batch_id=b.id
      where b.id=${batchId} and b.project_id=${projectId} and c.id=${childId} for update of b,c`);
    if (!current || current.batch_status !== 'running' || current.child_status !== 'running')
      throw new MutationError('SCOPE_DENIED', 'Batch child stopped before its provider request.');
    const report = current.report as { proposal?: { edits: unknown[] }; providerAttempted?: boolean } | null;
    if (report?.proposal) return { proposal: report.proposal };
    if (report?.providerAttempted) throw new MutationError('REVISION_CONFLICT', 'A previous child provider request has no saved proposal; review before another paid call.');
    if (!request) throw new MutationError('REVISION_CONFLICT', 'Batch proposal disappeared before resume.');
    const spent = batchConsumedCost(await tx.execute(sql`select report,usage from assistant_batch_children where batch_id=${batchId}`));
    if (spent === null) throw new MutationError('BUDGET_EXCEEDED', 'Prior batch cost is unknown; review before another provider call.');
    if (spent + request.reservation.costUsd > request.budget.maxCostUsd + 0.0000001)
      throw new MutationError('BUDGET_EXCEEDED', 'Batch cost ceiling would be exceeded by this child request.');
    const marker = { ...(report ?? {}), providerAttempted: true, providerAttemptedAt: new Date().toISOString(),
      reservedInputTokens: request.reservation.inputTokens, reservedOutputTokens: request.reservation.outputTokens,
      reservedCostUsd: request.reservation.costUsd };
    await tx.execute(sql`update assistant_batch_children set report=${JSON.stringify(marker)}::jsonb,updated_at=now() where id=${childId}`);
    return { proposal: null };
  });
  let proposal = ticket.proposal;
  if (!proposal) {
    if (!request) throw new MutationError('REVISION_CONFLICT', 'Batch request is unavailable.');
    const generated = await generateServerTextWithMetrics({ profile: request.profile, model: request.model,
        temperature: 0, maxTokens: request.budget.maxOutputTokens, timeoutMs: 60_000,
        maxRetries: 0, responseFormat: 'json_object',
        system: childSystem, prompt: request.prompt });
    const usage = { model: generated.model, durationMs: generated.durationMs, finishReason: generated.finishReason,
      ...generated.usage, estimatedCostUsd: estimatedBatchUsageCost(request.budget, generated.usage) };
    await db.execute(sql`update assistant_batch_children set usage=${JSON.stringify(usage)}::jsonb,updated_at=now()
      where id=${childId} and batch_id=${batchId} and status='running'`);
    if (generated.finishReason === 'length' || generated.toolCalls?.length || !generated.text.trim())
      throw new MutationError('INVALID_FIELD', 'Batch helper did not return a complete JSON decision.');
    proposal = z.object({ edits: z.array(z.unknown()).min(1).max(10) }).strict().parse(JSON.parse(generated.text));
    await db.execute(sql`update assistant_batch_children set report=report || ${JSON.stringify({ decisionHash: agentRunHash(proposal.edits), proposal })}::jsonb,updated_at=now()
      where id=${childId} and batch_id=${batchId} and status='running'`);
  }
  const receipt = await applyAssistantBatchChild({ batchId, childId, projectId,
      ...(batch.game_id ? { gameId: String(batch.game_id) } : {}), edits: proposal.edits });
  return { batchId, childId, status: receipt.child.status,
      counts: Object.fromEntries(['applied', 'conflict', 'failed', 'skipped'].map(status =>
        [status, receipt.targets.filter(row => row.status === status).length])) };
}

async function failChild(projectId: string, batchId: string, childId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await getDb().transaction(async tx => {
    await tx.execute(sql`select id from shelves where id=${projectId} for update`);
    await tx.execute(sql`update assistant_batch_children set status='failed',error=${message},finished_at=now(),updated_at=now()
      where id=${childId} and batch_id=${batchId} and status in ('pending','running')`);
    await tx.execute(sql`update assistant_batch_targets set status='failed',error=${message},updated_at=now()
      where child_id=${childId} and status in ('pending','running')`);
    const [remaining] = await tx.execute(sql`select count(*)::integer as count from assistant_batch_children where batch_id=${batchId} and status in ('pending','running')`);
    if (Number(remaining.count) === 0) await tx.execute(sql`update assistant_batches set status='failed',updated_at=now() where id=${batchId} and status='running'`);
  });
}
