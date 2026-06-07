#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
	buildBenchCampaignBootstrapCommandRequest,
	buildBenchCampaignStatusCommandRequest,
	buildBenchTranscriptPageCommandRequest,
	buildBenchTurnCommandRequest,
	buildBenchWorldSimCommandRequest,
	buildLongCampaignBenchmark,
	unwrapBenchEngineCommandPayload,
	unwrapBenchTurnPayload,
	unwrapBenchWorldSimPayload,
	verifyDbLongCampaignBenchmark,
} from './bench-generation-core.mjs';
import { databaseUrl } from './db-env.mjs';

const DEFAULT_URL = process.env.MTHERIOS_BENCH_URL || 'http://127.0.0.1:5173';

function parseArgs(argv) {
	const args = {
		url: DEFAULT_URL,
		mode: 'jobs',
		limit: 10,
		storyId: '',
		workerId: `bench_generation_${Date.now()}`,
		playerText: 'Look around and let the world respond.',
		localVersion: 0,
		turns: 10_000,
		entryLimit: 80,
		promptLimit: 120,
		maxDurationMs: 1_000,
		maxHeapMb: 128,
		batchSize: 1_000,
		keepSeed: false,
		replaceSeed: false,
		seedStoryId: '',
		dbUrl: '',
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === '--help' || arg === '-h') args.help = true;
		else if (arg === '--url' && next) args.url = next, i += 1;
		else if (arg.startsWith('--url=')) args.url = arg.slice('--url='.length);
		else if (arg === '--mode' && next) args.mode = next, i += 1;
		else if (arg.startsWith('--mode=')) args.mode = arg.slice('--mode='.length);
		else if (arg === '--story-id' && next) args.storyId = next, i += 1;
		else if (arg.startsWith('--story-id=')) args.storyId = arg.slice('--story-id='.length);
		else if (arg === '--limit' && next) args.limit = Number.parseInt(next, 10), i += 1;
		else if (arg.startsWith('--limit=')) args.limit = Number.parseInt(arg.slice('--limit='.length), 10);
		else if (arg === '--worker' && next) args.workerId = next, i += 1;
		else if (arg.startsWith('--worker=')) args.workerId = arg.slice('--worker='.length);
		else if (arg === '--player-text' && next) args.playerText = next, i += 1;
		else if (arg.startsWith('--player-text=')) args.playerText = arg.slice('--player-text='.length);
		else if (arg === '--local-version' && next) args.localVersion = Number.parseInt(next, 10), i += 1;
		else if (arg.startsWith('--local-version=')) args.localVersion = Number.parseInt(arg.slice('--local-version='.length), 10);
		else if (arg === '--turns' && next) args.turns = Number.parseInt(next, 10), i += 1;
		else if (arg.startsWith('--turns=')) args.turns = Number.parseInt(arg.slice('--turns='.length), 10);
		else if (arg === '--entry-limit' && next) args.entryLimit = Number.parseInt(next, 10), i += 1;
		else if (arg.startsWith('--entry-limit=')) args.entryLimit = Number.parseInt(arg.slice('--entry-limit='.length), 10);
		else if (arg === '--prompt-limit' && next) args.promptLimit = Number.parseInt(next, 10), i += 1;
		else if (arg.startsWith('--prompt-limit=')) args.promptLimit = Number.parseInt(arg.slice('--prompt-limit='.length), 10);
		else if (arg === '--max-duration-ms' && next) args.maxDurationMs = Number.parseInt(next, 10), i += 1;
		else if (arg.startsWith('--max-duration-ms=')) args.maxDurationMs = Number.parseInt(arg.slice('--max-duration-ms='.length), 10);
		else if (arg === '--max-heap-mb' && next) args.maxHeapMb = Number.parseInt(next, 10), i += 1;
		else if (arg.startsWith('--max-heap-mb=')) args.maxHeapMb = Number.parseInt(arg.slice('--max-heap-mb='.length), 10);
		else if (arg === '--batch-size' && next) args.batchSize = Number.parseInt(next, 10), i += 1;
		else if (arg.startsWith('--batch-size=')) args.batchSize = Number.parseInt(arg.slice('--batch-size='.length), 10);
		else if (arg === '--seed-story-id' && next) args.seedStoryId = next, i += 1;
		else if (arg.startsWith('--seed-story-id=')) args.seedStoryId = arg.slice('--seed-story-id='.length);
		else if (arg === '--db-url' && next) args.dbUrl = next, i += 1;
		else if (arg.startsWith('--db-url=')) args.dbUrl = arg.slice('--db-url='.length);
		else if (arg === '--keep-seed') args.keepSeed = true;
		else if (arg === '--replace-seed') args.replaceSeed = true;
	}
	args.url = String(args.url).replace(/\/+$/, '');
	args.limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.trunc(args.limit) : 10;
	args.localVersion = Number.isFinite(args.localVersion) && args.localVersion >= 0 ? Math.trunc(args.localVersion) : 0;
	args.turns = Number.isFinite(args.turns) && args.turns > 0 ? Math.trunc(args.turns) : 10_000;
	args.entryLimit = Number.isFinite(args.entryLimit) && args.entryLimit > 0 ? Math.trunc(args.entryLimit) : 80;
	args.promptLimit = Number.isFinite(args.promptLimit) && args.promptLimit > 0 ? Math.trunc(args.promptLimit) : 120;
	args.maxDurationMs = Number.isFinite(args.maxDurationMs) && args.maxDurationMs > 0 ? Math.trunc(args.maxDurationMs) : 1_000;
	args.maxHeapMb = Number.isFinite(args.maxHeapMb) && args.maxHeapMb > 0 ? Math.trunc(args.maxHeapMb) : 128;
	args.batchSize = Number.isFinite(args.batchSize) && args.batchSize > 0 ? Math.min(5_000, Math.trunc(args.batchSize)) : 1_000;
	args.seedStoryId = String(args.seedStoryId || '').trim();
	args.dbUrl = String(args.dbUrl || '').trim();
	return args;
}

