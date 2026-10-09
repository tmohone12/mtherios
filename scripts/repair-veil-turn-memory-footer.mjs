import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { resolveRuntimeOptions } from './runtime-config.mjs';

const STORY_ID = 'story_52d7c651-0b16-4b91-890d-e7f226f7926b';
const MARKER = '<turn_memory_update>';
const END = '</turn_memory_update>';
const apply = process.argv.includes('--apply');
const runtime = resolveRuntimeOptions([]);
const client = postgres(runtime.databaseUrl, { max: 1 });

function clean(content) {
	const start = content.indexOf(MARKER);
	assert(start > 0, 'Missing machine footer or visible narration');
	assert.equal(content.indexOf(MARKER, start + MARKER.length), -1, 'Multiple machine footers');
	const end = content.indexOf(END, start + MARKER.length);
	assert(end > start && !content.slice(end + END.length).trim(), 'Machine footer is not a complete suffix');
	const data = JSON.parse(content.slice(start + MARKER.length, end));
	assert.equal(data.version, 1, 'Unexpected machine footer version');
	assert(Array.isArray(data.changes), 'Unexpected machine footer shape');
	const visible = content.slice(0, start).trimEnd();
	assert(visible, 'Empty visible narration');
	return visible;
}

function cleanIfNeeded(content) {
	return content.includes(MARKER) ? clean(content) : content;
}

try {
	const result = await client.begin(async tx => {
		const [story] = await tx`select id, shelf_id, server_version from stories where id=${STORY_ID} for update`;
		assert(story, 'Veil story was not found in this database');
		const rows = await tx`select id, position, content, metadata, server_version, md5(content) as content_md5
			from story_entries where story_id=${STORY_ID} and type='narration'
			and content like '%<turn_memory_update>%' order by position for update`;
		const repairs = rows.map(row => ({ row, visible: clean(row.content) }));
		const events = await tx`select id, body, source_entry_ids, server_version, md5(body) as body_md5
			from story_events where story_id=${STORY_ID} and body like '%<turn_memory_update>%' for update`;
		const eventRepairs = [];
		for (const event of events) {
			const narrationId = event.source_entry_ids.find(id => id.startsWith('narration_'));
			assert(narrationId, `No narration source for event ${event.id}`);
			const [narration] = await tx`select content from story_entries where story_id=${STORY_ID} and id=${narrationId}`;
			assert(narration, `Missing narration source for event ${event.id}`);
			const visible = event.body.slice(0, event.body.indexOf(MARKER)).trimEnd();
			const normalized = value => value.replace(/\s+/g, ' ').trim();
			assert.equal(normalized(visible), normalized(cleanIfNeeded(narration.content)), `Event ${event.id} differs from source narration`);
			eventRepairs.push({ event, visible });
		}
		if (!apply || (repairs.length === 0 && eventRepairs.length === 0)) return {
			mode: 'preview', count: repairs.length, positions: repairs.map(item => item.row.position), eventCount: eventRepairs.length,
		};

		const backupDir = path.join(runtime.dataRoot, 'repairs');
		fs.mkdirSync(backupDir, { recursive: true });
		const backupPath = path.join(backupDir, `veil-turn-memory-footer-${Date.now()}-v${story.server_version}.json`);
		fs.writeFileSync(backupPath, JSON.stringify({ storyId: STORY_ID, originalStoryVersion: story.server_version,
			entries: rows, events }, null, 2), { flag: 'wx' });

		const version = Number(story.server_version) + 1;
		for (const { row, visible } of repairs) {
			const updated = await tx`update story_entries set content=${visible}, server_version=${version}, updated_at=now()
				where id=${row.id} and story_id=${STORY_ID} and md5(content)=${row.content_md5} returning id`;
			assert.equal(updated.length, 1, `Narration changed during repair: ${row.id}`);
		}
		for (const { event, visible } of eventRepairs) {
			const updated = await tx`update story_events set body=${visible}, server_version=${version}, updated_at=now()
				where id=${event.id} and story_id=${STORY_ID} and md5(body)=${event.body_md5} returning id`;
			assert.equal(updated.length, 1, `Story event changed during repair: ${event.id}`);
		}
		const updatedStory = await tx`update stories set server_version=${version}, updated_at=now()
			where id=${STORY_ID} and server_version=${story.server_version} returning id`;
		assert.equal(updatedStory.length, 1, 'Story changed during repair');
		const jobId = `job_refresh_scene_checkpoint_${STORY_ID.replaceAll('-', '_')}_footer_repair_v${version}`;
		await tx`insert into backend_jobs(id,project_id,story_id,type,payload,status,max_attempts)
			values(${jobId},${story.shelf_id},${STORY_ID},'refresh_scene_checkpoint',${tx.json({ reason: 'turn_memory_footer_repair', serverVersion: version })},'queued',3)
			on conflict (id) do nothing`;
		return { mode: 'applied', count: repairs.length, positions: repairs.map(item => item.row.position),
			eventCount: eventRepairs.length, version, backupPath, checkpointJobId: jobId };
	});
	console.log(JSON.stringify(result));
} finally {
	await client.end();
}
