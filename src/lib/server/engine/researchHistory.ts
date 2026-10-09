import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { isNarrativeTimelineEvent } from '$lib/server/events/timeline';
import { isOocControlText } from '$lib/server/memory/ranking';
import { getWorldRecord } from './worldRecords';

const statementSchema = z.object({
  kind: z.enum(['entry', 'event', 'world', 'content']),
  sourceId: z.string().min(1).max(300),
  revision: z.string().min(1).max(100),
  statement: z.string().min(1).max(400),
});
const receiptSchema = z.object({
  mode: z.literal('local_extract'),
  status: z.enum(['answered', 'insufficient_evidence', 'unavailable']),
  question: z.string().min(1).max(500),
  statements: z.array(statementSchema).max(3),
});
export type PublicResearchReceipt = z.infer<typeof receiptSchema> & { sourceUnavailable: boolean };
type Statement = z.infer<typeof statementSchema>;

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const revision = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? '');
const publicEntry = (value: unknown) => !['secret', 'gm', 'private'].includes(String(value ?? '').toLowerCase());

/** Recheck a saved quotation against current scoped, player-visible evidence before projecting it into the reader. */
export async function currentPublicResearchRevision(scope: { projectId: string; gameId: string }, source: Statement): Promise<string | null> {
  if (source.kind === 'entry') {
    const [row] = await getDb().execute(sql`select updated_at,metadata,content from story_entries
      where id=${source.sourceId} and story_id=${scope.gameId} and type='narration'`);
    if (!row || !publicEntry(record(row.metadata).visibility) || isOocControlText(String(row.content ?? ''))
      || !String(row.content ?? '').includes(source.statement)) return null;
    const corrections = await getDb().execute(sql`select metadata,body from story_events where story_id=${scope.gameId}
      and type='correction' and status='committed' and visibility in ('public','player_known')
      and (source_entry_ids ? ${source.sourceId} or (metadata->'supersedesEntryIds') ? ${source.sourceId})
      limit 32`);
    return corrections.some(correction => isNarrativeTimelineEvent({ type: 'correction', status: 'committed', metadata: correction.metadata })
      && !isOocControlText(String(correction.body ?? ''))) ? null : revision(row.updated_at);
  }
  if (source.kind === 'event') {
    const [row] = await getDb().execute(sql`select updated_at,body,metadata from story_events where id=${source.sourceId}
      and story_id=${scope.gameId} and type='correction' and status='committed' and visibility in ('public','player_known')`);
    return row && isNarrativeTimelineEvent({ type: 'correction', status: 'committed', metadata: row.metadata })
      && !isOocControlText(String(row.body ?? '')) && String(row.body ?? '').includes(source.statement) ? revision(row.updated_at) : null;
  }
  if (source.kind === 'content') {
    if (!source.sourceId.startsWith('content:')) return null;
    const [row] = await getDb().execute(sql`select title,description,data,revision from content_items where id=${source.sourceId.slice(8)}
      and project_id=${scope.projectId} and (game_id is null or game_id=${scope.gameId}) and deleted_at is null
      and branch_id is null and pov_character is null and visibility='public'`);
    const text = row ? `${row.title}. ${row.description}. ${Object.values(record(row.data)).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}` : '';
    return row && text.includes(source.statement) ? revision(row.revision) : null;
  }
  const colon = source.sourceId.indexOf(':');
  if (colon < 1) return null;
  try {
    const detail = await getWorldRecord(scope.gameId, source.sourceId.slice(0, colon), source.sourceId.slice(colon + 1));
    const row = record(detail.record);
    const text = `${row.name ?? row.title ?? ''} ${JSON.stringify(row)}`;
    return row.visibility === 'public' && text.includes(source.statement)
      ? revision(row.updatedAt ?? row.updated_at ?? row.revision) : null;
  } catch { return null; }
}

export async function publicResearchReceipt(raw: unknown, scope: { projectId: string; gameId: string },
  recheck = currentPublicResearchRevision): Promise<PublicResearchReceipt | null> {
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) return null;
  const statements: Statement[] = [];
  for (const source of parsed.data.statements) {
    if (await recheck(scope, source) === source.revision) statements.push(source);
  }
  return { ...parsed.data, statements, sourceUnavailable: statements.length !== parsed.data.statements.length };
}
