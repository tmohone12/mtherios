#!/usr/bin/env node

import { parseArgs, readIntFlag, requireVaultAndRest } from './lib/cli.mjs';
import { followGraph, loadVault } from './lib/vault.mjs';

const usage = `Usage:
  node scripts/wiki-core/follow.mjs <vaultPath> <page title or path...> [--depth 2] [--json]

Examples:
  npm run wiki:follow -- ./vault "House Stark" --depth 2
  npm run wiki:follow -- ./vault wiki/factions/house-stark--abc12345.md`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath, rest] = requireVaultAndRest(positional, usage);
const seed = rest.join(' ').trim();
if (!seed) {
	console.error(usage);
	process.exit(1);
}

const depth = readIntFlag(flags, 'depth', 2);
const vault = await loadVault(vaultPath);
const graph = followGraph(vault, seed, depth);

if (!graph.start) {
	console.error(`Could not find page: ${seed}`);
	process.exit(2);
}

if (flags.json) {
	console.log(JSON.stringify({
		start: { path: graph.start.relPath, title: graph.start.title },
		nodes: graph.nodes.map((node) => ({
			path: node.page.relPath,
			title: node.page.title,
			layer: node.page.layer,
			distance: node.distance,
			links: node.page.resolvedLinks ?? [],
			backlinks: node.page.backlinks ?? [],
		})),
		edges: graph.edges,
	}, null, 2));
} else {
	console.log(`${graph.start.title} (${graph.start.relPath})`);
	for (const node of graph.nodes) {
		if (node.page.relPath === graph.start.relPath) continue;
		console.log(`${'  '.repeat(node.distance)}- d${node.distance}: ${node.page.title} (${node.page.relPath})`);
	}
}
