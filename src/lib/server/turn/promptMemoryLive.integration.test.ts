import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';

const integration = process.env.MYTHENGINE_PROMPT_MEMORY_HTTP_INTEGRATION === '1' ? test : test.skip;

integration('built prompt packet retains chapter ending and reports an unrenderable arc', async () => {
  const base = process.env.MYTHENGINE_PROMPT_MEMORY_HTTP_BASE;
  if (!base) throw new Error('MYTHENGINE_PROMPT_MEMORY_HTTP_BASE is required.');
  const db = getDb();
  const projectId = `shelf_prompt_${randomUUID()}`;
  const storyId = `story_prompt_${randomUUID()}`;
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Prompt memory check',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${storyId},${projectId},'Prompt memory check')`);
    const chapter = `Opening chapter sentinel. ${'A repeated detail about the journey. '.repeat(300)} Ending chapter consequence sentinel.`;
    await db.execute(sql`insert into chapters(id,story_id,number,title,scene_outcome)
      values(${randomUUID()},${storyId},1,'One chapter',${chapter})`);
    const arc = `Opening arc sentinel. ${'Overgrown arc source. '.repeat(15000)} Ending arc sentinel.`;
    await db.execute(sql`insert into arcs(id,story_id,number,title,summary)
      values(${randomUUID()},${storyId},1,'Oversized arc',${arc})`);

    const response = await fetch(`${base}/api/debug/prompt-packet/${storyId}?q=chapter%20consequence`);
    expect(response.status).toBe(200);
    const body = await response.json() as { prompt?: { prompt?: string } };
    const prompt = body.prompt?.prompt ?? '';
    expect(prompt).toContain('Opening chapter sentinel.');
    expect(prompt).toContain('Ending chapter consequence sentinel.');
    expect(prompt).not.toContain('Opening arc sentinel.');
    expect(prompt).toContain('Historical summaries omitted for the context budget: 1 arcs (1)');
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
  }
});

afterAll(async () => { if (process.env.MYTHENGINE_PROMPT_MEMORY_HTTP_INTEGRATION === '1') await closeDb(); });
