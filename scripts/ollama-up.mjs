#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const url = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const bin = process.env.OLLAMA_BIN || 'ollama';
const timeoutMs = Number.parseInt(process.env.OLLAMA_START_TIMEOUT_MS || '15000', 10);

async function isUp() {
	try {
		const response = await fetch(`${url}/api/tags`);
		return response.ok;
	} catch {
		return false;
	}
}

async function waitUntilUp() {
	const deadline = Date.now() + Math.max(1000, timeoutMs);
	while (Date.now() < deadline) {
		if (await isUp()) return true;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

if (await isUp()) {
	console.log(`Ollama already running at ${url}`);
	process.exit(0);
}

fs.mkdirSync('logs', { recursive: true });
const out = fs.openSync(path.join('logs', 'ollama.out.log'), 'a');
const err = fs.openSync(path.join('logs', 'ollama.err.log'), 'a');

const child = spawn(bin, ['serve'], {
	detached: true,
	stdio: ['ignore', out, err],
	windowsHide: true,
});
child.unref();

if (await waitUntilUp()) {
	console.log(`Started Ollama at ${url}`);
	process.exit(0);
}

console.error(`Ollama did not become ready at ${url}. Check logs/ollama.err.log.`);
process.exit(1);
