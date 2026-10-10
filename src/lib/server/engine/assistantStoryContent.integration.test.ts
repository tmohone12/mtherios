import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, afterEach, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '$lib/server/db/client';
import { createCanonicalWorkspace, readCanonicalWorkspace, editCanonicalWorkspace, canonicalWorkspaceHistory } from './canonicalContent';
import { executeAssistantTool, assistantToolSchema } from './assistantTools';
import { reviewAssistantApproval, undoAssistantStoryApproval, cancelAssistantRun } from './assistantConversations';
import type { CanonicalView } from '$lib/contracts/canonicalContent';

const enabled = process.env.MYTHENGINE_ASSISTANT_STORY_INTEGRATION === '1';
const integration = enabled ? test : test.skip;
let projectId: string, gameId: string, foreignStory: string, conversationId: string, runId: string, character: CanonicalView, other: CanonicalView;
const scope = () => ({ projectId, gameId, conversationId });
const authority = () => ({ ...scope(), runId });
const readArgs = () => ({ projectId, gameId, kind: 'characters' as const, id: String(character.record.id) });
async function proposal(changes = { description: 'A careful bridge keeper.' }) {
  const value = await executeAssistantTool(authority(), { tool: 'storyContent', callId: 'propose', args: { action: 'propose', kind: 'characters', id: character.record.id, expected: character.revision, changes, reason: 'Clarify the authored biography.' } }) as { pendingApprovalId: string };
  const [approval] = await getDb().execute(sql`select * from assistant_approvals where id=${value.pendingApprovalId}`);
  return approval;
}
const review = (approval: Record<string, unknown>, decision = 'approve') => reviewAssistantApproval({ ...scope(), runId, approvalId: approval.id, expectedRevision: approval.revision, decision });
beforeEach(async () => {
  if (!enabled) return;
  const url = new URL(process.env.DATABASE_URL!);
  if (!['/mythengine_identity_candidate_20261006','/mythengine_summary_repair_recovery_20261006_aggregate'].includes(url.pathname)) throw Error('Disposable fixture database required');
  const id = randomUUID(); projectId = `fixture_${id}`; gameId = `story_${id}`; foreignStory = `other_${id}`; conversationId = `conversation_${id}`; runId = `run_${id}`;
  const db = getDb();
  await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Assistant fixture',${projectId})`);
  await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Disposable story'),(${foreignStory},${projectId},'Other disposable story')`);
  character = await createCanonicalWorkspace({ projectId, gameId, kind: 'characters', fields: { name: 'Mira', description: 'Original biography.' } }) as CanonicalView;
  other = await createCanonicalWorkspace({ projectId, gameId: foreignStory, kind: 'characters', fields: { name: 'Other Mira', description: 'Other canon.' } }) as CanonicalView;
  await db.execute(sql`insert into assistant_conversations(id,project_id,game_id) values(${conversationId},${projectId},${gameId})`);
  await db.execute(sql`insert into assistant_messages(id,conversation_id,role,content,status) values(${`message_${id}`},${conversationId},'user','Edit the fixture biography.','committed')`);
  await db.execute(sql`insert into assistant_runs(id,conversation_id,user_message_id,status,request_fingerprint,lease_until) values(${runId},${conversationId},${`message_${id}`},'running','fixture',now()+interval '10 minutes')`);
});
afterEach(async () => { if (enabled) await getDb().execute(sql`delete from shelves where id=${projectId}`); });
afterAll(async () => { if (enabled) await closeDb(); });

