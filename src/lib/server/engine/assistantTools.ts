import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { contentDefinitionSchema, contentUpdateSchema } from '$lib/contracts/content';
import type { AgentTool } from '$lib/contracts/agentTools';
import { getDb } from '$lib/server/db/client';
import type { NativeToolDefinition } from '$lib/server/turn/provider';
import { assertAgentToolAllowed } from './agentPolicy';
import { getAgentSettings } from './agentSettings';
import { agentRunHash } from './agentRunHash';
import { createFolderInTransaction, listContent, listContentHistory, listContentTypes, listFoldersInTransaction, moveFolderInTransaction, readContent, restoreContentHistoryInTransaction, saveContentTypeInTransaction, updateContentInTransaction, writeContentInTransaction } from './content';
import { MutationError } from './mutationSafety';
import { reserveExplicitImage } from './imageRequests';
import { completeDirectImageRequest } from './imageJobs';
import { assistantBatchPlanSchema, createAssistantBatchPlanInTransaction, queueAssistantBatchInTransaction } from './assistantBatchPlan';

const identifier = z.string().min(1).max(200);
const read = z.object({ tool: z.literal('read'), callId: identifier, args: z.object({ kind: z.enum(['item', 'type', 'itemHistory', 'typeHistory']), id: identifier }).strict() }).strict();
const list = z.object({ tool: z.literal('list'), callId: identifier, args: z.object({ kind: z.enum(['item', 'type']), query: z.string().max(300).default(''), limit: z.number().int().min(1).max(20).default(10) }).strict() }).strict();
const write = z.object({ tool: z.literal('write'), callId: identifier, args: z.object({ typeId: identifier, expectedTypeRevision: z.number().int().positive(), title: z.string().trim().min(1).max(200), slug: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), description: z.string().max(2000).default(''), folder: z.string().max(500).default(''), data: z.record(z.string(), z.unknown()), visibility: z.enum(['public', 'gm']).default('gm') }).strict() }).strict();
const update = z.object({ tool: z.literal('update'), callId: identifier, args: z.object({ id: identifier, expectedRevision: z.number().int().positive(), expectedTypeRevision: z.number().int().positive(), changes: contentUpdateSchema.shape.changes }).strict() }).strict();
const saveType = z.object({ tool: z.literal('saveType'), callId: identifier, args: z.object({ id: identifier.optional(), expectedRevision: z.number().int().positive().optional(), key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), extension: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), name: z.string().trim().min(1).max(100), definition: contentDefinitionSchema }).strict() }).strict();
const folderPath = z.string().min(1).max(500);
const folderMoveArgs = { from: folderPath, to: folderPath };
const folder = z.object({ tool: z.literal('folder'), callId: identifier, args: z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), prefix: z.string().max(500).default(''), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  z.object({ action: z.literal('create'), path: folderPath }).strict(),
  z.object({ action: z.literal('previewMove'), ...folderMoveArgs }).strict(),
  z.object({ action: z.literal('previewCopy'), ...folderMoveArgs }).strict(),
  z.object({ action: z.literal('move'), ...folderMoveArgs, expectedSnapshot: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal('copy'), ...folderMoveArgs, expectedSnapshot: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]) }).strict();
const askUserQuestion = z.object({ tool: z.literal('askUserQuestion'), callId: identifier, args: z.object({ prompt: z.string().trim().min(1).max(1000), options: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().trim().min(1).max(200) }).strict()).min(1).max(8), allowCustom: z.boolean().default(false) }).strict() }).strict();
const revert = z.object({ tool: z.literal('revert'), callId: identifier, args: z.object({ targetKind: z.enum(['item', 'type']), id: identifier, targetRevision: z.number().int().positive(), expectedRevision: z.number().int().positive() }).strict() }).strict();
const clearLayout = z.object({ tool: z.literal('clearLayout'), callId: identifier, args: z.object({ id: identifier, expectedRevision: z.number().int().positive() }).strict() }).strict();
const generateImage = z.object({ tool: z.literal('generateImage'), callId: identifier, args: z.object({ prompt: z.string().trim().min(1).max(1000) }).strict() }).strict();
const subagent = z.object({ tool: z.literal('subagent'), callId: identifier, args: z.discriminatedUnion('action', [
  assistantBatchPlanSchema.pick({ typeId: true, expectedTypeRevision: true, objective: true, instructions: true, allowedFields: true, maxTargets: true }).extend({ action: z.literal('plan') }).strict(),
  z.object({ action: z.literal('dispatch'), batchId: identifier }).strict(),
]) }).strict();
export const assistantToolSchema = z.discriminatedUnion('tool', [read, list, write, update, saveType, folder, askUserQuestion, revert, clearLayout, generateImage, subagent]);
export type AssistantToolCall = z.infer<typeof assistantToolSchema>;
export const implementedAssistantTools = ['read', 'list', 'write', 'update', 'saveType', 'folder', 'askUserQuestion', 'revert', 'clearLayout', 'generateImage', 'subagent'] as const satisfies readonly AgentTool[];

