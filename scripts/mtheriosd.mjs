#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initVault } from './wiki-core/lib/init.mjs';

const DEFAULT_DATABASE_URL = 'postgres://mtherios:mtherios@127.0.0.1:5432/mtherios';

export async function main(argv = process.argv.slice(2)) {
	const options = await resolveOptions(argv);
	await prepareDataRoot(options);
	const env = buildRuntimeEnv(options);

	printBanner(options);

	if (options.dev) {
		await runDevServer(options, env);
		return;
	}

	await runBuiltServer(options, env);
}

async function resolveOptions(argv) {
	const { flags } = parseArgs(argv);
	const cwd = path.resolve(flags.cwd ?? process.cwd());
	const configPath = path.resolve(cwd, flags.config ?? process.env.MTHERIOS_CONFIG ?? 'mtherios.config.json');
	const fileConfig = await readJsonIfExists(configPath);

	const dataRoot = path.resolve(cwd, flags['data-root'] ?? process.env.MTHERIOS_DATA_ROOT ?? fileConfig.dataRoot ?? './data');
	const vaultRoot = path.resolve(dataRoot, flags['vault-root'] ?? process.env.MTHERIOS_VAULT_ROOT ?? fileConfig.vaultRoot ?? './vaults');
	const defaultVault = path.resolve(vaultRoot, flags.vault ?? process.env.MTHERIOS_DEFAULT_VAULT ?? fileConfig.defaultVault ?? './default');
	const host = String(flags.host ?? process.env.HOST ?? fileConfig.host ?? '127.0.0.1');
	const port = Number(flags.port ?? process.env.PORT ?? fileConfig.port ?? 5173);
	const qdrantUrl = String(flags['qdrant-url'] ?? process.env.QDRANT_URL ?? fileConfig.qdrantUrl ?? 'http://127.0.0.1:6333');
	const qdrantCollection = String(flags.collection ?? process.env.QDRANT_COLLECTION ?? fileConfig.qdrantCollection ?? 'mtherios_wiki');
	const ollamaUrl = String(flags['ollama-url'] ?? process.env.OLLAMA_URL ?? fileConfig.ollamaUrl ?? 'http://127.0.0.1:11434');
	const wikiEmbedProvider = String(flags['wiki-embed-provider'] ?? process.env.WIKI_EMBED_PROVIDER ?? fileConfig.wikiEmbedProvider ?? 'openrouter');
	const wikiEmbedModel = String(flags['wiki-embed-model'] ?? process.env.WIKI_EMBED_MODEL ?? fileConfig.wikiEmbedModel ?? 'openai/text-embedding-3-small');
	const wikiEmbedBaseUrl = String(flags['wiki-embed-base-url'] ?? process.env.WIKI_EMBED_BASE_URL ?? fileConfig.wikiEmbedBaseUrl ?? 'https://openrouter.ai/api/v1');
	const wikiEmbedApiKey = String(flags['wiki-embed-api-key'] ?? process.env.WIKI_EMBED_API_KEY ?? fileConfig.wikiEmbedApiKey ?? process.env.OPENROUTER_API_KEY ?? fileConfig.llmApiKeys?.OPENROUTER_API_KEY ?? '');
	const wikiAutoIndexStoryVaults = booleanOption(flags['wiki-auto-index'], process.env.MTHERIOS_WIKI_AUTO_INDEX, fileConfig.wikiAutoIndexStoryVaults, false);
	const wikiAutoLintStoryVaults = booleanOption(flags['wiki-auto-lint'], process.env.MTHERIOS_WIKI_AUTO_LINT, fileConfig.wikiAutoLintStoryVaults, false);
	const databaseUrl = String(flags['database-url'] ?? process.env.DATABASE_URL ?? fileConfig.databaseUrl ?? DEFAULT_DATABASE_URL);
	const jobWorker = booleanOption(flags['job-worker'], process.env.MTHERIOS_JOB_WORKER, fileConfig.jobWorker, true);
	const jobIntervalMs = Math.max(1000, Number(flags['job-interval-ms'] ?? process.env.MTHERIOS_JOB_INTERVAL_MS ?? fileConfig.jobIntervalMs ?? 5000));
	const jobTimeoutMs = Math.max(5000, Number(flags['job-timeout-ms'] ?? process.env.MTHERIOS_JOB_TIMEOUT_MS ?? fileConfig.jobTimeoutMs ?? 10 * 60_000));
	const jobBatchLimit = Math.max(1, Math.min(100, Number(flags['job-batch-limit'] ?? process.env.MTHERIOS_JOB_BATCH_LIMIT ?? fileConfig.jobBatchLimit ?? 1)));
	const jobStaleLockMs = Math.max(60_000, Number(flags['job-stale-lock-ms'] ?? process.env.MTHERIOS_JOB_STALE_LOCK_MS ?? fileConfig.jobStaleLockMs ?? 30 * 60_000));
	const chapterThreshold = Math.max(1, Number(flags['chapter-threshold'] ?? process.env.MTHERIOS_CHAPTER_THRESHOLD ?? fileConfig.chapterThreshold ?? 20));
	const postChapterBuffer = Math.max(0, Number(flags['post-chapter-buffer'] ?? process.env.MTHERIOS_POST_CHAPTER_BUFFER ?? fileConfig.postChapterBuffer ?? 10));
	const chaptersPerArc = Math.max(1, Number(flags['chapters-per-arc'] ?? process.env.MTHERIOS_CHAPTERS_PER_ARC ?? fileConfig.chaptersPerArc ?? 5));
	const memoryEmbeddingProvider = String(flags['memory-embedding-provider'] ?? process.env.MEMORY_EMBEDDING_PROVIDER ?? fileConfig.memoryEmbeddingProvider ?? '');
	const memoryEmbeddingModel = String(flags['memory-embedding-model'] ?? process.env.MEMORY_EMBEDDING_MODEL ?? fileConfig.memoryEmbeddingModel ?? '');
	const memoryEmbeddingBaseUrl = String(flags['memory-embedding-base-url'] ?? process.env.MEMORY_EMBEDDING_BASE_URL ?? fileConfig.memoryEmbeddingBaseUrl ?? '');
	const memoryEmbeddingApiKey = String(flags['memory-embedding-api-key'] ?? process.env.MEMORY_EMBEDDING_API_KEY ?? fileConfig.memoryEmbeddingApiKey ?? (memoryEmbeddingProvider === 'openrouter' ? process.env.OPENROUTER_API_KEY ?? fileConfig.llmApiKeys?.OPENROUTER_API_KEY : '') ?? '');
	const memoryEmbeddingUrl = String(flags['memory-embedding-url'] ?? process.env.MEMORY_EMBEDDING_URL ?? fileConfig.memoryEmbeddingUrl ?? '');
	const memoryEmbeddingBatch = Math.max(1, Number(flags['memory-embedding-batch'] ?? process.env.MEMORY_EMBEDDING_BATCH ?? fileConfig.memoryEmbeddingBatch ?? 8));
	const memoryEmbeddingDimensions = Math.max(1, Number(flags['memory-embedding-dimensions'] ?? process.env.MEMORY_EMBEDDING_DIMENSIONS ?? fileConfig.memoryEmbeddingDimensions ?? 1536));

	return {
		cwd,
		configPath,
		dataRoot,
		vaultRoot,
		defaultVault,
		host,
		port,
		qdrantUrl,
		qdrantCollection,
		ollamaUrl,
		wikiEmbedProvider,
		wikiEmbedModel,
		wikiEmbedBaseUrl,
		wikiEmbedApiKey,
		wikiAutoIndexStoryVaults,
		wikiAutoLintStoryVaults,
		databaseUrl,
		jobWorker,
		jobIntervalMs,
		jobTimeoutMs,
		jobBatchLimit,
		jobStaleLockMs,
		chapterThreshold,
		postChapterBuffer,
		chaptersPerArc,
		memoryEmbeddingProvider,
		memoryEmbeddingModel,
		memoryEmbeddingBaseUrl,
		memoryEmbeddingApiKey,
		memoryEmbeddingUrl,
		memoryEmbeddingBatch,
		memoryEmbeddingDimensions,
		dev: Boolean(flags.dev),
		strictPort: flags.strictPort !== false,
	};
}

