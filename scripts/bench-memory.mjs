import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import { createServer } from 'vite';
import { cases, corpus, heldoutCases, storyId } from '../evals/memory/fixture.mjs';
import { loadEnvFile } from './db-env.mjs';
import { harnessBuildId } from './harness-build-id.mjs';

// No DATABASE_URL option: this command may only use a database it created itself.
const root = resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({ options: { model: { type: 'string' }, 'max-cost-usd': { type: 'string' } }, allowPositionals: true });
const rounds = Number(positionals[0] ?? 5);
assert(positionals.length <= 1 && Number.isInteger(rounds) && rounds >= 1 && rounds <= 20, 'Usage: npm run bench:memory -- [rounds: 1..20] [--model text-embedding-3-large] [--max-cost-usd 0.50]');
assert(!values.model || values.model === 'text-embedding-3-large', 'Only the explicitly supported text-embedding-3-large experiment is available');
assert(values.model ? values['max-cost-usd'] !== undefined : values['max-cost-usd'] === undefined, values.model ? 'Semantic embedding replay requires --max-cost-usd as an explicit positive spend cap' : '--max-cost-usd requires --model');
const spendCapUsd = values.model === undefined ? null : Number(values['max-cost-usd']);
assert(spendCapUsd === null || (Number.isFinite(spendCapUsd) && spendCapUsd > 0), '--max-cost-usd must be a positive finite number');
assert.equal(new Set(cases.map((test) => test.id)).size, cases.length, 'Duplicate benchmark case ID');
assert(heldoutCases.length >= 100, 'Held-out benchmark must contain at least 100 cases');
assert.equal(new Set(heldoutCases.map((test) => test.id)).size, heldoutCases.length, 'Duplicate held-out benchmark case ID');
const allCases = [...cases, ...heldoutCases];
let semantic;
if (values.model) {
	loadEnvFile();
	const openaiKey = process.env.OPENAI_API_KEY;
	const openrouterKey = process.env.OPENROUTER_API_KEY;
	assert(openaiKey || openrouterKey, 'Set OPENAI_API_KEY or OPENROUTER_API_KEY in the environment; saved credentials are not used');
	semantic = {
		provider: openaiKey ? 'openai' : 'openrouter',
		model: openaiKey ? values.model : `openai/${values.model}`, dimensions: 3072,
		baseUrl: openaiKey ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1', apiKey: openaiKey || openrouterKey,
	};
}
const runId = randomUUID();
const containerName = `mtherios-memory-bench-${runId}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim();
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const round = (n) => Number(n.toFixed(3));

function evaluate(test, packet, suite = 'regression') {
	const expected = Object.entries(test.expected ?? {});
	const forbidden = new Set(['foreign', 'poison', 'transcript_entry_380', 'transcript_entry_381', ...(test.forbidden ?? [])]);
	const exposure = [...packet.nodes, ...packet.retrievalTrace];
	const violations = [...new Set(exposure.filter((node) => forbidden.has(node.id)
		|| (!test.request?.includeSecret && node.visibility === 'secret')).map((node) => node.id))];
	if (packet.packet.includes('FOREIGN_SENTINEL') || packet.packet.includes('CONTROL_REPLY_SENTINEL')) violations.push('forbidden packet text');
	const ranks = expected.map(([id]) => packet.retrievalTrace.find((node) => node.id === id)?.rank ?? null);
	const included = expected.map(([id]) => packet.nodes.some((node) => node.id === id));
	const retained = expected.map(([id, answer]) => packet.nodes.some((node) => node.id === id) && packet.packet.toLowerCase().includes(answer.toLowerCase()));
	const budget = test.request?.tokenBudget ?? 1200;
	return {
		suite, id: test.id, group: test.group, query: test.query, request: test.request ?? {}, expected: test.expected ?? {},
		ranks, recall1: mean(ranks.map((rank) => Number(rank !== null && rank <= 1))),
		recall5: mean(ranks.map((rank) => Number(rank !== null && rank <= 5))),
		recall10: mean(ranks.map((rank) => Number(rank !== null && rank <= 10))),
		mrr: ranks.length ? 1 / (Math.min(...ranks.filter((rank) => rank !== null)) || Infinity) : 0,
		packetRecall: mean(included.map(Number)), answerRecall: mean(retained.map(Number)),
		violations, budget, budgetOk: packet.tokenEstimate <= budget,
		tokenEstimate: packet.tokenEstimate, selectedIds: packet.nodes.map((node) => node.id),
		packet: packet.packet, trace: packet.retrievalTrace, debug: packet.retrievalDebug,
	};
}

// Scoring self-check: don't let empty-gold safety cases inflate recall.
const selfCheck = evaluate({ id: 'check', expected: { wanted: 'answer' } }, {
	nodes: [{ id: 'wanted' }], retrievalTrace: [{ id: 'wanted', rank: 3 }], packet: 'answer', tokenEstimate: 2,
});
assert.equal(selfCheck.recall1, 0);
assert.equal(selfCheck.recall5, 1);
assert.equal(selfCheck.mrr, 1 / 3);
assert.equal(selfCheck.answerRecall, 1);
assert.equal(evaluate({ expected: { missing: 'x' } }, { nodes: [], retrievalTrace: [], packet: '', tokenEstimate: 0 }).mrr, 0);
assert.equal(evaluate({ expected: { wanted: 'answer' } }, { nodes: [{ id: 'wanted' }], retrievalTrace: [], packet: 'truncated', tokenEstimate: 2 }).answerRecall, 0);
assert.deepEqual(evaluate({}, { nodes: [{ id: 'secret', visibility: 'secret' }], retrievalTrace: [], packet: '', tokenEstimate: 0 }).violations, ['secret']);

function summarize(results) {
	const gold = results.filter((row) => Object.keys(row.expected).length);
	return {
		cases: results.length, recallCases: gold.length,
		...Object.fromEntries(['recall1', 'recall5', 'recall10', 'mrr', 'packetRecall', 'answerRecall'].map((key) => [key, round(mean(gold.map((row) => row[key])))])),
		violations: results.reduce((sum, row) => sum + row.violations.length, 0),
		budgetFailures: results.filter((row) => !row.budgetOk).length,
		p50Ms: round(percentile(results.flatMap((row) => row.latencies), 0.5)),
		p95Ms: round(percentile(results.flatMap((row) => row.latencies), 0.95)),
	};
}

let containerId, vite, client;
const originalWarn = console.warn;
const originalFetch = globalThis.fetch;
const apiUsage = [];
const queryVectors = new Map();
let reportedSpendUsd = 0;
let phase = 'seed';
try {
	console.log(`Starting disposable PostgreSQL/pgvector container (no live data; ${semantic ? 'paid embeddings for synthetic fixtures only' : 'no model API calls'}).`);
	if (semantic) globalThis.fetch = async (input, init) => {
		const endpoint = input instanceof Request ? input.url : String(input);
		if (endpoint !== `${semantic.baseUrl}/embeddings`) return originalFetch(input, init);
		const response = await originalFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(45_000) });
		if (response.ok) {
			const body = await response.clone().json();
			const request = JSON.parse(init.body);
			assert(body.model?.endsWith(values.model), 'API returned a different embedding model');
			assert(body.data.every((row, index) => row.index === index), 'API returned embeddings out of input order');
			const cost = body.usage?.cost;
			assert(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0, 'Semantic embedding response omitted a finite non-negative usage.cost');
			reportedSpendUsd += cost;
			assert(reportedSpendUsd <= spendCapUsd, `Semantic embedding reported spend ${reportedSpendUsd} USD above declared cap ${spendCapUsd} USD`);
			apiUsage.push({ phase, model: body.model, promptTokens: body.usage?.prompt_tokens ?? null, totalTokens: body.usage?.total_tokens ?? null, cost });
			if (phase !== 'seed' && typeof request.input === 'string') queryVectors.set(request.input, body.data[0].embedding);
		}
		return response;
	};
	containerId = docker('run', '--pull=never', '--rm', '-d', '--name', containerName,
		'--label', `mtherios.memory-benchmark=${runId}`, '--tmpfs', '/var/lib/postgresql/data',
		'-e', 'POSTGRES_USER=bench', '-e', 'POSTGRES_PASSWORD=bench', '-e', 'POSTGRES_DB=bench',
		'-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16');
	assert(/^[a-f0-9]{64}$/.test(containerId), 'Unexpected container identity');
	const inspect = JSON.parse(docker('inspect', containerId))[0];
	assert.equal(inspect.Config.Labels['mtherios.memory-benchmark'], runId);
	const port = inspect.NetworkSettings.Ports['5432/tcp'][0];
	assert.equal(port.HostIp, '127.0.0.1');
	const databaseUrl = `postgres://bench:bench@127.0.0.1:${port.HostPort}/bench`;
	Object.assign(process.env, {
		DATABASE_URL: databaseUrl, MEMORY_EMBEDDING_PROVIDER: 'local-hash', MEMORY_EMBEDDING_MODEL: 'local-hash-768',
		MEMORY_EMBEDDING_DIMENSIONS: '768', MEMORY_EMBEDDING_URL: '', MEMORY_EMBEDDING_BASE_URL: '', MEMORY_EMBEDDING_API_KEY: '',
	});
	let ready = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		try { docker('exec', containerId, 'pg_isready', '-U', 'bench', '-d', 'bench'); ready = true; break; }
		catch { await delay(250); }
	}
	assert(ready, 'Disposable database did not become ready');
	execFileSync(process.execPath, ['scripts/db-migrate.mjs'], { cwd: root, env: process.env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
	// Vite only resolves TS and the SvelteKit env import. Retrieval/ranking/SQL are unmodified.
	vite = await createServer({
		root, configFile: false, envFile: false, appType: 'custom',
		server: { middlewareMode: true, hmr: false, watch: null },
		resolve: { alias: { $lib: resolve(root, 'src/lib') } },
		plugins: [{ name: 'benchmark-env', resolveId: (id) => id === '$env/dynamic/private' ? '\0benchmark-env' : undefined,
			load: (id) => id === '\0benchmark-env' ? 'export const env = process.env;' : undefined }],
	});
	const load = (path) => vite.ssrLoadModule(`/src/lib/server/${path}.ts`);
	client = await load('db/client');
	const { getServerMemoryConfig } = await load('env');
	assert.equal(getServerMemoryConfig().databaseUrl, databaseUrl);
	const schema = await load('db/schema');
	const { embedMemoryTexts, memoryEmbeddingConfig, memoryNodeEmbeddingText, validateMemoryEmbeddingVector } = await load('memory/embeddings');
	const { memoryQueryTokens } = await load('memory/ranking');
	const { retrieveMemoryPacket } = await load('memory/retrieval');
	const data = corpus();
	const db = client.getDb();
	await db.insert(schema.stories).values(data.stories);
	await db.insert(schema.entities).values(data.entities);
	await db.insert(schema.storyEntries).values(data.entries);
	await db.insert(schema.storyEvents).values(data.events);
	await db.insert(schema.npcBeliefs).values(data.beliefs);
	const warnings = [];
	console.warn = (...args) => { warnings.push(args.map(String).join(' ')); originalWarn(...args); };
	const modes = [];
	for (const mode of [
		{ name: 'local-hash', provider: 'local-hash', model: 'local-hash-768', dimensions: 768, ranking: 'default' },
		{ name: 'disabled', provider: 'disabled', model: '', dimensions: 768, ranking: 'default' },
		{ name: 'local-hash-hybrid', provider: 'local-hash', model: 'local-hash-768', dimensions: 768, ranking: 'hybrid' },
		...(semantic ? [semantic] : []),
	]) {
		const { provider, model, dimensions } = mode;
		process.env.MEMORY_EMBEDDING_PROVIDER = provider === 'disabled' ? '' : provider;
		process.env.MEMORY_EMBEDDING_MODEL = model;
		process.env.MEMORY_EMBEDDING_DIMENSIONS = String(dimensions);
		process.env.MEMORY_EMBEDDING_BASE_URL = mode.baseUrl ?? '';
		process.env.MEMORY_EMBEDDING_API_KEY = mode.apiKey ?? '';
		process.env.MTHERIOS_MEMORY_RANKING_MODE = mode.ranking === 'hybrid' ? 'hybrid' : '';
		if (provider !== 'disabled') {
			phase = 'seed';
			console.log(`Embedding ${data.memories.length} synthetic memories with ${model} (${dimensions} dimensions); ${spendCapUsd} USD reported-spend cap.`);
			for (let offset = 0; offset < data.memories.length; offset += 64) {
				const batch = data.memories.slice(offset, offset + 64);
				const vectors = await embedMemoryTexts(batch.map(memoryNodeEmbeddingText), memoryEmbeddingConfig());
				await db.insert(schema.memoryNodes).values(batch.map((node, index) => ({
					...node, embedding: validateMemoryEmbeddingVector(vectors[index], dimensions),
				}))).onConflictDoUpdate({ target: schema.memoryNodes.id, set: { embedding: sql`excluded.embedding` } });
			}
		}
		const requestFor = (test) => ({ storyId, query: test.query, tokenBudget: 1200, ...test.request });
		console.log(`Benchmarking ${(mode.name ?? model) || provider}: ${allCases.length} cases (${cases.length} regression + ${heldoutCases.length} held-out), one warm-up each + ${rounds} measured rounds.`);
		const results = [];
		phase = 'warmup';
		for (const test of allCases) {
			const packet = await retrieveMemoryPacket(requestFor(test));
			assert.equal(warnings.length, 0, 'Retrieval fell back or warned; aborting this experiment');
			results.push({ ...evaluate(test, packet, cases.includes(test) ? 'regression' : 'heldout'), latencies: [] });
		}
		phase = 'measured';
		for (let iteration = 0; iteration < rounds; iteration++) {
			for (let offset = 0; offset < allCases.length; offset++) {
				const index = (offset + iteration * 7) % allCases.length;
				const start = performance.now();
				const packet = await retrieveMemoryPacket(requestFor(allCases[index]));
				results[index].latencies.push(round(performance.now() - start));
				assert.equal(warnings.length, 0, 'Retrieval fell back or warned; aborting this experiment');
				assert.deepEqual(packet.nodes.map((node) => node.id), results[index].selectedIds, `Unstable result: ${allCases[index].id}`);
			}
		}
		const summary = summarize(results);
		console.log(provider, JSON.stringify(summary));
		// Observe vector-only neighbors after timing, to distinguish embedding quality from final ranking.
		if (mode === semantic) for (const [index, test] of allCases.entries()) {
			const vector = queryVectors.get(memoryQueryTokens(test.query).join(' '));
			assert(vector, `No real query embedding recorded for ${test.id}`);
			const distance = sql`${schema.memoryNodes.embedding} <=> ${`[${vector.join(',')}]`}::vector`;
			results[index].vectorTop5 = await db.select({ id: schema.memoryNodes.id, distance }).from(schema.memoryNodes)
				.where(and(eq(schema.memoryNodes.storyId, storyId), test.request?.includeSecret ? undefined : sql`${schema.memoryNodes.visibility} in ('public', 'player_known')`))
				.orderBy(distance).limit(5);
		}
		modes.push({
			name: mode.name ?? provider,
			provider,
			model,
			dimensions,
			ranking: mode.ranking ?? 'default',
			summary,
			suites: {
				regression: summarize(results.filter((row) => row.suite === 'regression')),
				heldout: summarize(results.filter((row) => row.suite === 'heldout')),
			},
			groups: Object.fromEntries([...new Set(allCases.map((test) => test.group))].map((group) => [group, summarize(results.filter((row) => row.group === group))])),
			results,
		});
	}
	assert.equal(warnings.length, 0, 'Retrieval fell back or warned; benchmark is not valid');
	assert(modes.find((mode) => mode.name === 'local-hash')?.results.some((row) => row.trace.some((item) => item.signals.some((signal) => signal.startsWith('vector ')))), 'Vector path was not exercised');
	assert(!modes.find((mode) => mode.name === 'disabled')?.results.some((row) => row.trace.some((item) => item.signals.some((signal) => signal.startsWith('vector ')))), 'Text-only baseline unexpectedly used vectors');
	if (semantic) {
		assert.equal(apiUsage.filter((item) => item.phase === 'seed').length, Math.ceil(data.memories.length / 64));
		assert.equal(apiUsage.filter((item) => item.phase !== 'seed').length, allCases.length * (rounds + 1));
		const semanticMode = modes.find((mode) => mode.provider === semantic.provider && mode.model === semantic.model);
		assert(semanticMode?.results.some((row) => row.trace.some((item) => item.signals.some((signal) => signal.startsWith('vector ')))), 'Semantic vector path was not exercised');
	}
	const report = {
		createdAt: new Date().toISOString(), node: process.version, platform: process.platform, rounds,
		build: await harnessBuildId(root, ['scripts/bench-memory.mjs', 'src/lib/server/memory/retrieval.ts', 'src/lib/server/memory/ranking.ts', 'src/lib/server/memory/embeddings.ts']),
		fixtureSha256: createHash('sha256').update(await readFile(resolve(root, 'evals/memory/fixture.mjs'))).digest('hex'),
		gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
		sourceSha256: Object.fromEntries(await Promise.all(['retrieval', 'ranking', 'embeddings'].map(async (name) => [name,
			createHash('sha256').update(await readFile(resolve(root, `src/lib/server/memory/${name}.ts`))).digest('hex')]))),
		note: 'Working-tree retrieval code. Synthetic retrieval only; not extraction, chapter/arc rollups, Qdrant, or narrator behavior. Tokens use the production char/4 estimate. Rankings are observed through the top-32 retrieval trace. Latency excludes setup/seed/module loading and includes DB, query embedding, API response telemetry parsing, ranking, packet rendering. Serial warm queries, not a load test. Order: default hash, text-only, opt-in local-hash hybrid, optional semantic. vectorTop5 is a post-timing database diagnostic, not a change to ranking. Model dimensions differ from the hash baseline. The hybrid mode is controlled by MTHERIOS_MEMORY_RANKING_MODE and is not a saved production default.',
		measurementBoundary: {
			candidateRecall: 'reported per mode as recall1, recall5, recall10 and mrr from the production retrieval trace',
			packetAnswerRetention: 'reported per mode as answerRecall after packet rendering',
			downstreamNarratorUse: { status: 'not_measured', measured: false, reason: 'requires a provider-backed generation run with fixed prompts, settings, and a declared spend cap' },
		},
		apiUsage,
		providerSpend: { capUsd: spendCapUsd, reportedUsd: round(reportedSpendUsd), enforcement: semantic ? 'stop before the next provider request after cumulative reported usage exceeds cap' : 'no provider calls' },
		corpus: { stories: data.stories.length, memories: data.memories.length, transcriptEntries: data.entries.length, events: data.events.length, beliefs: data.beliefs.length }, modes,
	};
	const directory = resolve(root, 'evals/memory/results');
	await mkdir(directory, { recursive: true });
	const path = resolve(directory, `${report.createdAt.replace(/[:.]/g, '-')}.json`);
	await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`Report: ${path}`);
	for (const mode of modes) {
		for (const test of cases.filter(test => test.required)) {
			const result = mode.results.find(row => row.id === test.id);
			assert(result?.answerRecall === 1 && result.violations.length === 0 && result.budgetOk,
				`${mode.name}: required recall regression failed: ${test.id}`);
		}
	}
} finally {
	console.warn = originalWarn;
	globalThis.fetch = originalFetch;
	try { await client?.closeDb(); } finally {
		try { await vite?.close(); } finally {
			if (containerId) {
				const target = JSON.parse(docker('inspect', containerId))[0];
				assert.equal(target.Name, `/${containerName}`);
				assert.equal(target.Config.Labels['mtherios.memory-benchmark'], runId);
				docker('stop', '--time', '2', containerId);
				console.log('Disposable database removed; live database was not used.');
			}
		}
	}
}
