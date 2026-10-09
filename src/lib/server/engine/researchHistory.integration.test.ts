import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { gearExample } from '$lib/contracts/content';
import { closeDb, getDb } from '$lib/server/db/client';
import { getAgentRunHistory } from './agentRuns';

const integration = process.env.MYTHENGINE_RESEARCH_HISTORY_INTEGRATION === '1' ? test : test.skip;

integration('redacts an earlier public Research quote after the source becomes private', async () => {
  const db = getDb();
  const suffix = randomUUID();
  const projectId = `shelf_research_history_${suffix}`;
  const gameId = `story_research_history_${suffix}`;
  const typeId = `type_research_history_${suffix}`;
  const itemId = `item_research_history_${suffix}`;
  const runId = `run_research_history_${suffix}`;
  const turnId = `turn_research_history_${suffix}`;
  const statement = 'The lantern is kept by the gate.';
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Research history fixture',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Research history game')`);
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition)
      values(${typeId},${projectId},'gear','gear','Gear',${JSON.stringify(gearExample)}::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,type_id,title,slug,data,visibility)
      values(${itemId},${projectId},${typeId},'Lantern note','lantern-note',${JSON.stringify({ notes: statement })}::jsonb,'public')`);
    await db.execute(sql`insert into agent_runs(id,project_id,game_id,client_turn_id,status,request,expires_at)
      values(${runId},${projectId},${gameId},${turnId},'completed','{}'::jsonb,now()+interval '1 day')`);
    const result = { mode: 'local_extract', status: 'answered', question: 'Where is the lantern?', statements: [
      { kind: 'content', sourceId: `content:${itemId}`, revision: '1', statement },
    ] };
    await db.execute(sql`insert into agent_tool_calls(run_id,call_id,tool,args_hash,args,status,result)
      values(${runId},'research-one','research','fixture','{}'::jsonb,'completed',${JSON.stringify(result)}::jsonb)`);
    const visible = await getAgentRunHistory({ storyId: gameId, clientTurnIds: [turnId] });
    expect(visible.research[0].result).toMatchObject({ statements: result.statements, sourceUnavailable: false });
    await db.execute(sql`update content_items set visibility='gm' where id=${itemId}`);
    const hidden = await getAgentRunHistory({ storyId: gameId, clientTurnIds: [turnId] });
    expect(hidden.research[0].result).toMatchObject({ statements: [], sourceUnavailable: true });
    expect(JSON.stringify(hidden.research)).not.toContain(statement);
    expect(JSON.stringify(hidden.research)).not.toContain(itemId);
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
  }
}, 30_000);

afterAll(async () => { if (process.env.MYTHENGINE_RESEARCH_HISTORY_INTEGRATION === '1') await closeDb(); });
