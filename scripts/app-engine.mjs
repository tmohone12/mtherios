#!/usr/bin/env node
// @ts-nocheck

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.PORT || '5173';
const DEFAULT_URL = process.env.MTHERIOS_APP_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const BOOLEAN_FLAGS = new Set(['json', 'includeSecret', 'execute']);

export async function main(argv = process.argv.slice(2)) {
	const payload = buildEngineCommandPayload(argv);
	if (payload.help) {
		console.log(formatEngineHelp());
		return;
	}
	const result = await requestJson(payload.url, payload.requestPath, {
		method: 'POST',
		body: JSON.stringify(payload.body),
		timeoutMs: payload.timeoutMs,
	});
	printResult(result, payload);
}

export function buildEngineCommandPayload(argv = []) {
	const { command: rawCommand, flags, positional } = parseArgs(argv);
	if (isHelpCommand(rawCommand, flags)) {
		return {
			help: true,
			url: String(flags.url || DEFAULT_URL).replace(/\/$/, ''),
			requestPath: '',
			json: flags.json === true,
			timeoutMs: 0,
			body: {},
		};
	}
	const storyId = readStoryId(flags);
	const command = normalizeCommand(rawCommand, flags);
	const clientCommandId = optionalString(flags.clientCommandId) || `cli_cmd_${randomUUID()}`;
	const args = buildCommandArgs(command, flags, positional, clientCommandId);

	return {
		url: String(flags.url || DEFAULT_URL).replace(/\/$/, ''),
		requestPath: '/api/engine/command',
		json: flags.json === true,
		timeoutMs: command === 'turn.submit' || command === 'orchestrator.run' ? 180_000 : 60_000,
		body: {
			storyId,
			command,
			clientCommandId,
			args,
		},
	};
}

export function formatEngineHelp() {
	return `Usage:
  npm run app:engine -- status --story <storyId> [--json]
  npm run app:engine -- cache --story <storyId> [--segments] [--segment-limit 25] [--kind rules_pack] [--json]
  npm run app:engine -- page:read --story <storyId> --kind character_page --name "Mira" [--json]
  npm run app:engine -- page:write --story <storyId> --kind character_page --name "Mira" --body "## Notes" [--entity-ids npc_mira]
  npm run app:engine -- timeline:brief --story <storyId> [--present-npc-ids npc_a,npc_b] [--include-secret]
  npm run app:engine -- timeline:schedule --story <storyId> --type alliance --title "Marriage alliance" --body "Two factions bind themselves." [--delay-turns 2]
  npm run app:engine -- timeline:advance --story <storyId> [--delta 1]
  npm run app:engine -- orchestrate --story <storyId> --goal "Prepare the next response" [--execute] "player action"
  npm run app:engine -- prepare --story <storyId> "player action"
  npm run app:engine -- turn --story <storyId> "player action"
  npm run app:engine -- command --story <storyId> --command timeline.brief --args '{"includeSecret":true}'

All commands post to /api/engine/command so browser, CLI, MCP tools, and shell usage share the same terminal-owned backend.`;
}

