import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '$lib/server/db/client';
import { createCanonicalWorkspace } from './canonicalContent';
import { executeAssistantTool } from './assistantTools';
import type { CanonicalView } from '$lib/contracts/canonicalContent';

const fixture = process.env.MYTHENGINE_ASSISTANT_STORY_INTEGRATION === '1' ? test : test.skip;
fixture('prepares only disposable browser story edit proposals', async () => {
  expect(new URL(process.env.DATABASE_URL!).pathname).toBe('/mythengine_assistant_candidate_20261004');
  const suffix = randomUUID(), projectId = `browser_${suffix}`, db = getDb();
  await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Assistant UI fixtures',${projectId})`);
  const rows = [];
  for (const size of ['desktop','mobile','narrow']) for (const scenario of ['apply','cancel','conflict']) {
    const gameId = `browser_${size}_${scenario}_${suffix}`, conversationId = `conversation_${size}_${scenario}_${suffix}`, messageId = `message_${size}_${scenario}_${suffix}`, runId = `run_${size}_${scenario}_${suffix}`;
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},${`UI ${size} ${scenario}`})`);
    const character = await createCanonicalWorkspace({ projectId, gameId, kind: 'characters', fields: { name: 'Mira', description: 'Original bridge keeper biography.', state: { isProtagonist: true, relationship: 'self' } } }) as CanonicalView;
    await db.execute(sql`insert into assistant_conversations(id,project_id,game_id,title) values(${conversationId},${projectId},${gameId},'Review Mira biography')`);
    await db.execute(sql`insert into assistant_messages(id,conversation_id,role,content,status) values(${messageId},${conversationId},'user','Clarify Mira biography.','committed')`);
    await db.execute(sql`insert into assistant_runs(id,conversation_id,user_message_id,status,request_fingerprint,lease_until) values(${runId},${conversationId},${messageId},'running','fixture',now()+interval '10 minutes')`);
    const proposal = await executeAssistantTool({ projectId, gameId, conversationId, runId }, { tool: 'storyContent', callId: 'proposal', args: { action: 'propose', kind: 'characters', id: character.record.id, expected: character.revision, changes: { description: 'Mira watches the bridge with quiet patience.' }, reason: 'Make the authored biography more concrete.' } }) as { pendingApprovalId: string };
    rows.push({ projectId, gameId, conversationId, runId, approvalId: proposal.pendingApprovalId, entryId: character.record.id, expected: character.revision, title: `UI ${size} ${scenario}`, size, scenario });
  }
  fs.writeFileSync(path.resolve('..','assistant-browser-fixtures.json'), JSON.stringify({ database: 'mythengine_assistant_candidate_20261004', projectId, rows }, null, 2));
  await closeDb();
}, 30000);
