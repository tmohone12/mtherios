#!/usr/bin/env node

import { parseArgs, readIntFlag, requireVaultAndRest } from './lib/cli.mjs';
import { searchVault } from './lib/search.mjs';
import { loadVault } from './lib/vault.mjs';

const usage = `Usage:
  node scripts/wiki-core/search.mjs <vaultPath> <query...> [--limit 8] [--follow-depth 1] [--json] [--exact]

Examples:
  npm run wiki:search -- ./vault "what does House Stark owe?"
  npm run wiki:search -- ./vault "Jon Snow" --follow-depth 2`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath, rest] = requireVaultAndRest(positional, usage);
const query = rest.join(' ').trim();
if (!query) {
	console.error(usage);
	process.exit(1);
}

const limit = readIntFlag(flags, 'limit', 8);
const followDepth = readIntFlag(flags, 'follow-depth', 1);
const vault = await loadVault(vaultPath);
const result = await searchVault(vault, query, {
	limit,
	followDepth,
	exact: Boolean(flags.exact),
	provider: flags.provider,
	model: flags.model,
	collection: flags.collection,
});

if (flags.json) {
	console.log(JSON.stringify(result, null, 2));
} else {
	if (result.semanticError) console.log(`Semantic search unavailable; used exact search. ${result.semanticError}\n`);
	for (const [index, row] of result.results.entries()) {
		console.log(`${index + 1}. ${row.title} (${row.path})`);
		console.log(`   score ${row.score.toFixed(3)} | layer ${row.layer}`);
		if (row.text) console.log(`   ${row.text.replace(/\s+/g, ' ').slice(0, 360)}`);
		if (row.neighbors.length > 0) {
			console.log(`   neighborhood: ${row.neighbors.slice(0, 6).map((n) => `${n.title} <${n.path}>`).join('; ')}`);
		}
		console.log('');
	}
}
