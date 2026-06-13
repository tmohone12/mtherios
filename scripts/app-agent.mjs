#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.PORT || '5173';
const DEFAULT_URL = process.env.MTHERIOS_APP_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

const SYSTEM_BRIEF = `Mtherios terminal agent

Authority model:
  - The terminal Node/SvelteKit process owns runtime and API orchestration.
  - Postgres is canon; transcript and source refs are evidence.
  - Qdrant and story vault/wiki files are rebuildable projections.
  - Browser IndexedDB is cache and queued UI intent, never canon.

Safe repair rule:
  Inspect first, patch records through /api/records, drain queued jobs, then reindex canon.
  Do not regenerate wiki vaults unless the operator asks for wiki sync.`;

async function main(argv = process.argv.slice(2)) {
	const flags = parseArgs(argv);
	const agent = new Agent(flags.url);
	if (flags.command.length > 0) {
		await agent.runLine(flags.command.join(' '));
		return;
	}
	await agent.loop();
}

function parseArgs(argv) {
	const flags = { url: DEFAULT_URL, command: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--url' && argv[index + 1]) flags.url = argv[++index];
		else if (arg.startsWith('--url=')) flags.url = arg.slice('--url='.length);
		else if (arg === '--help' || arg === '-h') {
			printStartupHelp(flags.url);
			process.exit(0);
		} else {
			flags.command.push(arg);
		}
	}
	flags.url = String(flags.url || DEFAULT_URL).replace(/\/$/, '');
	return flags;
}

class Agent {
	constructor(url) {
		this.url = url.replace(/\/$/, '');
		this.rl = null;
	}

	async loop() {
		console.log('');
		console.log(SYSTEM_BRIEF);
		console.log('');
		console.log(`app: ${this.url}`);
		console.log('type "help" for commands, "quit" to exit');
		console.log('');
		this.rl = readline.createInterface({ input, output });
		try {
			for (;;) {
				const line = await this.rl.question('mtherios> ');
				const keepGoing = await this.runLine(line);
				if (!keepGoing) break;
			}
		} finally {
			this.rl.close();
		}
	}

