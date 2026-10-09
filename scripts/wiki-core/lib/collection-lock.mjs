import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** @param {unknown} value @param {number} fallback @param {number} minimum */
function lockNumber(value, fallback, minimum) {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.trunc(value)) : fallback;
}

/** @param {unknown} error */
function errorCode(error) {
	return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

/** @param {number} ms */
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} ownerToken */
function ownerRecord(ownerToken) {
	return {
		ownerToken,
		pid: process.pid,
		hostname: os.hostname(),
		acquiredAt: new Date().toISOString(),
	};
}

/** @param {string} directory */
async function readOwner(directory) {
	try {
		const owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
		return owner && typeof owner === 'object' ? owner : null;
	} catch {
		return null;
	}
}

/**
 * Publish a fully initialized owner directory atomically. A crash can leave the
 * unique candidate behind, but never a visible lock without owner metadata.
 * @param {string} target
 * @param {string} ownerToken
 */
async function createOwnedDirectory(target, ownerToken) {
	const candidate = `${target}.candidate-${ownerToken}`;
	await mkdir(candidate);
	try {
		await writeFile(path.join(candidate, 'owner.json'), JSON.stringify(ownerRecord(ownerToken)), 'utf8');
		try {
			await rename(candidate, target);
			return true;
		} catch (error) {
			const targetExists = await stat(target).then(() => true).catch((statError) => {
				if (errorCode(statError) === 'ENOENT') return false;
				throw statError;
			});
			if (targetExists || ['EEXIST', 'ENOTEMPTY'].includes(errorCode(error))) return false;
			throw error;
		}
	} finally {
		await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * Move an owned directory out of the contested path before deleting it, so a
 * newly acquired lock cannot be removed by an older owner's cleanup.
 * @param {string} target
 * @param {string} ownerToken
 * @param {string} label
 */
async function removeOwnedDirectory(target, ownerToken, label) {
	const owner = await readOwner(target);
	if (owner?.ownerToken !== ownerToken) return;
	const retired = `${target}.${label}-${ownerToken}`;
	try {
		await rename(target, retired);
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return;
		throw error;
	}
	await rm(retired, { recursive: true, force: true });
}

/** @param {string} lockKey @param {string} collection @param {number} timeoutMs @param {number} pollMs */
async function acquireWindowsPipeLock(lockKey, collection, timeoutMs, pollMs) {
	const pipeName = `\\\\.\\pipe\\mtherios-qdrant-${lockKey}`;
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const server = await new Promise((resolve, reject) => {
			const candidate = createServer();
			candidate.once('error', (error) => {
				if (errorCode(error) === 'EADDRINUSE') resolve(null);
				else reject(error);
			});
			candidate.listen(pipeName, () => resolve(candidate));
		});
		if (server) {
			return () => new Promise((resolve) => {
				server.close(() => resolve(undefined));
			});
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for Qdrant collection lock for "${collection}".`);
		}
		await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
}

/**
 * @typedef {{
 *   url: string;
 *   collection: string;
 *   lockDir?: string;
 *   lockTimeoutMs?: number;
 *   lockStaleMs?: number;
 *   lockPollMs?: number;
 * }} QdrantCollectionLockConfig
 */

/** @param {QdrantCollectionLockConfig} config */
async function acquireQdrantCollectionLock(config) {
	const lockRoot = config.lockDir ?? process.env.MTHERIOS_QDRANT_LOCK_DIR ?? path.join(os.tmpdir(), 'mtherios-qdrant-sync-locks');
	const lockKey = createHash('sha256').update(`${config.url.replace(/\/+$/, '')}|${config.collection}`).digest('hex').slice(0, 24);
	const lockPath = path.join(lockRoot, `${lockKey}.lock`);
	const timeoutMs = lockNumber(config.lockTimeoutMs, 5 * 60_000, 1_000);
	const pollMs = lockNumber(config.lockPollMs, 100, 5);
	if (process.platform === 'win32') {
		return acquireWindowsPipeLock(lockKey, config.collection, timeoutMs, pollMs);
	}
	const deadline = Date.now() + timeoutMs;
	const ownerToken = `${process.pid}-${randomUUID()}`;
	await mkdir(lockRoot, { recursive: true });

	while (true) {
		if (await createOwnedDirectory(lockPath, ownerToken)) {
			return () => removeOwnedDirectory(lockPath, ownerToken, 'released');
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Timed out waiting for Qdrant collection lock for "${config.collection}". ` +
				`If its owner crashed, remove the abandoned lock directory at ${lockPath}.`,
			);
		}
		await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
}

/**
 * Serialize a complete Qdrant collection lifecycle operation across local processes.
 * @template T
 * @param {QdrantCollectionLockConfig} config
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withQdrantCollectionLock(config, run) {
	const release = await acquireQdrantCollectionLock(config);
	try {
		return await run();
	} finally {
		await release();
	}
}
