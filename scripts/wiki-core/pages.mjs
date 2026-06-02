#!/usr/bin/env node

import { parseArgs, readIntFlag, requireVaultAndRest } from './lib/cli.mjs';
import { loadVault, stripMarkdown } from './lib/vault.mjs';

const usage = `Usage:
  node scripts/wiki-core/pages.mjs <vaultPath> [--layer wiki] [--type character] [--tag faction] [--orphans] [--limit 200] [--sort title] [--json]

Examples:
  npm run wiki:pages -- ./vault --json
  npm run wiki:pages -- ./vault --layer wiki --orphans`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath] = requireVaultAndRest(positional, usage);
const limit = readIntFlag(flags, 'limit', 200);
const sort = String(flags.sort || 'title').trim().toLowerCase();
const filters = {
	layer: cleanFlag(flags.layer),
	type: cleanFlag(flags.type),
	tag: cleanFlag(flags.tag),
	orphans: Boolean(flags.orphans),
};

const vault = await loadVault(vaultPath);
const allPages = vault.pages.map(pageRecord);
const pages = allPages
	.filter((page) => !filters.layer || page.layer === filters.layer)
	.filter((page) => !filters.type || page.type === filters.type)
	.filter((page) => !filters.tag || page.tags.includes(filters.tag))
	.filter((page) => !filters.orphans || page.backlinkCount === 0)
	.sort(pageSorter(sort))
	.slice(0, Math.max(1, limit));

const result = {
	root: vault.root,
	generatedAt: new Date().toISOString(),
	pageCount: allPages.length,
	returnedCount: pages.length,
	filters,
	sort,
	layers: countBy(allPages, 'layer'),
	types: countBy(allPages.filter((page) => page.type), 'type'),
	tags: countTags(allPages),
	pages,
};

if (flags.json) {
	console.log(JSON.stringify(result, null, 2));
} else {
	console.log(`Vault pages: ${result.returnedCount}/${result.pageCount}`);
	if (filters.layer || filters.type || filters.tag || filters.orphans) {
		console.log(`Filters: ${[
			filters.layer ? `layer=${filters.layer}` : '',
			filters.type ? `type=${filters.type}` : '',
			filters.tag ? `tag=${filters.tag}` : '',
			filters.orphans ? 'orphans' : '',
		].filter(Boolean).join(', ')}`);
	}
	for (const page of pages) {
		console.log(`${page.title} <${page.path}>`);
		console.log(`  layer=${page.layer} type=${page.type || '-'} links=${page.linkCount} backlinks=${page.backlinkCount} chars=${page.textChars}`);
		if (page.headings.length > 0) console.log(`  headings: ${page.headings.slice(0, 4).join(' | ')}`);
	}
}

function pageRecord(page) {
	const tags = normalizeTags(page.frontmatter.tags ?? page.frontmatter.tag);
	const type = typeof page.frontmatter.type === 'string' ? page.frontmatter.type : null;
	const links = page.resolvedLinks ?? [];
	const backlinks = page.backlinks ?? [];
	return {
		path: page.relPath,
		title: page.title,
		layer: page.layer,
		type,
		tags,
		headings: page.headings ?? [],
		links,
		linkCount: links.length,
		backlinks,
		backlinkCount: backlinks.length,
		updatedAt: page.updatedAt,
		textChars: stripMarkdown(page.body).length,
	};
}

function cleanFlag(value) {
	if (value === undefined || value === null || value === false || value === true) return null;
	const clean = String(value).trim();
	return clean || null;
}

function normalizeTags(value) {
	if (Array.isArray(value)) return value.map(cleanTag).filter(Boolean);
	if (typeof value === 'string') {
		const raw = value.trim().replace(/^\[|\]$/g, '');
		return raw
			.split(',')
			.map(cleanTag)
			.filter(Boolean);
	}
	return [];
}

function cleanTag(value) {
	return String(value ?? '').trim().replace(/^["']|["']$/g, '');
}

function pageSorter(sort) {
	return (a, b) => {
		switch (sort) {
			case 'updated':
				return b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title);
			case 'links':
				return b.linkCount - a.linkCount || a.title.localeCompare(b.title);
			case 'backlinks':
				return b.backlinkCount - a.backlinkCount || a.title.localeCompare(b.title);
			case 'path':
				return a.path.localeCompare(b.path);
			case 'title':
			default:
				return a.title.localeCompare(b.title);
		}
	};
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

function countTags(items) {
	const counts = {};
	for (const item of items) {
		for (const tag of item.tags) {
			counts[tag] = (counts[tag] ?? 0) + 1;
		}
	}
	return counts;
}
