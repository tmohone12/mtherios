#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.PORT || '5173';
const DEFAULT_URL = process.env.MTHERIOS_APP_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const BOOLEAN_FLAGS = new Set([
	'all',
	'allowRaw',
	'append',
	'clean',
	'dryRun',
	'exact',
	'force',
	'includeFresh',
	'index',
	'json',
	'lint',
	'orphans',
	'recreate',
	'replace',
	'runNow',
	'stdin',
]);

async function main(argv = process.argv.slice(2)) {
	const { command, flags, positional } = parseArgs(argv);
	const url = String(flags.url || DEFAULT_URL).replace(/\/$/, '');
	const json = flags.json === true;

	switch (command) {
		case 'stories':
			return printStories(await requestJson(url, '/api/stories'), json);
		case 'status':
			return printStatus(await loadStatus(url, flags), json);
		case 'init':
			return printInit(await initWikiVault(url, flags), json);
		case 'sync':
			return printJob(await runStoryWikiJob(url, command, flags), json);
		case 'archive':
		case 'export':
			return printArchive(await archiveStoryWiki(url, flags), json);
		case 'index':
			return printIndexOrJob(await runWikiIndex(url, flags), json);
		case 'lint':
			return printLintOrJob(await runWikiLint(url, flags), json);
		case 'ingest':
		case 'ingest-source':
		case 'source':
			return printIngest(await ingestSource(url, flags), json);
		case 'pages':
			return printPages(await loadPages(url, flags), json);
		case 'write':
		case 'put':
			return printWrite(await writePage(url, flags, positional), json);
		case 'search':
			return printSearch(await loadSearch(url, flags, positional), json);
		case 'brief':
		case 'agent':
			return printBrief(await loadBrief(url, flags, positional), json);
		case 'follow':
			return printFollow(await loadFollow(url, flags, positional), json);
		case 'page':
		case 'show':
			return printPage(await loadPage(url, flags, positional), json);
		case 'context':
			return printContext(await loadContext(url, flags, positional), json);
		case 'help':
		case undefined:
			return printHelp();
		default:
			throw new Error(`Unknown app wiki command: ${command}`);
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
		if (key.startsWith('no') && key.length > 2 && key[2] === key[2].toUpperCase()) {
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

async function requestJson(baseUrl, path, options = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		...options,
		headers: {
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
			...(options.headers ?? {}),
		},
		signal: AbortSignal.timeout(Number(options.timeoutMs ?? 30_000)),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status} ${path}`);
	}
	return body;
}

async function loadStatus(url, flags) {
	const storyId = readStoryId(flags, false);
	if (!storyId) return requestJson(url, '/api/wiki/status');
	return requestJson(url, `/api/wiki/story-vault/status?storyId=${encodeURIComponent(storyId)}`);
}

async function runStoryWikiJob(url, command, flags) {
	const all = flags.all === true;
	const storyId = readStoryId(flags, !all);
	return requestJson(url, '/api/app/jobs/wiki', {
		method: 'POST',
		body: JSON.stringify({
			storyId,
			all,
			runNow: all ? flags.runNow === true : flags.runNow !== false,
			index: command === 'index' || flags.index === true,
			lint: command === 'lint' || flags.lint === true,
			recreate: flags.recreate === true,
			dryRun: flags.dryRun === true,
			clean: flags.clean !== false,
			includeFresh: flags.includeFresh === true,
			thinChars: readNumber(flags.thinChars),
			orphanLayer: flags.orphanLayer === 'all' ? 'all' : 'derived',
			provider: optionalString(flags.provider),
			model: optionalString(flags.model),
			limit: readNumber(flags.limit),
		}),
		timeoutMs: all ? 10 * 60_000 : 180_000,
	});
}

async function archiveStoryWiki(url, flags) {
	const storyId = readStoryId(flags, true);
	const params = new URLSearchParams({ storyId });
	const response = await fetch(`${url}/api/wiki/story-vault/archive?${params.toString()}`, {
		signal: AbortSignal.timeout(180_000),
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status} /api/wiki/story-vault/archive`);
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	const headerFilename = filenameFromDisposition(response.headers.get('content-disposition'));
	const outputPath = path.resolve(String(flags.out || flags.output || headerFilename || `${storyId}.wiki.zip`));
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(outputPath, bytes);
	return {
		storyId,
		path: outputPath,
		bytes: bytes.length,
		serverVersion: response.headers.get('x-mtherios-server-version'),
		materialized: response.headers.get('x-mtherios-vault-materialized') === 'true',
	};
}

async function runWikiIndex(url, flags) {
	const storyId = readStoryId(flags, false);
	if (storyId) return runStoryWikiJob(url, 'index', flags);
	return {
		direct: true,
		result: await requestJson(url, '/api/wiki/index', {
			method: 'POST',
			body: JSON.stringify({
				...wikiTargetPayload(flags),
				recreate: flags.recreate === true,
				dryRun: flags.dryRun === true,
				provider: optionalString(flags.provider),
				model: optionalString(flags.model),
				maxChars: readNumber(flags.maxChars),
				overlapChars: readNumber(flags.overlapChars),
			}),
			timeoutMs: 10 * 60_000,
		}),
	};
}

async function runWikiLint(url, flags) {
	const storyId = readStoryId(flags, false);
	if (storyId) return runStoryWikiJob(url, 'lint', flags);
	return {
		direct: true,
		result: await requestJson(url, '/api/wiki/lint', {
			method: 'POST',
			body: JSON.stringify({
				...wikiTargetPayload(flags),
				thinChars: readNumber(flags.thinChars),
				orphanLayer: flags.orphanLayer === 'all' ? 'all' : 'derived',
			}),
			timeoutMs: 120_000,
		}),
	};
}

async function initWikiVault(url, flags) {
	return requestJson(url, '/api/wiki/init', {
		method: 'POST',
		body: JSON.stringify({
			...wikiTargetPayload(flags),
			title: optionalString(flags.title),
			description: optionalString(flags.description),
			owner: optionalString(flags.owner),
			force: flags.force === true,
			status: flags.status === true,
		}),
		timeoutMs: 120_000,
	});
}

async function loadPages(url, flags) {
	return requestJson(url, '/api/wiki/pages', {
		method: 'POST',
		body: JSON.stringify({
			...wikiTargetPayload(flags),
			layer: optionalString(flags.layer),
			type: optionalString(flags.type),
			tag: optionalString(flags.tag),
			orphans: flags.orphans === true,
			limit: readNumber(flags.limit),
			sort: optionalString(flags.sort),
		}),
		timeoutMs: 120_000,
	});
}

async function ingestSource(url, flags) {
	const markdown = await readSourceMarkdown(flags);
	if (!markdown.trim()) throw new Error('ingest requires --source-file, --body, --markdown, --content, or --stdin.');
	return requestJson(url, '/api/wiki/ingest', {
		method: 'POST',
		body: JSON.stringify({
			...wikiTargetPayload(flags),
			title: optionalString(flags.title),
			sourceName: optionalString(flags.sourceName) || inferSourceName(flags.sourceFile),
			sourceUrl: optionalString(flags.sourceUrl || flags.urlSource),
			sourceType: optionalString(flags.sourceType || flags.type),
			author: optionalString(flags.author),
			published: optionalString(flags.published),
			date: optionalString(flags.date),
			tags: optionalString(flags.tags || flags.tag),
			path: optionalString(flags.path),
			note: optionalString(flags.note),
			index: flags.index === false ? false : undefined,
			log: flags.log === false ? false : undefined,
			force: flags.force === true,
			markdown,
		}),
		timeoutMs: 120_000,
	});
}

async function writePage(url, flags, positional) {
	const title = optionalString(flags.title || flags.page) || (!flags.path ? optionalString(positional.join(' ')) : undefined);
	const markdown = await readWriteMarkdown(flags);
	if (!markdown.trim()) throw new Error('write requires --content-file, --body, --markdown, --content, or --stdin.');
	const mode = flags.replace === true
		? 'replace'
		: flags.append === true
			? 'append'
			: optionalString(flags.mode) || 'create';
	return requestJson(url, '/api/wiki/write', {
		method: 'POST',
		body: JSON.stringify({
			...wikiTargetPayload(flags),
			path: optionalString(flags.path),
			title,
			folder: optionalString(flags.folder),
			mode,
			markdown,
			log: optionalString(flags.log),
			allowRaw: flags.allowRaw === true,
		}),
		timeoutMs: 120_000,
	});
}

async function loadSearch(url, flags, positional) {
	const query = String(flags.query || positional.join(' ')).trim();
	if (!query) throw new Error('search requires a query.');
	return requestJson(url, '/api/wiki/search', {
		method: 'POST',
		body: JSON.stringify({
			...wikiTargetPayload(flags),
			query,
			limit: readNumber(flags.limit),
			followDepth: readNumber(flags.followDepth),
			exact: flags.exact === true,
			provider: optionalString(flags.provider),
			model: optionalString(flags.model),
		}),
		timeoutMs: 120_000,
	});
}

async function loadContext(url, flags, positional) {
	const query = String(flags.query || positional.join(' ')).trim();
	if (!query) throw new Error('context requires a query.');
	return requestJson(url, '/api/wiki/context', {
		method: 'POST',
		body: JSON.stringify({
			...wikiTargetPayload(flags),
			query,
			limit: readNumber(flags.limit),
			followDepth: readNumber(flags.followDepth),
			pageLimit: readNumber(flags.pageLimit),
			pageChars: readNumber(flags.pageChars),
			maxChars: readNumber(flags.maxChars),
			exact: flags.exact === true,
		}),
		timeoutMs: 120_000,
	});
}

async function loadBrief(url, flags, positional) {
	const query = String(flags.query || flags.task || positional.join(' ')).trim();
	if (!query) throw new Error('brief requires a task or query.');
	return requestJson(url, '/api/wiki/brief', {
		method: 'POST',
		body: JSON.stringify({
			...wikiTargetPayload(flags),
			query,
			mode: optionalString(flags.mode),
			limit: readNumber(flags.limit),
			followDepth: readNumber(flags.followDepth),
			pageLimit: readNumber(flags.pageLimit),
			pageChars: readNumber(flags.pageChars),
			maxChars: readNumber(flags.maxChars),
			inventoryLimit: readNumber(flags.inventoryLimit),
			thinChars: readNumber(flags.thinChars),
			orphanLayer: flags.orphanLayer === 'all' ? 'all' : 'derived',
			exact: flags.exact === true,
			provider: optionalString(flags.provider),
			model: optionalString(flags.model),
		}),
		timeoutMs: 120_000,
	});
}

async function loadFollow(url, flags, positional) {
	const page = String(flags.page || flags.path || flags.title || positional.join(' ')).trim();
	if (!page) throw new Error('follow requires a page title or path.');
	return requestJson(url, '/api/wiki/follow', {
		method: 'POST',
		body: JSON.stringify({
			...wikiTargetPayload(flags),
			page,
			depth: readNumber(flags.depth),
		}),
		timeoutMs: 120_000,
	});
}

async function loadPage(url, flags, positional) {
	const page = String(flags.page || flags.path || flags.title || positional.join(' ')).trim();
	if (!page) throw new Error('page requires a page title or path.');
	return requestJson(url, '/api/wiki/page', {
		method: 'POST',
		body: JSON.stringify({
			...wikiTargetPayload(flags),
			page,
		}),
		timeoutMs: 120_000,
	});
}

function wikiTargetPayload(flags) {
	return {
		storyId: optionalString(flags.story || flags.storyId),
		vaultPath: optionalString(flags.vault || flags.vaultPath),
		collection: optionalString(flags.collection),
	};
}

function readStoryId(flags, required) {
	const value = String(flags.story || flags.storyId || '').trim();
	if (!value && required) throw new Error('Missing --story <storyId>.');
	return value;
}

function readNumber(value) {
	if (value === undefined || value === null || value === false || value === true) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalString(value) {
	if (value === undefined || value === null || value === false || value === true) return undefined;
	const clean = String(value).trim();
	return clean || undefined;
}

function filenameFromDisposition(contentDisposition) {
	if (!contentDisposition) return null;
	const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition);
	if (!match?.[1]) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}

async function readWriteMarkdown(flags) {
	if (flags.stdin === true) return readStdin();
	if (flags.contentFile) return fs.readFile(String(flags.contentFile), 'utf8');
	if (flags.body !== undefined && flags.body !== true) return String(flags.body);
	if (flags.markdown !== undefined && flags.markdown !== true) return String(flags.markdown);
	if (flags.content !== undefined && flags.content !== true) return String(flags.content);
	return '';
}

async function readSourceMarkdown(flags) {
	if (flags.sourceFile) return fs.readFile(String(flags.sourceFile), 'utf8');
	return readWriteMarkdown(flags);
}

function inferSourceName(value) {
	if (!value || value === true) return undefined;
	const parts = String(value).replace(/\\/g, '/').split('/');
	return parts[parts.length - 1] || undefined;
}

function readStdin() {
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk) => {
			data += chunk;
		});
		process.stdin.on('end', () => resolve(data));
		process.stdin.on('error', reject);
	});
}

