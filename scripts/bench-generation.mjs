#!/usr/bin/env node

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
	}
	args.url = String(args.url).replace(/\/+$/, '');
	args.limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.trunc(args.limit) : 10;
	args.localVersion = Number.isFinite(args.localVersion) && args.localVersion >= 0 ? Math.trunc(args.localVersion) : 0;
	return args;
}

function usage() {
	console.log(`Mtherios generation benchmark

Usage:
  npm run bench:generation -- --story-id <story-id> [--mode jobs|world-sim|turn] [--url http://127.0.0.1:5173]

Examples:
  npm run bench:generation -- --story-id story_abc --mode jobs --limit 10
  npm run bench:generation -- --story-id story_abc --mode world-sim
  npm run bench:generation -- --story-id story_abc --mode turn --player-text "Ask what changed in the city."

The app server must already be running. For the terminal app, use npm run app:dev or npm run dev:backend first.`);
}

async function requestJson(baseUrl, path, options = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(options.headers || {}),
		},
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

async function runBenchmark(args) {
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
		payload = await requestJson(args.url, '/api/app/jobs/world-sim', {
			method: 'POST',
			body: JSON.stringify({
				storyId: args.storyId,
				workerId: args.workerId,
				force: true,
			}),
		});
	} else if (args.mode === 'turn') {
		payload = await requestJson(args.url, '/api/turn', {
			method: 'POST',
			body: JSON.stringify({
				storyId: args.storyId,
				clientTurnId: `bench_${Date.now()}`,
				playerText: args.playerText,
				localVersion: args.localVersion,
				clientContext: {},
			}),
		});
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