function buildCommandArgs(command, flags, positional, clientCommandId) {
	if (optionalString(flags.args)) return parseJsonFlag(flags.args);
	switch (command) {
		case 'campaign.status':
			return {};
		case 'campaign.cacheStatus':
			return compactObject({
				includeSegments: flags.segments === true || flags.includeSegments === true ? true : undefined,
				segmentLimit: readNumber(flags.segmentLimit),
				kind: optionalString(flags.kind),
			});
		case 'campaign.page.read':
			return compactObject({
				kind: requiredString(flags.kind, 'kind'),
				name: optionalString(flags.name),
				path: optionalString(flags.path),
			});
		case 'campaign.page.write':
			return compactObject({
				kind: requiredString(flags.kind, 'kind'),
				name: requiredString(flags.name, 'name'),
				title: optionalString(flags.title),
				body: optionalString(flags.body) || positional.join(' ').trim(),
				tags: splitCsv(flags.tags),
				entityIds: splitCsv(flags.entityIds),
				factionIds: splitCsv(flags.factionIds),
				sourceEntryIds: splitCsv(flags.sourceEntryIds),
				sourceEventIds: splitCsv(flags.sourceEventIds),
				sourcePatchIds: splitCsv(flags.sourcePatchIds),
				path: optionalString(flags.path),
				metadata: parseJsonFlag(flags.metadata),
				serverVersion: readNumber(flags.serverVersion),
			});
		case 'timeline.brief':
			return compactObject({
				currentTurn: readNumber(flags.currentTurn),
				presentNpcIds: splitCsv(flags.presentNpcIds),
				sceneEntityIds: splitCsv(flags.sceneEntityIds),
				includeSecret: flags.includeSecret === true ? true : undefined,
				recentLimit: readNumber(flags.recentLimit),
				scheduledLimit: readNumber(flags.scheduledLimit),
				dueLimit: readNumber(flags.dueLimit),
				npcLimit: readNumber(flags.npcLimit),
				npcEventLimit: readNumber(flags.npcEventLimit),
			});
		case 'timeline.schedule':
			return compactObject({
				type: requiredString(flags.type, 'type'),
				title: requiredString(flags.title, 'title'),
				body: optionalString(flags.body) || positional.join(' ').trim() || requiredString(flags.body, 'body'),
				delayTurns: readNumber(flags.delayTurns) ?? 0,
				currentTurn: readNumber(flags.currentTurn),
				currentWorldTime: optionalString(flags.currentWorldTime),
				worldTime: optionalString(flags.worldTime),
				actorEntityIds: splitCsv(flags.actorEntityIds),
				targetEntityIds: splitCsv(flags.targetEntityIds),
				actorNpcEntityIds: splitCsv(flags.actorNpcIds || flags.actorNpcEntityIds),
				targetNpcEntityIds: splitCsv(flags.targetNpcIds || flags.targetNpcEntityIds),
				locationId: optionalString(flags.locationId),
				locationIds: splitCsv(flags.locationIds),
				factionIds: splitCsv(flags.factionIds),
				threadIds: splitCsv(flags.threadIds),
				visibility: optionalString(flags.visibility),
				memoryImpact: parseJsonFlag(flags.memoryImpact),
				sourceEntryIds: splitCsv(flags.sourceEntryIds),
				sourcePatchIds: splitCsv(flags.sourcePatchIds),
				metadata: parseJsonFlag(flags.metadata),
				serverVersion: readNumber(flags.serverVersion),
			});
		case 'timeline.advance':
			return compactObject({
				delta: readNumber(flags.delta) ?? 1,
				presentNpcIds: splitCsv(flags.presentNpcIds),
				sceneEntityIds: splitCsv(flags.sceneEntityIds),
				includeSecret: flags.includeSecret === true ? true : undefined,
				recentLimit: readNumber(flags.recentLimit),
				scheduledLimit: readNumber(flags.scheduledLimit),
				dueLimit: readNumber(flags.dueLimit),
				npcLimit: readNumber(flags.npcLimit),
				npcEventLimit: readNumber(flags.npcEventLimit),
				serverVersion: readNumber(flags.serverVersion),
			});
		case 'orchestrator.run': {
			const playerText = optionalString(flags.text) || positional.join(' ').trim();
			return compactObject({
				mode: optionalString(flags.mode),
				goal: requiredString(flags.goal, 'goal'),
				playerText,
				clientTurnId: optionalString(flags.clientTurnId) || (playerText ? clientCommandId : undefined),
				roles: splitCsv(flags.roles),
				execute: flagBoolean(flags.execute),
				maxToolCalls: readNumber(flags.maxToolCalls),
				context: compactObject({
					locationId: optionalString(flags.locationId),
					sceneEntityIds: splitCsv(flags.sceneEntityIds),
					presentNpcIds: splitCsv(flags.presentNpcIds),
					threadIds: splitCsv(flags.threadIds),
					currentFactionId: optionalString(flags.currentFactionId),
					memoryTokenBudget: readNumber(flags.memoryTokenBudget),
					contextBudget: readNumber(flags.contextBudget),
					includeSecret: flags.includeSecret === true ? true : undefined,
					currentTurn: readNumber(flags.currentTurn),
					entryLimit: readNumber(flags.entryLimit),
				}),
			});
		}
		case 'turn.prepare': {
			const playerText = optionalString(flags.text) || positional.join(' ').trim();
			if (!playerText) throw new Error('prepare requires player text.');
			return compactObject({
				playerText,
				clientTurnId: optionalString(flags.clientTurnId) || clientCommandId,
				localVersion: readNumber(flags.localVersion),
				clientContext: compactObject({
					locationId: optionalString(flags.locationId),
					sceneEntityIds: splitCsv(flags.sceneEntityIds),
					presentNpcIds: splitCsv(flags.presentNpcIds),
					threadIds: splitCsv(flags.threadIds),
					currentFactionId: optionalString(flags.currentFactionId),
					memoryTokenBudget: readNumber(flags.memoryTokenBudget),
					contextBudget: readNumber(flags.contextBudget),
				}),
			});
		}
		case 'turn.submit': {
			const playerText = optionalString(flags.text) || positional.join(' ').trim();
			if (!playerText) throw new Error('turn requires player text.');
			return compactObject({
				playerText,
				clientTurnId: optionalString(flags.clientTurnId) || clientCommandId,
				localVersion: readNumber(flags.localVersion),
				clientContext: compactObject({
					locationId: optionalString(flags.locationId),
					sceneEntityIds: splitCsv(flags.sceneEntityIds),
					presentNpcIds: splitCsv(flags.presentNpcIds),
					threadIds: splitCsv(flags.threadIds),
					currentFactionId: optionalString(flags.currentFactionId),
					memoryTokenBudget: readNumber(flags.memoryTokenBudget),
					contextBudget: readNumber(flags.contextBudget),
					deferStateExtraction: flagBoolean(flags.deferStateExtraction),
				}),
			});
		}
		default:
			return {};
	}
}

