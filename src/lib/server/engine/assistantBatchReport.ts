import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';

type Scope = { projectId: string; gameId?: string; conversationId: string };
type BatchTarget = { item_id: unknown; child_id: unknown; status: unknown; committed_revision: unknown;
  report: unknown; snapshot: unknown; actor: unknown };
const outcomeOrder = ['applied', 'conflict', 'failed', 'skipped', 'cancelled', 'pending', 'running'];

function spotCheck(target: BatchTarget, batchId: string) {
  const report = target.report && typeof target.report === 'object' ? target.report as Record<string, unknown> : {};
  const proposal = report.proposal && typeof report.proposal === 'object' ? report.proposal as { edits?: unknown } : {};
  const edits = Array.isArray(proposal.edits) ? proposal.edits : [];
  const edit = edits.find(value => value && typeof value === 'object' && (value as Record<string, unknown>).itemId === target.item_id) as Record<string, unknown> | undefined;
  const snapshot = target.snapshot && typeof target.snapshot === 'object' ? target.snapshot as Record<string, unknown> : {};
  const data = snapshot.data && typeof snapshot.data === 'object' ? snapshot.data as Record<string, unknown> : {};
  const actor = target.actor && typeof target.actor === 'object' ? target.actor as Record<string, unknown> : {};
  const changes = edit?.data && typeof edit.data === 'object' && !Array.isArray(edit.data) ? edit.data as Record<string, unknown> : null;
  const verified = edit?.action === 'update' && changes && Object.keys(changes).length > 0
    && Number(target.committed_revision) === Number(snapshot.revision)
    && actor.role === 'batch' && actor.batchId === batchId && actor.childId === target.child_id
    && Object.entries(changes).every(([field, value]) => isDeepStrictEqual(data[field], value));
  return { itemId: String(target.item_id), revision: Number(target.committed_revision), verified: Boolean(verified) };
}

/** Idempotently turn terminal child receipts into a parent-visible, source-linked wrap-up. */
export async function publishAssistantBatchReports(scope: Scope) {
  const db = getDb();
  const pending = await db.execute(sql`select b.id from assistant_batches b join assistant_runs r on r.id=b.run_id
    where r.conversation_id=${scope.conversationId} and b.project_id=${scope.projectId}
      and b.game_id is not distinct from ${scope.gameId ?? null}
      and b.status in ('completed','failed','cancelled') and r.status in ('completed','failed','cancelled')
      and not exists (select 1 from assistant_messages m where m.id='assistant_batch_report_' || b.id)
    order by b.created_at,b.id limit 100`);
  for (const row of pending) await db.transaction(async tx => {
    await tx.execute(sql`select id from shelves where id=${scope.projectId} for update`);
    const [batch] = await tx.execute(sql`select b.id,b.objective,b.status from assistant_batches b join assistant_runs r on r.id=b.run_id
      where b.id=${row.id} and b.project_id=${scope.projectId} and b.game_id is not distinct from ${scope.gameId ?? null}
        and r.conversation_id=${scope.conversationId} and r.status in ('completed','failed','cancelled')
      for update of b`);
    if (!batch || !['completed', 'failed', 'cancelled'].includes(String(batch.status))) return;
    const targets = await tx.execute(sql`select t.item_id,t.child_id,t.status,t.committed_revision,c.report,
        h.snapshot,h.actor from assistant_batch_targets t
      join assistant_batch_children c on c.id=t.child_id
      left join content_revisions h on h.project_id=${scope.projectId} and h.target_kind='item'
        and h.target_id=t.item_id and h.revision=t.committed_revision
      where t.batch_id=${batch.id} order by t.item_id`) as BatchTarget[];
    const counts = Object.fromEntries(outcomeOrder.map(status => [status, targets.filter(target => target.status === status).length]));
    const applied = targets.filter(target => target.status === 'applied');
    const sample = applied.length > 1 ? [applied[0], applied[applied.length - 1]] : applied;
    const checks = sample.map(target => spotCheck(target, String(batch.id)));
    const summary = `${String(batch.objective)} — ${String(batch.status)}. ${targets.length} ${targets.length === 1 ? 'target' : 'targets'}: `
      + `${counts.applied} applied, ${counts.conflict} conflicted, ${counts.failed} failed, `
      + `${counts.skipped} skipped, ${counts.cancelled} cancelled, ${counts.pending + counts.running} unfinished. `
      + (checks.length ? `Spot-checked ${checks.length} committed ${checks.length === 1 ? 'revision' : 'revisions'}: `
        + checks.map(check => `${check.itemId}@${check.revision} ${check.verified ? 'verified' : 'needs review'}`).join('; ') + '.'
        : 'No applied revisions were available to spot-check.');
    const refs = checks.filter(check => check.verified).map(check => ({ kind: 'content', id: check.itemId, revision: check.revision }));
    const messageId = `assistant_batch_report_${String(batch.id)}`;
    const [inserted] = await tx.execute(sql`insert into assistant_messages(id,conversation_id,role,content,status,source_refs)
      values(${messageId},${scope.conversationId},'assistant',${summary},'committed',${JSON.stringify(refs)}::jsonb)
      on conflict(id) do nothing returning id`);
    if (inserted) await tx.execute(sql`update assistant_conversations set revision=revision+1,updated_at=now() where id=${scope.conversationId}`);
  });
}