function printStories(payload, json) {
	if (json) return printJson(payload);
	const stories = Array.isArray(payload.stories) ? payload.stories : [];
	console.log('');
	console.log('Mtherios terminal world databases');
	if (stories.length === 0) {
		console.log('  no stories found in the terminal database');
		console.log('');
		return;
	}
	for (const story of stories) {
		console.log(`  ${story.id}  v${story.serverVersion ?? 0}  ${story.title || 'Untitled'}`);
	}
	console.log('');
}

function printStatus(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	if (payload.storyId) {
		const lint = payload.lint ?? {};
		console.log(`Story wiki: ${payload.storyTitle || payload.storyId}`);
		console.log(`  story:    ${payload.storyId}`);
		console.log(`  vault:    ${freshLabel(payload.vaultFresh, payload.exists)}`);
		console.log(`  qdrant:   ${freshLabel(payload.indexFresh, Boolean(payload.indexedVersion))}`);
		console.log(`  health:   ${lintLabel(lint)}`);
		console.log(`  version:  backend v${payload.serverVersion ?? 0}, indexed v${payload.indexedVersion ?? '-'}`);
		console.log(`  path:     ${payload.vaultPath}`);
	} else {
		console.log('Mtherios wiki runtime');
		console.log(`  vaults:   ${payload.vaultRoot || 'unknown'}`);
		console.log(`  default:  ${payload.defaultVault || 'unknown'}${payload.defaultVaultExists ? '' : ' (missing)'}`);
		console.log(`  qdrant:   ${payload.qdrantUrl || 'unknown'} / ${payload.qdrantCollection || 'unknown'}`);
		console.log(`  embed:    ${payload.embedding?.provider || 'unknown'} / ${payload.embedding?.model || 'unknown'}`);
	}
	console.log('');
}

