#!/usr/bin/env node

import { parseArgs, readIntFlag, requireVaultAndRest } from './lib/cli.mjs';
import { lintVault } from './lib/lint.mjs';
import { loadVault } from './lib/vault.mjs';

const usage = `Usage:
  node scripts/wiki-core/lint.mjs <vaultPath> [--thin-chars 240] [--orphan-layer derived|all] [--json]

Examples:
  npm run wiki:lint -- ./vault
  npm run wiki:lint -- ./vault --json`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath] = requireVaultAndRest(positional, usage);
const vault = await loadVault(vaultPath);
const report = await lintVault(vault, {
	thinChars: readIntFlag(flags, 'thin-chars', 240),
	orphanLayer: flags['orphan-layer'] === 'all' ? 'all' : 'derived',
});

if (flags.json) {
	console.log(JSON.stringify(report, null, 2));
} else {
	printReport(report);
}

function printReport(report) {
	console.log('');
	console.log(`Wiki lint: ${report.ok ? 'ok' : 'issues found'}`);
	console.log(`  root:      ${report.root}`);
	console.log(`  pages:     ${report.summary.pageCount}`);
	console.log(`  issues:    ${report.summary.issueCount}`);
	console.log(`  core:      missing=${report.summary.missingCoreFiles}`);
	console.log(`  links:     broken=${report.summary.brokenLinks} duplicateTitles=${report.summary.duplicateTitles}`);
	console.log(`  health:    orphans=${report.summary.orphanPages} thin=${report.summary.thinPages} empty=${report.summary.emptyPages}`);
	console.log(`  manifest:  ${report.manifest.exists ? `serverVersion=${report.manifest.serverVersion ?? 'unknown'} indexedAt=${report.manifest.indexedAt ?? 'not indexed'}` : 'not present'}`);

	printSection('Missing Core Files', report.missingCoreFiles.filter((item) => !item.exists), (item) => `- ${item.path}`);
	printSection('Broken Links', report.brokenLinks.slice(0, 20), (item) => `- ${item.pageTitle} (${item.pagePath}) -> [[${item.target}]]`);
	printSection('Duplicate Titles', report.duplicateTitles.slice(0, 20), (item) => `- ${item.titleKey}: ${item.pages.map((page) => page.path).join(', ')}`);
	printSection('Orphan Pages', report.orphanPages.slice(0, 20), (item) => `- ${item.title} (${item.path})`);
	printSection('Thin Pages', report.thinPages.slice(0, 20), (item) => `- ${item.title} (${item.path}) ${item.textChars} chars`);
	printSection('Empty Pages', report.emptyPages.slice(0, 20), (item) => `- ${item.title} (${item.path})`);
	console.log('');
}

function printSection(title, items, format) {
	if (!items.length) return;
	console.log('');
	console.log(`${title}:`);
	for (const item of items) console.log(format(item));
}