function normalizeCommand(rawCommand, flags) {
	const explicit = optionalString(flags.command);
	if (explicit) return explicit;
	switch (rawCommand) {
		case 'status':
		case 'campaign:status':
		case undefined:
			return 'campaign.status';
		case 'cache':
		case 'campaign:cache':
			return 'campaign.cacheStatus';
		case 'page:read':
		case 'campaign:page:read':
		case 'vault:read':
			return 'campaign.page.read';
		case 'page:write':
		case 'campaign:page:write':
		case 'vault:write':
			return 'campaign.page.write';
		case 'timeline':
		case 'brief':
		case 'timeline:brief':
			return 'timeline.brief';
		case 'schedule':
		case 'timeline:schedule':
			return 'timeline.schedule';
		case 'advance':
		case 'timeline:advance':
			return 'timeline.advance';
		case 'orchestrate':
		case 'orchestrator':
		case 'orchestrator:run':
			return 'orchestrator.run';
		case 'prepare':
		case 'turn:prepare':
			return 'turn.prepare';
		case 'turn':
			return 'turn.submit';
		case 'command':
			return requiredString(flags.command, 'command');
		default:
			return rawCommand;
	}
}

function isHelpCommand(rawCommand, flags) {
	return rawCommand === 'help' || rawCommand === '--help' || flags.help === true || flags.h === true;
}

