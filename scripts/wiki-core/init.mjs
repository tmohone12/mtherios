#!/usr/bin/env node

import { parseArgs, requireVaultAndRest } from './lib/cli.mjs';
import { initVault, standaloneVaultStatus } from './lib/init.mjs';

const usage = `Usage:
  node scripts/wiki-core/init.mjs <vaultPath> [--title "Vault Title"] [--description "..."] [--owner "..."] [--force] [--status] [--json]

Examples:
  npm run wiki:init -- ./data/vaults/default
  npm run wiki:init -- ./data/vaults/research --title "Research Wiki" --json`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath] = requireVaultAndRest(positional, usage);

const result = flags.status
	? await standaloneVaultStatus(vaultPath)
	: await initVault(vaultPath, {
		title: cleanFlag(flags.title),
		description: cleanFlag(flags.description),
		owner: cleanFlag(flags.owner),
		force: flags.force === true,
	});

if (flags.json) console.log(JSON.stringify(result, null, 2));
else if (flags.status) printStatus(result);
else printInit(result);

function printInit(result) {
	console.log('');
	console.log(`Wiki init: ${result.title}`);
	console.log(`  action:  ${result.action}`);
	console.log(`  root:    ${result.root}`);
	console.log(`  created: ${result.created.length ? result.created.join(', ') : '-'}`);
	console.log(`  updated: ${result.updated.length ? result.updated.join(', ') : '-'}`);
	console.log(`  kept:    ${result.kept.length ? result.kept.length : 0}`);
	console.log('');
}

function printStatus(result) {
	console.log('');
	console.log(`Wiki vault: ${result.manifest?.title || result.root}`);
	console.log(`  root:        ${result.root}`);
	console.log(`  initialized: ${result.initialized ? 'yes' : 'no'}`);
	for (const file of result.files) {
		console.log(`  file:        ${file.exists ? 'ok' : 'missing'} ${file.path}`);
	}
	for (const directory of result.directories) {
		console.log(`  dir:         ${directory.exists ? 'ok' : 'missing'} ${directory.path}`);
	}
	console.log('');
}

function cleanFlag(value) {
	if (value === undefined || value === null || value === false || value === true) return null;
	const clean = String(value).trim();
	return clean || null;
}
