import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { agentRunHash } from './agentRunHash';
import { updateContentInTransaction } from './content';
import { MutationError } from './mutationSafety';

const id = z.string().min(1).max(200);
const decisionSchema = z.object({
  batchId: id,
  childId: id,
  projectId: id,
  gameId: id.optional(),
  edits: z.array(z.discriminatedUnion('action', [
    z.object({ action: z.literal('update'), itemId: id, data: z.record(z.string(), z.unknown()).refine(value => Object.keys(value).length > 0) }).strict(),
    z.object({ action: z.literal('skip'), itemId: id, reason: z.string().trim().min(1).max(500) }).strict(),
  ])).min(1).max(10),
}).strict();

export async function applyAssistantBatchChild(input: unknown) {
  const args = decisionSchema.parse(input);
  const decisionHash = agentRunHash(args.edits);
  const edits = new Map(args.edits.map(edit => [edit.itemId, edit]));
  if (edits.size !== args.edits.length) throw new MutationError('INVALID_FIELD', 'Batch child returned a duplicate target.');
  const db = getDb();
  const snapshot = await db.transaction(async tx => {
    await tx.execute(sql`select id from shelves where id=${args.projectId} for update`);
    const [batch] = await tx.execute(sql`select * from assistant_batches where id=${args.batchId} and project_id=${args.projectId}
      and game_id is not distinct from ${args.gameId ?? null} for update`);
    if (!batch || !['planned', 'running', 'completed'].includes(String(batch.status))) throw new MutationError('SCOPE_DENIED', 'Batch is not available in this scope.');
    const [child] = await tx.execute(sql`select * from assistant_batch_children where id=${args.childId} and batch_id=${args.batchId} for update`);
    if (!child || !['pending', 'running', 'completed'].includes(String(child.status))) throw new MutationError('SCOPE_DENIED', 'Batch child is unavailable.');
    if (batch.status === 'completed' && child.status !== 'completed') throw new MutationError('REVISION_CONFLICT', 'Batch ended before this child completed.');
    const expectedHash = (child.report as { decisionHash?: string } | null)?.decisionHash;
    if (expectedHash && expectedHash !== decisionHash) throw new MutationError('REVISION_CONFLICT', 'Batch child decisions changed after execution began.');
    const targets = await tx.execute(sql`select item_id,expected_revision,status from assistant_batch_targets where child_id=${args.childId} order by item_id`);
    if (targets.length !== args.edits.length || targets.some(target => !edits.has(String(target.item_id))))
      throw new MutationError('SCOPE_DENIED', 'Batch child must report exactly its assigned targets.');
    const allowedFields = batch.allowed_fields as string[];
    for (const edit of args.edits) if (edit.action === 'update' && Object.keys(edit.data).some(field => !allowedFields.includes(field)))
      throw new MutationError('SCOPE_DENIED', 'Batch child attempted to edit a field outside its plan.');
    if (child.status === 'pending') {
      await tx.execute(sql`update assistant_batch_children set status='running',report=${JSON.stringify({ ...(child.report as Record<string, unknown> | null ?? {}), decisionHash, proposal: { edits: args.edits } })}::jsonb,
        started_at=now(),updated_at=now() where id=${args.childId}`);
      await tx.execute(sql`update assistant_batches set status='running',updated_at=now() where id=${args.batchId} and status='planned'`);
    } else if (!expectedHash) {
      await tx.execute(sql`update assistant_batch_children set report=${JSON.stringify({ ...(child.report as Record<string, unknown> | null ?? {}), decisionHash, proposal: { edits: args.edits } })}::jsonb,updated_at=now() where id=${args.childId}`);
    }
    return { batch, child, targets };
  });
  if (snapshot.child.status === 'completed') return batchChildReceipt(args.batchId, args.childId, args.projectId, args.gameId);

  for (const edit of args.edits) {
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`select id from shelves where id=${args.projectId} for update`);
        const [batch] = await tx.execute(sql`select status,type_id,type_revision,run_id,call_id from assistant_batches
          where id=${args.batchId} and project_id=${args.projectId} and game_id is not distinct from ${args.gameId ?? null} for update`);
        const [child] = await tx.execute(sql`select status from assistant_batch_children where id=${args.childId} and batch_id=${args.batchId} for update`);
        const [target] = await tx.execute(sql`select status,expected_revision from assistant_batch_targets where batch_id=${args.batchId}
          and child_id=${args.childId} and item_id=${edit.itemId} for update`);
        if (!batch || batch.status !== 'running' || !child || child.status !== 'running' || !target)
          throw new MutationError('SCOPE_DENIED', 'Batch or child stopped before this edit.');
        if (['applied', 'conflict', 'failed', 'skipped', 'cancelled'].includes(String(target.status))) return;
        const [item] = await tx.execute(sql`select i.revision,i.type_id,i.game_id,i.deleted_at,t.revision as type_revision
          from content_items i join content_types t on t.id=i.type_id where i.id=${edit.itemId} and i.project_id=${args.projectId}`);
        if (!item || item.type_id !== batch.type_id || item.game_id !== (args.gameId ?? null) || item.deleted_at
          || item.revision !== target.expected_revision || item.type_revision !== batch.type_revision) {
          await tx.execute(sql`update assistant_batch_targets set status='conflict',error='Target or type changed after the batch plan.',updated_at=now()
            where batch_id=${args.batchId} and item_id=${edit.itemId}`);
          return;
        }
        if (edit.action === 'skip') {
          await tx.execute(sql`update assistant_batch_targets set status='skipped',result=${JSON.stringify({ reason: edit.reason })}::jsonb,updated_at=now()
            where batch_id=${args.batchId} and item_id=${edit.itemId}`);
          return;
        }
        const result = await updateContentInTransaction(tx, { projectId: args.projectId, ...(args.gameId ? { gameId: args.gameId } : {}),
          id: edit.itemId, expectedRevision: target.expected_revision, expectedTypeRevision: batch.type_revision,
          changes: { data: edit.data } }, { role: 'batch', batchId: args.batchId, childId: args.childId,
          runId: batch.run_id, callId: batch.call_id, initiatedBy: 'local-user' });
        await tx.execute(sql`update assistant_batch_targets set status='applied',committed_revision=${result.item.revision},
          result=${JSON.stringify({ changedFields: Object.keys(edit.data) })}::jsonb,updated_at=now()
          where batch_id=${args.batchId} and item_id=${edit.itemId}`);
      });
    } catch (error) {
      const status = error instanceof MutationError && error.code === 'REVISION_CONFLICT' ? 'conflict' : 'failed';
      await db.execute(sql`update assistant_batch_targets set status=${status},error=${error instanceof Error ? error.message : String(error)},updated_at=now()
        where batch_id=${args.batchId} and child_id=${args.childId} and item_id=${edit.itemId} and status in ('pending','running')`);
    }
  }
  await db.transaction(async tx => {
    await tx.execute(sql`select id from shelves where id=${args.projectId} for update`);
    const [remaining] = await tx.execute(sql`select count(*)::integer as count from assistant_batch_targets where child_id=${args.childId} and status in ('pending','running')`);
    if (remaining.count !== 0) return;
    await tx.execute(sql`update assistant_batch_children set status='completed',finished_at=now(),updated_at=now() where id=${args.childId} and status='running'`);
    const [unfinished] = await tx.execute(sql`select count(*)::integer as count from assistant_batch_children where batch_id=${args.batchId} and status in ('pending','running')`);
    if (unfinished.count === 0) {
      const [failed] = await tx.execute(sql`select count(*)::integer as count from assistant_batch_children where batch_id=${args.batchId} and status='failed'`);
      await tx.execute(sql`update assistant_batches set status=${Number(failed.count) > 0 ? 'failed' : 'completed'},updated_at=now() where id=${args.batchId} and status='running'`);
    }
  });
  return batchChildReceipt(args.batchId, args.childId, args.projectId, args.gameId);
}

async function batchChildReceipt(batchId: string, childId: string, projectId: string, gameId?: string) {
  const [child] = await getDb().execute(sql`select c.id,c.status,c.report,c.error,b.status as batch_status from assistant_batch_children c
    join assistant_batches b on b.id=c.batch_id where c.id=${childId} and c.batch_id=${batchId}
      and b.project_id=${projectId} and b.game_id is not distinct from ${gameId ?? null}`);
  if (!child) throw new MutationError('SCOPE_DENIED', 'Batch child not found.');
  const targets = await getDb().execute(sql`select item_id,status,expected_revision,committed_revision,result,error from assistant_batch_targets
    where batch_id=${batchId} and child_id=${childId} order by item_id`);
  return { child, targets };
}
