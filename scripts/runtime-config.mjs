// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATABASE_URL = 'postgres://mythengine:mythengine@127.0.0.1:5433/mythengine';

// Return a copy: resolving a config must not rewrite the caller's environment.
export function normalizeRuntimeEnv(input = process.env) {
	const env = { ...input };
	for (const [key, value] of Object.entries(input)) {
		if (key.startsWith('MYTHENGINE_')) env[key.replace('MYTHENGINE_', 'MTHERIOS_')] = value;
	}
	for (const key of ['HOST', 'PORT', 'DATABASE_URL', 'QDRANT_URL', 'QDRANT_COLLECTION', 'OLLAMA_URL']) {
		env[key] = input['MYTHENGINE_' + key] ?? input['MTHERIOS_' + key] ?? input[key];
	}
	return env;
}

export function loadEnvFile(cwd = process.cwd(), input = process.env) {
	const env = { ...input };
	for (const file of ['.env.local', '.env']) {
		const target = path.resolve(cwd, file);
		if (!fs.existsSync(target)) continue;
		for (const line of fs.readFileSync(target, 'utf8').split(/\r?\n/)) {
			const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
			if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
		}
	}
	return env;
}

export function resolveConfigPath(cwd = process.cwd(), input = process.env, explicit) {
	const env = normalizeRuntimeEnv(input);
	const selected = explicit ?? env.MTHERIOS_CONFIG;
	if (selected) return path.resolve(cwd, selected);
	const preferred = path.resolve(cwd, 'mythengine.config.json');
	const legacy = path.resolve(cwd, 'mtherios.config.json');
	return fs.existsSync(preferred) || !fs.existsSync(legacy) ? preferred : legacy;
}

function realTarget(value) {
	let current = path.resolve(value);
	const suffix = [];
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) break;
		suffix.unshift(path.basename(current));
		current = parent;
	}
	return path.resolve(fs.realpathSync(current), ...suffix);
}

export function assertLocalPath(value, cwd = process.cwd()) {
	const relative = path.relative(realTarget(cwd), realTarget(value));
	if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
		throw new Error('MythEngine isolation: a configured path is outside this checkout. Use MYTHENGINE_ALLOW_SHARED_RUNTIME=true only for an intentional shared runtime.');
	}
}

function loopback(url) {
	return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function assertRuntimeIsolation(options) {
	for (const value of [options.port]) {
		if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid application port.');
	}
	let database, qdrant, app;
	try {
		database = new URL(options.databaseUrl);
		qdrant = new URL(options.qdrantUrl);
		app = new URL(options.appUrl);
	} catch { throw new Error('Invalid runtime URL; check database, Qdrant and app configuration.'); }
	if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['http:', 'https:'].includes(qdrant.protocol) || !['http:', 'https:'].includes(app.protocol)) throw new Error('Unsupported runtime URL protocol.');
	if (options.allowSharedRuntime) return;
	// The application may replace Mtherios on its old HTTP port. Keep the
	// database, vector store and filesystem isolation independent of that port.
	if ((loopback(database) && (database.port === '5432' || database.pathname === '/mtherios')) ||
		(loopback(qdrant) && qdrant.port === '6333')) {
		throw new Error('MythEngine isolation: configuration targets a reserved Mtherios service. Use the MythEngine defaults or explicitly opt in with MYTHENGINE_ALLOW_SHARED_RUNTIME=true.');
	}
	for (const name of ['configPath', 'dataRoot', 'vaultRoot', 'defaultVault']) assertLocalPath(options[name], options.cwd);
}

export function resolveAppUrl(argv = process.argv.slice(2)) {
	return resolveRuntimeOptions(argv).appUrl;
}