async function requestJson(baseUrl, requestPath, options = {}) {
	const response = await fetch(`${baseUrl}${requestPath}`, {
		...options,
		headers: {
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
			...(options.headers ?? {}),
		},
		signal: AbortSignal.timeout(Number(options.timeoutMs ?? 60_000)),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status} ${requestPath}`);
	}
	return body;
}

function parseArgs(argv) {
	const flags = {};
	const positional = [];
	let command;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith('--') && !command) {
			command = arg;
			continue;
		}
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}

		const raw = arg.slice(2);
		const eq = raw.indexOf('=');
		const key = camelKey(eq === -1 ? raw : raw.slice(0, eq));
		const inlineValue = eq === -1 ? null : raw.slice(eq + 1);
		if (key.startsWith('no')) {
			flags[lowerFirst(key.slice(2))] = false;
		} else if (inlineValue !== null) {
			flags[key] = inlineValue;
		} else if (BOOLEAN_FLAGS.has(key)) {
			flags[key] = true;
		} else if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
			flags[key] = argv[index + 1];
			index += 1;
		} else {
			flags[key] = true;
		}
	}
	return { command, flags, positional };
}

function compactObject(record) {
	const output = {};
	for (const [key, value] of Object.entries(record)) {
		if (value === undefined || value === null || value === '') continue;
		if (Array.isArray(value) && value.length === 0) continue;
		if (isPlainObject(value) && Object.keys(value).length === 0) continue;
		output[key] = value;
	}
	return output;
}

function parseJsonFlag(value) {
	const text = optionalString(value);
	if (!text) return undefined;
	const parsed = JSON.parse(text);
	if (!isPlainObject(parsed)) throw new Error('JSON flag value must be an object.');
	return parsed;
}

function flagBoolean(value) {
	return typeof value === 'boolean' ? value : undefined;
}

function readStoryId(flags) {
	const storyId = optionalString(flags.story || flags.storyId);
	if (!storyId) throw new Error('Missing --story <storyId>.');
	return storyId;
}

function requiredString(value, name) {
	const clean = optionalString(value);
	if (!clean) throw new Error(`Missing --${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}.`);
	return clean;
}

function optionalString(value) {
	if (value === undefined || value === null || value === false || value === true) return undefined;
	const clean = String(value).trim();
	return clean || undefined;
}

function readNumber(value) {
	if (value === undefined || value === null || value === false || value === true) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function splitCsv(value) {
	const text = optionalString(value);
	return text ? text.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function camelKey(value) {
	return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function lowerFirst(value) {
	return value ? value[0].toLowerCase() + value.slice(1) : value;
}

function isPlainObject(value) {
	return value && typeof value === 'object' && !Array.isArray(value);
}

export function printResult(result, payload) {
	if (payload.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log('');
	console.log(`Engine command ${result.command ?? payload.body.command}: ${result.status ?? 'unknown'}`);
	console.log(`  story:   ${result.storyId ?? payload.body.storyId}`);
	console.log(`  command: ${result.commandId ?? payload.body.clientCommandId}`);
	if (result.error) console.log(`  error:   ${result.error}`);
	if (result.status === 'succeeded' && result.projectionChanges?.timeline) {
		const timeline = result.projectionChanges.timeline;
		console.log(`  turn:    ${timeline.currentTurn ?? 'unknown'}`);
		console.log(`  due:     ${Array.isArray(timeline.dueEvents) ? timeline.dueEvents.length : 0}`);
		console.log(`  future:  ${Array.isArray(timeline.scheduledEvents) ? timeline.scheduledEvents.length : 0}`);
	}
	if (result.command === 'turn.submit' && result.result?.narration) {
		console.log('');
		console.log(String(result.result.narration).trim());
	}
	if (result.command === 'turn.submit' && result.result?.performance) {
		const performance = result.result.performance;
		const cache = performance.cache;
		const generation = performance.generation;
		console.log('');
		console.log(`  performance: prepared-cache ${performance.preparedCacheHit ? 'hit' : 'miss'}`);
		if (performance.prompt) {
			console.log(`  prompt: ${performance.prompt.tokenEstimate ?? 0} tokens, ${performance.prompt.totalChars ?? 0} chars, ${performance.prompt.messageCount ?? 0} messages`);
		}
		if (cache) {
			console.log(`  cache: ${cache.hitCount ?? 0} hits, ${cache.missCount ?? 0} misses, ${cache.segmentCount ?? 0} segments, ${cache.tokenEstimate ?? 0} tokens`);
		}
		if (generation) {
			console.log(`  generation: ${generation.durationMs ?? 0}ms, tokens ${generation.requestTokens ?? 'n/a'} in / ${generation.responseTokens ?? 'n/a'} out / ${generation.totalTokens ?? 'n/a'} total`);
		}
		if (Array.isArray(performance.slowTimings) && performance.slowTimings.length > 0) {
			for (const timing of performance.slowTimings.slice(0, 5)) {
				console.log(`  slow: ${timing.operation} ${timing.durationMs}ms`);
			}
		}
	}
	console.log('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
