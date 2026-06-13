#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
	buildStoryBootstrapCommandRequest,
	buildStoryEntriesCommandRequest,
	buildStoryMemoryCommandRequest,
	buildStoryTurnCommandRequest,
	unwrapEngineTurnCommand,
} from './app-story-core.mjs';

const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = process.env.PORT || '5173';
const DEFAULT_URL = process.env.MTHERIOS_APP_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const BOOLEAN_FLAGS = new Set([
	'includeSecret',
	'json',
	'yes',
	'wiki',
	'syncWiki',
	'indexWiki',
	'lintWiki',
	'recreateWiki',
	'dryRunWiki',
	'preserveIds',
	'rebuildMemoryNodes',
]);
const BOOTSTRAP_LIMIT_KEYS = [
	'entryLimit',
	'entityLimit',
	'relationshipLimit',
	'factionLimit',
	'factionMembershipLimit',
	'factionResourceLimit',
	'factionGoalLimit',
	'agreementLimit',
	'npcBeliefLimit',
	'threadLimit',
	'chapterLimit',
	'arcLimit',
	'sagaLimit',
	'eventLimit',
	'patchLimit',
	'memoryNodeLimit',
];

async function main(argv = process.argv.slice(2)) {
	const { command, flags, positional } = parseArgs(argv);
	const url = String(flags.url || DEFAULT_URL).replace(/\/$/, '');
	const json = flags.json === true;

	switch (command) {
		case 'list':
		case 'stories':
			return printStories(await requestJson(url, '/api/stories'), json);
		case 'create':
			return printCreated(await createStory(url, flags), json);
		case 'delete':
			return printDeleted(await deleteStory(url, flags), json);
		case 'bootstrap':
			return printBootstrap(await bootstrapStory(url, flags), json);
		case 'entries':
			return printEntries(await listEntries(url, flags), json);
		case 'dossier':
		case 'entity':
		case 'faction':
			return printDossier(await buildDossier(url, flags, positional, command), json);
		case 'export':
			return printExported(await exportStory(url, flags), json);
		case 'import':
			return printImported(await importStory(url, flags), json);
		case 'memory':
			return printMemory(await retrieveMemory(url, flags, positional), json);
		case 'turn':
			return printTurn(await runTurn(url, flags, positional), json);
		case 'help':
		case undefined:
			return printHelp();
		default:
			throw new Error(`Unknown app story command: ${command}`);
	}
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

function camelKey(value) {
	return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function lowerFirst(value) {
	return value ? value[0].toLowerCase() + value.slice(1) : value;
}

async function requestJson(baseUrl, path, options = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		...options,
		headers: {
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
			...(options.headers ?? {}),
		},
		signal: AbortSignal.timeout(Number(options.timeoutMs ?? 30_000)),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status} ${path}`);
	}
	return body;
}

async function createStory(url, flags) {
	const title = String(flags.title || '').trim();
	if (!title) throw new Error('create requires --title <name>.');
	return requestJson(url, '/api/stories', {
		method: 'POST',
		body: JSON.stringify({
			title,
			description: optionalString(flags.description),
			genre: optionalString(flags.genre),
			mode: optionalString(flags.mode) || 'adventure',
			clientStoryId: optionalString(flags.clientStoryId),
			headerPrompt: optionalString(flags.headerPrompt),
			playerReputation: optionalString(flags.playerReputation),
		}),
	});
}

async function deleteStory(url, flags) {
	const storyId = readStoryId(flags);
	return requestJson(url, `/api/stories/${encodeURIComponent(storyId)}`, { method: 'DELETE', timeoutMs: 60_000 });
}

async function bootstrapStory(url, flags) {
	const storyId = readStoryId(flags);
	const commandRequest = buildStoryBootstrapCommandRequest({
		storyId,
		...readBootstrapLimitFlags(flags),
	});
	return unwrapEngineTurnCommand(await requestJson(url, commandRequest.requestPath, {
		method: 'POST',
		body: JSON.stringify(commandRequest.body),
		timeoutMs: 60_000,
	}));
}

function readBootstrapLimitFlags(flags) {
	const limits = {};
	for (const key of BOOTSTRAP_LIMIT_KEYS) {
		const value = readNumber(flags[key]);
		if (typeof value === 'number') limits[key] = value;
	}
	return limits;
}

async function listEntries(url, flags) {
	const storyId = readStoryId(flags);
	const limit = readNumber(flags.limit);
	const beforePosition = readNumber(flags.beforePosition);
	const commandRequest = buildStoryEntriesCommandRequest({
		storyId,
		limit,
		beforePosition,
		branchId: optionalString(flags.branchId),
	});
	return unwrapEngineTurnCommand(await requestJson(url, commandRequest.requestPath, {
		method: 'POST',
		body: JSON.stringify(commandRequest.body),
	}));
}

async function buildDossier(url, flags, positional, command) {
	const bootstrap = await bootstrapStory(url, flags);
	const query = String(flags.name || flags.entity || flags.faction || positional.join(' ')).trim();
	if (!query) throw new Error(`${command} requires a name or id query.`);

	const entities = asArray(bootstrap.entities).map(asRecord);
	const factions = asArray(bootstrap.factions).map(asRecord);
	const memberships = asArray(bootstrap.factionMemberships).map(asRecord);
	const resources = asArray(bootstrap.factionResources).map(asRecord);
	const goals = asArray(bootstrap.factionGoals).map(asRecord);
	const relationships = asArray(bootstrap.relationships).map(asRecord);
	const beliefs = asArray(bootstrap.npcBeliefs).map(asRecord);
	const memories = asArray(bootstrap.memoryNodes).map(asRecord);
	const events = asArray(bootstrap.recentEvents).map(asRecord);
	const entity = command !== 'faction' ? findByNameOrId(entities, query) : null;
	const faction = findByNameOrId(factions, query)
		|| (entity ? factions.find((row) => row.entityId === entity.id || asArray(row.memberEntityIds).includes(entity.id)) : null)
		|| null;
	const linkedEntity = faction?.entityId ? entities.find((row) => row.id === faction.entityId) ?? null : null;
	const targetEntity = entity || linkedEntity;
	const entityIds = new Set([targetEntity?.id, faction?.entityId, faction?.id].filter(Boolean));
	const factionIds = new Set([faction?.id, faction?.name].filter(Boolean));

	return {
		storyId: bootstrap.story?.id ?? flags.story ?? flags.storyId,
		serverVersion: bootstrap.serverVersion,
		query,
		entity: targetEntity,
		faction,
		memberships: memberships.filter((row) =>
			(faction?.id && row.factionId === faction.id) ||
			(targetEntity?.id && row.entityId === targetEntity.id) ||
			(targetEntity?.name && normalizeLookup(asRecord(row.metadata).memberNameOrId) === normalizeLookup(targetEntity.name))
		),
		factionGoals: faction?.id ? goals.filter((row) => row.factionId === faction.id) : [],
		factionResources: faction?.id ? resources.filter((row) => row.factionId === faction.id) : [],
		relationships: relationships.filter((row) => entityIds.has(row.sourceEntityId) || entityIds.has(row.targetEntityId)),
		beliefsHeld: targetEntity?.id ? beliefs.filter((row) => row.believerEntityId === targetEntity.id) : [],
		beliefsAbout: targetEntity?.id ? beliefs.filter((row) => row.subjectEntityId === targetEntity.id) : [],
		events: events.filter((row) =>
			asArray(row.actorEntityIds).some((id) => entityIds.has(id)) ||
			asArray(row.targetEntityIds).some((id) => entityIds.has(id)) ||
			entityIds.has(row.locationId)
		),
		memoryNodes: memories.filter((row) =>
			asArray(row.entityIds).some((id) => entityIds.has(id)) ||
			asArray(row.factionIds).some((id) => factionIds.has(id))
		),
		entitiesById: Object.fromEntries(entities.map((row) => [row.id, row.name || row.id])),
		factionsById: Object.fromEntries(factions.map((row) => [row.id, row.name || row.id])),
	};
}

async function exportStory(url, flags) {
	const storyId = readStoryId(flags);
	const payload = await requestJson(url, `/api/export/${encodeURIComponent(storyId)}`, { timeoutMs: 120_000 });
	const outputPath = path.resolve(String(flags.out || flags.output || defaultExportName(payload)));
	await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
	return { outputPath, storyId, bundle: payload };
}

async function importStory(url, flags) {
	const filePath = optionalString(flags.file) || optionalString(flags.input);
	if (!filePath) throw new Error('import requires --file <path>.');
	const raw = await fs.readFile(path.resolve(filePath), 'utf8');
	const parsed = JSON.parse(raw);
	const bundle = parsed && typeof parsed === 'object' && 'bundle' in parsed ? parsed.bundle : parsed;
	const preserveIds = flags.preserveIds === undefined ? true : flags.preserveIds === true;
	const rebuildMemoryNodes = flags.rebuildMemoryNodes === undefined ? true : flags.rebuildMemoryNodes === true;
	return requestJson(url, '/api/import/indexeddb', {
		method: 'POST',
		body: JSON.stringify({
			bundle,
			options: {
				preserveIds,
				rebuildMemoryNodes,
			},
		}),
		timeoutMs: 180_000,
	});
}

async function retrieveMemory(url, flags, positional) {
	const storyId = readStoryId(flags);
	const query = String(flags.query || positional.join(' ')).trim();
	const commandRequest = buildStoryMemoryCommandRequest({
		storyId,
		query,
		sceneEntityIds: splitCsv(flags.sceneEntityIds),
		presentNpcIds: splitCsv(flags.presentNpcIds),
		threadIds: splitCsv(flags.threadIds),
		locationId: optionalString(flags.locationId),
		currentFactionId: optionalString(flags.currentFactionId),
		includeSecret: flags.includeSecret === true,
		tokenBudget: readNumber(flags.tokenBudget),
	});
	return unwrapEngineTurnCommand(await requestJson(url, commandRequest.requestPath, {
		method: 'POST',
		body: JSON.stringify(commandRequest.body),
	}));
}

function defaultExportName(payload) {
	const story = asRecord(payload.story);
	const title = String(story.title || story.id || 'mtherios-story')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 48) || 'mtherios-story';
	const date = new Date().toISOString().slice(0, 10);
	return `${title}-${date}.mtherios.json`;
}

async function runTurn(url, flags, positional, request = requestJson) {
	const storyId = readStoryId(flags);
	const playerText = String(flags.text || positional.join(' ')).trim();
	if (!playerText) throw new Error('turn requires player text.');
	const clientTurnId = optionalString(flags.clientTurnId) || `cli_${randomUUID()}`;
	const providerProfile = buildProviderProfile(flags);
	const turnArgs = {
		storyId,
		clientTurnId,
		playerText,
		localVersion: readNumber(flags.localVersion) ?? 0,
		...(providerProfile ? { providerProfile } : {}),
		generation: {
			model: optionalString(flags.model),
			temperature: readNumber(flags.temperature) ?? 1,
			maxTokens: readNumber(flags.maxTokens) ?? 4096,
		},
		clientContext: {
			locationId: optionalString(flags.locationId),
			sceneEntityIds: splitCsv(flags.sceneEntityIds),
			presentNpcIds: splitCsv(flags.presentNpcIds),
			threadIds: splitCsv(flags.threadIds),
			currentFactionId: optionalString(flags.currentFactionId),
		},
	};
	const commandRequest = buildStoryTurnCommandRequest(turnArgs);
	const turn = unwrapEngineTurnCommand(await request(url, commandRequest.requestPath, {
		method: 'POST',
		body: JSON.stringify(commandRequest.body),
		timeoutMs: 180_000,
	}));
	if (!shouldRefreshWiki(flags)) return turn;
	return {
		...turn,
		wikiJob: await refreshStoryWiki(url, storyId, flags),
	};
}

async function refreshStoryWiki(url, storyId, flags) {
	return requestJson(url, '/api/app/jobs/wiki', {
		method: 'POST',
		body: JSON.stringify({
			storyId,
			runNow: true,
			index: flags.indexWiki === true,
			lint: flags.lintWiki === true,
			recreate: flags.recreateWiki === true,
			dryRun: flags.dryRunWiki === true,
			clean: flags.cleanWiki !== false,
			thinChars: readNumber(flags.thinChars),
			orphanLayer: flags.orphanLayer === 'all' ? 'all' : 'derived',
		}),
		timeoutMs: 180_000,
	});
}

function shouldRefreshWiki(flags) {
	return flags.wiki === true
		|| flags.syncWiki === true
		|| flags.indexWiki === true
		|| flags.lintWiki === true
		|| flags.recreateWiki === true
		|| flags.dryRunWiki === true;
}

function buildProviderProfile(flags) {
	const providerType = optionalString(flags.providerType);
	if (!providerType) return null;
	const apiKey = optionalString(flags.apiKey)
		|| process.env[optionalString(flags.apiKeyEnv) || '']
		|| process.env.MTHERIOS_TURN_API_KEY
		|| '';
	return {
		id: optionalString(flags.providerId),
		name: optionalString(flags.providerName) || providerType,
		providerType,
		baseUrl: optionalString(flags.baseUrl),
		apiKey,
		customModels: [],
		fetchedModels: [],
		reasoningModels: [],
		hiddenModels: [],
		favoriteModels: [],
	};
}

function readStoryId(flags) {
	const storyId = String(flags.story || flags.storyId || '').trim();
	if (!storyId) throw new Error('Missing --story <storyId>.');
	return storyId;
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

function printStories(payload, json) {
	if (json) return printJson(payload);
	const stories = Array.isArray(payload.stories) ? payload.stories : [];
	console.log('');
	console.log('Mtherios terminal world databases');
	if (stories.length === 0) {
		console.log('  no stories found in the terminal database');
		console.log('');
		return;
	}
	for (const story of stories) {
		console.log(`  ${story.id}  v${story.serverVersion ?? 0}  ${story.title || 'Untitled'}`);
	}
	console.log('');
}

function printCreated(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	console.log(`Created backend story ${payload.storyId}`);
	console.log(`  server version: ${payload.serverVersion ?? 0}`);
	console.log(`  created:        ${payload.createdAt ?? 'unknown'}`);
	console.log('');
}

function printDeleted(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	console.log(`Deleted backend story ${payload.storyId}`);
	if (payload.artifactCleanup) {
		console.log(`  vault deleted:  ${payload.artifactCleanup.vaultDeleted ? 'yes' : 'no'}`);
		console.log(`  qdrant deleted: ${payload.artifactCleanup.qdrantDeleted === null ? 'unknown' : payload.artifactCleanup.qdrantDeleted ? 'yes' : 'no'}`);
	}
	console.log('');
}

function printBootstrap(payload, json) {
	if (json) return printJson(payload);
	const story = asRecord(payload.story);
	console.log('');
	console.log(`Story bootstrap: ${story.title || story.id || 'unknown'}`);
	console.log(`  version:   ${payload.serverVersion ?? 0}`);
	console.log(`  entries:   ${payload.entryCount ?? payload.entries?.length ?? 0}`);
	console.log(`  entities:  ${payload.entities?.length ?? 0}`);
	console.log(`  relations: ${payload.relationships?.length ?? 0}`);
	console.log(`  factions:  ${payload.factions?.length ?? 0}`);
	console.log(`  threads:   ${payload.threads?.length ?? 0}`);
	console.log(`  memories:  ${payload.memoryNodes?.length ?? 0}`);
	console.log('');
}

function printEntries(payload, json) {
	if (json) return printJson(payload);
	const entries = Array.isArray(payload.entries) ? payload.entries : [];
	console.log('');
	console.log(`Story entries: ${payload.storyId} v${payload.serverVersion ?? 0}`);
	if (entries.length === 0) {
		console.log('  no entries');
		console.log('');
		return;
	}
	for (const entry of entries) {
		console.log(`  ${entry.position ?? '?'} ${entry.type || 'entry'} ${entry.id || ''}`);
		console.log(`    ${snippet(entry.content || '', 140)}`);
	}
	if (payload.hasMore) console.log(`  more before position ${payload.nextBeforePosition}`);
	console.log('');
}

function printExported(payload, json) {
	if (json) return printJson({ outputPath: payload.outputPath, storyId: payload.storyId, bundle: payload.bundle });
	const story = asRecord(payload.bundle.story);
	console.log('');
	console.log(`Exported backend story: ${story.title || payload.storyId}`);
	console.log(`  file:      ${payload.outputPath}`);
	console.log(`  version:   ${story.serverVersion ?? payload.bundle.backendCanon?.story?.serverVersion ?? 0}`);
	console.log(`  entries:   ${payload.bundle.storyEntries?.length ?? 0}`);
	console.log(`  entities:  ${payload.bundle.lorebookEntries?.length ?? 0}`);
	console.log(`  events:    ${payload.bundle.backendCanon?.events?.length ?? payload.bundle.worldEvents?.length ?? 0}`);
	console.log('');
}

function printImported(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	console.log(`Imported backend story ${payload.storyId}`);
	console.log(`  server version: ${payload.serverVersion ?? 0}`);
	console.log(`  counts:         ${formatCounts(payload.counts)}`);
	if (payload.skipped?.length) console.log(`  skipped:        ${payload.skipped.length}`);
	if (payload.merged?.length) console.log(`  merged:         ${payload.merged.length}`);
	console.log('');
}

function printMemory(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	console.log(`Memory packet: ${payload.storyId}`);
	console.log(`  query:  ${payload.query ?? ''}`);
	console.log(`  nodes:  ${payload.nodes?.length ?? 0}`);
	console.log(`  tokens: ${payload.tokenEstimate ?? 0}`);
	if (payload.packet) {
		console.log('');
		console.log(payload.packet.trim());
	}
	console.log('');
}

function printDossier(payload, json) {
	if (json) return printJson({
		...payload,
		entitiesById: undefined,
		factionsById: undefined,
	});
	const entity = asRecord(payload.entity);
	const faction = asRecord(payload.faction);
	const entityName = optionalString(entity.name);
	const factionName = optionalString(faction.name);
	console.log('');
	console.log(`World database dossier: ${entityName || factionName || payload.query}`);
	console.log(`  story:   ${payload.storyId ?? 'unknown'} v${payload.serverVersion ?? 0}`);
	if (!entityName && !factionName) {
		console.log('  no matching entity or faction found');
		console.log('');
		return;
	}

	if (entityName) {
		console.log('');
		console.log(`Entity: ${entityName}`);
		console.log(`  id:          ${entity.id ?? '-'}`);
		console.log(`  type:        ${entity.type ?? '-'}`);
		console.log(`  status:      ${entity.status ?? '-'}`);
		console.log(`  visibility:  ${entity.visibility ?? '-'}`);
		if (entity.description) console.log(`  description: ${snippet(entity.description, 220)}`);
		const profile = profileLines(asRecord(entity.state));
		if (profile.length) {
			console.log('  profile:');
			for (const line of profile) console.log(`    - ${line}`);
		}
	}

	if (factionName) {
		console.log('');
		console.log(`Faction: ${factionName}`);
		console.log(`  id:       ${faction.id ?? '-'}`);
		console.log(`  pressure: ${faction.pressure ?? 0}`);
		if (faction.entityId) console.log(`  entity:   ${nameFor(faction.entityId, payload.entitiesById)}`);
		printRows('Goals', payload.factionGoals, (row) =>
			`${row.goal ?? '-'} (${['priority ' + (row.priority ?? 0), row.status, row.secrecy].filter(Boolean).join(', ')})`
		);
		printRows('Members', payload.memberships, (row) => {
			const member = row.entityId
				? nameFor(row.entityId, payload.entitiesById)
				: nameFor(asRecord(row.metadata).memberNameOrId, payload.entitiesById) || 'unknown member';
			const factionLabel = row.factionId ? nameFor(row.factionId, payload.factionsById) : factionName;
			return `${member} -> ${factionLabel} (${[row.role, row.rank, row.status].filter(Boolean).join(', ')})`;
		});
		printRows('Resources', payload.factionResources, (row) =>
			`${row.kind ?? 'resource'}: ${row.name ?? '-'}${row.amount != null ? ` = ${row.amount}` : ''} (${row.status ?? 'unknown'})`
		);
	}

	printRows('Relationships', payload.relationships, (row) =>
		`${nameFor(row.sourceEntityId, payload.entitiesById)} ${row.type ?? 'related-to'} ${nameFor(row.targetEntityId, payload.entitiesById)}${row.label ? ` - ${row.label}` : ''}`
	);
	printRows('Beliefs held', payload.beliefsHeld, (row) =>
		`about ${row.subjectEntityId ? nameFor(row.subjectEntityId, payload.entitiesById) : 'the situation'}: ${snippet(row.belief ?? '', 180)}`
	);
	printRows('Beliefs about', payload.beliefsAbout, (row) =>
		`${nameFor(row.believerEntityId, payload.entitiesById)} believes: ${snippet(row.belief ?? '', 180)}`
	);
	printRows('Recent events', payload.events, (row) => `${row.title ?? row.type ?? row.id}: ${snippet(row.body ?? '', 160)}`);
	printRows('Memory nodes', payload.memoryNodes, (row) => `${row.title ?? row.id} (${row.type ?? 'memory'}, importance ${row.importance ?? '?'})`);
	console.log('');
}

function printTurn(payload, json) {
	if (json) return printJson(payload);
	console.log('');
	console.log(`Terminal turn complete: database v${payload.serverVersion ?? 0}`);
	if (payload.warnings?.length) {
		console.log('  warnings:');
		for (const warning of payload.warnings) console.log(`    - ${warning}`);
	}
	console.log('');
	console.log(payload.narration || '(no narration)');
	console.log('');
	console.log(`  player entry:    ${payload.playerEntryId ?? '-'}`);
	console.log(`  assistant entry: ${payload.assistantEntryId ?? '-'}`);
	console.log(`  events:          ${payload.eventIds?.length ?? 0}`);
	console.log(`  memories:        ${payload.memoryNodeIds?.length ?? 0}`);
	if (payload.wikiJob) {
		const status = payload.wikiJob.job?.result?.status ?? payload.wikiJob.status ?? {};
		console.log(`  wiki:            ${payload.wikiJob.ok ? 'refreshed' : 'failed'}${status.vaultPath ? ` at ${status.vaultPath}` : ''}`);
		if (status.indexFresh !== undefined) console.log(`  qdrant:          ${status.indexFresh ? 'fresh' : 'stale or skipped'}`);
		if (status.lint) console.log(`  lint:            ${lintLabel(status.lint)}`);
	}
	console.log('');
}

function printRows(title, rows, formatter) {
	const clean = asArray(rows).map(asRecord);
	if (!clean.length) return;
	console.log('');
	console.log(`${title}:`);
	for (const row of clean.slice(0, 24)) console.log(`  - ${formatter(row)}`);
	if (clean.length > 24) console.log(`  - ... ${clean.length - 24} more`);
}

function asRecord(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function findByNameOrId(rows, query) {
	const normalized = normalizeLookup(query);
	return rows.find((row) =>
		String(row.id ?? '') === query ||
		normalizeLookup(row.id) === normalized ||
		normalizeLookup(row.name) === normalized ||
		normalizeLookup(row.title) === normalized
	) ?? null;
}

function normalizeLookup(value) {
	return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function nameFor(id, lookup) {
	if (!id) return '-';
	const record = asRecord(lookup);
	return String(record[id] || id);
}

function profileLines(state) {
	const lines = [];
	pushStateValue(lines, state, 'personality', 'personality');
	pushStateValue(lines, state, 'bio', 'bio');
	pushStateValue(lines, state, 'currentDisposition', 'disposition');
	pushStateValue(lines, state, 'personalOpinion', 'personal opinion');
	pushStateValue(lines, state, 'lastSeenLocation', 'last seen');
	pushStateList(lines, state, 'motivations', 'motivations');
	pushStateList(lines, state, 'goals', 'goals');
	pushStateList(lines, state, 'pressures', 'pressures');
	pushStateList(lines, state, 'knownFacts', 'known facts');
	pushStateList(lines, state, 'revealedSecrets', 'revealed secrets');
	return lines;
}

function pushStateValue(lines, state, key, label) {
	const value = optionalString(state[key]);
	if (value) lines.push(`${label}: ${snippet(value, 180)}`);
}

function pushStateList(lines, state, key, label) {
	const items = asArray(state[key]).map((item) => optionalString(item)).filter(Boolean);
	if (items.length) lines.push(`${label}: ${items.slice(0, 8).join('; ')}`);
}

function snippet(value, max) {
	const clean = String(value).replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function lintLabel(lint) {
	if (!lint.exists) return 'not run';
	const issueCount = typeof lint.issueCount === 'number' ? lint.issueCount : '?';
	if (!lint.fresh) return `stale, ${issueCount} issue(s)`;
	if (lint.ok === true) return 'healthy';
	if (lint.ok === false) return `${issueCount} issue(s)`;
	return `recorded, ${issueCount} issue(s)`;
}

function formatCounts(value) {
	const counts = asRecord(value);
	const entries = Object.entries(counts).filter(([, count]) => Number(count) > 0);
	if (entries.length === 0) return 'none';
	return entries.map(([key, count]) => `${key}=${count}`).join(', ');
}

function printJson(value) {
	console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
	console.log(`Usage:
  npm run app:story -- list [--json]
  npm run app:story -- create --title "Story title" [--description "..."]
  npm run app:story -- delete --story <storyId>
  npm run app:story -- export --story <storyId> [--out story.mtherios.json]
  npm run app:story -- import --file story.mtherios.json [--no-preserve-ids]
  npm run app:story -- bootstrap --story <storyId> [--json]
  npm run app:story -- entries --story <storyId> [--limit 20] [--json]
  npm run app:story -- dossier --story <storyId> "character or faction name" [--json]
  npm run app:story -- memory --story <storyId> "query" [--json]
  npm run app:story -- turn --story <storyId> "player action" [--wiki] [--lint-wiki] [--index-wiki] [--json]

Turn provider options:
  --provider-type <type>     openai, anthropic, openai-compatible, google-agent-platform, etc.
  --api-key-env <name>       Read provider API key from an environment variable.
  --api-key <key>            Provider API key. Prefer --api-key-env for shell history hygiene.
  --base-url <url>           OpenAI-compatible or provider bridge URL.
  --model <name>             Generation model.

Turn wiki options:
  --wiki                     Materialize the story vault after the turn.
  --sync-wiki                Alias for --wiki.
  --lint-wiki                Materialize and lint the story vault after the turn.
  --index-wiki               Materialize and index the story vault into Qdrant after the turn.
  --recreate-wiki            Recreate the Qdrant collection while indexing.
  --no-clean-wiki            Preserve existing vault files instead of rewriting the vault cleanly.

General options:
  --url <url>                Running Mtherios terminal app URL. Default: ${DEFAULT_URL}
  --story <id>               Terminal world database/story id.
  --file <path>              Import source for app:story import.
  --out <path>               Export destination for app:story export.
  --no-preserve-ids          Import into a new backend story id instead of preserving the exported id.
  --json                     Print raw JSON.
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

export {
	main,
	runTurn,
};
