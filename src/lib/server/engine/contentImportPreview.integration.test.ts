import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { exportContent, importContent, previewContentImport } from './content';

const integration = process.env.MYTHENGINE_CONTENT_IMPORT_PREVIEW_INTEGRATION === '1' ? test : test.skip;
async function reviewImport(args: Parameters<typeof previewContentImport>[0]) {
  const direct = await previewContentImport(args);
  if (!process.env.MYTHENGINE_CONTENT_IMPORT_PREVIEW_HTTP_BASE) return direct;
  const response = await fetch(`${process.env.MYTHENGINE_CONTENT_IMPORT_PREVIEW_HTTP_BASE}/api/engine/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ storyId: '__app__', command: 'content.import.preview', args }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { status: string; result: typeof direct };
  expect(body.status).toBe('succeeded');
  expect(body.result).toEqual(direct);
  return direct;
}

integration('reviews content conflicts without writes, then imports only after they are resolved', async () => {
  const db = getDb();
  const sourceProject = `shelf_preview_source_${randomUUID()}`;
  const targetProject = `shelf_preview_target_${randomUUID()}`;
  const sourceType = randomUUID(), targetType = randomUUID();
  const sourceItem = randomUUID(), targetItem = randomUUID();
  const definition = { fields: {}, layout: [], defaults: {}, gmContextMode: 'searchable' };
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${sourceProject},'Preview source',${sourceProject}),(${targetProject},'Preview target',${targetProject})`);
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values
      (${sourceType},${sourceProject},'gear','gear','Gear',${JSON.stringify(definition)}::jsonb),
      (${targetType},${targetProject},'gear','gear','Older Gear',${JSON.stringify(definition)}::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,type_id,title,slug,data) values
      (${sourceItem},${sourceProject},${sourceType},'Source sword','sword','{}'::jsonb),
      (${targetItem},${targetProject},${targetType},'Destination sword','sword','{}'::jsonb)`);
    const bundle = await exportContent({ projectId: sourceProject });
    const args = { projectId: targetProject, bundle };
    const review = await reviewImport(args);
    expect(review).toMatchObject({ ready: false, typeCount: 1, itemCount: 1,
      conflicts: [{ kind: 'type', sourceId: sourceType, destinationId: targetType }] });
    expect(await db.execute(sql`select id from content_items where project_id=${targetProject}`)).toHaveLength(1);

    await db.execute(sql`update content_types set name='Gear' where id=${targetType}`);
    const pathReview = await reviewImport(args);
    expect(pathReview).toMatchObject({ ready: false, reusedTypes: 1,
      conflicts: [{ kind: 'path', sourceId: sourceItem, destinationId: targetItem }] });
    expect(await db.execute(sql`select id from content_items where project_id=${targetProject}`)).toHaveLength(1);

    await db.execute(sql`delete from content_items where id=${targetItem}`);
    const clearReview = await reviewImport(args);
    expect(clearReview).toMatchObject({ ready: true, conflicts: [], newTypes: 0, reusedTypes: 1 });
    expect(await db.execute(sql`select id from content_items where project_id=${targetProject}`)).toHaveLength(0);
    const imported = await importContent(args);
    expect(imported.itemIds[sourceItem]).not.toBe(sourceItem);
    expect(await db.execute(sql`select id from content_items where project_id=${targetProject}`)).toHaveLength(1);
  } finally {
    await db.execute(sql`delete from shelves where id in (${sourceProject},${targetProject})`);
  }
});

afterAll(async () => { if (process.env.MYTHENGINE_CONTENT_IMPORT_PREVIEW_INTEGRATION === '1') await closeDb(); });
