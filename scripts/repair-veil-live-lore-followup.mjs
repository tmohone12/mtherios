#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';
import { sanitizeProjectionText } from './repair-veil-live-lore.mjs';

export const STORY_ID = 'story_52d7c651-0b16-4b91-890d-e7f226f7926b';
export const CHAPTER_ID = 'chapter_entry_d33faa63_e50b_43d8_8760_3b494a9d41ee_narration_e10ac3ec_3482_4f0d_af75_391fe576a3a7';
export const MEMORY_ID = `mem_chapter_${CHAPTER_ID}`;
const REPAIR_KEY = 'veil_lore_integrity_v2';
const PRIOR_REPAIR_KEY = 'veil_lore_integrity_v1';
const FORBIDDEN = /Morning marriage rite and bow ceremony|Morning ceremony preparations|Armor polishing before dawn|the order of the morning/i;

function asObject(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function unique(values) {
	return [...new Set(values)];
}

export function sanitizeChapterPromiseLabels(values) {
	return unique((Array.isArray(values) ? values : []).map((value) => sanitizeProjectionText(String(value))));
}

export function sanitizeChapterMemoryText(value) {
	return sanitizeProjectionText(String(value ?? ''));
}

function parseArgs(argv) {
	const result = {
		apply: false,
		expectedVersion: null,
		backupRoot: path.resolve('exports', 'repairs', 'veil-live-lore-integrity'),
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--apply') result.apply = true;
		else if (arg === '--expected-version') result.expectedVersion = Number(argv[++index]);
		else if (arg === '--backup-root') result.backupRoot = path.resolve(argv[++index]);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isInteger(result.expectedVersion) || result.expectedVersion < 1) {
		throw new Error('--expected-version <positive integer> is required');
	}
	return result;
}

async function loadSnapshot(sql, forUpdate = false) {
	const lock = forUpdate ? sql` for update` : sql``;
	const [storyRows, chapterRows, memoryRows, activeJobs] = await Promise.all([
		sql`select * from stories where id = ${STORY_ID}${lock}`,
		sql`select * from chapters where story_id = ${STORY_ID} and id = ${CHAPTER_ID}${lock}`,
		sql`select * from memory_nodes where story_id = ${STORY_ID} and id = ${MEMORY_ID}${lock}`,
		sql`select id, type, status, locked_at, locked_by from backend_jobs where story_id = ${STORY_ID} and status in ('queued', 'retry', 'running') order by id`,
	]);
	assert.equal(storyRows.length, 1, 'Veil story is missing');
	assert.equal(chapterRows.length, 1, 'guarded Chapter 20 row is missing');
	assert.equal(memoryRows.length, 1, 'guarded Chapter 20 memory row is missing');
	return { story: storyRows[0], chapter: chapterRows[0], memory: memoryRows[0], activeJobs };
}

export function buildFollowupPlan(snapshot, now) {
	assert.equal(snapshot.story.title, 'Veil', 'story ID no longer belongs to Veil');
	const repairs = asObject(asObject(snapshot.story.metadata).loreIntegrityRepairs);
	if (asObject(repairs[REPAIR_KEY]).applied === true) {
		return { alreadyApplied: true, marker: repairs[REPAIR_KEY] };
	}
	assert.equal(asObject(repairs[PRIOR_REPAIR_KEY]).applied, true, 'the guarded v1 lore repair must be applied first');
	const promises = sanitizeChapterPromiseLabels(snapshot.chapter.promises_debts_oaths);
	const memoryContent = sanitizeChapterMemoryText(snapshot.memory.content);
	const memorySummary = sanitizeChapterMemoryText(snapshot.memory.summary);
	assert.doesNotMatch(promises.join('\n'), FORBIDDEN, 'planned Chapter 20 promises still contain deadline poison');
	assert.doesNotMatch(`${memoryContent}\n${memorySummary}`, FORBIDDEN, 'planned Chapter 20 memory still contains deadline poison');
	const newVersion = Number(snapshot.story.server_version) + 1;
	const marker = {
		applied: true,
		appliedAt: now,
		previousServerVersion: Number(snapshot.story.server_version),
		serverVersion: newVersion,
		chapterId: CHAPTER_ID,
		memoryId: MEMORY_ID,
		reason: 'Remove stale morning and before-dawn promise labels left behind by the v1 chapter projection repair.',
	};
	return {
		alreadyApplied: false,
		newVersion,
		promises,
		memoryContent,
		memorySummary,
		chapterMetadata: {
			...asObject(snapshot.chapter.metadata),
			loreIntegrityRepairFollowup: { key: REPAIR_KEY, at: now },
		},
		memoryMetadata: {
			...asObject(snapshot.memory.metadata),
			loreIntegrityRepairFollowup: { key: REPAIR_KEY, at: now },
		},
		storyMetadata: {
			...asObject(snapshot.story.metadata),
			loreIntegrityRepairs: { ...repairs, [REPAIR_KEY]: marker },
		},
		marker,
	};
}

function preview(snapshot, plan) {
	if (plan.alreadyApplied) return { ok: true, mode: 'preview', storyId: STORY_ID, alreadyApplied: true, marker: plan.marker };
	const runningJobs = snapshot.activeJobs.filter((job) => job.status === 'running');
	return {
		ok: runningJobs.length === 0,
		mode: 'preview',
		storyId: STORY_ID,
		serverVersion: Number(snapshot.story.server_version),
		plannedServerVersion: plan.newVersion,
		activeJobs: snapshot.activeJobs,
		runningBlockers: runningJobs,
		before: {
			promises: snapshot.chapter.promises_debts_oaths,
			memoryHasForbiddenLabels: FORBIDDEN.test(`${snapshot.memory.content}\n${snapshot.memory.summary}`),
		},
		after: {
			promises: plan.promises,
			memoryHasForbiddenLabels: FORBIDDEN.test(`${plan.memoryContent}\n${plan.memorySummary}`),
		},
	};
}

async function writeBackup(snapshot, backupRoot) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupPath = path.join(backupRoot, `${stamp}-v${snapshot.story.server_version}-followup`);
	await mkdir(backupPath, { recursive: true });
	await writeFile(path.join(backupPath, 'backend-targets-before.json'), JSON.stringify({
		story: snapshot.story,
		chapter: snapshot.chapter,
		memory: snapshot.memory,
	}, null, 2), 'utf8');
	return backupPath;
}

