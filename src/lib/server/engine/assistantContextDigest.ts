import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';

type Cursor = { createdAt: string; id: string };
type Source = { kind: string; id: string; revision: number | string | null };
type MessageStub = { id: string; role: string; excerpt: string };
type Receipt = { runId: string; callId: string; tool: string; itemId?: string; typeId?: string; afterRevision?: number; changedFields?: string[]; decision?: string; answer?: string; operation?: string; path?: string; from?: string; to?: string };
export type AssistantDigest = { version: 1; through: Cursor | null; foldedCount: number; messages: MessageStub[]; receipts: Receipt[] };
type StoredMessage = { id: unknown; role: unknown; content: unknown; source_refs: unknown; created_at: unknown; cursor_at?: unknown };
type StoredTool = { run_id: unknown; call_id: unknown; tool: unknown; result: unknown };

const emptyDigest = (): AssistantDigest => ({ version: 1, through: null, foldedCount: 0, messages: [], receipts: [] });
const iso = (value: unknown) => new Date(value instanceof Date ? value.getTime() : String(value)).toISOString();
const excerpt = (value: unknown, limit: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

export function parseAssistantDigest(raw: unknown): AssistantDigest {
  if (!raw) return emptyDigest();
  const value = JSON.parse(String(raw)) as AssistantDigest;
  if (value.version !== 1 || !Array.isArray(value.messages) || !Array.isArray(value.receipts) || typeof value.foldedCount !== 'number') throw new Error('Stored Assistant context digest is invalid.');
  return value;
}

function source(value: unknown): Source | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.kind !== 'string' || typeof row.id !== 'string' || !row.kind || !row.id) return null;
  const revision = typeof row.revision === 'number' || typeof row.revision === 'string' ? row.revision : null;
  return { kind: row.kind.slice(0, 80), id: row.id.slice(0, 200), revision };
}

export function foldAssistantDigest(previous: AssistantDigest, previousSources: Source[], messages: StoredMessage[], tools: StoredTool[]) {
  const uniqueMessages = [...new Map(previous.messages.map(item => [item.id, item])).values()];
  const uniqueReceipts = [...new Map(previous.receipts.map(item => [`${item.runId}:${item.callId}`, item])).values()];
  const digest: AssistantDigest = { ...previous, foldedCount: Math.max(0, previous.foldedCount - (previous.messages.length - uniqueMessages.length)), messages: uniqueMessages, receipts: uniqueReceipts };
  const seenMessages = new Set(digest.messages.map(item => item.id));
  const seenReceipts = new Set(digest.receipts.map(item => `${item.runId}:${item.callId}`));
  const sources = new Map<string, Source>();
  for (const item of previousSources) { const parsed = source(item); if (parsed) sources.set(`${parsed.kind}:${parsed.id}`, parsed); }
  const addSource = (item: unknown) => { const parsed = source(item); if (parsed) { const key = `${parsed.kind}:${parsed.id}`; sources.delete(key); sources.set(key, parsed); } };
  for (const message of messages) {
    const id = String(message.id);
    if (!seenMessages.has(id) && digest.through?.id !== id) {
      digest.messages.push({ id, role: String(message.role), excerpt: excerpt(message.content, message.role === 'user' ? 220 : 140) });
      for (const ref of Array.isArray(message.source_refs) ? message.source_refs : []) addSource(ref);
      digest.foldedCount += 1;
      seenMessages.add(id);
    }
    digest.through = { createdAt: typeof message.cursor_at === 'string' ? message.cursor_at : iso(message.created_at), id };
  }
  for (const tool of tools) {
    const receiptKey = `${String(tool.run_id)}:${String(tool.call_id)}`;
    if (seenReceipts.has(receiptKey)) continue;
    const result = tool.result && typeof tool.result === 'object' ? tool.result as Record<string, unknown> : {};
    if (result.applied !== true && result.declined !== true && tool.tool !== 'askUserQuestion') continue;
    const itemId = typeof result.itemId === 'string' ? result.itemId : result.targetKind === 'item' && typeof result.id === 'string' ? result.id : undefined;
    const typeId = typeof result.typeId === 'string' ? result.typeId : result.targetKind === 'type' && typeof result.id === 'string' ? result.id : undefined;
    const afterRevision = typeof result.afterRevision === 'number' ? result.afterRevision : undefined;
    const answer = result.answer && typeof result.answer === 'object' ? result.answer as Record<string, unknown> : null;
    digest.receipts.push({ runId: String(tool.run_id), callId: String(tool.call_id), tool: String(tool.tool), ...(itemId ? { itemId } : {}), ...(typeId ? { typeId } : {}), ...(afterRevision !== undefined ? { afterRevision } : {}), ...(Array.isArray(result.changedFields) ? { changedFields: result.changedFields.filter((field): field is string => typeof field === 'string').slice(0, 12) } : {}), ...(result.declined === true ? { decision: 'declined' } : {}), ...(answer ? { answer: excerpt(answer.label ?? answer.text ?? answer.optionId, 140) } : {}),
      ...(tool.tool === 'folder' && typeof result.operation === 'string' ? { operation: excerpt(result.operation, 20) } : {}),
      ...(tool.tool === 'folder' && typeof result.path === 'string' ? { path: excerpt(result.path, 500) } : {}),
      ...(tool.tool === 'folder' && typeof result.from === 'string' ? { from: excerpt(result.from, 500) } : {}),
      ...(tool.tool === 'folder' && typeof result.to === 'string' ? { to: excerpt(result.to, 500) } : {}) });
    seenReceipts.add(receiptKey);
    if (itemId && afterRevision) addSource({ kind: 'content', id: itemId, revision: afterRevision });
    if (typeId && afterRevision) addSource({ kind: 'content_type', id: typeId, revision: afterRevision });
  }
  digest.messages = digest.messages.slice(-24);
  digest.receipts = digest.receipts.slice(-48);
  while (JSON.stringify(digest).length > 12_000 && (digest.messages.length || digest.receipts.length)) {
    if (digest.messages.length >= digest.receipts.length) digest.messages.shift();
    else digest.receipts.shift();
  }
  return { digest, sources: [...sources.values()].slice(-500) };
}

