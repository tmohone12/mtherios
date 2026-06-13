#!/usr/bin/env node

import { parseArgs, readIntFlag, requireVaultAndRest } from './lib/cli.mjs';
import { buildContextPack } from './lib/context.mjs';
import { searchVault } from './lib/search.mjs';
import { loadVault } from './lib/vault.mjs';

const usage = `Usage:
  node scripts/wiki-core/context.mjs <vaultPath> <query...> [--limit 5] [--follow-depth 2] [--page-limit 24] [--page-chars 1800] [--max-chars 24000] [--json] [--exact]

Examples:
  npm run wiki:context -- ./vault "what does House Stark owe?" --follow-depth 2
  npm run wiki:context -- ./vault "Balaerys debts" --json`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath, rest] = requireVaultAndRest(positional, usage);
const query = rest.join(' ').trim();
if (!query) {
	console.error(usage);
	process.exit(1);
}

const limit = readIntFlag(flags, 'limit', 5);
const followDepth = readIntFlag(flags, 'follow-depth', 2);
const pageLimit = readIntFlag(flags, 'page-limit', 24);
const pageChars = readIntFlag(flags, 'page-chars', 1800);
const maxChars = readIntFlag(flags, 'max-chars', 24000);
const vault = await loadVault(vaultPath);
const search = await searchVault(vault, query, {
	limit,
	followDepth,
	exact: Boolean(flags.exact),
	provider: flags.provider,
	model: flags.model,
	collection: flags.collection,
});
const context = buildContextPack(vault, search, {
	followDepth,
	pageLimit,
	pageChars,
	maxChars,
});

if (flags.json) {
	console.log(JSON.stringify(context, null, 2));
} else {
	if (context.semanticError) console.log(`Semantic search unavailable; used exact search. ${context.semanticError}\n`);
	console.log(context.contextMarkdown);
}