function printJob(payload, json) {
	if (json) return printJson(payload);
	if (payload.mode === 'bulk') return printBulkJob(payload);
	const status = payload.job?.result?.status ?? payload.status;
	console.log('');
	console.log(`Wiki job ${payload.ok ? 'completed' : 'failed'}: ${payload.jobId}`);
	if (payload.job?.error) console.log(`  error:    ${payload.job.error}`);
	if (status) {
		console.log(`  story:    ${status.storyId}`);
		console.log(`  vault:    ${freshLabel(status.vaultFresh, status.exists)}`);
		console.log(`  qdrant:   ${freshLabel(status.indexFresh, Boolean(status.indexedVersion))}`);
		console.log(`  health:   ${lintLabel(status.lint ?? {})}`);
		console.log(`  path:     ${status.vaultPath}`);
	}
	console.log('');
}

function printArchive(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	console.log('Wiki archive exported');
	console.log(`  story:    ${payload.storyId}`);
	console.log(`  file:     ${payload.path}`);
	console.log(`  bytes:    ${payload.bytes}`);
	if (payload.serverVersion) console.log(`  version:  backend v${payload.serverVersion}`);
	console.log(`  vault:    ${payload.materialized ? 'refreshed before export' : 'already fresh'}`);
	console.log('');
}

