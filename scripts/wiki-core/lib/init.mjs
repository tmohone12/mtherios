import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { toSlashPath } from './vault.mjs';

const DEFAULT_DIRS = [
	'raw/sources',
	'raw/assets',
	'wiki',
	'wiki/entities',
	'wiki/concepts',
	'wiki/synthesis',
	'.obsidian',
	'.mtherios',
];

export async function initVault(vaultPath, options = {}) {
	const root = path.resolve(vaultPath);
	const now = options.now || new Date().toISOString();
	const title = cleanString(options.title) || inferVaultTitle(root);
	const description = cleanString(options.description) || 'Persistent LLM-maintained knowledge base.';
	const owner = cleanString(options.owner) || 'Mtherios terminal app';
	const force = options.force === true;

	if (fssync.existsSync(path.join(root, '.mtherios', 'story-vault.json'))) {
		throw new Error('Refusing to initialize a generated story vault. Story vaults are regenerated from the terminal world database.');
	}

	await mkdir(root, { recursive: true });
	const directories = [];
	for (const relDir of DEFAULT_DIRS) {
		const absDir = path.join(root, relDir);
		assertPathInside(root, absDir);
		await mkdir(absDir, { recursive: true });
		directories.push(toSlashPath(relDir));
	}

	const files = new Map([
		['README.md', renderReadme({ title, description, owner })],
		['AGENTS.md', renderAgents({ title })],
		['index.md', renderIndex({ title })],
		['log.md', renderLog({ title, now })],
		['wiki/synthesis/overview.md', renderSynthesis({ title, description })],
		['.mtherios/wiki-vault.json', `${JSON.stringify(renderManifest({ title, description, owner, root, now }), null, 2)}\n`],
	]);

	const created = [];
	const updated = [];
	const kept = [];
	for (const [relPath, contents] of files) {
		const absPath = path.join(root, relPath);
		assertPathInside(root, absPath);
		await mkdir(path.dirname(absPath), { recursive: true });
		const exists = fssync.existsSync(absPath);
		if (exists && !force) {
			kept.push(toSlashPath(relPath));
			continue;
		}
		await writeFile(absPath, contents, 'utf8');
		(exists ? updated : created).push(toSlashPath(relPath));
	}
	const manifest = await readStandaloneVaultManifest(root);

	return {
		ok: true,
		action: created.length || updated.length ? 'initialized' : 'exists',
		initId: randomUUID(),
		root,
		title: cleanString(manifest?.title) || title,
		description: cleanString(manifest?.description) || description,
		created,
		updated,
		kept,
		directories,
		initializedAt: now,
	};
}

export async function readStandaloneVaultManifest(vaultPath) {
	const manifestPath = path.join(path.resolve(vaultPath), '.mtherios', 'wiki-vault.json');
	try {
		return JSON.parse(await readFile(manifestPath, 'utf8'));
	} catch (error) {
		if (error?.code === 'ENOENT') return null;
		throw error;
	}
}

export async function standaloneVaultStatus(vaultPath) {
	const root = path.resolve(vaultPath);
	const manifest = await readStandaloneVaultManifest(root);
	const requiredFiles = ['AGENTS.md', 'index.md', 'log.md'];
	const requiredDirs = ['raw/sources', 'raw/assets', 'wiki'];
	const files = await Promise.all(requiredFiles.map(async (relPath) => existsWithType(root, relPath, 'file')));
	const directories = await Promise.all(requiredDirs.map(async (relPath) => existsWithType(root, relPath, 'directory')));
	return {
		root,
		manifest,
		initialized: Boolean(manifest) && files.every((item) => item.exists) && directories.every((item) => item.exists),
		files,
		directories,
	};
}

function renderReadme({ title, description, owner }) {
	return [
		frontmatter({ title, type: 'vault_readme' }),
		`# ${title}`,
		'',
		description,
		'',
		`Owner: ${owner}.`,
		'',
		'This vault is the durable markdown knowledge base. The browser can read it, Obsidian can browse it, and terminal agents can search, follow links, ingest sources, and update maintained pages.',
		'',
		'## Entry Points',
		'- [[Index]]',
		'- [[Synthesis Overview]]',
		'- [[Log]]',
		'- [[Agent Maintainer Schema]]',
		'',
		'## Layout',
		'- `raw/sources/` contains immutable imported evidence.',
		'- `raw/assets/` contains local attachments copied from clips or Obsidian.',
		'- `wiki/` contains maintained entity, concept, comparison, and synthesis pages.',
		'- `index.md` is the content catalog.',
		'- `log.md` is the chronological maintenance trail.',
		'- `AGENTS.md` is the operating schema for LLM maintainers.',
		'',
	].join('\n');
}

