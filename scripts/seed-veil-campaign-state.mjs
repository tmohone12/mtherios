// Bounded, source-checked backfill. Dry run unless --apply; never replaces an existing brief.
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';

const storyId = 'story_52d7c651-0b16-4b91-890d-e7f226f7926b';
const url = `http://127.0.0.1:5174/api/records/stories/${storyId}`;
const seeds = [
	{ key: 'aurion_identity', kind: 'current', position: 1886, statement: 'Aurion Belaerys is Aegon Targaryen; Mei-Lin publicly named him before the Volantene court.', evidence: '"Aegon Targaryen." Your true name, spoken clear in the Old Valyrian, before the whole court — the first time she has ever said it aloud.' },
	{ key: 'volantis_ruler', kind: 'current', position: 1896, statement: 'Aurion/Aegon rules Volantis as Archon.', evidence: 'goes to one knee on the stone floor of the hall of the Archon of Volantis.' },
	{ key: 'yin_betrothal', kind: 'current', position: 2038, statement: 'The Yin betrothal was annulled. Aurion was never married; calling him a widower is social gossip, not legal status.', evidence: 'There was a betrothal in Yin — sealed, then annulled, and the princess kept your ledger and your stones for eight weeks.' },
	{ key: 'mei_lin_marriage', kind: 'current', position: 1886, statement: 'Princess Mei-Lin is married to Shen Wei; they arrived together as the Yi Tish envoys in Volantis.', evidence: 'The Princess of Yi Ti — at the hall. She comes with her husband and her own guard, and the harbor master\'s men behind.' },
	{ key: 'qarth_dragonfire', kind: 'milestone', position: 1783, statement: 'Aegarax burned Qarth on Aurion\'s command: the outer gate collapsed and fire spread into the streets and houses. Total destruction of the city is not established.', evidence: 'It pours through the broken gate and into the street beyond, and the first houses catch, and the first screams rise, and the smoke rolls up in black columns, and the city of Qarth—the Queen of Cities, the center of the world—begins to burn.' },
];

const db = postgres(databaseUrl(), { max: 1 });
try {
	const rows = await db.unsafe('SELECT id, position, content, metadata FROM story_entries WHERE story_id=$1 AND type=$2 AND position=ANY($3::int[])', [storyId, 'narration', seeds.map(seed => seed.position)]);
	const facts = seeds.map(({ position, ...seed }) => {
		const row = rows.find(row => row.position === position);
		assert(row, `Missing source at ${position}`);
		assert(!row.metadata?.nonCanon && !['parallel_pov', 'ooc'].includes(row.metadata?.narrativeMode) && row.metadata?.actionType !== 'ooc', `Invalid source scope at ${position}`);
		assert(row.content.includes(seed.evidence), `Evidence changed at ${position}`);
		return { ...seed, sourceEntryId: row.id, sourcePosition: position };
	});
	const response = await fetch(url);
	assert(response.ok, `Story read failed: ${response.status}`);
	const { record } = await response.json();
	if (record.metadata?.campaignState?.length) {
		console.log('Existing campaign state retained; backfill skipped.');
	} else if (!process.argv.includes('--apply')) {
		console.log(JSON.stringify({ mode: 'dry-run', storyId, facts }, null, 2));
	} else {
		const active = await db.unsafe('SELECT locked_by FROM backend_jobs WHERE story_id=$1 AND status=$2', [storyId, 'running']);
		for (const job of active) {
			const pid = /^mtheriosd_(\d+)$/.exec(job.locked_by ?? '')?.[1];
			assert(pid, 'Unknown active worker; wait before seeding.');
			let alive = true;
			try { process.kill(Number(pid), 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
			assert(!alive, 'Wait for this story\'s background jobs before seeding.');
		}
		const latest = await (await fetch(url)).json();
		assert.equal(latest.record.server_version, record.server_version, 'Story changed during source verification; rerun.');
		const saved = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates: { metadata: { ...record.metadata, campaignState: facts } }, reason: 'Backfill five source-verified Veil campaign continuity anchors; no transcript replay or other canon changes.' }) });
		assert(saved.ok, `State save failed: ${saved.status} ${await saved.text()}`);
		const verified = await (await fetch(url)).json();
		assert.deepEqual(verified.record.metadata.campaignState, facts);
		assert.equal(verified.record.header_prompt, record.header_prompt);
		for (const [key, value] of Object.entries(record.metadata ?? {})) assert.deepEqual(verified.record.metadata[key], value);
		console.log(JSON.stringify({ mode: 'applied', count: facts.length, serverVersion: verified.record.server_version, statements: facts.map(fact => fact.statement) }, null, 2));
	}
} finally { await db.end(); }