export const assistantToolDefinitions: Record<AssistantToolCall['tool'], NativeToolDefinition> = {
  subagent: { name: 'subagent', description: 'Plan or dispatch a bounded batch of same-type documents. First read the type and sample records, then plan with its exact current revision, objective, instructions, and allowed data fields. Inspect the returned target count and sample before a separate dispatch call. Dispatch queues isolated child jobs; it does not mean edits are complete. Children cannot change types/settings, use tools, or inherit this conversation.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['plan', 'dispatch'] }, typeId: { type: 'string' }, expectedTypeRevision: { type: 'integer', minimum: 1 }, objective: { type: 'string' }, instructions: { type: 'string' }, allowedFields: { type: 'array', items: { type: 'string' } }, maxTargets: { type: 'integer', minimum: 1, maximum: 500 }, batchId: { type: 'string' } }, required: ['action'], additionalProperties: false } },
  generateImage: { name: 'generateImage', description: 'Generate one image directly for this Assistant conversation when chat images are enabled. Read relevant files first and use saved bio appearance, species and current form. For scenes gather and include everyone present, their actions and setting. Avoid the word portrait and human framing for creatures; a dragon in dragon form has a complete dragon body. Follow the project image style. The API waits for generation and returns a completed image receipt; report failures honestly.', parameters: { type: 'object', properties: { prompt: { type: 'string', maxLength: 1000 } }, required: ['prompt'], additionalProperties: false } },
  read: { name: 'read', description: 'Read one scoped document or custom type, or its last 20 retained revisions using itemHistory/typeHistory. Read before any update or restore.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['item', 'type', 'itemHistory', 'typeHistory'] }, id: { type: 'string' } }, required: ['kind', 'id'], additionalProperties: false } },
  list: { name: 'list', description: 'List bounded documents or custom types in this conversation scope. Game scope includes shared project documents for reading.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['item', 'type'] }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['kind'], additionalProperties: false } },
  write: { name: 'write', description: 'Create one document in this conversation scope with an existing type ID and exact current type revision.', parameters: { type: 'object', properties: { typeId: { type: 'string' }, expectedTypeRevision: { type: 'integer' }, title: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string' }, folder: { type: 'string' }, data: { type: 'object' }, visibility: { type: 'string', enum: ['public', 'gm'] } }, required: ['typeId', 'expectedTypeRevision', 'title', 'slug', 'data'], additionalProperties: false } },
  update: { name: 'update', description: 'Apply a partial edit to one document owned by this conversation scope. Supply exact item and type revisions from a current read.', parameters: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'integer' }, expectedTypeRevision: { type: 'integer' }, changes: { type: 'object' } }, required: ['id', 'expectedRevision', 'expectedTypeRevision', 'changes'], additionalProperties: false } },
  saveType: { name: 'saveType', description: 'Create or edit one project-wide custom document type. For edits, read the type first and supply id plus exact current expectedRevision. Supply the complete definition. Existing documents must remain valid. To clear a populated layout, use clearLayout instead; saveType cannot bypass human review.', parameters: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'integer' }, key: { type: 'string' }, extension: { type: 'string' }, name: { type: 'string' }, definition: { type: 'object', properties: { fields: { type: 'object', additionalProperties: { type: 'object', properties: { kind: { type: 'string', enum: ['text', 'longtext', 'number', 'boolean', 'enum', 'array', 'object', 'reference'] }, label: { type: 'string' }, required: { type: 'boolean' }, options: { type: 'array', items: { type: 'string' } }, fields: { type: 'object' }, items: { type: 'object' } }, required: ['kind'], additionalProperties: false } }, layout: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } } }, required: ['title', 'fields'], additionalProperties: false } }, defaults: { type: 'object' }, gmContextMode: { type: 'string', enum: ['pinned', 'partial', 'searchable'] } }, required: ['fields', 'layout', 'defaults', 'gmContextMode'], additionalProperties: false } }, required: ['key', 'extension', 'name', 'definition'], additionalProperties: false } },
  folder: { name: 'folder', description: 'List folders, create an empty folder, or preview and then move/copy a complete folder tree in this conversation scope. Preview returns an exact snapshot token and affected counts; move/copy requires that token and fails if the tree changed. A game conversation organizes game folders, not shared project folders. This tool cannot archive or restore folders.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'create', 'previewMove', 'previewCopy', 'move', 'copy'] }, prefix: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, path: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, expectedSnapshot: { type: 'string' } }, required: ['action'], additionalProperties: false } },
  askUserQuestion: { name: 'askUserQuestion', description: 'Pause this Assistant run for one author answer when an essential choice is missing. Give stable option IDs and labels. Do not ask again after an answer is supplied.', parameters: { type: 'object', properties: { prompt: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false } }, allowCustom: { type: 'boolean' } }, required: ['prompt', 'options'], additionalProperties: false } },
  revert: { name: 'revert', description: 'Propose restoring one exact document or custom type revision. Requires current revision from read and target revision from retained history. This pauses for a human to review the concrete diff; the tool alone never applies the restore.', parameters: { type: 'object', properties: { targetKind: { type: 'string', enum: ['item', 'type'] }, id: { type: 'string' }, targetRevision: { type: 'integer', minimum: 1 }, expectedRevision: { type: 'integer', minimum: 1 } }, required: ['targetKind', 'id', 'targetRevision', 'expectedRevision'], additionalProperties: false } },
  clearLayout: { name: 'clearLayout', description: 'Propose clearing only the layout of one project custom type at an exact current revision. Retains fields, defaults and other type settings. Pauses for a human to review the layout diff and document impact; this tool never applies the clear by itself.', parameters: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 1 } }, required: ['id', 'expectedRevision'], additionalProperties: false } },
};

