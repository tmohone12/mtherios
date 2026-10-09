import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function git(root, args) {
	try {
		return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
	} catch {
		return '';
	}
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

/** Return the identity of the source actually used by a harness run. */
export async function harnessBuildId(root, sourceFiles = []) {
	const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
	const dirtyStatus = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
	const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [
		file,
		sha256(await readFile(resolve(root, file))),
	])));
	return {
		identity: `${packageJson.name ?? 'mythengine'}@${packageJson.version ?? 'unknown'}`,
		version: packageJson.version ?? null,
		source: 'local-checkout',
		artifact: (process.env.MYTHENGINE_BUILD_ARTIFACT ?? process.env.MTHERIOS_BUILD_ARTIFACT)?.trim() || 'working-tree',
		externalId: (process.env.MYTHENGINE_BUILD_ID ?? process.env.MTHERIOS_BUILD_ID)?.trim() || null,
		gitHead: git(root, ['rev-parse', 'HEAD']) || null,
		dirty: dirtyStatus.length > 0,
		dirtyFileCount: dirtyStatus ? dirtyStatus.split(/\r?\n/).filter(Boolean).length : 0,
		dirtyStatusSha256: sha256(dirtyStatus),
		sourceHashes,
	};
}
