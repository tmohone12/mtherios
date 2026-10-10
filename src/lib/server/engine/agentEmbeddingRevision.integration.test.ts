import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '$lib/server/db/client';
import { getServerMemoryConfig } from '$lib/server/env';
import { agentEmbeddingRevision } from './agentEmbeddingRevision';
import { withQueryEmbeddingReuse } from './queryEmbeddingReuse';
import { embedMemoryText } from '$lib/server/memory/embeddings';
import { createAgentRuntimeBudget, withAgentRuntimeBudget } from './agentRuntime';
import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { memoryRecallEvidence } from './memoryRecallEvidence';

const enabled = process.env.MYTHENGINE_CONTEXT_REPAIR_INTEGRATION === '1';
const run = enabled ? test : test.skip;
const key = `context_fixture_${Date.now()}`;
beforeAll(async () => {
  if (!enabled) return;
  const u = new URL(getServerMemoryConfig().databaseUrl!);
  if (u.hostname !== '127.0.0.1' || !['/mythengine_faction_repair_context_20261003','/mythengine_identity_candidate_20261006','/mythengine_summary_repair_recovery_20261006_aggregate'].includes(u.pathname)) throw Error('Wrong disposable database');
  const [identity] = await getDb().execute(sql`select current_database() as name`);
  if (identity.name !== u.pathname.slice(1)) throw Error('Database identity mismatch');
  await getDb().execute(sql`insert into shelves(id,name,slug) values(${key},'Context regression',${key})`);
  await getDb().execute(sql`insert into stories(id,shelf_id,title) values(${key},${key},'Synthetic context regression'),(${key+'-other'},${key},'Other private scope')`);
  await getDb().execute(sql`insert into memory_nodes(id,story_id,type,title,content,summary,keywords,source_entry_ids)
    values(${key+'-node'},${key},'episodic','Escort letter','The escort leaves at dawn.','The escort leaves at dawn.','["escort","letter"]'::jsonb,'["entry-letter"]'::jsonb)`);
});
afterAll(async () => { vi.unstubAllGlobals(); if (enabled) { await getDb().execute(sql`delete from llm_service_settings where service_id=${key+'-setting'}`); await getDb().execute(sql`delete from shelves where id=${key}`); await closeDb(); } });

run('actual PostgreSQL revision is stable for identical sources and distinct for another story', async () => {
  const a = await agentEmbeddingRevision(key);
  expect(await agentEmbeddingRevision(key)).toBe(a);
  expect(await agentEmbeddingRevision(key+'-other')).not.toBe(a);
});
run.each(['story', 'project', 'memory', 'document', 'settings'])('invalidates query reuse after actual %s revision changes', async kind => {
  const revision = await agentEmbeddingRevision(key);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }], usage: { prompt_tokens: 5, total_tokens: 5 } })));
  vi.stubGlobal('fetch', fetcher);
  const state = { messages: [], budget: createAgentRuntimeBudget() };
  const config = { provider: 'openai-compatible', model: 'query-model', baseUrl: 'https://mocked.test', apiKey: '', customUrl: '', batchSize: 8, dimensions: 2 };
  const embedding = () => withAgentRuntimeBudget({ state, onSave: async () => {} }, () => embedMemoryText('same letter', config));
  await withQueryEmbeddingReuse({ revision: () => agentEmbeddingRevision(key) }, async () => {
    await embedding(); await embedding();
    if (kind === 'story') await getDb().execute(sql`update stories set server_version=server_version+1,current_turn=current_turn+1 where id=${key}`);
    if (kind === 'project') await getDb().execute(sql`update shelves set server_version=server_version+1,metadata='{"agentSettings":{"gmResearch":false}}'::jsonb where id=${key}`);
    if (kind === 'memory') await getDb().execute(sql`update memory_nodes set server_version=server_version+1,summary='The escort is delayed.' where id=${key+'-node'}`);
    if (kind === 'document') {
      await getDb().execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values(${key+'-type'},${key},'context-note','.contextnote','Context note','{}'::jsonb)`);
      await getDb().execute(sql`insert into content_items(id,project_id,type_id,title,slug,data) values(${key+'-doc'},${key},${key+'-type'},'Revised instruction','revised-instruction','{}'::jsonb)`);
    }
    if (kind === 'settings') await getDb().execute(sql`insert into llm_service_settings(service_id,provider_type,model) values(${key+'-setting'},'openai-compatible','new-model')`);
    expect(await agentEmbeddingRevision(key)).not.toBe(revision);
    await embedding();
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(state.budget).toMatchObject({ modelRequests: 2, consumedTokens: 10, reservedTokens: 0 });
});
run('fresh retrieval sees changed evidence and preserves recipient visibility while vectors may be reused', async () => {
  await getDb().execute(sql`update memory_nodes set summary='The escort leaves at dawn.',content='The escort leaves at dawn.' where id=${key+'-node'}`);
  await getDb().execute(sql`insert into memory_nodes(id,story_id,type,title,content,summary,keywords,visibility)
    values(${key+'-secret'},${key},'episodic','Private escort letter','SECRET hidden escort plan','SECRET hidden escort plan','["escort","letter"]'::jsonb,'secret'),
      (${key+'-other-node'},${key+'-other'},'episodic','Other escort letter','OTHER STORY escort plan','OTHER STORY escort plan','["escort","letter"]'::jsonb,'public')`);
  const request = { storyId: key, query: 'escort letter', tokenBudget: 2000, includeSemantic: false, includeSecret: false };
  const initial = await retrieveMemoryPacket(request);
  const projected = memoryRecallEvidence(initial)!;
  expect(projected.content).toContain('dawn');
  expect(projected.content).not.toContain('SECRET'); expect(projected.content).not.toContain('OTHER STORY');
  await getDb().execute(sql`update memory_nodes set summary='The escort was cancelled.',content='The escort was cancelled.',server_version=server_version+1 where id=${key+'-node'}`);
  const changed = memoryRecallEvidence(await retrieveMemoryPacket(request))!;
  expect(changed.content).toContain('cancelled'); expect(changed.content).not.toContain('leaves at dawn');
});
