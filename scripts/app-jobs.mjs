#!/usr/bin/env node

const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.PORT || '5173';

async function main(argv = process.argv.slice(2)) {
	const { command, flags } = parseArgs(argv);
	if (command === 'status') {
		const status = await getStatus(flags);
		if (flags.json) {
			console.log(JSON.stringify(status.jobs ?? {}, null, 2));
			return;
		}
		printStatus(status, flags);
		return;
	}
	if (command === 'run') {
		const result = flags.untilEmpty
			? await runUntilEmpty(flags)
			: await runOnce(flags);
		if (flags.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}
		printRun(result, flags);
		return;
	}
	throw new Error(`Unknown app jobs command: ${command}`);
}

function parseArgs(argv) {
	const flags = {
		json: false,
		untilEmpty: false,
		limit: 25,
		maxCycles: 25,
		timeoutMs: readInt(process.env.MTHERIOS_JOB_TIMEOUT_MS, 120_000),
		url: process.env.MTHERIOS_APP_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
	};
	let command = 'status';
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith('--') && command === 'status') {
			command = arg;
			continue;
		}
		if (arg === '--json') flags.json = true;
		else if (arg === '--until-empty') flags.untilEmpty = true;
		else if (arg === '--url' && argv[index + 1]) flags.url = argv[++index];
		else if (arg.startsWith('--url=')) flags.url = arg.slice('--url='.length);
		else if (arg === '--story' && argv[index + 1]) flags.storyId = argv[++index];
		else if (arg.startsWith('--story=')) flags.storyId = arg.slice('--story='.length);
		else if (arg === '--worker' && argv[index + 1]) flags.workerId = argv[++index];
		else if (arg.startsWith('--worker=')) flags.workerId = arg.slice('--worker='.length);
		else if (arg === '--limit' && argv[index + 1]) flags.limit = readInt(argv[++index], flags.limit);
		else if (arg.startsWith('--limit=')) flags.limit = readInt(arg.slice('--limit='.length), flags.limit);
		else if (arg === '--max-cycles' && argv[index + 1]) flags.maxCycles = readInt(argv[++index], flags.maxCycles);
		else if (arg.startsWith('--max-cycles=')) flags.maxCycles = readInt(arg.slice('--max-cycles='.length), flags.maxCycles);
		else if (arg === '--timeout-ms' && argv[index + 1]) flags.timeoutMs = readInt(argv[++index], flags.timeoutMs);
		else if (arg.startsWith('--timeout-ms=')) flags.timeoutMs = readInt(arg.slice('--timeout-ms='.length), flags.timeoutMs);
		else if (arg === '--help' || arg === '-h') {
			printHelp();
			process.exit(0);
		}
	}
	flags.limit = Math.max(1, Math.min(100, flags.limit));
	flags.maxCycles = Math.max(1, Math.min(250, flags.maxCycles));
	if (typeof flags.storyId === 'string') flags.storyId = flags.storyId.trim();
	if (typeof flags.workerId !== 'string' || !flags.workerId.trim()) {
		flags.workerId = `app_jobs_${Date.now()}`;
	}
	return { command, flags };
}