function renderAgents({ title }) {
	return [
		frontmatter({ title: 'Agent Maintainer Schema', type: 'agent_schema' }),
		'# Agent Maintainer Schema',
		'',
		`Vault: [[${title}]]`,
		'',
		'## Mission',
		'Maintain this vault as a persistent, compounding knowledge base. Raw sources are evidence; wiki pages are the current synthesis. Do not re-derive the whole world from scratch when the vault already contains maintained structure.',
		'',
		'## Source Rules',
		'- Treat `raw/sources/` as append-only evidence.',
		'- Do not edit raw source pages except to repair malformed frontmatter created by the ingest command.',
		'- Preserve source metadata, hashes, URLs, authors, and ingest dates.',
		'- If a source contradicts an older claim, update the derived page and name the contradiction instead of silently deleting it.',
		'',
		'## Wiki Rules',
		'- Use Obsidian wikilinks for people, factions, places, artifacts, concepts, sources, questions, comparisons, and synthesis pages.',
		'- Prefer small durable pages over one giant note when a concept will recur.',
		'- Keep `index.md` content-oriented: page link, one-line purpose, and important metadata.',
		'- Keep `log.md` chronological and append-only. Use headings like `## [YYYY-MM-DD] ingest | Title`.',
		'- File useful query answers back into `wiki/` when they create reusable analysis.',
		'',
		'## Agent Workflow',
		'1. Read `index.md` first.',
		'2. Use terminal search or page inventory to find candidate pages.',
		'3. Follow wikilinks and backlinks around the candidates.',
		'4. Read exact pages before editing or answering.',
		'5. Cite source pages or maintained wiki pages in answers.',
		'6. Update derived pages, `index.md`, and `log.md` after ingest or durable analysis.',
		'',
		'## Boundaries',
		'- Qdrant is an index, not canon. Rebuild it from markdown when needed.',
		'- The browser is a frontend. The terminal app process owns long-running wiki operations.',
		'- Generated story vaults are read-only projections from the terminal world database. Standalone vaults like this one can be maintained directly.',
		'',
	].join('\n');
}

function renderIndex({ title }) {
	return [
		frontmatter({ title: 'Index', type: 'index' }),
		'# Index',
		'',
		`Catalog for [[${title}]]. Read this before searching or editing the vault.`,
		'',
		'## Core',
		'- [[Synthesis Overview]] - current high-level synthesis and open questions.',
		'- [[Agent Maintainer Schema]] - rules for LLM wiki maintenance.',
		'- [[Log]] - chronological ingest, query, lint, and maintenance history.',
		'',
		'## Raw Sources',
		'',
		'## Entities',
		'',
		'## Concepts',
		'',
		'## Comparisons And Analysis',
		'',
		'## Open Questions',
		'',
	].join('\n');
}

function renderLog({ title, now }) {
	return [
		frontmatter({ title: 'Log', type: 'wiki_log' }),
		'# Log',
		'',
		'Chronological record of wiki maintenance.',
		'',
		`## [${now.slice(0, 10)}] init | ${title}`,
		'- Initialized standalone terminal wiki vault.',
		'- Created schema, index, log, raw source folders, asset folder, and synthesis workspace.',
		'',
	].join('\n');
}

function renderSynthesis({ title, description }) {
	return [
		frontmatter({ title: 'Synthesis Overview', type: 'synthesis', tags: ['synthesis'] }),
		'# Synthesis Overview',
		'',
		`This page is the front door for the maintained synthesis of [[${title}]].`,
		'',
		description,
		'',
		'## Current Thesis',
		'No durable thesis has been written yet. After the first source ingest, summarize the strongest claims here and link to supporting source and entity pages.',
		'',
		'## Important Pages',
		'- [[Index]]',
		'- [[Log]]',
		'',
		'## Open Questions',
		'- What entities, concepts, and contradictions should be split into their own pages?',
		'- Which raw sources are most authoritative for the current synthesis?',
		'- What claim would change if the newest source is trusted over older notes?',
		'',
		'## Maintenance Notes',
		'Keep this page broad and readable. Move detailed claims into linked entity, concept, comparison, or source pages, then summarize the relationship here. This prevents the overview from becoming a pile of disconnected excerpts while still giving an LLM a quick orientation point.',
		'',
	].join('\n');
}

function renderManifest({ title, description, owner, root, now }) {
	return {
		schemaVersion: 1,
		type: 'standalone_wiki_vault',
		title,
		description,
		owner,
		root,
		initializedAt: now,
		layout: {
			rawSources: 'raw/sources',
			rawAssets: 'raw/assets',
			wiki: 'wiki',
			index: 'index.md',
			log: 'log.md',
			schema: 'AGENTS.md',
		},
	};
}

function frontmatter(obj) {
	const lines = ['---'];
	for (const [key, value] of Object.entries(obj)) {
		if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	lines.push('---', '');
	return lines.join('\n');
}

async function existsWithType(root, relPath, expectedType) {
	const absPath = path.join(root, relPath);
	assertPathInside(root, absPath);
	try {
		const info = await stat(absPath);
		return {
			path: toSlashPath(relPath),
			exists: expectedType === 'directory' ? info.isDirectory() : info.isFile(),
		};
	} catch (error) {
		if (error?.code === 'ENOENT') return { path: toSlashPath(relPath), exists: false };
		throw error;
	}
}

function inferVaultTitle(root) {
	const base = path.basename(root).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
	return base ? titleCase(base) : 'Mtherios Wiki Vault';
}

function titleCase(value) {
	return value.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function cleanString(value) {
	if (value === undefined || value === null || value === false || value === true) return null;
	const clean = String(value).trim();
	return clean || null;
}

function assertPathInside(parent, child) {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
	throw new Error(`Refusing to write outside ${parent}: ${child}`);
}