integration('lists and reads the selected story; denies foreign stories and injected authority', async () => {
  const list = await executeAssistantTool(authority(), { tool: 'storyContent', callId: 'list', args: { action: 'list', kind: 'characters' } }) as { records: Array<{ id: string }> };
  expect(list.records.map(record => record.id)).toEqual([character.record.id]);
  await expect(executeAssistantTool(authority(), { tool: 'storyContent', callId: 'foreign', args: { action: 'read', kind: 'characters', id: other.record.id } })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  await expect(executeAssistantTool({ ...authority(), gameId: foreignStory }, { tool: 'storyContent', callId: 'swapped', args: { action: 'read', kind: 'characters', id: other.record.id } })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  expect(assistantToolSchema.safeParse({ tool: 'storyContent', callId: 'inject', args: { action: 'read', kind: 'characters', id: character.record.id, gameId: foreignStory } }).success).toBe(false);
  expect(assistantToolSchema.safeParse({ tool: 'storyContent', callId: 'state', args: { action: 'propose', kind: 'characters', id: character.record.id, expected: character.revision, changes: { state: { isProtagonist: true } }, reason: 'Escalate' } }).success).toBe(false);
});
integration('proposal retains concrete diff without changing canon; cancel is durable', async () => {
  const approval = await proposal();
  expect(approval.preview).toMatchObject({ storyId: gameId, changes: [{ field: 'description', from: 'Original biography.', to: 'A careful bridge keeper.' }] });
  expect((await readCanonicalWorkspace(readArgs()) as CanonicalView).revision).toEqual(character.revision);
  await review(approval, 'decline');
  expect((await readCanonicalWorkspace(readArgs()) as CanonicalView).record.description).toBe('Original biography.');
  const [run] = await getDb().execute(sql`select status from assistant_runs where id=${runId}`); expect(run.status).toBe('completed');
});
integration('applies once with attributed history and undo as a new revision, without model calls', async () => {
  const approval = await proposal();
  const snapshot = await review(approval); await review(approval);
  const saved = await readCanonicalWorkspace(readArgs()) as CanonicalView;
  expect(saved.record.description).toBe('A careful bridge keeper.'); expect(saved.revision.recordVersion).toBeGreaterThan(character.revision.recordVersion);
  const history = await canonicalWorkspaceHistory(readArgs()); expect(history.revisions[0].actor).toMatchObject({ role: 'assistant', runId, approvedBy: 'local-user' });
  const receipt = snapshot.approvals.find(row => row.id === approval.id)!;
  const undo = { ...scope(), approvalId: approval.id, expectedRevision: receipt.revision };
  await undoAssistantStoryApproval(undo); await undoAssistantStoryApproval(undo);
  const restored = await readCanonicalWorkspace(readArgs()) as CanonicalView;
  expect(restored.record.description).toBe('Original biography.'); expect(restored.revision.recordVersion).toBeGreaterThan(saved.revision.recordVersion);
  const [calls] = await getDb().execute(sql`select count(*)::integer as count from api_call_logs where story_id=${gameId}`); expect(calls.count).toBe(0);
});
integration('rejects changes made between proposal and approval without losing the pending review', async () => {
  const approval = await proposal();
  await editCanonicalWorkspace({ ...readArgs(), expected: character.revision, updates: { description: 'Concurrent author edit.' } });
  await expect(review(approval)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await readCanonicalWorkspace(readArgs()) as CanonicalView).record.description).toBe('Concurrent author edit.');
  const [pending] = await getDb().execute(sql`select status from assistant_approvals where id=${approval.id}`); expect(pending.status).toBe('pending');
  await review(approval, 'decline');
});
integration('rejects undo after a concurrent author edit and denies cross-story review/undo', async () => {
  const approval = await proposal(); const snapshot = await review(approval);
  const receipt = snapshot.approvals.find(row => row.id === approval.id)!;
  await expect(undoAssistantStoryApproval({ ...scope(), gameId: foreignStory, approvalId: approval.id, expectedRevision: receipt.revision })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  const saved = await readCanonicalWorkspace(readArgs()) as CanonicalView;
  await editCanonicalWorkspace({ ...readArgs(), expected: saved.revision, updates: { name: 'New author name' } });
  await expect(undoAssistantStoryApproval({ ...scope(), approvalId: approval.id, expectedRevision: receipt.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(reviewAssistantApproval({ ...scope(), gameId: foreignStory, runId, approvalId: approval.id, expectedRevision: receipt.revision, decision: 'approve' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
});
integration('run cancellation makes its proposal unavailable and never changes the record', async () => {
  const approval = await proposal(); await cancelAssistantRun({ ...scope(), runId });
  await expect(review(approval)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await readCanonicalWorkspace(readArgs()) as CanonicalView).revision).toEqual(character.revision);
});
integration.each(['locations','items','factions'] as const)('uses existing %s canonical owner and bounds authored fields', async kind => {
  const entry = await createCanonicalWorkspace({ projectId, gameId, kind, fields: { name: 'Fixture', ...(kind === 'factions' ? { goals: ['Original goal'] } : { description: 'Original description' }) } }) as CanonicalView;
  await executeAssistantTool(authority(), { tool: 'storyContent', callId: 'entry', args: { action: 'propose', kind, id: entry.record.id, expected: entry.revision, changes: kind === 'factions' ? { goals: ['Guard the bridge'] } : { description: 'A bridge fixture.' }, reason: 'Fixture edit' } });
  const [approval] = await getDb().execute(sql`select * from assistant_approvals where run_id=${runId}`);
  await review(approval);
  const saved = await readCanonicalWorkspace({ projectId, gameId, kind, id: entry.record.id }) as CanonicalView;
  expect(kind === 'factions' ? saved.record.goals : saved.record.description).toEqual(kind === 'factions' ? ['Guard the bridge'] : 'A bridge fixture.');
});