function printBulkJob(payload) {
	const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
	console.log('');
	console.log(`Wiki bulk job ${payload.ok ? 'queued' : 'failed'}: selected ${payload.selected ?? jobs.length}, queued ${payload.queued ?? jobs.length}`);
	console.log(`  run now:  ${payload.runNow ? 'yes' : 'no'}`);
	if (jobs.length > 0) {
		console.log('  jobs:');
		for (const row of jobs.slice(0, 12)) {
			const job = row.job;
			const status = job ? (job.completed ? 'completed' : 'failed') : 'queued';
			const error = job?.error ? ` - ${job.error}` : '';
			console.log(`    ${status} ${row.storyTitle || row.storyId}: ${row.jobId}${error}`);
		}
		if (jobs.length > 12) console.log(`    ...${jobs.length - 12} more`);
	}
	const after = payload.after ?? {};
	if (after.total !== undefined) {
		console.log(`  backlog: total=${after.total ?? 0} ready=${after.ready ?? 0} retry=${after.retry ?? 0} running=${after.running ?? 0} delayed=${after.delayed ?? 0} failed=${after.failed ?? 0}`);
	}
	console.log('');
}

function printIndexOrJob(payload, json) {
	if (!payload.direct) return printJob(payload, json);
	if (json) return printJson(payload.result);
	console.log('');
	console.log(`Wiki index ${payload.result?.ok ? 'completed' : 'failed'}`);
	if (payload.result?.output) {
		console.log(`  ${String(payload.result.output).trim().split(/\r?\n/).slice(-3).join('\n  ')}`);
	}
	console.log('');
}