function usage() {
	console.log(`Mtherios generation benchmark

Usage:
  npm run bench:generation -- --mode long-campaign [--turns 10000]
  npm run bench:generation -- --mode db-long-campaign [--turns 10000] [--url http://127.0.0.1:5173]
  npm run bench:generation -- --story-id <story-id> [--mode jobs|world-sim|turn] [--url http://127.0.0.1:5173]

Examples:
  npm run bench:generation -- --mode long-campaign --turns 10000
  npm run bench:generation -- --mode db-long-campaign --turns 10000
  npm run bench:generation -- --story-id story_abc --mode jobs --limit 10
  npm run bench:generation -- --story-id story_abc --mode world-sim
  npm run bench:generation -- --story-id story_abc --mode turn --player-text "Ask what changed in the city."

The app server must already be running for db-long-campaign, jobs, world-sim, and turn modes. The long-campaign mode is deterministic and runs locally.`);
}

async function requestJson(baseUrl, path, options = {}) {
	const { headers = {}, timeoutMs, ...requestOptions } = options;
	const response = await fetch(`${baseUrl}${path}`, {
		...requestOptions,
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
		...(timeoutMs ? { signal: AbortSignal.timeout(Number(timeoutMs)) } : {}),
	});
	const text = await response.text();
	let payload = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = { raw: text };
	}
	if (!response.ok) {
		throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${text || response.statusText}`);
	}
	return payload;
}

async function getApiCallLogs(baseUrl, storyId) {
	if (!storyId) return [];
	try {
		const result = await requestJson(baseUrl, `/api/api-call-logs?storyId=${encodeURIComponent(storyId)}&limit=500`);
		return Array.isArray(result.logs) ? result.logs : [];
	} catch {
		return [];
	}
}

function flattenTimingReports(payload) {
	const reports = [];
	if (Array.isArray(payload?.timings)) reports.push(...payload.timings);
	if (payload?.job?.timings) reports.push(payload.job.timings);
	if (payload?.timings && !Array.isArray(payload.timings) && payload.timings.phases) reports.push(payload.timings);
	return reports;
}

function aggregatePhases(reports) {
	const phases = new Map();
	for (const report of reports) {
		for (const phase of report.phases || []) {
			const key = phase.phase || 'unknown';
			const current = phases.get(key) || { phase: key, count: 0, totalMs: 0, maxMs: 0 };
			const duration = Number(phase.durationMs) || 0;
			current.count += 1;
			current.totalMs += duration;
			current.maxMs = Math.max(current.maxMs, duration);
			phases.set(key, current);
		}
	}
	return [...phases.values()].sort((a, b) => b.totalMs - a.totalMs);
}

function printPhaseTable(phases) {
	if (phases.length === 0) {
		console.log('Per-phase duration: unavailable from this endpoint.');
		return;
	}
	console.log('Per-phase duration:');
	for (const phase of phases) {
		console.log(`  ${phase.phase}: total=${Math.round(phase.totalMs)}ms count=${phase.count} max=${Math.round(phase.maxMs)}ms`);
	}
}

function countNewApiCalls(before, after) {
	const beforeIds = new Set(before.map((log) => log.id).filter(Boolean));
	return after.filter((log) => !beforeIds.has(log.id)).length;
}

function seedStoryId(args) {
	return args.seedStoryId || `bench_long_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function seededDbEntry(storyId, position) {
	const turn = Math.floor(position / 2) + 1;
	const isPlayer = position % 2 === 0;
	return {
		id: `${storyId}_entry_${position}`,
		story_id: storyId,
		type: isPlayer ? 'user_action' : 'narration',
		content: isPlayer
			? `Turn ${turn}: the player tests the long-campaign control surface.`
			: `Turn ${turn}: the terminal backend stores bounded append-only evidence.`,
		position,
		metadata: {
			source: 'bench:generation db-long-campaign',
			turn,
		},
		server_version: 1,
	};
}

async function seedDbLongCampaign(sql, args) {
	const storyId = seedStoryId(args);
	const entryCount = args.turns * 2;
	const started = performance.now();
	const [existing] = await sql`select id from stories where id = ${storyId} limit 1`;
	if (existing && !args.replaceSeed) {
		throw new Error(`Seed story already exists: ${storyId}. Use --replace-seed or choose --seed-story-id.`);
	}

	await sql.begin(async (tx) => {
		if (existing) {
			await tx`delete from stories where id = ${storyId}`;
		}
		await tx`
			insert into stories (id, title, description, genre, mode, current_turn, metadata, server_version)
			values (
				${storyId},
				${`Benchmark 10k Campaign ${storyId}`},
				${'Seeded by bench:generation db-long-campaign to verify bounded backend projections.'},
				${'benchmark'},
				${'adventure'},
				${args.turns},
				${sql.json({ source: 'bench:generation db-long-campaign', turns: args.turns })},
				1
			)
		`;

		for (let start = 0; start < entryCount; start += args.batchSize) {
			const rows = [];
			const end = Math.min(entryCount, start + args.batchSize);
			for (let position = start; position < end; position += 1) {
				rows.push(seededDbEntry(storyId, position));
			}
			await tx`insert into story_entries ${tx(rows, 'id', 'story_id', 'type', 'content', 'position', 'metadata', 'server_version')}`;
		}
	});

	return {
		storyId,
		entryCount,
		durationMs: Math.round(performance.now() - started),
	};
}

async function cleanupSeedStory(sql, storyId) {
	if (!storyId.startsWith('bench_long_')) {
		throw new Error(`Refusing to clean up non-benchmark story id: ${storyId}`);
	}
	await sql`delete from stories where id = ${storyId}`;
}

async function runEngineCommand(baseUrl, request) {
	return unwrapBenchEngineCommandPayload(await requestJson(baseUrl, request.requestPath, {
		method: 'POST',
		body: JSON.stringify(request.body),
		timeoutMs: 120_000,
	}), String(request.body.command || 'engine.command'));
}

async function runDbLongCampaignBenchmark(args) {
	const sql = postgres(args.dbUrl || databaseUrl(), { max: 1, prepare: false });
	let seed = null;
	try {
		seed = await seedDbLongCampaign(sql, args);
		const gatewayStarted = performance.now();
		const [status, transcript, bootstrap] = await Promise.all([
			runEngineCommand(args.url, buildBenchCampaignStatusCommandRequest({
				storyId: seed.storyId,
				entryLimit: args.entryLimit,
			})),
			runEngineCommand(args.url, buildBenchTranscriptPageCommandRequest({
				storyId: seed.storyId,
				limit: args.entryLimit,
			})),
			runEngineCommand(args.url, buildBenchCampaignBootstrapCommandRequest({
				storyId: seed.storyId,
				entryLimit: args.entryLimit,
			})),
		]);
		const gatewayDurationMs = Math.round(performance.now() - gatewayStarted);
		const verification = verifyDbLongCampaignBenchmark({
			turns: args.turns,
			entryLimit: args.entryLimit,
			transcriptLimit: args.entryLimit,
			status,
			transcript,
			bootstrap,
		});

		console.log('Mtherios generation benchmark');
		console.log('  mode: db-long-campaign');
		console.log(`  url: ${args.url}`);
		console.log(`  storyId: ${seed.storyId}`);
		console.log(`  turns: ${args.turns}`);
		console.log(`  entries: ${seed.entryCount}`);
		console.log(`  seed duration: ${seed.durationMs}ms`);
		console.log(`  gateway duration: ${gatewayDurationMs}ms`);
		console.log(`  projection: ${verification.projection.length}/${verification.projection.limit} entries positions ${verification.projection.firstPosition}-${verification.projection.lastPosition}`);
		console.log(`  transcript: ${verification.transcript.length}/${verification.transcript.limit} entries positions ${verification.transcript.firstPosition}-${verification.transcript.lastPosition} hasMore=${verification.transcript.hasMore}`);
		console.log(`  bootstrap: total=${verification.bootstrap?.entryCount ?? 'n/a'} selected=${verification.bootstrap?.selectedLength ?? 'n/a'} count=${verification.bootstrap?.projectionCountEntries ?? 'n/a'}`);

		if (!verification.ok) {
			for (const error of verification.errors) console.log(`  error: ${error}`);
			throw new Error('DB long-campaign benchmark failed bounded backend assertions.');
		}
	} finally {
		if (seed && !args.keepSeed) {
			await cleanupSeedStory(sql, seed.storyId);
			console.log(`  cleanup: deleted ${seed.storyId}`);
		} else if (seed) {
			console.log(`  cleanup: kept ${seed.storyId}`);
		}
		await sql.end({ timeout: 5 });
	}
}

async function runBenchmark(args) {
	if (args.mode === 'long-campaign') {
		const result = buildLongCampaignBenchmark(args);
		const heapMb = typeof result.heapDeltaBytes === 'number'
			? result.heapDeltaBytes / 1024 / 1024
			: null;
		console.log('Mtherios generation benchmark');
		console.log('  mode: long-campaign');
		console.log(`  turns: ${result.turns}`);
		console.log(`  entries: ${result.entryCount}`);
		console.log(`  duration: ${result.durationMs}ms`);
		if (heapMb != null) console.log(`  heap delta: ${heapMb.toFixed(2)}MB`);
		console.log(`  projection: ${result.projection.selected}/${result.projection.limit} entries positions ${result.projection.firstPosition}-${result.projection.lastPosition}`);
		console.log(`  prompt: ${result.prompt.selected}/${result.prompt.limit} entries positions ${result.prompt.firstPosition}-${result.prompt.lastPosition} tokens~${result.prompt.tokenEstimate}`);
		console.log(`  cache warm hits: ${result.cache.warmAssembly.hits}/${result.cache.stableSegmentCount}`);
		console.log(`  cache invalidated after character edit: ${result.cache.afterCharacterEdit.changedKeys.join(', ') || 'none'}`);
		if (!result.ok) throw new Error('Long-campaign benchmark failed bounded projection/cache assertions.');
		if (result.durationMs > args.maxDurationMs) {
			throw new Error(`Long-campaign benchmark exceeded --max-duration-ms (${result.durationMs}ms > ${args.maxDurationMs}ms).`);
		}
		if (heapMb != null && heapMb > args.maxHeapMb) {
			throw new Error(`Long-campaign benchmark exceeded --max-heap-mb (${heapMb.toFixed(2)}MB > ${args.maxHeapMb}MB).`);
		}
		return;
	}
	if (args.mode === 'db-long-campaign') {
		await runDbLongCampaignBenchmark(args);
		return;
	}
	if (!args.storyId) throw new Error('--story-id is required.');
	const beforeLogs = await getApiCallLogs(args.url, args.storyId);
	const started = performance.now();
	let payload;
	if (args.mode === 'jobs') {
		payload = await requestJson(args.url, '/api/app/jobs/run', {
			method: 'POST',
			body: JSON.stringify({
				storyId: args.storyId,
				workerId: args.workerId,
				limit: args.limit,
			}),
		});
	} else if (args.mode === 'world-sim') {
		const worldSimRequest = buildBenchWorldSimCommandRequest({
			storyId: args.storyId,
			workerId: args.workerId,
			localVersion: args.localVersion,
		});
		payload = unwrapBenchWorldSimPayload(await requestJson(args.url, worldSimRequest.requestPath, {
			method: 'POST',
			body: JSON.stringify(worldSimRequest.body),
		}));
	} else if (args.mode === 'turn') {
		const turnRequest = buildBenchTurnCommandRequest({
			storyId: args.storyId,
			playerText: args.playerText,
			localVersion: args.localVersion,
		});
		payload = unwrapBenchTurnPayload(await requestJson(args.url, turnRequest.requestPath, {
			method: 'POST',
			body: JSON.stringify(turnRequest.body),
			timeoutMs: turnRequest.timeoutMs,
		}));
	} else {
		throw new Error(`Unknown mode: ${args.mode}`);
	}
	const totalMs = Math.round(performance.now() - started);
	const afterLogs = await getApiCallLogs(args.url, args.storyId);
	const reports = flattenTimingReports(payload);
	const phases = aggregatePhases(reports);

	console.log(`Mtherios generation benchmark`);
	console.log(`  mode: ${args.mode}`);
	console.log(`  url: ${args.url}`);
	console.log(`  storyId: ${args.storyId}`);
	console.log(`  total duration: ${totalMs}ms`);
	console.log(`  model/API calls: ${countNewApiCalls(beforeLogs, afterLogs)}`);
	if (typeof payload.claimed === 'number') console.log(`  jobs: claimed=${payload.claimed} completed=${payload.completed ?? 0} failed=${payload.failed?.length ?? 0}`);
	if (payload.job) console.log(`  job: completed=${Boolean(payload.job.completed)} id=${payload.job.jobId || payload.jobId}`);
	if (Array.isArray(payload.generationTimings)) {
		console.log(`  LLM timings:`);
		for (const timing of payload.generationTimings) {
			console.log(`    ${timing.operation}: ${timing.durationMs}ms model=${timing.model || 'unknown'} tokens=${timing.totalTokens ?? 'n/a'}`);
		}
	}
	printPhaseTable(phases);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	usage();
} else {
	runBenchmark(args).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
