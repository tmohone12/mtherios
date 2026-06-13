#!/usr/bin/env node

import { parseArgs, readIntFlag, requireVaultAndRest } from './lib/cli.mjs';
import { buildContextPack, clipText, layerWeight } from './lib/context.mjs';
import { lintVault } from './lib/lint.mjs';
import { searchVault } from './lib/search.mjs';
import { loadVault, resolvePage, stripMarkdown } from './lib/vault.mjs';

const usage = `Usage:
  node scripts/wiki-core/brief.mjs <vaultPath> <task...> [--mode answer|maintain|ingest|lint|explore] [--limit 5] [--follow-depth 2] [--page-limit 24] [--inventory-limit 24] [--json] [--exact]

Examples:
  npm run wiki:brief -- ./vault "who knows about the hidden route?"
  npm run wiki:brief -- ./vault "process the Glassmarket source" --mode ingest --json`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath, rest] = requireVaultAndRest(positional, usage);
const task = rest.join(' ').trim();
if (!task) {
	console.error(usage);
	process.exit(1);
}

const options = {
	mode: normalizeMode(flags.mode),
	limit: readIntFlag(flags, 'limit', 5),
	followDepth: readIntFlag(flags, 'follow-depth', 2),
	pageLimit: readIntFlag(flags, 'page-limit', 24),
	pageChars: readIntFlag(flags, 'page-chars', 1800),
	maxChars: readIntFlag(flags, 'max-chars', 36000),
	inventoryLimit: readIntFlag(flags, 'inventory-limit', 24),
	thinChars: readIntFlag(flags, 'thin-chars', 240),
	orphanLayer: flags['orphan-layer'] === 'all' ? 'all' : 'derived',
	exact: Boolean(flags.exact),
	provider: flags.provider,
	model: flags.model,
	collection: flags.collection,
};

const vault = await loadVault(vaultPath);
const [search, lint] = await Promise.all([
	searchVault(vault, task, {
		limit: options.limit,
		followDepth: options.followDepth,
		exact: options.exact,
		provider: options.provider,
		model: options.model,
		collection: options.collection,
	}),
	lintVault(vault, {
		thinChars: options.thinChars,
		orphanLayer: options.orphanLayer,
	}),
]);
const context = buildContextPack(vault, search, options);
const corePages = corePageRecords(vault);
const inventory = inventorySnapshot(vault, options.inventoryLimit);
const brief = {
	ok: true,
	task,
	mode: options.mode,
	root: vault.root,
	generatedAt: new Date().toISOString(),
	search: {
		query: search.query,
		semanticError: search.semanticError,
		seedCount: context.seedCount,
		pageCount: context.pageCount,
		seeds: context.seeds,
	},
	lint: {
		ok: lint.ok,
		summary: lint.summary,
		missingCoreFiles: lint.missingCoreFiles.filter((item) => !item.exists),
		brokenLinks: lint.brokenLinks.slice(0, 20),
		orphanPages: lint.orphanPages.slice(0, 20),
		thinPages: lint.thinPages.slice(0, 20),
		emptyPages: lint.emptyPages.slice(0, 20),
		duplicateTitles: lint.duplicateTitles.slice(0, 20),
	},
	corePages,
	inventory,
	context,
	runbook: runbook(options.mode),
	nextCommands: nextCommands(vault.root, task, options, context),
	briefMarkdown: briefMarkdown({
		task,
		mode: options.mode,
		vault,
		lint,
		corePages,
		inventory,
		context,
		commands: nextCommands(vault.root, task, options, context),
	}),
};

if (flags.json) console.log(JSON.stringify(brief, null, 2));
else console.log(brief.briefMarkdown);

function normalizeMode(value) {
	const mode = cleanFlag(value) ?? 'maintain';
	if (['answer', 'maintain', 'ingest', 'lint', 'explore'].includes(mode)) return mode;
	throw new Error('--mode must be answer, maintain, ingest, lint, or explore.');
}

function corePageRecords(vault) {
	return ['AGENTS.md', 'index.md', 'log.md', 'README.md']
		.map((query) => resolvePage(vault, query))
		.filter(Boolean)
		.map((page) => ({
			path: page.relPath,
			title: page.title,
			layer: page.layer,
			type: typeof page.frontmatter.type === 'string' ? page.frontmatter.type : null,
			headings: page.headings ?? [],
			links: page.resolvedLinks ?? [],
			backlinks: page.backlinks ?? [],
			text: clipText(stripMarkdown(page.body), 1200),
		}));
}

