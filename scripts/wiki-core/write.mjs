#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { parseArgs, requireVaultAndRest } from './lib/cli.mjs';
import { parseFrontmatter, titleFromMarkdown, toSlashPath } from './lib/vault.mjs';

const usage = `Usage:
  node scripts/wiki-core/write.mjs <vaultPath> [--path wiki/page.md|--title "Page Title"] [--mode create|replace|append] [--content-file page.md|--body "..."] [--json]

Examples:
  npm run wiki:write -- ./vault --title "House Sythar" --content-file ./draft.md --mode replace
  Get-Content ./draft.md | npm run wiki:write -- ./vault --path wiki/factions/house-sythar.md --stdin --mode replace`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath] = requireVaultAndRest(positional, usage);
const vaultRoot = path.resolve(vaultPath);
const title = cleanFlag(flags.title);
const relPath = resolveRelPath(cleanFlag(flags.path), title, cleanFlag(flags.folder));
const mode = normalizeMode(flags.mode, flags);
const now = new Date().toISOString();

await assertEditableVault(vaultRoot);
const markdown = await readMarkdown(flags);
if (!markdown.trim()) {
	console.error('Missing page markdown. Use --content-file, --body, or --stdin.');
	process.exit(1);
}

const absPath = path.resolve(vaultRoot, relPath);
assertPathInside(vaultRoot, absPath);
assertWritableRelPath(relPath, flags);

const existed = fssync.existsSync(absPath);
if (mode === 'create' && existed) {
	throw new Error(`Refusing to overwrite existing page without --mode replace or --mode append: ${relPath}`);
}
if (mode === 'replace' && !existed && flags['must-exist']) {
	throw new Error(`Cannot replace missing page: ${relPath}`);
}

const finalMarkdown = prepareMarkdown(markdown, { title, mode, existed });
const prior = existed ? await readFile(absPath, 'utf8') : '';
const contents = mode === 'append'
	? `${prior.replace(/\s*$/, '')}\n\n${finalMarkdown.trim()}\n`
	: `${finalMarkdown.trim()}\n`;

await mkdir(path.dirname(absPath), { recursive: true });
await writeFile(absPath, contents, 'utf8');
const info = await stat(absPath);
const parsed = parseFrontmatter(contents);
const pageTitle = titleFromMarkdown(relPath, parsed.body, parsed.frontmatter);

let logUpdated = false;
if (flags.log) {
	logUpdated = await appendLog(vaultRoot, String(flags.log), { relPath, title: pageTitle, mode, now });
}

const result = {
	ok: true,
	action: existed ? mode : 'create',
	mode,
	path: relPath,
	title: pageTitle,
	existed,
	bytes: Buffer.byteLength(contents, 'utf8'),
	updatedAt: info.mtime.toISOString(),
	logUpdated,
	writeId: randomUUID(),
};

if (flags.json) console.log(JSON.stringify(result, null, 2));
else {
	console.log(`Wrote ${result.title} <${result.path}>`);
	console.log(`  action: ${result.action}`);
	console.log(`  bytes:  ${result.bytes}`);
	if (logUpdated) console.log('  log:    appended');
}

async function readMarkdown(flags) {
	if (flags.stdin) return readStdin();
	if (flags['content-file']) return readFile(path.resolve(String(flags['content-file'])), 'utf8');
	if (flags.body != null && flags.body !== true) return String(flags.body);
	if (flags.markdown != null && flags.markdown !== true) return String(flags.markdown);
	return '';
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

function prepareMarkdown(markdown, { title, mode, existed }) {
	const clean = markdown.replace(/^\uFEFF/, '').trim();
	if (mode === 'append') return clean;
	if (/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(clean) || /^#\s+.+/m.test(clean) || !title || existed) {
		return clean;
	}
	return `# ${title}\n\n${clean}`;
}

function normalizeMode(value, flags) {
	if (flags.append) return 'append';
	if (flags.replace) return 'replace';
	const mode = cleanFlag(value) ?? 'create';
	if (!['create', 'replace', 'append'].includes(mode)) {
		throw new Error('--mode must be create, replace, or append.');
	}
	return mode;
}

function resolveRelPath(inputPath, title, folder) {
	const raw = inputPath || path.join(folder || 'wiki', `${slug(title || 'untitled')}.md`);
	let relPath = toSlashPath(raw.trim());
	if (!relPath.toLowerCase().endsWith('.md')) relPath = `${relPath}.md`;
	if (!relPath || relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) {
		throw new Error(`Page path must be relative to the vault: ${raw}`);
	}
	const normalized = toSlashPath(path.posix.normalize(relPath));
	if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
		throw new Error(`Page path must stay inside the vault: ${raw}`);
	}
	return normalized;
}

function assertWritableRelPath(relPath, flags) {
	const parts = relPath.split('/');
	const top = parts[0]?.toLowerCase();
	if (!top || top.startsWith('.')) throw new Error(`Refusing to write hidden/system path: ${relPath}`);
	if (['.git', '.obsidian', '.mtherios', 'node_modules'].includes(top)) {
		throw new Error(`Refusing to write system path: ${relPath}`);
	}
	if (top === 'raw' && !flags['allow-raw']) {
		throw new Error('Refusing to write raw sources through page write. Use a source ingest flow instead.');
	}
}

async function assertEditableVault(root) {
	assertPathInside(path.resolve(root), root);
	if (fssync.existsSync(path.join(root, '.mtherios', 'story-vault.json'))) {
		throw new Error('Refusing to edit a generated story vault. Mutate the terminal world database or use a standalone vault.');
	}
	await mkdir(root, { recursive: true });
}

async function appendLog(root, message, info) {
	const logPath = path.join(root, 'log.md');
	assertPathInside(root, logPath);
	const heading = `## [${info.now.slice(0, 10)}] write | ${info.title}`;
	const entry = [
		'',
		heading,
		`- Path: ${info.relPath}`,
		`- Mode: ${info.mode}`,
		`- Note: ${message}`,
		'',
	].join('\n');
	const prior = fssync.existsSync(logPath) ? await readFile(logPath, 'utf8') : '# Log\n';
	await writeFile(logPath, `${prior.replace(/\s*$/, '')}${entry}`, 'utf8');
	return true;
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