function printLintOrJob(payload, json) {
	if (!payload.direct) return printJob(payload, json);
	if (json) return printJson(payload.result);
	const summary = payload.result?.summary ?? {};
	console.log('');
	console.log(`Wiki lint: ${payload.result?.ok ? 'ok' : 'issues found'}`);
	console.log(`  pages:      ${summary.pageCount ?? '?'}`);
	console.log(`  issues:     ${summary.issueCount ?? '?'}`);
	console.log(`  duplicates: ${summary.duplicateTitles ?? '?'}`);
	console.log(`  broken:     ${summary.brokenLinks ?? '?'}`);
	console.log(`  orphans:    ${summary.orphanPages ?? '?'}`);
	console.log(`  thin:       ${summary.thinPages ?? '?'}`);
	console.log('');
}

function printPages(payload, json) {
	if (json) return printJson(payload);
	const pages = Array.isArray(payload.pages) ? payload.pages : [];
	const filters = payload.filters ?? {};
	console.log('');
	console.log(`Wiki pages: ${payload.returnedCount ?? pages.length}/${payload.pageCount ?? pages.length}`);
	if (filters.layer || filters.type || filters.tag || filters.orphans) {
		console.log(`  filters: ${[
			filters.layer ? `layer=${filters.layer}` : '',
			filters.type ? `type=${filters.type}` : '',
			filters.tag ? `tag=${filters.tag}` : '',
			filters.orphans ? 'orphans' : '',
		].filter(Boolean).join(', ')}`);
	}
	for (const page of pages.slice(0, 80)) {
		console.log(`  ${page.title || page.path} <${page.path}>`);
		console.log(`     layer ${page.layer || 'unknown'} | type ${page.type || '-'} | links ${page.linkCount ?? 0} | backlinks ${page.backlinkCount ?? 0} | chars ${page.textChars ?? 0}`);
	}
	if (pages.length > 80) console.log(`  ... ${pages.length - 80} more omitted from display; use --json for all returned pages`);
	console.log('');
}

