import { randomUUID } from 'node:crypto';
import { afterAll, expect, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '$lib/server/db/client';
import { emptyLocationMap } from '$lib/contracts/locationMap';

vi.mock('$lib/server/turn/orchestrator', async (importOriginal) => ({
  ...await importOriginal<typeof import('$lib/server/turn/orchestrator')>(),
  prepareServerTurnContext: vi.fn(async () => ({
    prompt: { prompt: '' }, narrativeSystemDynamic: '', narrativePrompt: '',
    narrativeProfile: {}, narrativeGeneration: { model: null },
  })),
  processServerTurn: vi.fn(async () => ({ serverVersion: 2 })),
}));
vi.mock('$lib/server/turn/provider', async (importOriginal) => ({
  ...await importOriginal<typeof import('$lib/server/turn/provider')>(),
  generateServerTextWithMetrics: vi.fn(async () => ({
    text: 'done', toolCalls: [], model: 'deterministic-test', finishReason: 'stop',
    durationMs: 0, usage: {},
  })),
}));

import { getAgentRun } from './agentRuns';
import { getLocationMap, saveLocationMap } from './locationMaps';
import { generateServerTextWithMetrics } from '$lib/server/turn/provider';

const integration = process.env.MYTHENGINE_AGENT_MAP_INTEGRATION === '1' ? test : test.skip;

integration('executes a pending GM map call and records its canonical revision and receipt', async () => {
  const db = getDb();
  const projectId = `shelf_agent_map_${randomUUID()}`;
  const gameId = `story_agent_map_${randomUUID()}`;
  const locationId = `entity_agent_map_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const callId = 'map-save-1';
  const map = emptyLocationMap();
  map.pins.push({ id: 'pin-1', label: 'Crossroads', kind: 'pin', layerId: 'base', order: 0,
    visibility: 'public', point: { x: 0.3, y: 0.4 }, color: '#aabbcc', locationId: null });
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Agent map fixture',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Agent map fixture')`);
    await db.execute(sql`insert into entities(id,story_id,type,name) values(${locationId},${gameId},'location','Crossroads')`);
    const decision = { kind: 'tool', call: { tool: 'map', callId, args: {
      action: 'save', locationId, expectedRevision: 0, map, reason: 'Draw the crossroads.',
    } } };
    await db.execute(sql`insert into agent_runs(id,project_id,game_id,client_turn_id,status,request,pending_decision,lease_until,expires_at)
      values(${runId},${projectId},${gameId},'test-agent-map','running',${JSON.stringify({ storyId: gameId, clientTurnId: 'test-agent-map', playerText: 'Draw the crossroads.' })}::jsonb,
      ${JSON.stringify(decision)}::jsonb,now()-interval '1 minute',now()+interval '1 hour')`);

    const run = await getAgentRun({ runId, storyId: gameId });
    expect(run.status).toBe('completed');
    const saved = await getLocationMap(gameId, { locationId });
    expect(saved).toMatchObject({ revision: 1, map: { pins: [{ id: 'pin-1', label: 'Crossroads' }] } });
    const [receipt] = await db.execute(sql`select status,result from agent_tool_calls where run_id=${runId} and call_id=${callId}`);
    expect(receipt).toMatchObject({ status: 'completed', result: { revision: 1, unchanged: false } });
    const [revision] = await db.execute(sql`select actor from location_map_revisions where location_id=${locationId} and revision=1`);
    expect(revision.actor).toMatchObject({ kind: 'agent', runId, callId });
    const replay = await saveLocationMap(gameId, { locationId, expectedRevision: 0, map, reason: 'Draw the crossroads.' }, { kind: 'agent', runId, callId });
    expect(replay).toMatchObject({ revision: 1, unchanged: true });
    const [count] = await db.execute(sql`select count(*)::integer as count from location_map_revisions where location_id=${locationId}`);
    expect(count.count).toBe(1);
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
  }
});

integration('resumes and completes multiple pending native tool calls before the final turn', async () => {
  const db = getDb();
  const projectId = `shelf_agent_batch_${randomUUID()}`;
  const gameId = `story_agent_batch_${randomUUID()}`;
  const locationId = `entity_agent_batch_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Agent batch fixture',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Agent batch fixture')`);
    await db.execute(sql`insert into entities(id,story_id,type,name) values(${locationId},${gameId},'location','Crossroads')`);
    const decision = { kind: 'tools', calls: [
      { tool: 'map', callId: 'map-first', args: { action: 'get', locationId } },
      { tool: 'map', callId: 'map-second', args: { action: 'get', locationId } },
    ] };
    await db.execute(sql`insert into agent_runs(id,project_id,game_id,client_turn_id,status,request,pending_decision,lease_until,expires_at)
      values(${runId},${projectId},${gameId},'test-agent-batch','running',${JSON.stringify({ storyId: gameId, clientTurnId: 'test-agent-batch', playerText: 'Inspect the map.' })}::jsonb,
      ${JSON.stringify(decision)}::jsonb,now()-interval '1 minute',now()+interval '1 hour')`);
    const run = await getAgentRun({ runId, storyId: gameId });
    expect(run.status).toBe('completed');
    const rows = await db.execute(sql`select call_id,status from agent_tool_calls where run_id=${runId} order by created_at,call_id`);
    expect(rows.map(row => ({ callId: row.call_id, status: row.status }))).toEqual([
      { callId: 'map-first', status: 'completed' }, { callId: 'map-second', status: 'completed' },
    ]);
    expect((run.continuation as Array<{ decision: { kind: string } }>).at(-1)?.decision.kind).toBe('final');
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
  }
});

integration('runs two native calls returned together by the provider', async () => {
  const db = getDb();
  const projectId = `shelf_agent_native_${randomUUID()}`;
  const gameId = `story_agent_native_${randomUUID()}`;
  const locationId = `entity_agent_native_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Agent native fixture',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Agent native fixture')`);
    await db.execute(sql`insert into entities(id,story_id,type,name) values(${locationId},${gameId},'location','Crossroads')`);
    await db.execute(sql`insert into agent_runs(id,project_id,game_id,client_turn_id,status,request,lease_until,expires_at)
      values(${runId},${projectId},${gameId},'test-agent-native','running',${JSON.stringify({ storyId: gameId, clientTurnId: 'test-agent-native', playerText: 'Inspect the map.' })}::jsonb,
      now()-interval '1 minute',now()+interval '1 hour')`);
    vi.mocked(generateServerTextWithMetrics).mockResolvedValueOnce({
      text: '', toolCalls: [
        { id: 'native-first', name: 'map', arguments: { action: 'get', locationId } },
        { id: 'native-second', name: 'map', arguments: { action: 'get', locationId } },
      ], model: 'deterministic-test', finishReason: 'tool_calls', durationMs: 0, usage: {},
    } as unknown as Awaited<ReturnType<typeof generateServerTextWithMetrics>>);
    const run = await getAgentRun({ runId, storyId: gameId });
    expect(run.status).toBe('completed');
    const rows = await db.execute(sql`select call_id,status from agent_tool_calls where run_id=${runId} order by created_at,call_id`);
    expect(rows.map(row => ({ callId: row.call_id, status: row.status }))).toEqual([
      { callId: 'native-first', status: 'completed' }, { callId: 'native-second', status: 'completed' },
    ]);
    expect((run.continuation as Array<{ decision: { kind: string } }>)[0]?.decision.kind).toBe('tools');
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
  }
});

afterAll(async () => { if (process.env.MYTHENGINE_AGENT_MAP_INTEGRATION === '1') await closeDb(); });
