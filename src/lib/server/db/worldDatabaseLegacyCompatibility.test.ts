import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { parseStoryExportBundle } from '$lib/contracts/worldDatabase';
import { getDb, closeDb } from './client';
import { importWorldDatabaseBundle } from './worldDatabaseImport';
import { exportBackendStory } from '$lib/server/memory/canonical';

const integration = process.env.MYTHENGINE_LEGACY_IMPORT_INTEGRATION === '1' ? test : test.skip;

integration('reads a version-1 backendCanon campaign and exports its canonical data as version 3', async () => {
  const projectId = `shelf_legacy_${randomUUID()}`;
  const storyId = `story_legacy_${randomUUID()}`;
  const entryId = `entry_legacy_${randomUUID()}`;
  const oldBundle = parseStoryExportBundle({
    version: 1, schemaVersion: 1, exportedAt: Date.now(),
    story: { id: storyId, title: 'Legacy compatibility fixture', shelfId: projectId },
    storyEntries: [{ id: entryId, storyId, type: 'user_action', content: 'Keep this old event.', position: 0 }],
    characters: [], locations: [], items: [], storyBeats: [], chapters: [], lorebookEntries: [], arcs: [],
    backendCanon: {
      story: { id: storyId, shelfId: projectId, title: 'Legacy compatibility fixture' },
      storyEntries: [{ id: entryId, storyId, type: 'user_action', content: 'Keep this old event.', position: 0 }],
    },
  });
  try {
    const result = await importWorldDatabaseBundle({ bundle: oldBundle, options: { preserveIds: true, replaceExisting: false, syncWiki: false } });
    expect(result).toMatchObject({ storyId, projectId, counts: { shelves: 1, stories: 1, entries: 1 } });
    const [entry] = await getDb().execute(sql`select content,position from story_entries where id=${entryId} and story_id=${storyId}`);
    expect(entry).toMatchObject({ content: 'Keep this old event.', position: 0 });
    const current = await exportBackendStory(storyId);
    expect(current).toMatchObject({ version: 3, schemaVersion: 3, shelf: { id: projectId },
      worldDatabase: { story: { id: storyId }, entries: [{ id: entryId, content: 'Keep this old event.' }] } });
  } finally {
    await getDb().execute(sql`delete from shelves where id=${projectId}`);
  }
});

afterAll(async () => { if (process.env.MYTHENGINE_LEGACY_IMPORT_INTEGRATION === '1') await closeDb(); });
