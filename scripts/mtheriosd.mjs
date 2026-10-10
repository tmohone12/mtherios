#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initVault } from './wiki-core/lib/init.mjs';

import { resolveRuntimeOptions, buildRuntimeEnv, safeRuntimeSummary } from './runtime-config.mjs';
import { readBuildIdentity } from './build.mjs';

export async function main(argv = process.argv.slice(2)) {
	const options = resolveRuntimeOptions(argv);
	if (options.printConfig) { console.log(JSON.stringify(safeRuntimeSummary(options), null, 2)); return; }
	await prepareDataRoot(options);
	const env = buildRuntimeEnv(options);
	await startLocalModels(options, env);

	printBanner(options);

	if (options.dev) {
		await runDevServer(options, env);
		return;
	}

	await runBuiltServer(options, env);
}

async function startLocalModels(options, env) {
	if (options.localEmbeddingsEnabled && (options.wikiEmbedProvider === 'ollama' || options.memoryEmbeddingProvider === 'ollama')) {
		if (!await localEndpointUp(`${options.ollamaUrl.replace(/\/$/, '')}/api/tags`)) {
			const child = spawn('ollama', ['serve'], { cwd: options.cwd, env, stdio: 'ignore', windowsHide: true, detached: true });
			child.on('error', error => console.warn(`[models] Ollama could not start: ${error.message}`));
			child.unref();
			if (child.pid) {
				await fs.mkdir(path.join(options.dataRoot, 'models'), { recursive: true });
				await fs.writeFile(path.join(options.dataRoot, 'models', 'ollama.pid'), String(child.pid));
			}
			console.log('[models] starting Ollama for local embeddings');
		}
	}
	if (!options.localKevEnabled) return;
	const kevDir = path.join(options.dataRoot, 'models', 'kev');
	const python = path.join(kevDir, process.platform === 'win32' ? '.venv-rocm/Scripts/python.exe' : '.venv/bin/python');
	if (!fssync.existsSync(python)) return;
	const pidPath = path.join(kevDir, 'serve.pid');
	const previousPid = Number(await fs.readFile(pidPath, 'utf8').catch(() => ''));
	if (previousPid && processAlive(previousPid)) return;
	if (await localEndpointUp('http://127.0.0.1:8008/v1/models')) return;
	const stdout = fssync.openSync(path.join(options.dataRoot, 'logs', 'kev.stdout.log'), 'a');
	const stderr = fssync.openSync(path.join(options.dataRoot, 'logs', 'kev.stderr.log'), 'a');
	const child = spawn(python, ['-m', 'kev.serve', '--run', 'jaredpalmer/kev-9b', '--port', '8008'], {
		cwd: kevDir, windowsHide: true, detached: true, stdio: ['ignore', stdout, stderr],
		env: { ...env, HF_HOME: env.HF_HOME || path.join(options.dataRoot, 'models', 'hf'),
			KEV_PREFIX_CACHE: env.KEV_PREFIX_CACHE ?? '0', KEV_CUDA_GRAPHS: env.KEV_CUDA_GRAPHS ?? '0', KEV_FUSED: env.KEV_FUSED ?? '0' },
	});
	fssync.closeSync(stdout);
	fssync.closeSync(stderr);
	child.on('error', error => console.warn(`[models] Kev could not start: ${error.message}`));
	child.unref();
	if (child.pid) await fs.writeFile(pidPath, String(child.pid));
	console.log('[models] starting local Kev-9B decision server');
}

async function localEndpointUp(url) {
	try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; }
	catch { return false; }
}

function processAlive(pid) {
	try { process.kill(pid, 0); return true; }
	catch { return false; }
}

async function prepareDataRoot(options) {
	await fs.mkdir(options.dataRoot, { recursive: true });
	await fs.mkdir(options.vaultRoot, { recursive: true });
	await fs.mkdir(options.defaultVault, { recursive: true });
	await fs.mkdir(path.join(options.dataRoot, 'exports'), { recursive: true });
	await fs.mkdir(path.join(options.dataRoot, 'uploads'), { recursive: true });
	await fs.mkdir(path.join(options.dataRoot, 'logs'), { recursive: true });

	await initVault(options.defaultVault, {
		title: 'MythEngine Default Vault',
		description: 'Default standalone Obsidian-style vault for terminal-owned lore sources, maintained wiki pages, and local LLM search.',
		owner: 'MythEngine terminal app process',
	});
}

