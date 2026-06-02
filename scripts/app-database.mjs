#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.PORT || '5173';
const DEFAULT_URL = process.env.MTHERIOS_APP_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const BOOLEAN_FLAGS = new Set(['json', 'preserveIds', 'replaceExisting', 'syncWiki', 'index', 'lint', 'recreate', 'runNow']);

async function main(argv = process.argv.slice(2)) {
	const { command, flags, positional } = parseArgs(argv);
	const url = String(flags.url || DEFAULT_URL).replace(/\/$/, '');
	const json = flags.json === true;

	switch (command) {
		case 'schema':
			return printSchema(await getSchema(url), flags, json);
		case 'list':
		case 'databases':
			return printList(await requestJson(url, '/api/stories'), json);
		case 'create':
			return printCreated(await createDatabase(url, flags), json);
		case 'import':
			return printImported(await importDatabase(url, flags), json);
		case 'export':
			return printExported(await exportDatabase(url, flags), json);
		case 'sync-wiki':
		case 'wiki':
			return printWiki(await syncWiki(url, flags), json);
		case 'help':
		case undefined:
			return printHelp();
		default:
			throw new Error(`Unknown app database command: ${command}`);
	}
}

function parseArgs(argv) {
	const flags = {};
	const positional = [];
	let command;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith('--') && !command) {
			command = arg;
			continue;
		}
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}
		const raw = arg.slice(2);
		const eq = raw.indexOf('=');
		const key = camelKey(eq === -1 ? raw : raw.slice(0, eq));
		const inlineValue = eq === -1 ? null : raw.slice(eq + 1);
		if (key.startsWith('no')) {
			flags[lowerFirst(key.slice(2))] = false;
		} else if (inlineValue !== null) {
			flags[key] = inlineValue;
		} else if (BOOLEAN_FLAGS.has(key)) {
			flags[key] = true;
		} else if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
			flags[key] = argv[index + 1];
			index += 1;
		} else {
			flags[key] = true;
		}
	}
	return { command, flags, positional };
}

