#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { parseArgs, requireVaultAndRest } from './lib/cli.mjs';

const usage = `Usage:
  node scripts/wiki-core/ingest.mjs <vaultPath> --source-file article.md [--title "Article Title"] [--source-url URL] [--source-type article] [--tags a,b] [--json]

Examples:
  npm run wiki:ingest -- ./vault --source-file ./clips/article.md --title "Glassmarket Debt Records"
  Get-Content ./clips/article.md | npm run wiki:ingest -- ./vault --stdin --title "Glassmarket Debt Records"`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath] = requireVaultAndRest(positional, usage);
const vaultRoot = path.resolve(vaultPath);
const now = new Date().toISOString();

await assertEditableVault(vaultRoot);
const source = await readSource(flags);
if (!source.content.trim()) {
	console.error('Missing source content. Use --source-file, --body, --markdown, or --stdin.');
	process.exit(1);
}

const title = cleanFlag(flags.title) || inferTitle(source.content, source.name);
const sourceType = cleanFlag(flags['source-type']) || cleanFlag(flags.type) || 'source';
const tags = normalizeTags(flags.tags ?? flags.tag);
const hash = createHash('sha256').update(source.content).digest('hex');
const datePrefix = cleanFlag(flags.date) || now.slice(0, 10);
const relPath = resolveSourcePath(cleanFlag(flags.path), title, hash, datePrefix);
const absPath = path.resolve(vaultRoot, relPath);
assertPathInside(vaultRoot, absPath);

const existed = fssync.existsSync(absPath);
if (existed && !flags.force) {
	const existing = await stat(absPath);
	const result = {
		ok: true,
		action: 'exists',
		path: relPath,
		title,
		sourceHash: hash,
		bytes: existing.size,
		updatedAt: existing.mtime.toISOString(),
		logUpdated: false,
		indexUpdated: false,
		ingestId: randomUUID(),
	};
	printResult(result);
	process.exit(0);
}

const markdown = renderRawSource({
	title,
	sourceType,
	tags,
	source,
	hash,
	now,
	url: cleanFlag(flags['source-url']) || cleanFlag(flags.url),
	author: cleanFlag(flags.author),
	published: cleanFlag(flags.published) || cleanFlag(flags.date),
});

await mkdir(path.dirname(absPath), { recursive: true });
await writeFile(absPath, markdown, 'utf8');
const info = await stat(absPath);
const indexUpdated = flags.index !== false && flags['no-index'] !== true
	? await updateIndex(vaultRoot, { title, relPath, sourceType, now })
	: false;
const logUpdated = flags.log !== false && flags['no-log'] !== true
	? await appendLog(vaultRoot, { title, relPath, sourceType, now, note: cleanFlag(flags.note) })
	: false;

printResult({
	ok: true,
	action: existed ? 'replace' : 'ingest',
	path: relPath,
	title,
	sourceType,
	sourceHash: hash,
	bytes: info.size,
	updatedAt: info.mtime.toISOString(),
	indexUpdated,
	logUpdated,
	ingestId: randomUUID(),
});

