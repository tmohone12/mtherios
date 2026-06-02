#!/usr/bin/env node

import { parseArgs, requireVaultAndRest } from './lib/cli.mjs';
import { loadVault, resolvePage, stripMarkdown } from './lib/vault.mjs';

const usage = `Usage:
  node scripts/wiki-core/page.mjs <vaultPath> <page title or path...> [--json] [--raw]

Examples:
  npm run wiki:page -- ./vault "House Stark"
  npm run wiki:page -- ./vault wiki/factions/house-stark--abc12345.md --json`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath, rest] = requireVaultAndRest(positional, usage);
const query = rest.join(' ').trim();
if (!query) {
	console.error(usage);
	process.exit(1);
}

const vault = await loadVault(vaultPath);
const page = resolvePage(vault, query);
if (!page) {
	console.error(`Could not find page: ${query}`);
	process.exit(2);
}

const result = {
	query,
	path: page.relPath,
	title: page.title,
	layer: page.layer,
	type: page.frontmatter.type ?? null,
	frontmatter: page.frontmatter,
	headings: page.headings,
	links: page.links,
	resolvedLinks: page.resolvedLinks ?? [],
	backlinks: page.backlinks ?? [],
	updatedAt: page.updatedAt,
	markdown: page.raw,
	body: page.body,
	text: stripMarkdown(page.body),
};

if (flags.json) {
	console.log(JSON.stringify(result, null, 2));
} else if (flags.raw) {
	console.log(page.raw.trim());
} else {
	console.log(`# ${page.title}`);
	console.log(`path: ${page.relPath}`);
	console.log(`layer: ${page.layer}`);
	if (page.links.length > 0) console.log(`links: ${page.links.join(', ')}`);
	if ((page.backlinks ?? []).length > 0) console.log(`backlinks: ${(page.backlinks ?? []).join(', ')}`);
	console.log('');
	console.log(page.raw.trim());
}
