// Explicit Veil pilot: retained room redirects plus a source-guarded primary scene repair.
// Dry-run by default. Original records and inverse values are retained in the evidence receipt.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';
const storyId = 'story_52d7c651-0b16-4b91-890d-e7f226f7926b';
const keeper = 'entity_f484d248-0ac5-4283-b77b-12bb8b9bbda6';
const manse = 'entity_cd230b5e-9c11-4c86-aa0c-064e9088b850';
const courtyard = 'entity_f5e3952f-a9b9-4d89-9ed6-57d32effe587';
const primary = 'narration_7a5e4d7b-13d7-4cc7-9fd0-55dda3ac32b6';
const parallel = ['narration_d59d75d4-6e78-4f26-96a3-49b8faf4fb51', 'narration_711e2d27-46d7-4d88-a739-987b38433d5c'];
const base = process.env.LOCATION_LORE_BASE_URL ?? 'http://127.0.0.1:5174';
const apply = process.argv.includes('--apply');
const sql = postgres(databaseUrl(), { max: 1, prepare: false });
const audit = JSON.parse(fs.readFileSync('docs/evidence/location-lore-chambers-reconciliation-2026-09-07.json', 'utf8'));
const receiptPath = 'docs/evidence/location-lore-pilot-reconciliation-2026-09-07.json';
const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : { storyId, keeper, merged: [], sourceCaveat: 'The curly-apostrophe duplicate and one keeper source ID have missing transcript sources. Identity is also supported by exact compound/room names and retained resolver metadata; missing evidence is not counted as a verified narration.' };
const saveReceipt = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
const command = async (command, args = {}) => {
  const result = await (await fetch(`${base}/api/engine/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storyId, command, args }) })).json();
  assert.equal(result.status, 'succeeded', JSON.stringify(result.error)); return result.result;
};
try {
  const [latest] = await sql`select id,position from story_entries where story_id=${storyId} order by position desc limit 1`;
  assert.equal(latest.id, parallel[1], 'Transcript advanced; review this repair again.');
  const rows = await sql`select * from entities where story_id=${storyId} and id in ${sql(audit.candidates.map(row => row.id))}`;
  assert.equal(rows.length, 31);
  for (const expected of audit.candidates) {
    const actual = rows.find(row => row.id === expected.id);
    if (actual.id === keeper || receipt.merged.includes(actual.id)) continue;
    assert.equal(actual.server_version, expected.server_version, `Candidate changed: ${actual.id}`);
    assert.deepEqual(actual.state, expected.state);
  }
  if (!receipt.before) {
    receipt.before = { entities: rows,
      aliases: await sql`select * from entity_aliases where story_id=${storyId} and entity_id in ${sql(rows.map(row => row.id))}`,
      sourceRefs: await sql`select * from source_refs where story_id=${storyId} and target_table='entities' and target_record_id in ${sql(rows.map(row => row.id))}` };
    saveReceipt();
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', keeper, duplicates: 30, primaryLocation: courtyard, preserveParallelSources: parallel }));
  if (apply) {
    for (const row of rows.filter(row => row.id !== keeper)) {
      if (receipt.merged.includes(row.id)) continue;
      const current = await command('world.location.get', { locationId: keeper });
      await command('entity.merge', { keepEntityId: keeper, mergeEntityId: row.id, expectedVersion: current.storyVersion,
        reason: 'Reviewed location-lore pilot: same explicitly named Belaerys Manse room; keep the established route and event-bearing ID. Preserve original records and all sources as inactive redirects. See location-lore-chambers-reconciliation-2026-09-07.json and the pilot reconciliation receipt.' });
      receipt.merged.push(row.id); saveReceipt();
    }
    if (!receipt.parentApplied) {
      const current = await command('world.location.get', { locationId: keeper });
      receipt.parentApplied = await command('world.location.save', { locationId: keeper, expectedVersion: current.storyVersion, parentLocationId: manse, locationKind: 'room',
        reason: 'Source-backed chambers within Belaerys Manse, established by narration_c74cedcb-feca-4515-9305-3a5f08af82f2 and later retained headers. City inheritance follows the reviewed Manse parent.' });
      saveReceipt();
    }
    if (!receipt.primaryRepair) {
      receipt.primaryRepair = await sql.begin(async tx => {
        const [story] = await tx`select * from stories where id=${storyId} for update`;
        const sources = await tx`select id,position,metadata,case when content like '[%' then split_part(content,E'\n',1) else '[no scene header]' end as header from story_entries where story_id=${storyId} and id in ${tx([primary, ...parallel])} order by position`;
        assert.deepEqual(sources.map(row => row.id), [primary, ...parallel]);
        assert.deepEqual(sources.map(row => row.position), [2495, 2497, 2499]);
        for (const row of sources.slice(1)) assert.equal(row.metadata.narrativeMode, 'parallel_pov');
        const [head] = await tx`select id from story_entries where story_id=${storyId} order by position desc limit 1`;
        assert.equal(head.id, parallel[1]);
        assert.equal(story.current_location_id, 'entity_f879c54b-a838-4114-852b-0b4634fc9722');
        assert.equal(story.current_world_time, 'Day Twenty-Seventh, Moon 6, 299 AC | 10:06');
        assert.ok(sources[0].header.includes('09:33') && sources[0].header.includes('first great courtyard'));
        const flags = await tx`select * from entities where story_id=${storyId} and type='location' and (state->>'current'='true' or state->>'isCurrentLocation'='true' or id=${courtyard})`;
        const patchId = `location_pov_repair_${crypto.randomUUID()}`;
        const version = story.server_version + 1;
        const time = 'Day Twenty-Seventh, Moon 6, 299 AC | 09:33';
        const operations = [
          { op: 'replace', path: `/stories/${storyId}/currentLocationId`, before: story.current_location_id, value: courtyard },
          { op: 'replace', path: `/stories/${storyId}/currentWorldTime`, before: story.current_world_time, value: time },
          ...flags.map(row => ({ op: 'replace', path: `/entities/${row.id}/state`, before: row.state, value: { ...row.state, current: row.id === courtyard, isCurrentLocation: row.id === courtyard } })),
        ];
        const backup = { story, flags, sources, patchId, version, operations };
        fs.writeFileSync('docs/evidence/location-lore-primary-scene-prewrite-2026-09-07.json', JSON.stringify(backup, null, 2) + '\n');
        await tx`insert into state_patches(id,story_id,operations,reason,status,source_entry_ids,server_version) values (${patchId},${storyId},${tx.json(operations)},'Restore primary Volantis scene from narration 2495; retain subsequent explicit Mei-Lin POVs, actor locations and transcript.','applied',${tx.json([primary, ...parallel])},${version})`;
        await tx`update stories set current_location_id=${courtyard},current_world_time=${time},server_version=${version},updated_at=now() where id=${storyId}`;
        for (const row of flags) await tx`update entities set state=${tx.json({ ...row.state, current: row.id === courtyard, isCurrentLocation: row.id === courtyard })}, source_patch_ids=${tx.json([...new Set([...row.source_patch_ids, patchId])])},server_version=${version},updated_at=now() where id=${row.id} and story_id=${storyId}`;
        await tx`insert into source_refs(id,story_id,source_type,source_id,target_table,target_record_id,server_version) values (${`source_${crypto.randomUUID()}`},${storyId},'story_entry',${primary},'stories',${storyId},${version})`;
        return { patchId, version, beforeLocation: story.current_location_id, locationId: courtyard, currentWorldTime: time, flagsUpdated: flags.map(row => row.id), transcriptUnchanged: true };
      });
      saveReceipt();
      // Reuse the ordinary canonical outbox path to refresh the scene entity and story vault.
      const current = await command('world.location.get', { locationId: courtyard });
      await command('world.location.save', { locationId: courtyard, expectedVersion: current.storyVersion, locationKind: 'site', reason: `Refresh canonical projections after source-backed primary scene patch ${receipt.primaryRepair.patchId}.` });
    }
    const after = await command('world.location.get', { locationId: keeper });
    receipt.finalVersion = after.storyVersion;
    receipt.chain = after.context.chain.map(place => ({ id: place.id, name: place.name }));
    receipt.inheritedLoreCount = after.context.facts.filter(fact => fact.inherited).length;
    saveReceipt();
    console.log(JSON.stringify({ merged: receipt.merged.length, chain: receipt.chain, inheritedLoreCount: receipt.inheritedLoreCount, primaryRepair: receipt.primaryRepair, finalVersion: receipt.finalVersion }));
  }
} finally { await sql.end({ timeout: 1 }); }