async function applyPlan(tx, snapshot, plan, now, backupPath) {
	const version = plan.newVersion;
	plan.marker.backupPath = backupPath;
	plan.marker.checkpointId = `checkpoint_${REPAIR_KEY}_v${snapshot.story.server_version}`;
	plan.storyMetadata.loreIntegrityRepairs[REPAIR_KEY] = plan.marker;
	const chapter = await tx`update chapters set promises_debts_oaths = ${tx.json(plan.promises)}, metadata = ${tx.json(plan.chapterMetadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${CHAPTER_ID} and server_version = ${snapshot.chapter.server_version} returning id`;
	assert.equal(chapter.length, 1, 'Chapter 20 changed during follow-up repair');
	const memory = await tx`update memory_nodes set content = ${plan.memoryContent}, summary = ${plan.memorySummary}, metadata = ${tx.json(plan.memoryMetadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${MEMORY_ID} and server_version = ${snapshot.memory.server_version} returning id`;
	assert.equal(memory.length, 1, 'Chapter 20 memory changed during follow-up repair');
	const story = await tx`update stories set metadata = ${tx.json(plan.storyMetadata)}, server_version = ${version}, updated_at = ${now} where id = ${STORY_ID} and server_version = ${snapshot.story.server_version} returning id`;
	assert.equal(story.length, 1, 'Veil story version changed during follow-up repair');
	await tx`insert into context_checkpoints (id, story_id, label, reason, entry_position, current_turn, snapshot, metadata, server_version, created_at, updated_at)
		values (${plan.marker.checkpointId}, ${STORY_ID}, ${'Before Veil lore-integrity follow-up'}, ${plan.marker.reason}, 604, ${snapshot.story.current_turn}, ${tx.json({ backupPath, chapterId: CHAPTER_ID, memoryId: MEMORY_ID })}, ${tx.json({ repairKey: REPAIR_KEY, previousServerVersion: snapshot.story.server_version })}, ${version}, ${now}, ${now}) on conflict (id) do nothing`;
	const jobs = [
		{ id: `job_sync_story_vault_${REPAIR_KEY}_v${version}`, type: 'sync_story_vault', payload: { serverVersion: version, reason: REPAIR_KEY, clean: true, index: true, lint: true } },
		{ id: `job_embed_memory_nodes_${REPAIR_KEY}_v${version}`, type: 'embed_memory_nodes', payload: { serverVersion: version, memoryNodeIds: [MEMORY_ID] } },
		{ id: `job_index_canonical_records_${REPAIR_KEY}_v${version}`, type: 'index_canonical_records', payload: { serverVersion: version, reason: REPAIR_KEY, recreate: false, maxRecords: 40, recordTypes: ['chapters'], recordId: CHAPTER_ID } },
	];
	for (const job of jobs) {
		await tx`insert into backend_jobs (id, story_id, type, payload, status, attempt_count, max_attempts, run_after, metadata, created_at, updated_at)
			values (${job.id}, ${STORY_ID}, ${job.type}, ${tx.json(job.payload)}, 'queued', 0, 3, ${now}, ${tx.json({ repairKey: REPAIR_KEY })}, ${now}, ${now}) on conflict (id) do nothing`;
	}
	return jobs.map((job) => job.id);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const sql = postgres(databaseUrl(), { max: 1, prepare: false });
	try {
		if (!args.apply) {
			const snapshot = await loadSnapshot(sql);
			assert.equal(Number(snapshot.story.server_version), args.expectedVersion, `expected version ${args.expectedVersion}, found ${snapshot.story.server_version}`);
			const plan = buildFollowupPlan(snapshot, new Date().toISOString());
			const output = preview(snapshot, plan);
			if (!output.ok) throw new Error(`Preview is blocked by active Veil jobs: ${JSON.stringify(output.activeJobs)}`);
			console.log(JSON.stringify(output, null, 2));
			return;
		}
		let result;
		await sql.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(hashtextextended(${`mtherios:story-entry:${STORY_ID}`}, 0))`;
			const snapshot = await loadSnapshot(tx, true);
			assert.equal(Number(snapshot.story.server_version), args.expectedVersion, `expected version ${args.expectedVersion}, found ${snapshot.story.server_version}`);
			assert.deepEqual(snapshot.activeJobs.filter((job) => job.status === 'running'), [], 'running Veil jobs block the follow-up repair');
			const now = new Date().toISOString();
			const plan = buildFollowupPlan(snapshot, now);
			if (plan.alreadyApplied) {
				result = { alreadyApplied: true, marker: plan.marker };
				return;
			}
			const backupPath = await writeBackup(snapshot, args.backupRoot);
			const jobIds = await applyPlan(tx, snapshot, plan, now, backupPath);
			result = { alreadyApplied: false, backupPath, previousServerVersion: snapshot.story.server_version, serverVersion: plan.newVersion, jobIds };
		});
		console.log(JSON.stringify({ ok: true, mode: 'apply', storyId: STORY_ID, ...result, transcriptEntriesDeleted: 0, affinityHistoryChanged: false }, null, 2));
	} finally {
		await sql.end({ timeout: 1 });
	}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack : error);
		process.exitCode = 1;
	});
}