function printBanner(options) {
	console.log('');
	console.log('MythEngine terminal app process');
	console.log(`  app:      http://${options.host}:${options.port}`);
	console.log(`  local AI: Kev ${options.localKevEnabled ? 'on' : 'off'}, Ollama/embeddings ${options.localEmbeddingsEnabled ? 'on' : 'off'}`);
	console.log(`  data:     ${options.dataRoot}`);
	console.log(`  vaults:   ${options.vaultRoot}`);
	console.log(`  default:  ${options.defaultVault}`);
	console.log(`  qdrant:   ${options.qdrantUrl} / ${options.qdrantCollection}`);
	console.log(`  database: ${redactDatabaseUrl(options.databaseUrl)}`);
	console.log(`  jobs:     ${options.jobWorker ? `enabled (${options.jobWorkerScope}) every ${options.jobIntervalMs}ms, limit ${options.jobBatchLimit}, timeout ${options.jobTimeoutMs}ms` : 'disabled'}`);
	console.log(`  wiki:     ${options.wikiEmbedProvider} / ${options.wikiEmbedModel}, auto-index ${options.wikiAutoIndexStoryVaults ? 'on' : 'off'}`);
	console.log(`  memory:   chapters every ${options.chapterThreshold} completed turns, arcs every ${options.chaptersPerArc} chapters`);
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
	const stopChapters = startChapterRunner(options);
	try {
		await waitForChild(child);
	} finally {
		stopJobs();
		stopChapters();
	}
}

async function runBuiltServer(options, env) {
	const handlerPath = path.join(options.cwd, 'build', 'handler.js');
	if (!fssync.existsSync(handlerPath)) {
		throw new Error('Missing build/handler.js. Run `npm run build` before `npm run app:start`.');
	}

	const build = readBuildIdentity(options.cwd);
	Object.assign(env, {
		ORIGIN: env.ORIGIN ?? new URL(options.appUrl).origin,
		MYTHENGINE_BUILD_SOURCE: 'local-checkout',
		MYTHENGINE_BUILD_ID: build.sourceSha256,
		MYTHENGINE_BUILD_ARTIFACT: build.artifactSha256,
	});
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

	console.log(`MythEngine is listening on http://${options.host}:${options.port}`);
	startJobWorker(options);
	startChapterRunner(options);
}

/** Separate loop for one explicitly configured story; no backend queue recovery. */
export function startChapterRunner(options,{request=fetch,setTimer=setTimeout}={}) {
	if(!options.chapterRunnerEnabled)return ()=>{};
	if(!options.chapterRunnerStoryId)throw new Error('Chapter-only runner requires a story ID.');
	let stopped=false,timer;
	const endpoint=`http://${options.host}:${options.port}/api/app/chapters`;
	const tick=async()=>{
		if(stopped)return;
		try {
			const response=await request(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
				body:JSON.stringify({action:'tick',storyId:options.chapterRunnerStoryId}),signal:AbortSignal.timeout(9*60000)});
			if(!response.ok)console.warn(`[chapters] status ${response.status}; review the Chapters panel.`);
		}catch{console.warn('[chapters] Waiting for chapter-only endpoint; review the Chapters panel.');}
		finally{if(!stopped){timer=setTimer(tick,60000);timer.unref?.();}}
	};
	timer=setTimer(tick,60000);timer.unref?.();
	return ()=>{stopped=true;clearTimeout(timer);};
}

function startJobWorker(options) {
	if (!options.jobWorker) return () => {};
	let stopped = false;
	let timer = null;
	let consecutiveErrors = 0;
	const endpoint = `http://${options.host}:${options.port}/api/app/jobs/run`;
	const workerId = `mythengined_${process.pid}`;

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
				body: JSON.stringify({ workerId, limit: options.jobBatchLimit, scope: options.jobWorkerScope }),
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
			if (code && code !== 0) reject(new Error(`MythEngine dev child exited with code ${code}`));
			else if (signal) reject(new Error(`MythEngine dev child exited from signal ${signal}`));
			else resolve();
		});
		child.once('error', reject);
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main(process.argv.slice(2));
}
