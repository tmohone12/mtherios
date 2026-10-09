#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { harnessBuildId } from './harness-build-id.mjs';

const stampName = 'mythengine-build.json';

function filesUnder(root) {
	return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
		const file = path.join(root, entry.name);
		return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
	}).sort();
}

function fingerprint(root, files) {
	const hash = createHash('sha256');
	for (const file of files) {
		hash.update(path.relative(root, file).replaceAll('\\', '/'));
		hash.update('\0');
		hash.update(createHash('sha256').update(fs.readFileSync(file)).digest());
	}
	return hash.digest('hex');
}

export function readBuildIdentity(cwd) {
	const root = path.join(cwd, 'build');
	const stampPath = path.join(root, stampName);
	if (!fs.existsSync(stampPath)) throw new Error('Missing MythEngine build identity. Run npm run build.');
	const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
	const actual = fingerprint(root, filesUnder(root).filter(file => file !== stampPath));
	if (actual !== stamp.artifactSha256) throw new Error('Build files changed after compilation. Run npm run build again.');
	return stamp;
}

async function main() {
	const cwd = process.cwd();
	const sourceFiles = ['src', 'scripts', 'static', 'drizzle'].flatMap(dir => filesUnder(path.join(cwd, dir)))
		.concat(['package.json', 'package-lock.json', 'vite.config.ts', 'svelte.config.js', 'tsconfig.json', 'server.js'].map(file => path.join(cwd, file))).sort();
	const sourceSha256 = fingerprint(cwd, sourceFiles);
	const identity = await harnessBuildId(cwd);
	const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd, stdio: 'inherit', windowsHide: true });
	if (result.error) throw result.error;
	if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
	if (sourceSha256 !== fingerprint(cwd, sourceFiles)) throw new Error('Source changed during build; rebuild before starting.');
	const root = path.join(cwd, 'build');
	const stampPath = path.join(root, stampName);
	const stamp = { ...identity, builtAt: new Date().toISOString(), sourceSha256, artifactSha256: fingerprint(root, filesUnder(root).filter(file => file !== stampPath)) };
	fs.writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + '\n');
	console.log('MythEngine build: ' + sourceSha256.slice(0, 12) + ' / artifact ' + stamp.artifactSha256.slice(0, 12));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