function printInit(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	if (payload && typeof payload === 'object' && 'initialized' in payload) {
		console.log(`Wiki vault: ${payload.manifest?.title || payload.root}`);
		console.log(`  root:        ${payload.root}`);
		console.log(`  initialized: ${payload.initialized ? 'yes' : 'no'}`);
		for (const file of payload.files ?? []) {
			console.log(`  file:        ${file.exists ? 'ok' : 'missing'} ${file.path}`);
		}
		for (const directory of payload.directories ?? []) {
			console.log(`  dir:         ${directory.exists ? 'ok' : 'missing'} ${directory.path}`);
		}
		console.log('');
		return;
	}
	console.log(`Wiki init: ${payload.title || payload.root || 'vault'}`);
	console.log(`  action:  ${payload.action || 'initialized'}`);
	console.log(`  root:    ${payload.root || '-'}`);
	console.log(`  created: ${(payload.created ?? []).length ? payload.created.join(', ') : '-'}`);
	console.log(`  updated: ${(payload.updated ?? []).length ? payload.updated.join(', ') : '-'}`);
	console.log(`  kept:    ${(payload.kept ?? []).length}`);
	console.log('');
}

function printIngest(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	console.log(`Wiki ingest: ${payload.title || payload.path || 'source'} <${payload.path || '-'}>`);
	console.log(`  action: ${payload.action || 'ingest'}`);
	console.log(`  hash:   ${payload.sourceHash || '-'}`);
	console.log(`  bytes:  ${payload.bytes ?? '?'}`);
	if (payload.indexUpdated) console.log('  index:  updated');
	if (payload.logUpdated) console.log('  log:    appended');
	console.log('');
}

function printWrite(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	console.log(`Wiki write: ${payload.title || payload.path || 'page'} <${payload.path || '-'}>`);
	console.log(`  action: ${payload.action || payload.mode || 'write'}`);
	console.log(`  bytes:  ${payload.bytes ?? '?'}`);
	if (payload.logUpdated) console.log('  log:    appended');
	console.log('');
}

function printSearch(payload, json) {
	if (json) return printJson(payload);
	const results = Array.isArray(payload.results) ? payload.results : [];
	console.log('');
	console.log(`Wiki search: ${payload.query || ''}`);
	if (payload.semanticError) {
		console.log(`  semantic fallback: ${payload.semanticError}`);
	}
	if (results.length === 0) {
		console.log('  no matching pages');
		console.log('');
		return;
	}
	for (const [index, row] of results.entries()) {
		console.log(`  ${index + 1}. ${row.title || row.path} <${row.path}>`);
		console.log(`     score ${formatScore(row.score)} | layer ${row.layer || 'unknown'}`);
		if (row.text) console.log(`     ${snippet(row.text, 220)}`);
		const neighbors = Array.isArray(row.neighbors) ? row.neighbors : [];
		if (neighbors.length > 0) {
			console.log(`     follows: ${neighbors.slice(0, 4).map((node) => `${node.title} <${node.path}>`).join('; ')}`);
		}
	}
	console.log('');
}

function printContext(payload, json) {
	if (json) return printJson(payload);
	if (typeof payload.contextMarkdown === 'string' && payload.contextMarkdown.trim()) {
		console.log(payload.contextMarkdown.trim());
		return;
	}
	const pages = Array.isArray(payload.pages) ? payload.pages : [];
	console.log('');
	console.log(`Wiki context pages: ${pages.length}`);
	for (const page of pages.slice(0, 12)) {
		console.log(`  ${page.title || page.path} <${page.path}>`);
	}
	console.log('');
}

function printBrief(payload, json) {
	if (json) return printJson(payload);
	if (typeof payload.briefMarkdown === 'string' && payload.briefMarkdown.trim()) {
		console.log(payload.briefMarkdown.trim());
		return;
	}
	console.log('');
	console.log(`Wiki brief: ${payload.task || ''}`);
	console.log(`  mode:  ${payload.mode || 'maintain'}`);
	console.log(`  pages: ${payload.context?.pageCount ?? '?'}`);
	console.log(`  lint:  ${payload.lint?.ok ? 'ok' : 'issues found'}`);
	console.log('');
}

function printFollow(payload, json) {
	if (json) return printJson(payload);
	const start = payload.start ?? {};
	const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
	const edges = Array.isArray(payload.edges) ? payload.edges : [];
	console.log('');
	console.log(`Wiki graph: ${start.title || start.path || 'unknown'} <${start.path || '-'}>`);
	console.log(`  nodes: ${nodes.length}`);
	console.log(`  edges: ${edges.length}`);
	for (const node of nodes.slice(0, 30)) {
		console.log(`  d${node.distance ?? '?'} ${node.title || node.path} <${node.path}>`);
	}
	console.log('');
}