function booleanOption(flagValue, envValue, configValue, fallback = false) {
	if (flagValue === false) return false;
	if (flagValue === true) return true;
	if (typeof flagValue === 'string') return flagValue === 'true' || flagValue === '1';
	if (typeof envValue === 'string') return envValue === 'true' || envValue === '1';
	if (typeof configValue === 'boolean') return configValue;
	return fallback;
}

function parseArgs(argv) {
	const flags = {};
	const positional = [];

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}

		const raw = arg.slice(2);
		const eq = raw.indexOf('=');
		const key = eq === -1 ? raw : raw.slice(0, eq);
		const inlineValue = eq === -1 ? null : raw.slice(eq + 1);
		if (key.startsWith('no-')) {
			flags[key.slice(3)] = false;
		} else if (inlineValue !== null) {
			flags[key] = inlineValue;
		} else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
			flags[key] = argv[i + 1];
			i += 1;
		} else {
			flags[key] = true;
		}
	}

	return { flags, positional };
}

async function readJsonIfExists(configPath) {
	try {
		const raw = await fs.readFile(configPath, 'utf8');
		return JSON.parse(raw);
	} catch (error) {
		if (error?.code === 'ENOENT') return {};
		throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function prepareDataRoot(options) {
	await fs.mkdir(options.dataRoot, { recursive: true });
	await fs.mkdir(options.vaultRoot, { recursive: true });
	await fs.mkdir(options.defaultVault, { recursive: true });
	await fs.mkdir(path.join(options.dataRoot, 'exports'), { recursive: true });
	await fs.mkdir(path.join(options.dataRoot, 'uploads'), { recursive: true });
	await fs.mkdir(path.join(options.dataRoot, 'logs'), { recursive: true });

	await initVault(options.defaultVault, {
		title: 'Mtherios Default Vault',
		description: 'Default standalone Obsidian-style vault for terminal-owned lore sources, maintained wiki pages, and local LLM search.',
		owner: 'Mtherios terminal app process',
	});
}

function buildRuntimeEnv(options) {
	return {
		...process.env,
		NODE_ENV: process.env.NODE_ENV ?? (options.dev ? 'development' : 'production'),
		HOST: options.host,
		PORT: String(options.port),
		DATABASE_URL: options.databaseUrl,
		MTHERIOS_CONFIG: options.configPath,
		MTHERIOS_DATA_ROOT: options.dataRoot,
		MTHERIOS_VAULT_ROOT: options.vaultRoot,
		MTHERIOS_DEFAULT_VAULT: options.defaultVault,
		MTHERIOS_ALLOW_EXTERNAL_VAULTS: process.env.MTHERIOS_ALLOW_EXTERNAL_VAULTS ?? 'false',
		QDRANT_URL: options.qdrantUrl,
		QDRANT_COLLECTION: options.qdrantCollection,
		OLLAMA_URL: options.ollamaUrl,
		MTHERIOS_WIKI_AUTO_INDEX: options.wikiAutoIndexStoryVaults ? 'true' : 'false',
		MTHERIOS_WIKI_AUTO_LINT: options.wikiAutoLintStoryVaults ? 'true' : 'false',
		MTHERIOS_JOB_WORKER: options.jobWorker ? 'true' : 'false',
		MTHERIOS_JOB_INTERVAL_MS: String(options.jobIntervalMs),
		MTHERIOS_JOB_TIMEOUT_MS: String(options.jobTimeoutMs),
		MTHERIOS_JOB_BATCH_LIMIT: String(options.jobBatchLimit),
		MTHERIOS_JOB_STALE_LOCK_MS: String(options.jobStaleLockMs),
		MTHERIOS_CHAPTER_THRESHOLD: String(options.chapterThreshold),
		MTHERIOS_POST_CHAPTER_BUFFER: String(options.postChapterBuffer),
		MTHERIOS_CHAPTERS_PER_ARC: String(options.chaptersPerArc),
		MEMORY_EMBEDDING_PROVIDER: options.memoryEmbeddingProvider,
		MEMORY_EMBEDDING_MODEL: options.memoryEmbeddingModel,
		MEMORY_EMBEDDING_BASE_URL: options.memoryEmbeddingBaseUrl,
		MEMORY_EMBEDDING_API_KEY: options.memoryEmbeddingApiKey,
		MEMORY_EMBEDDING_URL: options.memoryEmbeddingUrl,
		MEMORY_EMBEDDING_BATCH: String(options.memoryEmbeddingBatch),
		MEMORY_EMBEDDING_DIMENSIONS: String(options.memoryEmbeddingDimensions),
		WIKI_EMBED_PROVIDER: options.wikiEmbedProvider,
		WIKI_EMBED_MODEL: options.wikiEmbedModel,
		WIKI_EMBED_BASE_URL: options.wikiEmbedBaseUrl,
		WIKI_EMBED_API_KEY: options.wikiEmbedApiKey,
	};
}

function printBanner(options) {
	console.log('');
	console.log('Mtherios terminal app process');
	console.log(`  app:      http://${options.host}:${options.port}`);
	console.log(`  data:     ${options.dataRoot}`);
	console.log(`  vaults:   ${options.vaultRoot}`);
	console.log(`  default:  ${options.defaultVault}`);
	console.log(`  qdrant:   ${options.qdrantUrl} / ${options.qdrantCollection}`);
	console.log(`  database: ${redactDatabaseUrl(options.databaseUrl)}`);
	console.log(`  jobs:     ${options.jobWorker ? `enabled every ${options.jobIntervalMs}ms, limit ${options.jobBatchLimit}, timeout ${options.jobTimeoutMs}ms` : 'disabled'}`);
	console.log(`  wiki:     ${options.wikiEmbedProvider} / ${options.wikiEmbedModel}, auto-index ${options.wikiAutoIndexStoryVaults ? 'on' : 'off'}, auto-lint ${options.wikiAutoLintStoryVaults ? 'on' : 'off'}`);
	console.log(`  memory:   chapters every ${options.chapterThreshold} entries (+${options.postChapterBuffer} buffer), arcs every ${options.chaptersPerArc} chapters`);
	console.log(`  vectors:  ${options.memoryEmbeddingProvider && options.memoryEmbeddingModel ? `${options.memoryEmbeddingProvider} / ${options.memoryEmbeddingModel} (${options.memoryEmbeddingDimensions}d)` : 'disabled'}`);
	console.log('');
}

function redactDatabaseUrl(value) {
	try {
		const url = new URL(value);
		if (url.password) url.password = '***';
		return url.toString();
	} catch {
		return value;
	}
}

async function runDevServer(options, env) {
	const viteArgs = ['run', 'dev', '--', '--host', options.host, '--port', String(options.port)];
	if (options.strictPort) viteArgs.push('--strictPort');
	const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
	const args = process.platform === 'win32'
		? ['/d', '/s', '/c', 'npm.cmd', ...viteArgs]
		: viteArgs;

	const child = spawn(command, args, {
		cwd: options.cwd,
		env,
		stdio: 'inherit',
		windowsHide: true,
	});

	const stopJobs = startJobWorker(options);
	try {
		await waitForChild(child);
	} finally {
		stopJobs();
	}
}

async function runBuiltServer(options, env) {
	const handlerPath = path.join(options.cwd, 'build', 'handler.js');
	if (!fssync.existsSync(handlerPath)) {
		throw new Error('Missing build/handler.js. Run `npm run build` before `npm run app:start`.');
	}

	Object.assign(process.env, env);
	const { handler } = await import(pathToFileURL(handlerPath).href);
	const server = createServer((request, response) => {
		handler(request, response, (error) => {
			if (error) {
				console.error(error);
				response.statusCode = 500;
				response.end('Internal server error');
				return;
			}
			response.statusCode = 404;
			response.end('Not found');
		});
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, options.host, resolve);
	});

	console.log(`Mtherios is listening on http://${options.host}:${options.port}`);
	startJobWorker(options);
}

function startJobWorker(options) {
	if (!options.jobWorker) return () => {};
	let stopped = false;
	let timer = null;
	let consecutiveErrors = 0;
	const endpoint = `http://${options.host}:${options.port}/api/app/jobs/run`;
	const workerId = `mtheriosd_${process.pid}`;

	const schedule = (delay = options.jobIntervalMs) => {
		if (stopped) return;
		timer = setTimeout(tick, delay);
		timer.unref?.();
	};

	const tick = async () => {
		if (stopped) return;
		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workerId, limit: options.jobBatchLimit }),
				signal: AbortSignal.timeout(options.jobTimeoutMs),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const result = await response.json();
			consecutiveErrors = 0;
			if (result.claimed || result.failed?.length) {
				console.log(`[jobs] claimed=${result.claimed} completed=${result.completed} failed=${result.failed?.length ?? 0} ${formatJobBacklog(result.after)}`);
			}
		} catch (error) {
			consecutiveErrors += 1;
			if (consecutiveErrors === 1 || consecutiveErrors % 12 === 0) {
				console.warn(`[jobs] waiting for app job endpoint: ${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			schedule();
		}
	};

	schedule(1000);
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}

function formatJobBacklog(stats) {
	if (!stats || typeof stats !== 'object') return 'backlog=unknown';
	const ready = Number(stats.ready ?? 0);
	const retry = Number(stats.retry ?? 0);
	const delayed = Number(stats.delayed ?? 0);
	const running = Number(stats.running ?? 0);
	const failed = Number(stats.failed ?? 0);
	return `ready=${ready} retry=${retry} running=${running} delayed=${delayed} failedTotal=${failed}`;
}

function waitForChild(child) {
	return new Promise((resolve, reject) => {
		const forward = (signal) => {
			if (!child.killed) child.kill(signal);
		};
		process.once('SIGINT', forward);
		process.once('SIGTERM', forward);

		child.once('exit', (code, signal) => {
			process.removeListener('SIGINT', forward);
			process.removeListener('SIGTERM', forward);
			if (code && code !== 0) reject(new Error(`Mtherios dev child exited with code ${code}`));
			else if (signal) reject(new Error(`Mtherios dev child exited from signal ${signal}`));
			else resolve();
		});
		child.once('error', reject);
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main(process.argv.slice(2));
}