	async runLine(line) {
		const argv = splitCommand(line);
		if (argv.length === 0) return true;
		const command = argv[0].toLowerCase();
		const args = argv.slice(1);
		try {
			if (command === 'quit' || command === 'exit') return false;
			if (command === 'help' || command === '?') return this.help();
			if (command === 'system') return this.system();
			if (command === 'status') return this.status(args);
			if (command === 'stories') return this.stories();
			if (command === 'schema') return this.schema(args);
			if (command === 'jobs') return this.jobs(args);
			if (command === 'drain') return this.drain(args);
			if (command === 'record') return this.record(args);
			if (command === 'patch') return this.patch(args);
			if (command === 'reindex') return this.reindex(args);
			if (command === 'wiki') return this.wiki(args);
			if (command === 'fix') return this.fix(args);
			if (command === 'export') return this.export(args);
			if (command === 'import') return this.import(args);
			console.log(`Unknown command: ${command}`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
		}
		return true;
	}

	help() {
		console.log(`Commands
  system                         Print terminal/canon architecture brief
  status [storyId]               Backend, db, qdrant, wiki, and job health
  stories                        List terminal stories
  schema [file]                  Show database schema, or write JSON to file
  jobs [storyId]                 Show job backlog and failures
  drain [storyId]                Run due backend jobs until empty
  record <type> <id>             Fetch a canonical record
  patch <type> <id>              Patch a record with validated manual-edit metadata
  reindex <storyId>              Rebuild Qdrant/search projection from canon
  wiki <storyId> [--index]       Manually sync story vault/wiki projection
  fix <storyId>                  Drain jobs and reindex canon without wiki regen
  export <storyId> <file>        Export world database bundle
  import <file>                  Import a world database bundle
  quit                           Exit`);
		return true;
	}

	system() {
		console.log('');
		console.log(SYSTEM_BRIEF);
		console.log('');
		return true;
	}

	async status(args) {
		const storyId = args[0];
		const query = storyId ? `?storyId=${encodeURIComponent(storyId)}` : '';
		const payload = await this.request(`/api/app/status${query}`, { timeoutMs: 15_000 });
		const jobs = asRecord(payload.jobs);
		const services = asRecord(payload.services);
		const config = asRecord(payload.config);
		console.log('');
		console.log(`mode:     ${payload.mode ?? 'unknown'}`);
		console.log(`data:     ${config.dataRoot ?? 'unknown'}`);
		console.log(`database: ${config.databaseConfigured ? 'configured' : 'not configured'}`);
		console.log(`qdrant:   ${serviceText(services.qdrant)}`);
		console.log(`jobs:     total=${jobs.total ?? 0} ready=${jobs.ready ?? 0} failed=${jobs.failed ?? 0}`);
		console.log('');
	}

	async stories() {
		const payload = await this.request('/api/stories');
		const stories = Array.isArray(payload.stories) ? payload.stories : Array.isArray(payload) ? payload : [];
		if (stories.length === 0) {
			console.log('No stories returned.');
			return true;
		}
		for (const row of stories) {
			console.log(`${row.id ?? row.serverStoryId ?? 'unknown'}  ${row.title ?? 'Untitled'}  v${row.serverVersion ?? row.version ?? '-'}`);
		}
		return true;
	}

	async schema(args) {
		const payload = await this.request('/api/database/schema');
		if (args[0]) {
			const outputPath = path.resolve(args[0]);
			await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
			console.log(`Wrote schema to ${outputPath}`);
			return true;
		}
		console.log(`${payload.name ?? 'Mtherios'} v${payload.schemaVersion ?? '-'}`);
		for (const [name, table] of Object.entries(asRecord(payload.tables))) {
			console.log(`  ${name}: ${asRecord(table).purpose ?? ''}`);
		}
		return true;
	}

	async jobs(args) {
		const storyId = args[0];
		const query = storyId ? `?storyId=${encodeURIComponent(storyId)}&limit=50` : '?limit=50';
		const payload = await this.request(`/api/jobs${query}`);
		printJson(payload);
		return true;
	}

	async drain(args) {
		const storyId = args[0];
		let cycles = 0;
		for (;;) {
			cycles += 1;
			const result = await this.request('/api/app/jobs/run', {
				method: 'POST',
				body: {
					workerId: `app_agent_${Date.now()}_${cycles}`,
					limit: 50,
					...(storyId ? { storyId } : {}),
				},
				timeoutMs: 180_000,
			});
			const after = asRecord(result.after);
			console.log(`cycle ${cycles}: claimed=${result.claimed ?? 0} completed=${result.completed ?? 0} failed=${Array.isArray(result.failed) ? result.failed.length : 0} ready=${after.ready ?? 0}`);
			if (Number(result.claimed ?? 0) <= 0 || Number(after.ready ?? 0) <= 0 || cycles >= 50) break;
		}
		return true;
	}

	async record(args) {
		const [type, id] = args;
		if (!type || !id) throw new Error('record requires <type> <id>.');
		printJson(await this.request(`/api/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`));
		return true;
	}

	async patch(args) {
		const [type, id] = args;
		if (!type || !id) throw new Error('patch requires <type> <id>.');
		const updatesText = await this.ask('updates JSON> ');
		const reason = (await this.ask('reason [Manual database repair.]> ')).trim() || 'Manual database repair.';
		const updates = JSON.parse(updatesText);
		const payload = await this.request(`/api/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			body: { updates, reason },
			timeoutMs: 60_000,
		});
		printJson(payload);
		return true;
	}

	async reindex(args) {
		const storyId = args[0];
		if (!storyId) throw new Error('reindex requires <storyId>.');
		const payload = await this.request('/api/jobs/reindex-story', {
			method: 'POST',
			body: { storyId, runNow: true },
			timeoutMs: 180_000,
		});
		printJson(payload);
		return true;
	}

	async wiki(args) {
		const storyId = args[0];
		if (!storyId) throw new Error('wiki requires <storyId>.');
		const flags = new Set(args.slice(1));
		const payload = await this.request('/api/app/jobs/wiki', {
			method: 'POST',
			body: {
				storyId,
				runNow: true,
				index: flags.has('--index'),
				lint: flags.has('--lint'),
				recreate: flags.has('--recreate'),
			},
			timeoutMs: 180_000,
		});
		printJson(payload);
		return true;
	}

	async fix(args) {
		const storyId = args[0];
		if (!storyId) throw new Error('fix requires <storyId>.');
		console.log('Step 1: backend status');
		await this.status([storyId]);
		console.log('Step 2: drain due jobs');
		await this.drain([storyId]);
		console.log('Step 3: reindex canonical records');
		await this.reindex([storyId]);
		console.log('Fix pass complete. Wiki regeneration was skipped; run wiki <storyId> --index when you want that projection refreshed.');
		return true;
	}

	async export(args) {
		const [storyId, filePath] = args;
		if (!storyId || !filePath) throw new Error('export requires <storyId> <file>.');
		const payload = await this.request(`/api/export/${encodeURIComponent(storyId)}`, { timeoutMs: 120_000 });
		const outputPath = path.resolve(filePath);
		await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
		console.log(`Exported ${storyId} to ${outputPath}`);
		return true;
	}

	async import(args) {
		const filePath = args[0];
		if (!filePath) throw new Error('import requires <file>.');
		const raw = await fs.readFile(path.resolve(filePath), 'utf8');
		const parsed = JSON.parse(raw);
		const bundle = parsed && typeof parsed === 'object' && 'bundle' in parsed ? parsed.bundle : parsed;
		const payload = await this.request('/api/database/import', {
			method: 'POST',
			body: {
				bundle,
				options: {
					preserveIds: true,
					replaceExisting: false,
					syncWiki: false,
					source: 'app_agent',
				},
			},
			timeoutMs: 180_000,
		});
		printJson(payload);
		return true;
	}

	async ask(prompt) {
		if (!this.rl) throw new Error('Interactive input is not available in one-shot mode.');
		return this.rl.question(prompt);
	}

	async request(requestPath, options = {}) {
		const response = await fetch(`${this.url}${requestPath}`, {
			method: options.method ?? 'GET',
			headers: { 'Content-Type': 'application/json' },
			body: options.body ? JSON.stringify(options.body) : undefined,
			signal: AbortSignal.timeout(Number(options.timeoutMs ?? 30_000)),
		});
		const text = await response.text();
		let payload = {};
		if (text.trim()) {
			try {
				payload = JSON.parse(text);
			} catch {
				payload = { raw: text };
			}
		}
		if (!response.ok) {
			const message = typeof payload.error === 'string' ? payload.error : text;
			throw new Error(`HTTP ${response.status}${message ? ` - ${message}` : ''}`);
		}
		return payload;
	}
}

function splitCommand(line) {
	const args = [];
	let current = '';
	let quote = null;
	let escaped = false;
	for (const char of String(line || '')) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === '\\') {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = '';
			}
			continue;
		}
		current += char;
	}
	if (current) args.push(current);
	return args;
}

function serviceText(value) {
	const service = asRecord(value);
	if (service.ok) return `ok${service.status ? ` (${service.status})` : ''}`;
	return `down${service.error ? ` (${service.error})` : ''}`;
}

function asRecord(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function printJson(value) {
	console.log(JSON.stringify(value, null, 2));
}

function printStartupHelp(url) {
	console.log(`Mtherios terminal agent

Usage:
  npm run app:agent
  npm run app:agent -- --url http://127.0.0.1:5173
  node scripts/app-agent.mjs status

Default app URL: ${url}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