function printPage(payload, json) {
	if (json) return printJson(payload);
	const markdown = String(payload.markdown || '').trim();
	console.log('');
	console.log(`Wiki page: ${payload.title || payload.path || 'unknown'} <${payload.path || '-'}>`);
	if (payload.updatedAt) console.log(`  updated: ${payload.updatedAt}`);
	const links = Array.isArray(payload.links) ? payload.links : [];
	const backlinks = Array.isArray(payload.backlinks) ? payload.backlinks : [];
	if (links.length > 0) console.log(`  links: ${links.join(', ')}`);
	if (backlinks.length > 0) console.log(`  backlinks: ${backlinks.join(', ')}`);
	console.log('');
	console.log(markdown || '(empty page)');
	console.log('');
}

function freshLabel(fresh, exists) {
	if (fresh) return 'fresh';
	return exists ? 'stale' : 'missing';
}

function lintLabel(lint) {
	if (!lint.exists) return 'not run';
	const issueCount = typeof lint.issueCount === 'number' ? lint.issueCount : '?';
	if (!lint.fresh) return `stale, ${issueCount} issue(s)`;
	if (lint.ok === true) return 'healthy';
	if (lint.ok === false) return `${issueCount} issue(s)`;
	return `recorded, ${issueCount} issue(s)`;
}

function formatScore(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number.toFixed(3) : '-';
}

function snippet(value, max) {
	const clean = String(value).replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function printJson(value) {
	console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
	console.log(`Usage:
  npm run app:wiki -- stories [--json]
  npm run app:wiki -- status [--story <storyId>] [--json]
  npm run app:wiki -- init [--vault <path>] [--title "Vault Title"] [--status] [--force]
  npm run app:wiki -- sync --story <storyId> [--index] [--lint] [--no-run-now]
  npm run app:wiki -- sync --all [--index] [--lint] [--run-now]
  npm run app:wiki -- archive --story <storyId> [--out story.wiki.zip]
  npm run app:wiki -- index [--story <storyId>|--vault <path>] [--collection <name>] [--recreate]
  npm run app:wiki -- lint [--story <storyId>|--vault <path>] [--thin-chars 240] [--orphan-layer derived|all]
  npm run app:wiki -- ingest [--vault <path>] --source-file article.md [--title "Article Title"] [--tags a,b]
  npm run app:wiki -- pages [--story <storyId>|--vault <path>] [--layer wiki] [--orphans] [--json]
  npm run app:wiki -- write [--vault <path>] --title "Page Title" --content-file page.md [--mode create|replace|append] [--log "..."]
  npm run app:wiki -- search [--story <storyId>|--vault <path>] "query" [--follow-depth 1] [--exact] [--json]
  npm run app:wiki -- brief [--story <storyId>|--vault <path>] "task or query" [--mode maintain|answer|ingest|lint|explore] [--json]
  npm run app:wiki -- follow [--story <storyId>|--vault <path>] "Page Title" [--depth 2] [--json]
  npm run app:wiki -- page [--story <storyId>|--vault <path>] "Page Title" [--json]
  npm run app:wiki -- context [--story <storyId>|--vault <path>] "query" [--follow-depth 2] [--json]

Options:
  --url <url>       Running Mtherios terminal app URL. Default: ${DEFAULT_URL}
  --story <id>      Terminal world database/story id.
  --vault <path>    Vault under the configured vault root. Omit story/vault to use the default vault.
  --collection <n>  Qdrant collection override for non-story vaults.
  --out <path>      Output path for archive/export commands.
  --title <text>    Vault title for init, source title for ingest, or page title for write/page.
  --description <t> Vault description for init.
  --source-file <p> Markdown/text source file to ingest into raw/sources.
  --content-file <p> Markdown file to write for app:wiki write.
  --stdin           Read markdown from stdin for app:wiki write.
  --json            Print raw JSON.
`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