export interface AssistantAuthority { runId: string; conversationId: string; projectId: string; gameId: string | null }

export function assertAssistantReplySupported(request: string, reply: string, observations: Array<{ tool?: string; result: unknown }>) {
  const actionRequested = /\b(create|copy|move|rename|update|edit|save|write|replace|archive|restore|revise|add|remove)\b/i.test(request);
  const claimedApplied = /\b(successfully\s+(?:created|copied|updated|moved|renamed|saved|applied|restored|archived|deleted|revised)|applied\s+(?:results?|revision|changes)|new\s+(?:item|type|document)\s+id)\b/i.test(reply.replace(/[`*]/g, ''));
  const applied = observations.some(observation => !!observation.result && typeof observation.result === 'object' && (observation.result as { applied?: unknown }).applied === true);
  if (actionRequested && claimedApplied && !applied) throw new MutationError('UNVERIFIED_ASSISTANT_CLAIM', 'Assistant claimed an edit without an applied tool receipt; no change was confirmed.');
  const imageRequested = /\b(image|picture|portrait|cover|artwork|illustration)\b/i.test(request);
  const claimedImageComplete = /\b(?:generated|rendered|finished|completed)\s+(?:(?:an?|the|your)\s+)?(?:image|picture|portrait|cover|artwork|illustration)\b|\b(?:image|picture|portrait|cover|artwork|illustration)\s+(?:(?:is|was|has been)\s+)?(?:ready|generated|rendered|finished|complete)\b/i.test(reply);
  const imageComplete = observations.some(observation => observation.tool === 'generateImage' && observation.result
    && typeof observation.result === 'object' && (observation.result as { status?: string; imageResult?: { assetId?: string } }).status === 'complete'
    && (observation.result as { imageResult?: { assetId?: string } }).imageResult?.assetId);
  if (imageRequested && claimedImageComplete && !imageComplete) throw new MutationError('UNVERIFIED_ASSISTANT_CLAIM', 'Assistant claimed a completed image without a completed image receipt.');
}

function bounded(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized.length <= 16_000 ? value : { excerpt: serialized.slice(0, 16_000), truncated: true };
}

export async function executeAssistantTool(authority: AssistantAuthority, rawCall: unknown): Promise<unknown> {
  const call = assistantToolSchema.parse(rawCall);
  const settings = await getAgentSettings({ projectId: authority.projectId, ...(authority.gameId ? { gameId: authority.gameId } : {}) });
  assertAgentToolAllowed({ role: 'assistant', projectId: authority.projectId, gameId: authority.gameId }, call.tool, { projectId: authority.projectId, gameId: authority.gameId, ...('id' in call.args ? { id: call.args.id } : {}) }, settings.effective, implementedAssistantTools);
  const argsHash = agentRunHash(call.args);
  const actor = { role: 'assistant', runId: authority.runId, callId: call.callId, initiatedBy: 'local-user' };
  try {
    const result = await getDb().transaction(async tx => {
      const [run] = await tx.execute(sql`select r.status,c.project_id,c.game_id from assistant_runs r join assistant_conversations c on c.id=r.conversation_id where r.id=${authority.runId} and r.conversation_id=${authority.conversationId} for update of r`);
      if (!run || run.project_id !== authority.projectId || run.game_id !== authority.gameId || run.status !== 'running') throw new MutationError('SCOPE_DENIED', 'Assistant run is no longer active in this scope.');
      const [saved] = await tx.execute(sql`select status,args_hash,result,error from assistant_tool_calls where run_id=${authority.runId} and call_id=${call.callId} for update`);
      if (saved) {
        if (saved.args_hash !== argsHash) throw new MutationError('REVISION_CONFLICT', 'Tool call ID was reused with different arguments.');
        if (saved.status === 'completed') return saved.result;
        if (saved.status === 'failed') throw new Error(String(saved.error ?? 'Assistant tool failed.'));
      } else {
        await tx.execute(sql`insert into assistant_tool_calls(run_id,call_id,tool,args_hash,args,status) values(${authority.runId},${call.callId},${call.tool},${argsHash},${JSON.stringify(call.args)}::jsonb,'reserved')`);
      }
      if (call.tool === 'askUserQuestion') {
        if (new Set(call.args.options.map(option => option.id)).size !== call.args.options.length) throw new MutationError('INVALID_FIELD', 'Question option IDs must be distinct.');
        const questionId = `assistant_question_${randomUUID()}`;
        await tx.execute(sql`insert into assistant_questions(id,run_id,call_id,prompt,options,allow_custom,status) values(${questionId},${authority.runId},${call.callId},${call.args.prompt},${JSON.stringify(call.args.options)}::jsonb,${call.args.allowCustom},'pending')`);
        await tx.execute(sql`update assistant_runs set status='awaiting_input',lease_until=null,updated_at=now() where id=${authority.runId}`);
        return { pendingQuestionId: questionId };
      }
      if (call.tool === 'revert') {
        const restoreRequest = { projectId: authority.projectId, ...(call.args.targetKind === 'item' && authority.gameId ? { gameId: authority.gameId } : {}), ...call.args };
        const preview = await restoreContentHistoryInTransaction(tx, restoreRequest, true);
        if (!preview.compatible) throw new MutationError('SCHEMA_CONFLICT', 'The requested revision cannot be restored.', { conflicts: preview.conflicts });
        const approvalId = `assistant_restore_${randomUUID()}`;
        await tx.execute(sql`insert into assistant_approvals(id,run_id,call_id,kind,request,preview,status) values(${approvalId},${authority.runId},${call.callId},'restore',${JSON.stringify(restoreRequest)}::jsonb,${JSON.stringify(preview)}::jsonb,'pending')`);
        await tx.execute(sql`update assistant_runs set status='awaiting_input',lease_until=null,updated_at=now() where id=${authority.runId}`);
        return { pendingRestoreId: approvalId };
      }
      if (call.tool === 'clearLayout') {
        const [current] = await tx.execute(sql`select * from content_types where id=${call.args.id} and project_id=${authority.projectId}`);
        if (!current) throw new MutationError('SCOPE_DENIED', 'Custom type is unavailable in this project.');
        const definition = contentDefinitionSchema.parse(current.definition);
        const clearRequest = { projectId: authority.projectId, id: call.args.id, expectedRevision: call.args.expectedRevision, key: current.key, extension: current.extension, name: current.name, definition: { ...definition, layout: [] } };
        const checked = await saveContentTypeInTransaction(tx, clearRequest, actor, true);
        if (!checked.requiresClearConfirmation) throw new MutationError('INVALID_FIELD', 'This type has no populated layout to clear.');
        if (!checked.compatible) throw new MutationError('SCHEMA_CONFLICT', 'The layout clear is incompatible with existing documents.', { conflicts: checked.conflicts });
        const preview = { ...checked, title: current.name, currentRevision: current.revision, changes: [{ field: 'definition.layout', from: definition.layout, to: [] }] };
        const approvalId = `assistant_clear_${randomUUID()}`;
        await tx.execute(sql`insert into assistant_approvals(id,run_id,call_id,kind,request,preview,status) values(${approvalId},${authority.runId},${call.callId},'layout_clear',${JSON.stringify(clearRequest)}::jsonb,${JSON.stringify(preview)}::jsonb,'pending')`);
        await tx.execute(sql`update assistant_runs set status='awaiting_input',lease_until=null,updated_at=now() where id=${authority.runId}`);
        return { pendingApprovalId: approvalId };
      }
      const scope = { projectId: authority.projectId, ...(authority.gameId ? { gameId: authority.gameId } : {}) };
      let result: unknown;
      if (call.tool === 'folder') {
        const args = call.args;
        if (args.action === 'list') {
          const folders = await listFoldersInTransaction(tx, scope);
          const paths = folders.paths.filter(path => !args.prefix || path === args.prefix || path.startsWith(`${args.prefix}/`));
          result = { operation: 'list', paths: paths.slice(args.offset, args.offset + args.limit).map(path => ({ path, archived: !folders.activePaths.includes(path) })), total: paths.length,
            nextOffset: args.offset + args.limit < paths.length ? args.offset + args.limit : null };
        } else if (args.action === 'create') {
          const created = await createFolderInTransaction(tx, { ...scope, path: args.path }, actor);
          result = { applied: true, operation: 'create', path: created.folder.path, folderId: created.folder.id, afterRevision: created.folder.revision };
        } else {
          const operation = args.action.endsWith('Copy') || args.action === 'copy' ? 'copy' : 'move';
          const preview = args.action.startsWith('preview');
          const changed = await moveFolderInTransaction(tx, { ...scope, from: args.from, to: args.to,
            ...('expectedSnapshot' in args ? { expectedSnapshot: args.expectedSnapshot } : {}) }, preview, operation, actor);
          result = { applied: !preview, operation, from: changed.from, to: changed.to, expectedSnapshot: changed.expectedSnapshot,
            counts: changed.counts, sample: changed.items.slice(0, 10), sampleTruncated: changed.items.length > 10,
            ...('itemIds' in changed && changed.itemIds ? { copiedItemIds: Object.entries(changed.itemIds).slice(0, 10) } : {}) };
        }
      } else if (call.tool === 'subagent') {
        if (call.args.action === 'plan') {
          const { action: _action, ...planArgs } = call.args;
          const planned = await createAssistantBatchPlanInTransaction(tx, { ...planArgs,
            runId: authority.runId, callId: call.callId, conversationId: authority.conversationId,
            projectId: authority.projectId, ...(authority.gameId ? { gameId: authority.gameId } : {}) });
          result = { batchId: planned.batchId, status: 'planned', targetCount: planned.targetCount,
            childCount: planned.childCount, sample: planned.sample, budget: planned.budget };
        } else {
          await queueAssistantBatchInTransaction(tx, call.args.batchId, scope, authority.runId);
          const [queued] = await tx.execute(sql`select status from assistant_batches where id=${call.args.batchId} and project_id=${authority.projectId}`);
          result = { batchId: call.args.batchId, status: queued.status };
        }
      } else if (call.tool === 'generateImage') {
        return reserveExplicitImage(tx, { role: 'assistant', projectId: authority.projectId, gameId: authority.gameId,
          runId: authority.runId, callId: call.callId, conversationId: authority.conversationId, prompt: call.args.prompt });
      } else if (call.tool === 'read') {
        if (call.args.kind === 'item') result = (await readContent({ ...scope, ids: [call.args.id] })).items[0];
        else if (call.args.kind === 'type') result = (await listContentTypes({ projectId: authority.projectId })).types.find(type => type.id === call.args.id) ?? null;
        else result = await listContentHistory({ projectId: authority.projectId, ...(call.args.kind === 'itemHistory' && authority.gameId ? { gameId: authority.gameId } : {}), targetKind: call.args.kind === 'itemHistory' ? 'item' : 'type', id: call.args.id, limit: 20 });
        if (!result) throw new MutationError('SCOPE_DENIED', 'Requested content is unavailable in this scope.');
        result = bounded(result);
      } else if (call.tool === 'list') {
        if (call.args.kind === 'item') result = await listContent({ ...scope, q: call.args.query, limit: call.args.limit });
        else result = { types: (await listContentTypes({ projectId: authority.projectId })).types.filter(type => `${type.name} ${type.key}`.toLowerCase().includes(call.args.query.toLowerCase())).slice(0, call.args.limit) };
        result = bounded(result);
      } else if (call.tool === 'write') {
        const created = await writeContentInTransaction(tx, { ...scope, ...call.args }, actor);
        result = { applied: true, itemId: created.item.id, title: created.item.title, beforeRevision: null, afterRevision: created.item.revision, typeRevision: created.item.type_revision, changedFields: Object.keys(call.args.data) };
      } else if (call.tool === 'saveType') {
        const savedType = await saveContentTypeInTransaction(tx, { projectId: authority.projectId, ...call.args }, actor);
        if (!savedType.type) throw new Error('Type save returned no applied type.');
        result = { applied: true, typeId: savedType.type.id, title: savedType.type.name, beforeRevision: call.args.expectedRevision ?? null, afterRevision: savedType.type.revision, changedFields: ['definition'] };
      } else {
        const updated = await updateContentInTransaction(tx, { ...scope, ...call.args }, actor);
        result = { applied: true, itemId: updated.item.id, title: updated.item.title, beforeRevision: call.args.expectedRevision, afterRevision: updated.item.revision, typeRevision: updated.item.type_revision, changedFields: Object.keys(call.args.changes) };
      }
      await tx.execute(sql`update assistant_tool_calls set status='completed',result=${JSON.stringify(result)}::jsonb,updated_at=now() where run_id=${authority.runId} and call_id=${call.callId}`);
      return result;
    });
    if (call.tool === 'generateImage' && result && typeof result === 'object' && 'isNew' in result) {
      const image = await completeDirectImageRequest(result as { jobId: string; isNew: boolean });
      await getDb().execute(sql`update assistant_tool_calls set status='completed',result=${JSON.stringify(image)}::jsonb,updated_at=now()
        where run_id=${authority.runId} and call_id=${call.callId} and args_hash=${argsHash} and status='reserved'`);
      return image;
    }
    return result;
  } catch (error) {
    if (error instanceof MutationError && error.code === 'IMAGE_PENDING') throw error;
    await getDb().execute(sql`insert into assistant_tool_calls(run_id,call_id,tool,args_hash,args,status,error) values(${authority.runId},${call.callId},${call.tool},${argsHash},${JSON.stringify(call.args)}::jsonb,'failed',${error instanceof Error ? error.message : String(error)}) on conflict (run_id,call_id) do update set status='failed',error=excluded.error,updated_at=now() where assistant_tool_calls.status<>'completed' and assistant_tool_calls.args_hash=excluded.args_hash`);
    throw error;
  }
}