export function safeRuntimeSummary(options) {
	const database = new URL(options.databaseUrl);
	const safeUrl = value => { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); };
	return {
		application: 'MythEngine', cwd: options.cwd, configPath: options.configPath,
		appUrl: safeUrl(options.appUrl), host: options.host, port: options.port,
		dataRoot: options.dataRoot, vaultRoot: options.vaultRoot, defaultVault: options.defaultVault,
		database: { host: database.hostname, port: database.port || '5432', name: database.pathname.slice(1) },
		qdrantUrl: safeUrl(options.qdrantUrl), qdrantCollection: options.qdrantCollection,
		jobWorker: options.jobWorker, jobWorkerScope: options.jobWorkerScope, wikiAutoIndex: options.wikiAutoIndexStoryVaults,
		allowSharedRuntime: options.allowSharedRuntime,
		localKevEnabled: options.localKevEnabled, localEmbeddingsEnabled: options.localEmbeddingsEnabled,
		environmentKeys: Object.keys(process.env).filter(key => /^(MYTHENGINE_|MTHERIOS_|DATABASE_URL$|PORT$|QDRANT_)/.test(key) && !/KEY|SECRET|TOKEN/.test(key)),
	};
}

export function resolveRuntimeOptions(argv = [], { cwd: workingDirectory = process.cwd(), env: inputEnv = process.env } = {}) {
	const { flags } = parseArgs(argv);
	const cwd = path.resolve(flags.cwd ?? workingDirectory);
	const env = normalizeRuntimeEnv(loadEnvFile(cwd, inputEnv));
	const configPath = resolveConfigPath(cwd, env, flags.config);
	if (!booleanOption(flags['allow-shared-runtime'], env.MTHERIOS_ALLOW_SHARED_RUNTIME, false, false)) assertLocalPath(configPath, cwd);
	const fileConfig = readJsonIfExists(configPath);

	const dataRoot = path.resolve(cwd, flags['data-root'] ?? env.MTHERIOS_DATA_ROOT ?? fileConfig.dataRoot ?? './data');
	const vaultRoot = path.resolve(dataRoot, flags['vault-root'] ?? env.MTHERIOS_VAULT_ROOT ?? fileConfig.vaultRoot ?? './vaults');
	const defaultVault = path.resolve(vaultRoot, flags.vault ?? env.MTHERIOS_DEFAULT_VAULT ?? fileConfig.defaultVault ?? './default');
	const host = String(flags.host ?? env.HOST ?? fileConfig.host ?? '127.0.0.1');
	const port = Number(flags.port ?? env.PORT ?? fileConfig.port ?? 5174);
	const qdrantUrl = String(flags['qdrant-url'] ?? env.QDRANT_URL ?? fileConfig.qdrantUrl ?? 'http://127.0.0.1:6335');
	const qdrantCollection = String(flags.collection ?? env.QDRANT_COLLECTION ?? fileConfig.qdrantCollection ?? 'mythengine_wiki');
	const ollamaUrl = String(flags['ollama-url'] ?? env.OLLAMA_URL ?? fileConfig.ollamaUrl ?? 'http://127.0.0.1:11434');
	const ollamaEmbedNumGpu = String(flags['ollama-embed-num-gpu'] ?? env.OLLAMA_EMBED_NUM_GPU ?? fileConfig.ollamaEmbedNumGpu ?? '');
	const localKevEnabled = booleanOption(flags['local-kev'], env.MTHERIOS_LOCAL_KEV, fileConfig.localKevEnabled, false);
	const localEmbeddingsEnabled = booleanOption(flags['local-embeddings'], env.MTHERIOS_LOCAL_EMBEDDINGS, fileConfig.localEmbeddingsEnabled, false);
	const wikiEmbedProvider = String(flags['wiki-embed-provider'] ?? env.WIKI_EMBED_PROVIDER ?? fileConfig.wikiEmbedProvider ?? 'openrouter');
	const wikiEmbedModel = String(flags['wiki-embed-model'] ?? env.WIKI_EMBED_MODEL ?? fileConfig.wikiEmbedModel ?? 'openai/text-embedding-3-small');
	const wikiEmbedBaseUrl = String(flags['wiki-embed-base-url'] ?? env.WIKI_EMBED_BASE_URL ?? fileConfig.wikiEmbedBaseUrl ?? 'https://openrouter.ai/api/v1');
	const wikiEmbedApiKey = String(flags['wiki-embed-api-key'] ?? env.WIKI_EMBED_API_KEY ?? fileConfig.wikiEmbedApiKey ?? env.OPENROUTER_API_KEY ?? fileConfig.llmApiKeys?.OPENROUTER_API_KEY ?? '');
	const wikiAutoIndexStoryVaults = booleanOption(flags['wiki-auto-index'], env.MTHERIOS_WIKI_AUTO_INDEX, fileConfig.wikiAutoIndexStoryVaults, false);
	const databaseUrl = String(flags['database-url'] ?? env.DATABASE_URL ?? fileConfig.databaseUrl ?? DEFAULT_DATABASE_URL);
	const jobWorker = booleanOption(flags['job-worker'], env.MTHERIOS_JOB_WORKER, fileConfig.jobWorker, false);
	const jobWorkerScope = String(flags['job-worker-scope'] ?? env.MTHERIOS_JOB_WORKER_SCOPE ?? fileConfig.jobWorkerScope ?? 'all');
	if (!['all', 'faction'].includes(jobWorkerScope)) throw new Error('Invalid job worker scope.');
	const jobIntervalMs = Math.max(1000, Number(flags['job-interval-ms'] ?? env.MTHERIOS_JOB_INTERVAL_MS ?? fileConfig.jobIntervalMs ?? 5000));
	const jobTimeoutMs = Math.max(5000, Number(flags['job-timeout-ms'] ?? env.MTHERIOS_JOB_TIMEOUT_MS ?? fileConfig.jobTimeoutMs ?? 10 * 60_000));
	const jobBatchLimit = Math.max(1, Math.min(100, Number(flags['job-batch-limit'] ?? env.MTHERIOS_JOB_BATCH_LIMIT ?? fileConfig.jobBatchLimit ?? 1)));
	const jobStaleLockMs = Math.max(60_000, Number(flags['job-stale-lock-ms'] ?? env.MTHERIOS_JOB_STALE_LOCK_MS ?? fileConfig.jobStaleLockMs ?? 30 * 60_000));
	const chapterThreshold = 20;
	const postChapterBuffer = 0;
	const chaptersPerArc = 10;
	const memoryEmbeddingProvider = String(flags['memory-embedding-provider'] ?? env.MEMORY_EMBEDDING_PROVIDER ?? fileConfig.memoryEmbeddingProvider ?? '');
	const memoryEmbeddingModel = String(flags['memory-embedding-model'] ?? env.MEMORY_EMBEDDING_MODEL ?? fileConfig.memoryEmbeddingModel ?? '');
	const memoryEmbeddingBaseUrl = String(flags['memory-embedding-base-url'] ?? env.MEMORY_EMBEDDING_BASE_URL ?? fileConfig.memoryEmbeddingBaseUrl ?? '');
	const memoryEmbeddingApiKey = String(flags['memory-embedding-api-key'] ?? env.MEMORY_EMBEDDING_API_KEY ?? fileConfig.memoryEmbeddingApiKey ?? (memoryEmbeddingProvider === 'openrouter' ? env.OPENROUTER_API_KEY ?? fileConfig.llmApiKeys?.OPENROUTER_API_KEY : '') ?? '');
	const memoryEmbeddingUrl = String(flags['memory-embedding-url'] ?? env.MEMORY_EMBEDDING_URL ?? fileConfig.memoryEmbeddingUrl ?? '');
	const memoryEmbeddingBatch = Math.max(1, Number(flags['memory-embedding-batch'] ?? env.MEMORY_EMBEDDING_BATCH ?? fileConfig.memoryEmbeddingBatch ?? 8));
	const memoryEmbeddingDimensions = Math.max(1, Number(flags['memory-embedding-dimensions'] ?? env.MEMORY_EMBEDDING_DIMENSIONS ?? fileConfig.memoryEmbeddingDimensions ?? 1536));

	const options = {
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
		ollamaEmbedNumGpu,
		localKevEnabled,
		localEmbeddingsEnabled,
		wikiEmbedProvider,
		wikiEmbedModel,
		wikiEmbedBaseUrl,
		wikiEmbedApiKey,
		wikiAutoIndexStoryVaults,
		databaseUrl,
		jobWorker,
		jobWorkerScope,
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
		appUrl: String(flags.url ?? env.MTHERIOS_APP_URL ?? fileConfig.appUrl ?? ('http://' + host + ':' + port)).replace(/\/$/, ''),
		allowSharedRuntime: booleanOption(flags['allow-shared-runtime'], env.MTHERIOS_ALLOW_SHARED_RUNTIME, fileConfig.allowSharedRuntime, false),
		allowExternalVaults: booleanOption(undefined, env.MTHERIOS_ALLOW_EXTERNAL_VAULTS, fileConfig.allowExternalVaults, false),
		printConfig: flags['print-config'] === true,
		configKeys: Object.keys(fileConfig).filter(key => !/key|secret/i.test(key)),
	};
	if (!localEmbeddingsEnabled) {
		if (options.wikiEmbedProvider === 'ollama') options.wikiEmbedProvider = 'disabled';
		if (options.memoryEmbeddingProvider === 'ollama') options.memoryEmbeddingProvider = '';
	}
	assertRuntimeIsolation(options);
	return options;
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

function readJsonIfExists(configPath) {
	try {
		const raw = fs.readFileSync(configPath, 'utf8');
		return JSON.parse(raw);
	} catch (error) {
		if (error?.code === 'ENOENT') return {};
		throw new Error(`Could not read ${configPath}: ${'invalid or unreadable JSON'}`);
	}
}


export function buildRuntimeEnv(options, inputEnv = process.env) {
	const env = normalizeRuntimeEnv(inputEnv);
	const result = {
		...env,
		NODE_ENV: env.NODE_ENV ?? (options.dev ? 'development' : 'production'),
		BODY_SIZE_LIMIT: env.BODY_SIZE_LIMIT ?? '128M',
		HOST: options.host,
		PORT: String(options.port),
		DATABASE_URL: options.databaseUrl,
		MTHERIOS_CONFIG: options.configPath,
		MTHERIOS_ALLOW_SHARED_RUNTIME: options.allowSharedRuntime ? 'true' : 'false',
		MTHERIOS_DATA_ROOT: options.dataRoot,
		MTHERIOS_VAULT_ROOT: options.vaultRoot,
		MTHERIOS_DEFAULT_VAULT: options.defaultVault,
		MTHERIOS_ALLOW_EXTERNAL_VAULTS: options.allowExternalVaults ? 'true' : 'false',
		QDRANT_URL: options.qdrantUrl,
		QDRANT_COLLECTION: options.qdrantCollection,
		OLLAMA_URL: options.ollamaUrl,
		OLLAMA_EMBED_NUM_GPU: options.ollamaEmbedNumGpu,
		MTHERIOS_LOCAL_KEV: options.localKevEnabled ? 'true' : 'false',
		MTHERIOS_LOCAL_EMBEDDINGS: options.localEmbeddingsEnabled ? 'true' : 'false',
		MTHERIOS_WIKI_AUTO_INDEX: options.wikiAutoIndexStoryVaults ? 'true' : 'false',
		MTHERIOS_JOB_WORKER: options.jobWorker ? 'true' : 'false',
		MTHERIOS_JOB_WORKER_SCOPE: options.jobWorkerScope,
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
	for (const [key, value] of Object.entries(result)) {
		if (key.startsWith('MTHERIOS_')) result[key.replace('MTHERIOS_', 'MYTHENGINE_')] = value;
	}
	for (const key of ['HOST','PORT','DATABASE_URL','QDRANT_URL','QDRANT_COLLECTION','OLLAMA_URL']) result['MYTHENGINE_' + key] = result[key];
	return result;
}