function readInt(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

async function getStatus(flags) {
	const suffix = flags.storyId ? `?storyId=${encodeURIComponent(flags.storyId)}` : '';
	return requestJson(flags.url, `/api/app/status${suffix}`, { timeoutMs: Math.min(flags.timeoutMs, 30_000) });
}

async function runOnce(flags) {
	return requestJson(flags.url, '/api/app/jobs/run', {
		method: 'POST',
		body: {
			workerId: flags.workerId,
			limit: flags.limit,
			...(flags.storyId ? { storyId: flags.storyId } : {}),
		},
		timeoutMs: flags.timeoutMs,
	});
}

async function runUntilEmpty(flags) {
	const cycles = [];
	let final = null;
	for (let index = 0; index < flags.maxCycles; index += 1) {
		const result = await runOnce({
			...flags,
			workerId: `${flags.workerId}_${index + 1}`,
		});
		cycles.push(result);
		final = result;
		const after = asRecord(result.after);
		if (Number(after.ready ?? 0) <= 0 || Number(result.claimed ?? 0) <= 0) break;
	}
	return {
		ok: cycles.every((cycle) => Array.isArray(cycle.failed) && cycle.failed.length === 0),
		mode: 'until-empty',
		cycles: cycles.length,
		limit: flags.limit,
		storyId: flags.storyId ?? null,
		results: cycles,
		final,
	};
}

async function requestJson(baseUrl, path, options = {}) {
	const response = await fetch(`${String(baseUrl).replace(/\/$/, '')}${path}`, {
		method: options.method ?? 'GET',
		headers: { 'Content-Type': 'application/json' },
		body: options.body ? JSON.stringify(options.body) : undefined,
		signal: AbortSignal.timeout(Number(options.timeoutMs ?? 10_000)),
	});
	const text = await response.text();
	let payload = {};
	if (text.trim()) {
		try {
			payload = JSON.parse(text);
		} catch {
			payload = { raw: text };
		}
	}
	if (!response.ok) {
		const message = typeof payload.error === 'string' ? payload.error : text;
		throw new Error(`Request failed: HTTP ${response.status}${message ? ` - ${message}` : ''}`);
	}
	return payload;
}

function printStatus(status, flags) {
	const jobs = asRecord(status.jobs);
	console.log('');
	console.log('Mtherios backend jobs');
	console.log(`  app:      ${flags.url}`);
	console.log(`  scope:    ${flags.storyId || 'all stories'}`);
	printBacklog(jobs);
	printJobMap('  ready:', jobs.readyByType);
	printJobMap('  failed:', jobs.failedByType);
	printRecentFailures(jobs.recentFailures);
	console.log('');
}

function printRun(result, flags) {
	if (result.mode === 'until-empty') {
		const final = asRecord(result.final);
		console.log('');
		console.log(`Mtherios job drain: ${result.cycles} cycle${result.cycles === 1 ? '' : 's'}`);
		console.log(`  app:      ${flags.url}`);
		console.log(`  scope:    ${result.storyId || 'all stories'}`);
		for (const [index, cycle] of result.results.entries()) {
			console.log(`  cycle ${index + 1}: claimed=${cycle.claimed ?? 0} completed=${cycle.completed ?? 0} failed=${Array.isArray(cycle.failed) ? cycle.failed.length : 0}`);
		}
		printBacklog(asRecord(final.after));
		console.log('');
		return;
	}
	console.log('');
	console.log('Mtherios job run');
	console.log(`  app:      ${flags.url}`);
	console.log(`  scope:    ${flags.storyId || 'all stories'}`);
	console.log(`  worker:   ${result.workerId || flags.workerId}`);
	console.log(`  claimed:  ${result.claimed ?? 0}`);
	console.log(`  complete: ${result.completed ?? 0}`);
	console.log(`  failed:   ${Array.isArray(result.failed) ? result.failed.length : 0}`);
	printBacklog(asRecord(result.after));
	printRunFailures(result.failed);
	console.log('');
}

function printBacklog(jobs) {
	console.log(
		`  backlog:  total=${jobs.total ?? 0} ready=${jobs.ready ?? 0} retry=${jobs.retry ?? 0} ` +
		`running=${jobs.running ?? 0} delayed=${jobs.delayed ?? 0} failed=${jobs.failed ?? 0}`,
	);
}

function printJobMap(label, value) {
	const entries = Object.entries(asRecord(value));
	if (entries.length === 0) return;
	console.log(label);
	for (const [type, count] of entries) console.log(`    ${type}: ${count}`);
}

function printRecentFailures(value) {
	if (!Array.isArray(value) || value.length === 0) return;
	console.log('  recent failures:');
	for (const job of value.slice(0, 5)) {
		const error = typeof job.lastError === 'string' && job.lastError ? ` - ${job.lastError}` : '';
		console.log(`    ${job.status || 'unknown'} ${job.type || 'job'} ${job.id || ''}${error}`);
	}
}

function printRunFailures(value) {
	if (!Array.isArray(value) || value.length === 0) return;
	console.log('  run failures:');
	for (const row of value.slice(0, 8)) {
		console.log(`    ${row.jobId || 'job'} - ${row.error || 'unknown error'}`);
	}
}

function asRecord(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function printHelp() {
	console.log(`Mtherios backend job CLI

Usage:
  npm run app:jobs -- status [--story <storyId>] [--json]
  npm run app:jobs -- run [--story <storyId>] [--limit 25] [--until-empty] [--json]

Options:
  --url <u>         Running app URL. Defaults to MTHERIOS_APP_URL or http://127.0.0.1:5173.
  --story <id>     Scope status and job claiming to one backend story.
  --worker <id>    Worker id prefix for claimed jobs.
  --limit <n>      Jobs to claim per run request. Max 100.
  --until-empty    Repeat due-job runs until the ready queue is empty or no jobs are claimed.
  --max-cycles <n> Safety cap for --until-empty. Default 25.
  --timeout-ms <n> Request timeout for job runs. Default 120000.
  --json           Print JSON.
`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
