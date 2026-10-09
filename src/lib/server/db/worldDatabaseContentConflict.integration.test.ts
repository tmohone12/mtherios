import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from './client';
import { exportBackendStory } from '$lib/server/memory/canonical';
import { importWorldDatabaseBundle, previewWorldDatabaseImport } from './worldDatabaseImport';

const integration = process.env.MYTHENGINE_IMPORT_CONFLICT_INTEGRATION === '1' ? test : test.skip;
async function preview(input: Parameters<typeof previewWorldDatabaseImport>[0]) {
  const direct = await previewWorldDatabaseImport(input);
  if (!process.env.MYTHENGINE_IMPORT_CONFLICT_HTTP_BASE) return direct;
  const response = await fetch(`${process.env.MYTHENGINE_IMPORT_CONFLICT_HTTP_BASE}/api/database/import/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(direct);
  return direct;
}

integration('explicit project merge reports type and document conflicts without partial writes', async () => {
  const db = getDb();
  const sourceProject = `shelf_import_source_${randomUUID()}`;
  const targetProject = `shelf_import_target_${randomUUID()}`;
  const sourceGame = `story_import_${randomUUID()}`;
  const sourceType = randomUUID();
  const targetType = randomUUID();
  const sourceItem = randomUUID();
  const targetItem = randomUUID();
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${sourceProject},'Import source',${sourceProject}),(${targetProject},'Import target',${targetProject})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${sourceGame},${sourceProject},'Source game')`);
    const definition = { fields: {}, layout: [], defaults: {}, gmContextMode: 'searchable' };
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values
      (${sourceType},${sourceProject},'gear','gear','Gear',${JSON.stringify(definition)}::jsonb),
      (${targetType},${targetProject},'gear','gear','Older Gear',${JSON.stringify(definition)}::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,type_id,title,slug,data) values
      (${sourceItem},${sourceProject},${sourceType},'Source sword','sword','{}'::jsonb),
      (${targetItem},${targetProject},${targetType},'Destination sword','sword','{}'::jsonb)`);
    const bundle = await exportBackendStory(sourceGame);
    const request = { bundle, options: { preserveIds: false, replaceExisting: false, syncWiki: false,
      sourceProjectId: sourceProject, destinationProjectId: targetProject } };

    expect(await preview({ bundle, options: { preserveIds: false, replaceExisting: false, syncWiki: false } }))
      .toMatchObject({ ready: true, mode: 'copy', sourceProjectId: sourceProject, destinationProjectId: null,
        content: { typeCount: 1, itemCount: 1, reusedTypes: 0, newTypes: 1 }, conflicts: [] });

    const typePreview = await preview(request);
    expect(typePreview).toMatchObject({ ready: false, mode: 'merge', sourceProjectId: sourceProject,
      destinationProjectId: targetProject, content: { typeCount: 1, itemCount: 1 },
      conflicts: [{ kind: 'type', sourceId: sourceType, destinationId: targetType }] });
    expect((await db.execute(sql`select id from stories where shelf_id=${targetProject}`))).toHaveLength(0);

    await expect(importWorldDatabaseBundle(request)).rejects.toMatchObject({ code: 'SCHEMA_CONFLICT', details: {
      key: 'gear', sourceTypeId: sourceType, destinationTypeId: targetType, destinationName: 'Older Gear',
    } });
    if (process.env.MYTHENGINE_IMPORT_CONFLICT_HTTP_BASE) {
      const response = await fetch(`${process.env.MYTHENGINE_IMPORT_CONFLICT_HTTP_BASE}/api/database/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'SCHEMA_CONFLICT', details: {
        sourceTypeId: sourceType, destinationTypeId: targetType,
      } });
    }
    expect((await db.execute(sql`select id from stories where shelf_id=${targetProject}`))).toHaveLength(0);
    expect((await db.execute(sql`select id from content_items where project_id=${targetProject}`))).toHaveLength(1);

    await db.execute(sql`update content_types set name='Gear' where id=${targetType}`);
    expect(await preview(request)).toMatchObject({ ready: false,
      conflicts: [{ kind: 'path', sourceId: sourceItem, destinationId: targetItem }] });
    await expect(importWorldDatabaseBundle(request)).rejects.toMatchObject({ code: 'CONTENT_EXISTS', details: {
      folder: '', slug: 'sword', sourceItemId: sourceItem, destinationItemId: targetItem, destinationTitle: 'Destination sword',
    } });
    if (process.env.MYTHENGINE_IMPORT_CONFLICT_HTTP_BASE) {
      const response = await fetch(`${process.env.MYTHENGINE_IMPORT_CONFLICT_HTTP_BASE}/api/database/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'CONTENT_EXISTS', details: {
        sourceItemId: sourceItem, destinationItemId: targetItem,
      } });
    }
    expect((await db.execute(sql`select id from stories where shelf_id=${targetProject}`))).toHaveLength(0);
    expect((await db.execute(sql`select id from content_items where project_id=${targetProject}`))).toHaveLength(1);

    await db.execute(sql`delete from content_items where id=${targetItem}`);
    expect(await preview(request)).toMatchObject({ ready: true, conflicts: [] });
    const imported = await importWorldDatabaseBundle(request);
    expect(imported).toMatchObject({ projectId: targetProject });
    expect(imported.storyId).not.toBe(sourceGame);
    const [copied] = await db.execute(sql`select i.id,i.title,i.slug,i.type_id from content_items i where i.project_id=${targetProject}`);
    expect(copied).toMatchObject({ title: 'Source sword', slug: 'sword', type_id: targetType });
    expect(copied.id).not.toBe(sourceItem);
    expect((await db.execute(sql`select id from content_items where id=${sourceItem} and project_id=${sourceProject}`))).toHaveLength(1);
  } finally {
    await db.execute(sql`delete from shelves where id in (${sourceProject},${targetProject})`);
  }
});

afterAll(async () => { if (process.env.MYTHENGINE_IMPORT_CONFLICT_INTEGRATION === '1') await closeDb(); });