function camelKey(value) {
	return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function lowerFirst(value) {
	return value ? value[0].toLowerCase() + value.slice(1) : value;
}

async function requestJson(baseUrl, requestPath, options = {}) {
	const response = await fetch(`${baseUrl}${requestPath}`, {
		...options,
		headers: {
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
			...(options.headers ?? {}),
		},
		signal: AbortSignal.timeout(Number(options.timeoutMs ?? 30_000)),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status} ${requestPath}`);
	}
	return body;
}

async function getSchema(url) {
	return requestJson(url, '/api/database/schema');
}

async function createDatabase(url, flags) {
	const title = optionalString(flags.title);
	if (!title) throw new Error('create requires --title <name>.');
	return requestJson(url, '/api/stories', {
		method: 'POST',
		body: JSON.stringify({
			title,
			description: optionalString(flags.description),
			genre: optionalString(flags.genre),
			mode: optionalString(flags.mode) || 'adventure',
			settings: flags.settings ? JSON.parse(String(flags.settings)) : undefined,
			headerPrompt: optionalString(flags.headerPrompt),
			playerReputation: optionalString(flags.playerReputation),
		}),
	});
}

async function importDatabase(url, flags) {
	const filePath = optionalString(flags.file) || optionalString(flags.input);
	if (!filePath) throw new Error('import requires --file <path>.');
	const raw = await fs.readFile(path.resolve(filePath), 'utf8');
	const parsed = JSON.parse(raw);
	const bundle = parsed && typeof parsed === 'object' && 'bundle' in parsed ? parsed.bundle : parsed;
	const preserveIds = flags.preserveIds === undefined ? true : flags.preserveIds === true;
	const replaceExisting = flags.replaceExisting === true;
	const syncWiki = flags.syncWiki === undefined ? true : flags.syncWiki === true;
	return requestJson(url, '/api/database/import', {
		method: 'POST',
		body: JSON.stringify({
			bundle,
			options: {
				preserveIds,
				replaceExisting,
				syncWiki,
				source: optionalString(flags.source),
			},
		}),
		timeoutMs: 180_000,
	});
}

async function exportDatabase(url, flags) {
	const storyId = readStoryId(flags);
	const payload = await requestJson(url, `/api/export/${encodeURIComponent(storyId)}`, { timeoutMs: 120_000 });
	const outputPath = path.resolve(String(flags.out || flags.output || defaultExportName(payload)));
	await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
	return { outputPath, storyId, bundle: payload };
}

async function syncWiki(url, flags) {
	const storyId = readStoryId(flags);
	return requestJson(url, '/api/app/jobs/wiki', {
		method: 'POST',
		body: JSON.stringify({
			storyId,
			runNow: flags.runNow !== false,
			index: flags.index === true,
			lint: flags.lint === true,
			recreate: flags.recreate === true,
		}),
		timeoutMs: 180_000,
	});
}

function defaultExportName(payload) {
	const story = asRecord(payload.worldDatabase?.story ?? payload.story);
	const title = String(story.title || story.id || 'mtherios-world')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 48) || 'mtherios-world';
	const date = new Date().toISOString().slice(0, 10);
	return `${title}-${date}.world-db.json`;
}

function readStoryId(flags) {
	const storyId = String(flags.story || flags.storyId || '').trim();
	if (!storyId) throw new Error('Missing --story <storyId>.');
	return storyId;
}

function optionalString(value) {
	if (value === undefined || value === null || value === false || value === true) return undefined;
	const clean = String(value).trim();
	return clean || undefined;
}

function asRecord(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function formatCounts(value) {
	const counts = asRecord(value);
	const entries = Object.entries(counts).filter(([, count]) => Number(count) > 0);
	if (entries.length === 0) return 'none';
	return entries.map(([key, count]) => `${key}=${count}`).join(', ');
}

async function printSchema(payload, flags, json) {
	if (flags.out || flags.output) {
		const outputPath = path.resolve(String(flags.out || flags.output));
		await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
		if (!json) console.log(`Wrote terminal world database schema to ${outputPath}`);
		return;
	}
	if (json) return printJson(payload);
	console.log('');
	console.log(`${payload.name} v${payload.schemaVersion}`);
	console.log(`  app:      ${payload.ownership?.app ?? 'terminal process'}`);
	console.log(`  database: ${payload.ownership?.database ?? 'Postgres'}`);
	console.log(`  wiki:     ${payload.ownership?.wiki ?? 'generated projection'}`);
	console.log('');
	console.log('Tables');
	for (const [name, table] of Object.entries(asRecord(payload.tables))) {
		console.log(`  ${name}: ${table.purpose ?? ''}`);
	}
	console.log('');
}

function printList(payload, json) {
	if (json) return printJson(payload);
	const stories = Array.isArray(payload.stories) ? payload.stories : [];
	console.log('');
	console.log('Terminal world databases');
	if (stories.length === 0) {
		console.log('  none');
		console.log('');
		return;
	}
	for (const story of stories) console.log(`  ${story.id}  v${story.serverVersion ?? 0}  ${story.title || 'Untitled'}`);
	console.log('');
}

function printCreated(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	console.log(`Created terminal world database ${payload.storyId}`);
	console.log(`  version: ${payload.serverVersion ?? 0}`);
	console.log('');
}

function printImported(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	console.log(`Imported terminal world database ${payload.storyId}`);
	console.log(`  version: ${payload.serverVersion ?? 0}`);
	console.log(`  counts:  ${formatCounts(payload.counts)}`);
	console.log(`  jobs:    ${payload.jobIds?.length ?? 0}`);
	console.log('');
}

function printExported(payload, json) {
	if (json) return printJson({ outputPath: payload.outputPath, storyId: payload.storyId, bundle: payload.bundle });
	const story = asRecord(payload.bundle.worldDatabase?.story ?? payload.bundle.story);
	console.log('');
	console.log(`Exported terminal world database: ${story.title || payload.storyId}`);
	console.log(`  file:    ${payload.outputPath}`);
	console.log(`  version: ${story.serverVersion ?? 0}`);
	console.log('');
}

function printWiki(payload, json) {
	if (json) return printJson(payload);
	const status = payload.job?.result?.status ?? payload.status ?? {};
	console.log('');
	console.log(`Wiki projection ${payload.ok ? 'updated' : 'queued'} for ${payload.storyId ?? status.storyId ?? 'story'}`);
	if (status.vaultPath) console.log(`  vault: ${status.vaultPath}`);
	if (status.collection) console.log(`  qdrant: ${status.collection}`);
	console.log('');
}

function printJson(value) {
	console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
	console.log(`Usage:
  npm run app:database -- schema [--out schema.json] [--json]
  npm run app:database -- list [--json]
  npm run app:database -- create --title "World name"
  npm run app:database -- export --story <storyId> [--out world-db.json]
  npm run app:database -- import --file world-db.json [--replace-existing] [--no-preserve-ids] [--no-sync-wiki]
  npm run app:database -- sync-wiki --story <storyId> [--index] [--lint] [--recreate]

General options:
  --url <url>                Running terminal app URL. Default: ${DEFAULT_URL}
  --story <id>               Terminal world database/story id.
  --file <path>              Import source.
  --out <path>               Export/schema destination.
  --replace-existing         Delete and replace an existing database with the same story id.
  --no-preserve-ids          Import into a newly generated database id.
  --no-sync-wiki             Skip generated wiki projection jobs after import.
  --json                     Print raw JSON.
`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
