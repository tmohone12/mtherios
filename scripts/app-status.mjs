#!/usr/bin/env node

const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.PORT || '5173';

async function main(argv = process.argv.slice(2)) {
	const { url, json } = parseArgs(argv);
	const endpoint = `${url.replace(/\/$/, '')}/api/app/status`;
	const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
	if (!response.ok) {
		throw new Error(`Status request failed: HTTP ${response.status}`);
	}
	const status = await response.json();
	if (json) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}
	printStatus(status, url);
}

function parseArgs(argv) {
	const flags = { json: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--json') {
			flags.json = true;
		} else if (arg === '--url' && argv[index + 1]) {
			flags.url = argv[index + 1];
			index += 1;
		} else if (arg.startsWith('--url=')) {
			flags.url = arg.slice('--url='.length);
		} else if (!arg.startsWith('--') && !flags.url) {
			flags.url = arg;
		}
	}
	return {
		url: String(flags.url || process.env.MTHERIOS_APP_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`),
		json: flags.json,
	};
}

function printStatus(status, url) {
	const config = asRecord(status.config);
	const runtime = asRecord(status.runtime);
	const services = asRecord(status.services);
	const jobs = asRecord(status.jobs);
	const wiki = asRecord(status.wiki);
	const qdrant = asRecord(services.qdrant);
	const ollama = asRecord(services.ollama);

	console.log('');
	console.log('Mtherios terminal app status');
	console.log(`  app:      ${url}`);
	console.log(`  mode:     ${status.mode || 'unknown'}`);
	console.log(`  runtime:  pid ${runtime.pid ?? 'unknown'}, uptime ${formatDuration(Number(runtime.uptimeSeconds ?? 0))}`);
	console.log(`  data:     ${config.dataRoot || 'unknown'}`);
	console.log(`  vaults:   ${config.vaultRoot || 'unknown'}`);
	console.log(`  database: ${config.databaseConfigured ? 'configured' : 'not configured'}`);
	console.log(`  jobs:     ${config.jobWorkerEnabled ? `enabled every ${config.jobIntervalMs ?? 'unknown'}ms` : 'disabled'}`);
	console.log(`  qdrant:   ${serviceLine(qdrant)} ${config.qdrantUrl || ''}`);
	printQdrantCollections(qdrant);
	console.log(`  ollama:   ${serviceLine(ollama)} ${config.ollamaUrl || ''}`);
	console.log(`  wiki:     ${config.wikiEmbedProvider || 'unknown'} / ${config.wikiEmbedModel || 'unknown'}, auto-index ${config.wikiAutoIndexStoryVaults ? 'on' : 'off'}, auto-lint ${config.wikiAutoLintStoryVaults ? 'on' : 'off'}`);
	printWikiStatus(wiki);
	console.log(`  memory:   chapters every ${config.chapterThreshold ?? 'unknown'} entries (+${config.postChapterBuffer ?? 'unknown'} buffer), arcs every ${config.chaptersPerArc ?? 'unknown'} chapters`);
	console.log(`  vectors:  ${config.memoryEmbeddingsConfigured ? `${config.memoryEmbeddingProvider} / ${config.memoryEmbeddingModel} (${config.memoryEmbeddingDimensions}d)` : 'disabled'}`);
	console.log(`  backlog:  total=${jobs.total ?? 0} ready=${jobs.ready ?? 0} retry=${jobs.retry ?? 0} running=${jobs.running ?? 0} delayed=${jobs.delayed ?? 0} failed=${jobs.failed ?? 0}`);
	printRecentFailures(jobs.recentFailures);
	console.log('');
}

function asRecord(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function serviceLine(service) {
	if (service.ok) return `ok${service.status ? ` (${service.status})` : ''}`;
	return `down${service.error ? ` (${service.error})` : ''}`;
}

function printWikiStatus(wiki) {
	if (wiki.error) {
		console.log(`  story wiki: unavailable (${wiki.error})`);
		return;
	}
	if (wiki.totalStories === undefined) return;
	console.log(
		`  story wiki: stories=${wiki.totalStories ?? 0} ` +
		`vault fresh=${wiki.vaultFresh ?? 0} stale=${wiki.vaultStale ?? 0} missing=${wiki.vaultMissing ?? 0}; ` +
		`qdrant fresh=${wiki.indexFresh ?? 0} stale=${wiki.indexStale ?? 0} missing=${wiki.indexMissing ?? 0}`,
	);
	const attention = Array.isArray(wiki.attention) ? wiki.attention.slice(0, 4) : [];
	if (attention.length === 0) return;
	console.log('  story wiki attention:');
	for (const row of attention) {
		const title = row.storyTitle || row.storyId || 'unknown story';
		const vault = row.vaultFresh ? 'vault fresh' : row.exists ? `vault v${row.manifestVersion ?? '-'} < backend v${row.serverVersion ?? '-'}` : 'vault missing';
		const index = row.indexFresh ? 'qdrant fresh' : row.indexedVersion ? `qdrant v${row.indexedVersion} < backend v${row.serverVersion ?? '-'}` : 'qdrant missing';
		console.log(`    ${title}: ${vault}; ${index}`);
	}
}

function printQdrantCollections(qdrant) {
	const collections = Array.isArray(qdrant.collections) ? qdrant.collections : [];
	if (collections.length === 0) return;
	const total = qdrant.totalCollections ?? collections.length;
	const points = qdrant.totalPoints ?? collections.reduce((sum, row) => sum + Number(row.pointsCount ?? 0), 0);
	const orphaned = qdrant.orphanedStoryCollections ?? collections.filter((row) => row.orphaned).length;
	const orphanText = orphaned > 0 ? `, ${orphaned} orphaned story collection${orphaned === 1 ? '' : 's'}` : '';
	console.log(`  qdrant collections: ${total} collection${total === 1 ? '' : 's'}, ${points} point${points === 1 ? '' : 's'}${orphanText}`);
	for (const row of collections.slice(0, 8)) {
		const role = row.orphaned ? 'orphaned story ' : row.role && row.role !== 'other' ? `${row.role} ` : '';
		const count = row.pointsCount ?? '?';
		const vector = row.vectorSize ? `${row.vectorSize}d ${row.distance || ''}`.trim() : 'unknown vectors';
		const status = row.status || 'unknown';
		console.log(`    ${role}${row.name}: ${count} points, ${vector}, ${status}`);
	}
	if (total > collections.length) console.log(`    ...${total - collections.length} more collection${total - collections.length === 1 ? '' : 's'}`);
}

function formatDuration(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown';
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${Math.max(1, minutes)}m`;
}

function printRecentFailures(value) {
	if (!Array.isArray(value) || value.length === 0) return;
	console.log('  failures:');
	for (const job of value.slice(0, 5)) {
		const error = typeof job.lastError === 'string' && job.lastError ? ` - ${job.lastError}` : '';
		console.log(`    ${job.status || 'unknown'} ${job.type || 'job'} ${job.id || ''}${error}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
