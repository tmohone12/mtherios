import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import type { CanonicalView } from '$lib/contracts/canonicalContent';
import { storyEditRequest, type StoryEditRequest } from '$lib/contracts/assistantStoryContent';
import { getDb } from '$lib/server/db/client';
import { readCanonicalWorkspaceInTransaction, editCanonicalWorkspaceInTransaction } from './canonicalContent';
import { agentRunHash } from './agentRunHash';
import { MutationError } from './mutationSafety';

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
export async function previewAssistantStoryEdit(tx: Tx, input: unknown) {
  const request = storyEditRequest.parse(input);
  if ((request.kind === 'factions' && request.changes.description !== undefined) || (request.kind !== 'factions' && request.changes.goals !== undefined)) {
    throw new MutationError('INVALID_FIELD', 'Factions support name and goals; characters, locations and items support name and description.');
  }
  const current = await readCanonicalWorkspaceInTransaction(tx, { projectId: request.projectId, gameId: request.gameId, kind: request.kind, id: request.id }, true) as CanonicalView;
  if (!isDeepStrictEqual(request.expected, current.revision)) throw new MutationError('REVISION_CONFLICT', 'This story entry changed. Read it again and propose a fresh edit.');
  const changes = Object.entries(request.changes).filter(([field, to]) => !isDeepStrictEqual(current.record[field], to))
    .map(([field, to]) => ({ field, from: current.record[field] ?? (field === 'goals' ? [] : ''), to }));
  if (!changes.length) throw new MutationError('INVALID_FIELD', 'The proposed fields already match this entry.');
  const [story] = await tx.execute(sql`select title from stories where id=${request.gameId} and shelf_id=${request.projectId}`);
  return { title: String(current.record.name), storyId: request.gameId, storyTitle: String(story?.title ?? 'Selected story'), kind: request.kind, currentRevision: current.revision,
    compatible: true, conflicts: [] as string[], reason: request.reason, changes,
    expectedSnapshot: agentRunHash({ request, current }) };
}

export async function applyAssistantStoryEdit(tx: Tx, input: unknown, reviewedHash: string, actor: Record<string, unknown>) {
  const request = storyEditRequest.parse(input);
  const preview = await previewAssistantStoryEdit(tx, request);
  if (preview.expectedSnapshot !== reviewedHash) throw new MutationError('REVISION_CONFLICT', 'The reviewed entry changed. Cancel this proposal and request a fresh edit.');
  const saved = await editCanonicalWorkspaceInTransaction(tx, { projectId: request.projectId, gameId: request.gameId, kind: request.kind, id: request.id, expected: request.expected, updates: request.changes }, actor);
  return { applied: true, storyId: request.gameId, kind: request.kind, id: request.id, title: String(saved.record.name), beforeRevision: request.expected, afterRevision: saved.revision,
    changedFields: preview.changes.map(change => change.field), undoChanges: Object.fromEntries(preview.changes.map(change => [change.field, change.from])), savedHash: agentRunHash(saved) };
}

// Author action only. Restores just the approved fields, producing a fresh canonical revision.
export async function undoAssistantStoryEdit(tx: Tx, request: StoryEditRequest, result: Record<string, unknown>, actor: Record<string, unknown>) {
  const current = await readCanonicalWorkspaceInTransaction(tx, { projectId: request.projectId, gameId: request.gameId, kind: request.kind, id: request.id }, true) as CanonicalView;
  if (!isDeepStrictEqual(current.revision, result.afterRevision) || agentRunHash(current) !== result.savedHash) throw new MutationError('REVISION_CONFLICT', 'This entry changed after apply. Review its history before restoring older fields.');
  const saved = await editCanonicalWorkspaceInTransaction(tx, { projectId: request.projectId, gameId: request.gameId, kind: request.kind, id: request.id, expected: current.revision, updates: result.undoChanges }, actor);
  return { ...result, undone: true, undoRevision: saved.revision };
}