async function readSource(flags) {
	if (flags.stdin) return { name: cleanFlag(flags['source-name']) || 'stdin', content: await readStdin() };
	if (flags['source-file']) {
		const sourcePath = path.resolve(String(flags['source-file']));
		return {
			name: cleanFlag(flags['source-name']) || path.basename(sourcePath),
			path: sourcePath,
			content: await readFile(sourcePath, 'utf8'),
		};
	}
	if (flags.body != null && flags.body !== true) return { name: cleanFlag(flags['source-name']) || 'body', content: String(flags.body) };
	if (flags.markdown != null && flags.markdown !== true) return { name: cleanFlag(flags['source-name']) || 'markdown', content: String(flags.markdown) };
	if (flags.content != null && flags.content !== true) return { name: cleanFlag(flags['source-name']) || 'content', content: String(flags.content) };
	return { name: cleanFlag(flags['source-name']) || 'source', content: '' };
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

function renderRawSource({ title, sourceType, tags, source, hash, now, url, author, published }) {
	const frontmatter = {
		title,
		type: 'raw_source',
		sourceType,
		sourceName: source.name,
		sourceUrl: url,
		author,
		published,
		sourceHash: hash,
		ingestedAt: now,
		tags,
	};
	return [
		renderFrontmatter(frontmatter),
		`# ${title}`,
		'',
		'## Source Metadata',
		`- Source type: ${sourceType}`,
		source.name ? `- Source name: ${source.name}` : '',
		url ? `- URL: ${url}` : '',
		author ? `- Author: ${author}` : '',
		published ? `- Published: ${published}` : '',
		`- SHA-256: ${hash}`,
		`- Ingested: ${now}`,
		'',
		'## Source Text',
		'',
		source.content.replace(/^\uFEFF/, '').trim(),
		'',
	].filter((line) => line !== '').join('\n');
}

function renderFrontmatter(values) {
	const lines = ['---'];
	for (const [key, value] of Object.entries(values)) {
		if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	lines.push('---', '');
	return lines.join('\n');
}

async function updateIndex(root, source) {
	const indexPath = path.join(root, 'index.md');
	assertPathInside(root, indexPath);
	const link = `[[${source.title}]]`;
	const bullet = `- ${link} (${source.sourceType}) - ${source.relPath}`;
	const prior = fssync.existsSync(indexPath) ? await readFile(indexPath, 'utf8') : '# Index\n';
	if (prior.includes(source.relPath) || prior.includes(link)) return false;
	const heading = '## Raw Sources';
	const next = prior.includes(heading)
		? prior.replace(heading, `${heading}\n${bullet}`)
		: `${prior.replace(/\s*$/, '')}\n\n${heading}\n${bullet}\n`;
	await writeFile(indexPath, next, 'utf8');
	return true;
}

async function appendLog(root, source) {
	const logPath = path.join(root, 'log.md');
	assertPathInside(root, logPath);
	const prior = fssync.existsSync(logPath) ? await readFile(logPath, 'utf8') : '# Log\n';
	const entry = [
		'',
		`## [${source.now.slice(0, 10)}] ingest | ${source.title}`,
		`- Path: ${source.relPath}`,
		`- Source type: ${source.sourceType}`,
		source.note ? `- Note: ${source.note}` : '',
		'',
	].filter(Boolean).join('\n');
	await writeFile(logPath, `${prior.replace(/\s*$/, '')}${entry}`, 'utf8');
	return true;
}

function inferTitle(content, sourceName) {
	const heading = content.replace(/^\uFEFF/, '').match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return heading;
	const clean = sourceName.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
	return clean || 'Untitled Source';
}

function resolveSourcePath(inputPath, title, hash, datePrefix) {
	const raw = inputPath || path.posix.join('raw', 'sources', `${datePrefix}-${slug(title)}--${hash.slice(0, 8)}.md`);
	let relPath = raw.trim().replace(/\\/g, '/');
	if (!relPath.toLowerCase().endsWith('.md')) relPath = `${relPath}.md`;
	if (!relPath.startsWith('raw/sources/')) {
		throw new Error('Source ingest writes only under raw/sources/.');
	}
	const normalized = path.posix.normalize(relPath);
	if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
		throw new Error(`Source path must stay inside the vault: ${raw}`);
	}
	return normalized;
}

async function assertEditableVault(root) {
	assertPathInside(path.resolve(root), root);
	if (fssync.existsSync(path.join(root, '.mtherios', 'story-vault.json'))) {
		throw new Error('Refusing to ingest into a generated story vault. Add story evidence through the terminal world database.');
	}
	await mkdir(root, { recursive: true });
}

function normalizeTags(value) {
	if (value === undefined || value === null || value === true || value === false) return [];
	if (Array.isArray(value)) return value.map(cleanTag).filter(Boolean);
	return String(value).split(',').map(cleanTag).filter(Boolean);
}

function cleanTag(value) {
	return String(value ?? '').trim().replace(/^\[|\]$/g, '').replace(/^["']|["']$/g, '');
}

function cleanFlag(value) {
	if (value === undefined || value === null || value === false || value === true) return null;
	const clean = String(value).trim();
	return clean || null;
}

function slug(value) {
	return String(value || 'untitled')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 90) || 'untitled';
}

function assertPathInside(parent, child) {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
	throw new Error(`Refusing to write outside ${parent}: ${child}`);
}

function printResult(value) {
	if (flags.json) console.log(JSON.stringify(value, null, 2));
	else {
		console.log(`Ingested ${value.title} <${value.path}>`);
		console.log(`  action: ${value.action}`);
		console.log(`  hash:   ${value.sourceHash}`);
		console.log(`  bytes:  ${value.bytes}`);
		if (value.indexUpdated) console.log('  index:  updated');
		if (value.logUpdated) console.log('  log:    appended');
	}
}