export async function prepareAssistantConversationContext(conversationId: string, currentMessageId: string) {
  const recent = await getDb().execute(sql`select id,role,content,created_at,created_at::text as cursor_at from assistant_messages where conversation_id=${conversationId} and id<>${currentMessageId} and role in ('user','assistant') and status='committed' order by created_at desc,id desc limit 12`);
  const boundary = recent.at(-1);
  const compacted = await getDb().transaction(async tx => {
    const [conversation] = await tx.execute(sql`select summary,summary_sources from assistant_conversations where id=${conversationId} for update`);
    if (!conversation) throw new Error('Assistant conversation disappeared during context preparation.');
    let digest = parseAssistantDigest(conversation.summary);
    let sources = Array.isArray(conversation.summary_sources) ? conversation.summary_sources as Source[] : [];
    let changed = false;
    if (boundary) {
      const boundaryAt = String(boundary.cursor_at);
      for (;;) {
        const after = digest.through ? sql`and (m.created_at,m.id)>(${digest.through.createdAt}::timestamptz,${digest.through.id})` : sql``;
        const batch = await tx.execute(sql`select m.id,m.role,m.content,m.source_refs,m.created_at,m.created_at::text as cursor_at from assistant_messages m where m.conversation_id=${conversationId} and m.role in ('user','assistant') and m.status='committed' and (m.created_at,m.id)<(${boundaryAt}::timestamptz,${boundary.id}) ${after} order by m.created_at,m.id limit 100`);
        if (!batch.length) break;
        const userIds = batch.filter(row => row.role === 'user').map(row => String(row.id));
        const tools = userIds.length ? await tx.execute(sql`select t.run_id,t.call_id,t.tool,t.result from assistant_tool_calls t join assistant_runs r on r.id=t.run_id where r.conversation_id=${conversationId} and r.user_message_id in (${sql.join(userIds.map(id => sql`${id}`), sql`,`)}) and t.status='completed' order by t.created_at,t.call_id`) : [];
        const folded = foldAssistantDigest(digest, sources,
          batch.map(row => ({ id: row.id, role: row.role, content: row.content, source_refs: row.source_refs, created_at: row.created_at, cursor_at: row.cursor_at })),
          tools.map(row => ({ run_id: row.run_id, call_id: row.call_id, tool: row.tool, result: row.result })));
        digest = folded.digest; sources = folded.sources; changed = true;
        if (batch.length < 100) break;
      }
    }
    if (changed) await tx.execute(sql`update assistant_conversations set summary=${JSON.stringify(digest)},summary_sources=${JSON.stringify(sources)}::jsonb where id=${conversationId}`);
    return { digest, sources };
  });
  const historical = compacted.digest.foldedCount ? JSON.stringify({ foldedMessages: compacted.digest.foldedCount, olderMessages: compacted.digest.messages, appliedReceipts: compacted.digest.receipts, retainedSources: compacted.sources.slice(-48) }) : '';
  return { recent: [...recent].reverse().map(row => ({ role: row.role as 'user' | 'assistant', content: String(row.content).slice(0, 4_000) })), historical, sources: compacted.sources };
}
