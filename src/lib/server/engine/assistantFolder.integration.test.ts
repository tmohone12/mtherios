import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { gearExample } from '$lib/contracts/content';
import { closeDb, getDb } from '$lib/server/db/client';
import { executeAssistantTool } from './assistantTools';

const integration = process.env.MYTHENGINE_ASSISTANT_FOLDER_INTEGRATION === '1' ? test : test.skip;

integration('organizes scoped folder trees with exact previews, attributed revisions, and durable receipts', async () => {
  const db = getDb();
  const suffix = randomUUID();
  const projectId = `shelf_assistant_folder_${suffix}`;
  const gameId = `story_assistant_folder_${suffix}`;
  const typeId = `type_assistant_folder_${suffix}`;
  const documentId = `item_assistant_folder_${suffix}`;
  const conversationId = `assistant_conversation_${suffix}`;
  const messageId = `assistant_message_${suffix}`;
  const runId = `assistant_run_${suffix}`;
  const authority = { runId, conversationId, projectId, gameId: null };
  const call = (callId: string, args: Record<string, unknown>) => ({ tool: 'folder', callId, args });
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Assistant folder fixture',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Folder fixture game')`);
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition)
      values(${typeId},${projectId},'gear','gear','Gear',${JSON.stringify(gearExample)}::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,type_id,title,slug,folder,data)
      values(${documentId},${projectId},${typeId},'Folder source','folder-source','Source/Nested','{"notes":"original"}'::jsonb)`);
    await db.execute(sql`insert into assistant_conversations(id,project_id) values(${conversationId},${projectId})`);
    await db.execute(sql`insert into assistant_messages(id,conversation_id,role,content,status)
      values(${messageId},${conversationId},'user','Organize fixture folders.','committed')`);
    await db.execute(sql`insert into assistant_runs(id,conversation_id,user_message_id,status,request_fingerprint,lease_until)
      values(${runId},${conversationId},${messageId},'running','fixture',now()+interval '10 minutes')`);

    const created = await executeAssistantTool(authority, call('create', { action: 'create', path: 'Empty' })) as { applied: boolean; path: string };
    expect(created).toMatchObject({ applied: true, path: 'Empty' });
    expect(await executeAssistantTool(authority, call('create', { action: 'create', path: 'Empty' }))).toEqual(created);
    const listed = await executeAssistantTool(authority, call('list', { action: 'list' })) as { paths: Array<{ path: string }> };
    expect(listed.paths.map(row => row.path)).toEqual(expect.arrayContaining(['Empty', 'Source', 'Source/Nested']));

    const copyPreview = await executeAssistantTool(authority, call('preview-copy', { action: 'previewCopy', from: 'Source', to: 'Copied' })) as
      { expectedSnapshot: string; counts: { documents: number }; applied: boolean };
    expect(copyPreview).toMatchObject({ applied: false, counts: { documents: 1 } });
    const copyCall = call('copy', { action: 'copy', from: 'Source', to: 'Copied', expectedSnapshot: copyPreview.expectedSnapshot });
    const copied = await executeAssistantTool(authority, copyCall) as { applied: boolean; copiedItemIds: Array<[string, string]> };
    expect(copied.applied).toBe(true);
    expect(copied.copiedItemIds[0][0]).toBe(documentId);
    expect(await executeAssistantTool(authority, copyCall)).toEqual(copied);
    const copiedId = copied.copiedItemIds[0][1];
    const [copiedDocument] = await db.execute(sql`select folder,data,revision from content_items where id=${copiedId}`);
    expect(copiedDocument).toMatchObject({ folder: 'Copied/Nested', data: { notes: 'original' }, revision: 1 });
    const [copiedHistory] = await db.execute(sql`select actor from content_revisions where target_kind='item' and target_id=${copiedId} and revision=1`);
    expect(copiedHistory.actor).toMatchObject({ role: 'assistant', runId, callId: 'copy' });

    const stalePreview = await executeAssistantTool(authority, call('preview-stale', { action: 'previewMove', from: 'Source', to: 'Filed' })) as { expectedSnapshot: string };
    await db.execute(sql`update content_items set revision=revision+1 where id=${documentId}`);
    await expect(executeAssistantTool(authority, call('stale', { action: 'move', from: 'Source', to: 'Filed', expectedSnapshot: stalePreview.expectedSnapshot })))
      .rejects.toThrow('changed or no preview');
    const [unmoved] = await db.execute(sql`select folder from content_items where id=${documentId}`);
    expect(unmoved.folder).toBe('Source/Nested');
    const freshPreview = await executeAssistantTool(authority, call('preview-move', { action: 'previewMove', from: 'Source', to: 'Filed' })) as { expectedSnapshot: string };
    const moved = await executeAssistantTool(authority, call('move', { action: 'move', from: 'Source', to: 'Filed', expectedSnapshot: freshPreview.expectedSnapshot })) as { applied: boolean };
    expect(moved.applied).toBe(true);
    const [movedDocument] = await db.execute(sql`select folder,revision from content_items where id=${documentId}`);
    expect(movedDocument).toMatchObject({ folder: 'Filed/Nested', revision: 3 });
    const [movedHistory] = await db.execute(sql`select actor from content_revisions where target_kind='item' and target_id=${documentId} and revision=3`);
    expect(movedHistory.actor).toMatchObject({ role: 'assistant', runId, callId: 'move' });

    const gameConversationId = `assistant_conversation_game_${suffix}`;
    const gameMessageId = `assistant_message_game_${suffix}`;
    const gameRunId = `assistant_run_game_${suffix}`;
    await db.execute(sql`insert into assistant_conversations(id,project_id,game_id) values(${gameConversationId},${projectId},${gameId})`);
    await db.execute(sql`insert into assistant_messages(id,conversation_id,role,content,status)
      values(${gameMessageId},${gameConversationId},'user','List game folders.','committed')`);
    await db.execute(sql`insert into assistant_runs(id,conversation_id,user_message_id,status,request_fingerprint,lease_until)
      values(${gameRunId},${gameConversationId},${gameMessageId},'running','fixture',now()+interval '10 minutes')`);
    const gameAuthority = { runId: gameRunId, conversationId: gameConversationId, projectId, gameId };
    const gameFolders = await executeAssistantTool(gameAuthority, call('game-list', { action: 'list' })) as { total: number };
    expect(gameFolders.total).toBe(0);
    await expect(executeAssistantTool(gameAuthority, call('game-preview', { action: 'previewMove', from: 'Filed', to: 'Game Filed' })))
      .rejects.toThrow('not found in this scope');
    const [receiptCount] = await db.execute(sql`select count(*)::integer as count from assistant_tool_calls where run_id=${runId} and status='completed' and tool='folder'`);
    expect(receiptCount.count).toBe(7);
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
  }
}, 30_000);

afterAll(async () => { if (process.env.MYTHENGINE_ASSISTANT_FOLDER_INTEGRATION === '1') await closeDb(); });