function inventorySnapshot(vault, limit) {
	const pages = vault.pages.map((page) => ({
		path: page.relPath,
		title: page.title,
		layer: page.layer,
		type: typeof page.frontmatter.type === 'string' ? page.frontmatter.type : null,
		headings: page.headings ?? [],
		linkCount: (page.resolvedLinks ?? []).length,
		backlinkCount: (page.backlinks ?? []).length,
		updatedAt: page.updatedAt,
		textChars: stripMarkdown(page.body).length,
	}));
	return {
		pageCount: pages.length,
		layers: countBy(pages, 'layer'),
		types: countBy(pages.filter((page) => page.type), 'type'),
		hubs: pages
			.toSorted((a, b) => b.backlinkCount - a.backlinkCount || b.linkCount - a.linkCount || a.title.localeCompare(b.title))
			.slice(0, limit),
		recent: pages
			.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
			.slice(0, limit),
		rawSources: pages
			.filter((page) => page.layer === 'raw')
			.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
			.slice(0, limit),
		derivedCandidates: pages
			.filter((page) => page.layer !== 'raw')
			.toSorted((a, b) => layerWeight(a.layer) - layerWeight(b.layer) || a.title.localeCompare(b.title))
			.slice(0, limit),
	};
}

function runbook(mode) {
	const shared = [
		'Read AGENTS.md and index.md before editing.',
		'Use the context pages as leads, not as proof by themselves.',
		'Follow links and backlinks around any page you plan to cite or update.',
		'Use raw sources as evidence and wiki pages as current synthesis.',
		'When editing, update the maintained page, index.md if a new page is created, and log.md with a dated entry.',
	];
	const modeSpecific = {
		answer: [
			'Answer from the context first, then page-read any cited source if the claim is important.',
			'If the answer is reusable, save it as a derived analysis page.',
		],
		maintain: [
			'Repair lint issues that are relevant to the task before adding new synthesis.',
			'Prefer improving existing pages over creating duplicates.',
		],
		ingest: [
			'After source ingest, read the raw source page and compare it to existing entity, concept, and synthesis pages.',
			'Name contradictions explicitly and keep the raw source immutable.',
		],
		lint: [
			'Start with missing core files, then broken links, then duplicate titles, then orphans/thin pages.',
			'Do not bulk delete pages just because they are orphans; link them or explain why they should remain isolated.',
		],
		explore: [
			'Use hubs and recent pages to map the neighborhood before drawing conclusions.',
			'Create open-question pages when an important uncertainty recurs.',
		],
	};
	return [...shared, ...(modeSpecific[mode] ?? [])];
}

function nextCommands(root, task, options, context) {
	const quotedRoot = quote(root);
	const quotedTask = quote(task);
	const firstPage = context.pages[0]?.path;
	const commands = [
		`npm run wiki:pages -- ${quotedRoot} --sort backlinks --json`,
		`npm run wiki:context -- ${quotedRoot} ${quotedTask} --follow-depth ${options.followDepth} --json`,
		`npm run wiki:lint -- ${quotedRoot} --json`,
	];
	if (firstPage) {
		commands.push(`npm run wiki:page -- ${quotedRoot} ${quote(firstPage)} --json`);
		commands.push(`npm run wiki:follow -- ${quotedRoot} ${quote(firstPage)} --depth ${Math.max(1, options.followDepth)} --json`);
	}
	commands.push(`npm run wiki:write -- ${quotedRoot} --title "New Analysis Page" --content-file ./draft.md --mode create --log "filed analysis for: ${escapeDouble(task)}"`);
	return commands;
}

function briefMarkdown({ task, mode, vault, lint, corePages, inventory, context, commands }) {
	const lines = [
		'# Wiki Agent Brief',
		'',
		`Task: ${task}`,
		`Mode: ${mode}`,
		`Vault: ${vault.root}`,
		'',
		'## Health',
		`- Lint: ${lint.ok ? 'ok' : `${lint.summary.issueCount} issue(s)`}`,
		`- Pages: ${inventory.pageCount}`,
		`- Missing core files: ${lint.summary.missingCoreFiles}`,
		`- Broken links: ${lint.summary.brokenLinks}`,
		`- Orphans: ${lint.summary.orphanPages}`,
		`- Thin pages: ${lint.summary.thinPages}`,
		'',
		'## Core Pages',
		...corePages.map((page) => `- ${page.title} <${page.path}> headings: ${page.headings.slice(0, 5).join(' | ') || '-'}`),
		'',
		'## Hubs',
		...inventory.hubs.slice(0, 8).map((page) => `- ${page.title} <${page.path}> backlinks=${page.backlinkCount} links=${page.linkCount}`),
		'',
		'## Relevant Context',
		context.semanticError ? `Semantic fallback: ${context.semanticError}` : '',
		context.contextMarkdown,
		'',
		'## Runbook',
		...runbook(mode).map((step, index) => `${index + 1}. ${step}`),
		'',
		'## Useful Commands',
		...commands.map((command) => `- \`${command}\``),
		'',
	].filter((line) => line !== '').join('\n');
	return clipText(lines, 52000);
}

function countBy(items, key) {
	const counts = {};
	for (const item of items) {
		const value = item[key];
		if (!value) continue;
		counts[value] = (counts[value] ?? 0) + 1;
	}
	return counts;
}

function cleanFlag(value) {
	if (value === undefined || value === null || value === false || value === true) return null;
	const clean = String(value).trim();
	return clean || null;
}

function quote(value) {
	const clean = String(value).replace(/"/g, '\\"');
	return `"${clean}"`;
}

function escapeDouble(value) {
	return String(value).replace(/"/g, '\\"');
}
