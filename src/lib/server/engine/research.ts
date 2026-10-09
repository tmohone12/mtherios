import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { isOocControlText, memoryQueryTokens } from '$lib/server/memory/ranking';
import { isNarrativeTimelineEvent } from '$lib/server/events/timeline';
import { executeEngineCommand } from './command';

type Source = { id: string; kind: 'entry' | 'event' | 'world' | 'content'; excerpt: string; revision: string; recordType?: string; position?: number; entryType?: string; linked?: boolean };
const questionSchema = z.string().trim().min(3).max(500);
const claimSchema = z.object({ sourceId: z.string().min(1), statement: z.string().min(12).max(400) });
const contextTerms = new Set(['early', 'recent', 'current', 'currently', 'now', 'room', 'scene', 'story', 'history', 'event']);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const revision = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? '');
const excerpt = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 800);
const eligible = (value: unknown) => !['secret', 'gm', 'private'].includes(String(value ?? '').toLowerCase());
const acceptedCorrection = (value: unknown) => {
  const metadata = record(value);
  return isNarrativeTimelineEvent({ type: 'correction', status: 'committed', metadata });
};

/** Keep a short source quotation that addresses the question; never rewrite its claim. */
function researchQuoteCandidate(source: string, question: string): { statement: string; score: number } | null {
  const queried = memoryQueryTokens(question).filter(token => !['find', 'found', 'look', 'know', 'happen', 'explain', 'rule', 'rules', 'stat', 'stats'].includes(token));
  const specific = queried.filter(token => !contextTerms.has(token));
  const terms = specific.length ? specific : queried;
  const header = source.match(/^\s*\[(?:[^\[\]]|\[[^\[\]]*\]){0,220}\]\s*/u)?.[0];
  const content = header?.includes('Time') ? source.slice(header.length) : source;
  const sentences = content.split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(part => part.length >= 12);
  const score = (sentence: string) => {
    const words = new Set(memoryQueryTokens(sentence, 256));
    let value = terms.reduce((total, term) => total + Number(words.has(term)), 0);
    if (value === 0) return 0;
    if (/\bwhere\b/i.test(question) && /\b(?:east|west|north|south|inside|outside|near|located|beyond|beneath)\b/i.test(sentence)) value += 6;
    if (/\b(?:stat|score|strength|health)\b/i.test(question) && /\d/.test(sentence)) value += 6;
    if (/\b(?:rule|allowed|permitted|required)\b/i.test(question) && /\b(?:requires|must|may|cannot|rule)\b/i.test(sentence)) value += 6;
    return value;
  };
  const ranked = sentences.map((sentence, index) => ({ sentence, index, score: score(sentence) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (!ranked[0] || ranked[0].score <= 0) return null;
  return { statement: ranked[0].sentence.slice(0, 400).trimEnd(), score: ranked[0].score };
}

export function researchQuote(source: string, question: string): string | null {
  return researchQuoteCandidate(source, question)?.statement ?? null;
}

/** Weakened lexical hits are leads for further reading, not answer citations. */
export function selectResearchQuotes(sources: readonly Pick<Source, 'id' | 'excerpt'>[], question: string) {
  const candidates = sources.flatMap(source => {
    const quote = researchQuoteCandidate(source.excerpt, question);
    return quote ? [{ sourceId: source.id, ...quote }] : [];
  });
  const best = Math.max(0, ...candidates.map(candidate => candidate.score));
  return candidates.filter(candidate => candidate.score >= best * 0.75).slice(0, 3)
    .map(({ sourceId, statement }) => ({ sourceId, statement }));
}

/** The brief can cite only text actually returned by a permitted, current source. */
export async function validateResearchClaims(raw: unknown, sources: readonly Source[], recheck: (source: Source) => Promise<string | null>) {
  const claims = z.array(claimSchema).max(4).parse(raw);
  const byId = new Map(sources.map(source => [source.id, source]));
  const statements: Array<{ statement: string; sourceId: string; revision: string; kind: Source['kind'] }> = [];
  for (const claim of claims) {
    const source = byId.get(claim.sourceId);
    if (!source || !source.revision || !source.excerpt.includes(claim.statement)) continue;
    if (await recheck(source) !== source.revision) continue;
    statements.push({ statement: claim.statement, sourceId: source.id, revision: source.revision, kind: source.kind });
  }
  return { status: statements.length ? 'answered' as const : 'insufficient_evidence' as const, statements, rejectedCitations: claims.length - statements.length };
}

/** Local extractive Research: no provider request and no secret or GM-only source text in observations. */
export async function runCompactResearch(input: { storyId: string; projectId: string; question: string; runId: string; callId: string }) {
  const question = questionSchema.parse(input.question);
  const tokens = memoryQueryTokens(question).slice(0, 8);
  const queryTerms = tokens.filter(token => !['find', 'found', 'look', 'know', 'happen', 'explain', 'rule', 'rules', 'stat', 'stats'].includes(token));
  const threshold = Math.min(2, queryTerms.length);
  const overlap = (text: string) => { const available = new Set(memoryQueryTokens(text, 256)); return queryTerms.filter(token => available.has(token)).length; };
  const sources: Source[] = [];
  const gaps: string[] = [];
  let neighborRead = false;
  const supersededEntryIds = new Set<string>();
  let commandSequence = 0;
  const add = (source: Source) => { if (!source.excerpt) return; const index = sources.findIndex(item => item.id === source.id); if (index < 0) sources.push(source); else if (source.linked) sources[index] = source; };
  const command = async (name: 'memory.retrieve' | 'world.search' | 'world.record.get' | 'campaign.entriesAround', args: Record<string, unknown>) => {
    const response = await executeEngineCommand({ storyId: input.storyId, command: name, args, clientCommandId: `${input.runId}:${input.callId}:${name}:${++commandSequence}` });
    if (response.status !== 'succeeded') throw new Error(response.error ?? `${name} failed.`);
    return record(response.result);
  };
  try {
    const memory = await command('memory.retrieve', { query: question, includeSecret: false, includeSemantic: false, tokenBudget: 1200 });
    for (const raw of Array.isArray(memory.nodes) ? memory.nodes.slice(0, 8) : []) {
      const node = record(raw), metadata = record(node.metadata);
      const position = Number(metadata.sourcePosition ?? record(metadata.retrieval).position);
      const entryId = Array.isArray(node.sourceEntryIds) ? node.sourceEntryIds.find(id => typeof id === 'string') : null;
      const eventId = Array.isArray(node.sourceEventIds) ? node.sourceEventIds[0] : null;
      if (typeof eventId === 'string' && node.id === `event_memory_${eventId}`
        && metadata.eventType === 'correction' && metadata.status === 'committed'
        && ['public', 'player_known'].includes(String(node.visibility)) && !isOocControlText(String(node.content ?? ''))) {
        const [live] = await getDb().execute(sql`select updated_at,source_entry_ids,metadata from story_events where id=${eventId} and story_id=${input.storyId} and type='correction' and status='committed' and visibility in ('public','player_known')`);
        if (!live || revision(live.updated_at) !== revision(node.updatedAt) || !acceptedCorrection(live.metadata)) continue;
        add({ id: eventId, kind: 'event', excerpt: excerpt(node.content), revision: revision(node.updatedAt) });
        const supersedes = record(live.metadata).supersedesEntryIds;
        for (const id of [...(Array.isArray(live.source_entry_ids) ? live.source_entry_ids : []), ...(Array.isArray(supersedes) ? supersedes : [])]) {
          if (typeof id === 'string') supersededEntryIds.add(id);
        }
      } else if (typeof entryId === 'string' && Number.isInteger(position) && ['public', 'player_known'].includes(String(node.visibility)) && !isOocControlText(String(node.content ?? ''))) {
        add({ id: entryId, kind: 'entry', excerpt: excerpt(node.content ?? node.summary), revision: revision(node.updatedAt), position, entryType: String(node.title ?? '').includes('player action') ? 'user_action' : 'narration' });
      }
    }
    // FTS may return a short snippet around only one query term. Read the best
    // transcript hit before deciding whether the full entry answers the question.
    const hit = sources.filter(source => source.position !== undefined && overlap(source.excerpt) > 0)
      .sort((a, b) => overlap(b.excerpt) - overlap(a.excerpt)
        || Number(a.entryType === 'user_action') - Number(b.entryType === 'user_action'))[0];
    if (hit) {
      const around = await command('campaign.entriesAround', { position: hit.position, radius: 2 });
      neighborRead = true;
      for (const raw of Array.isArray(around.entries) ? around.entries : []) {
        const row = record(raw), metadata = record(row.metadata);
        if (row.type !== 'narration' || typeof row.id !== 'string' || !eligible(metadata.visibility) || isOocControlText(String(row.content ?? ''))) continue;
        add({ id: row.id, kind: 'entry', excerpt: excerpt(row.content), revision: revision(row.updatedAt ?? row.updated_at), position: Number(row.position), entryType: 'narration', linked: true });
      }
    }
  } catch (error) { gaps.push(`Transcript recall: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    // The shared memory packet uses correction events as tombstones. Follow source-linked
    // corrections here so a neighboring transcript read cannot restore a stale fact.
    const entryIds = [...new Set(sources.filter(source => source.kind === 'entry').map(source => source.id))];
    if (entryIds.length) {
      const links = entryIds.map(id => sql`(source_entry_ids ? ${id} or (metadata->'supersedesEntryIds') ? ${id})`);
      const rows = await getDb().execute(sql`select id,body,updated_at,metadata,source_entry_ids from story_events where story_id=${input.storyId} and type='correction' and status='committed' and visibility in ('public','player_known') and (${sql.join(links, sql` or `)}) order by updated_at desc limit 32`);
      for (const row of rows) {
        if (typeof row.id !== 'string' || !acceptedCorrection(row.metadata) || isOocControlText(String(row.body ?? ''))) continue;
        add({ id: row.id, kind: 'event', excerpt: excerpt(row.body), revision: revision(row.updated_at) });
        const supersedes = record(row.metadata).supersedesEntryIds;
        for (const id of [...(Array.isArray(row.source_entry_ids) ? row.source_entry_ids : []), ...(Array.isArray(supersedes) ? supersedes : [])]) {
          if (typeof id === 'string') supersededEntryIds.add(id);
        }
      }
    }
  } catch (error) { gaps.push(`Corrections: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const terms = tokens.filter(token => token.length >= 4 && !['rule', 'rules', 'stat', 'stats', 'where', 'what', 'current', 'currently', 'location'].includes(token)).slice(-3);
    const pages = await Promise.all((terms.length ? terms : tokens.slice(-1)).map(term => command('world.search', { q: term, limit: 8, includeSemantic: false })));
    for (const raw of pages.flatMap(page => Array.isArray(page.results) ? page.results : [])) {
      const result = record(raw), row = record(result.record);
      if (typeof result.recordId !== 'string' || typeof result.recordType !== 'string' || row.visibility !== 'public') continue;
      add({ id: `${result.recordType}:${result.recordId}`, kind: 'world', recordType: result.recordType, excerpt: excerpt(`${result.title ?? ''} ${JSON.stringify(row)}`), revision: revision(row.updatedAt ?? row.updated_at ?? row.revision) });
    }
  } catch (error) { gaps.push(`Current records: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const terms = tokens.filter(token => token.length >= 3);
    if (terms.length) {
      const filters = terms.map(token => sql`strpos(lower(i.title || ' ' || i.description || ' ' || i.data::text), ${token}) > 0`);
      const rows = await getDb().execute(sql`select i.id,i.title,i.description,i.data,i.revision from content_items i where i.project_id=${input.projectId} and (i.game_id is null or i.game_id=${input.storyId}) and i.deleted_at is null and i.branch_id is null and i.pov_character is null and i.visibility='public' and (${sql.join(filters, sql` or `)}) order by i.title,i.id limit 10`);
      for (const row of rows) add({ id: `content:${row.id}`, kind: 'content', excerpt: excerpt(`${row.title}. ${row.description}. ${Object.values(record(row.data)).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}`), revision: revision(row.revision) });
    }
  } catch (error) { gaps.push(`Authored files: ${error instanceof Error ? error.message : String(error)}`); }
  const currentFirst = /\b(?:rule|stat|ability|location|where is|currently|now)\b/i.test(question);
  const order = currentFirst ? { event: 0, content: 1, world: 2, entry: 3 } : { event: 0, entry: 1, world: 2, content: 3 };
  const score = (source: Source) => overlap(source.excerpt) + Number(source.linked === true);
  const ranked = threshold ? sources.filter(source => !(source.kind === 'entry' && supersededEntryIds.has(source.id)) && score(source) >= threshold)
    .sort((a, b) => score(b) - score(a) || order[a.kind] - order[b.kind] || Number(a.entryType === 'user_action') - Number(b.entryType === 'user_action'))
    .slice(0, 8) : [];
  const recheck = async (source: Source): Promise<string | null> => {
    if (source.kind === 'entry') {
      const [row] = await getDb().execute(sql`select updated_at,metadata,content from story_entries where id=${source.id} and story_id=${input.storyId} and type in ('user_action','narration')`);
      return row && eligible(record(row.metadata).visibility) && !isOocControlText(String(row.content ?? '')) ? revision(row.updated_at) : null;
    }
    if (source.kind === 'event') {
      const [row] = await getDb().execute(sql`select updated_at,metadata from story_events where id=${source.id} and story_id=${input.storyId} and type='correction' and status='committed' and visibility in ('public','player_known')`);
      return row && acceptedCorrection(row.metadata) ? revision(row.updated_at) : null;
    }
    if (source.kind === 'content') {
      const id = source.id.slice('content:'.length);
      const [row] = await getDb().execute(sql`select revision from content_items where id=${id} and project_id=${input.projectId} and (game_id is null or game_id=${input.storyId}) and deleted_at is null and branch_id is null and pov_character is null and visibility='public'`);
      return row ? revision(row.revision) : null;
    }
    if (!source.recordType) return null;
    try {
      const detail = await command('world.record.get', { type: source.recordType, recordId: source.id.slice(source.recordType.length + 1) });
      const row = record(detail.record);
      return row.id && row.visibility === 'public' ? revision(row.updatedAt ?? row.updated_at ?? row.revision) : null;
    } catch { return null; }
  };
  const answerSources = ranked.filter(source => source.entryType !== 'user_action');
  const claims = selectResearchQuotes(answerSources, question);
  const brief = await validateResearchClaims(claims, ranked, recheck);
  return { question, ...brief, unresolved: brief.status === 'answered' ? [] : [question], searchedSourceIds: ranked.map(source => source.id), gaps, neighborRead, sourceCount: ranked.length, mode: 'local_extract', usage: { inputTokens: 0, outputTokens: 0, providerCost: null } };
}
