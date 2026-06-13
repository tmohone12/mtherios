// @ts-check

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalString(value) {
	if (value === undefined || value === null || value === false || value === true) return undefined;
	const clean = String(value).trim();
	return clean || undefined;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function nonnegativeInteger(value, fallback) {
	const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInteger(value, fallback) {
	const parsed = nonnegativeInteger(value, fallback);
	return parsed > 0 ? parsed : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function positiveIntegerCapped(value, fallback, max) {
	return Math.min(max, positiveInteger(value, fallback));
}

/**
 * @returns {number}
 */
function nowMs() {
	return typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();
}

/**
 * @returns {number | null}
 */
function heapUsedBytes() {
	if (typeof process === 'undefined' || typeof process.memoryUsage !== 'function') return null;
	return process.memoryUsage().heapUsed;
}

/**
 * @param {number} position
 * @param {'user_action' | 'narration'} type
 * @returns {{ id: string; type: 'user_action' | 'narration'; position: number; content: string; createdAt: number }}
 */
function seededEntry(position, type) {
	const turn = Math.floor(position / 2) + 1;
	return {
		id: `${type === 'user_action' ? 'user' : 'narration'}_${turn}`,
		type,
		position,
		content: type === 'user_action'
			? `Turn ${turn}: the player presses the world for a concrete response.`
			: `Turn ${turn}: the world answers with bounded, append-only evidence.`,
		createdAt: turn,
	};
}

/**
 * @param {Array<{ key: string; hash: string; tokens: number }>} segments
 * @param {Map<string, string>} cache
 * @returns {{ hits: number; misses: number; tokenEstimate: number; changedKeys: string[] }}
 */
function assemblePromptSegments(segments, cache) {
	let hits = 0;
	let misses = 0;
	let tokenEstimate = 0;
	const changedKeys = [];
	for (const segment of segments) {
		tokenEstimate += segment.tokens;
		const cacheHash = cache.get(segment.key);
		if (cacheHash === segment.hash) {
			hits += 1;
		} else {
			misses += 1;
			changedKeys.push(segment.key);
			cache.set(segment.key, segment.hash);
		}
	}
	return { hits, misses, tokenEstimate, changedKeys };
}

/**
 * Deterministic harness for the first long-campaign performance target.
 * This does not call an LLM; it verifies that the local control-surface and
 * prompt assembly windows stay bounded when the campaign has 10k turns.
 *
 * @param {Record<string, unknown>} input
 * @returns {Record<string, unknown>}
 */
export function buildLongCampaignBenchmark(input = {}) {
	const args = asRecord(input);
	const turns = positiveInteger(args.turns, 10_000);
	const entryLimit = Math.min(500, positiveInteger(args.entryLimit, 80));
	const promptLimit = Math.min(1_000, positiveInteger(args.promptLimit, 120));
	const started = nowMs();
	const heapBefore = heapUsedBytes();

	const entries = [];
	for (let i = 0; i < turns; i += 1) {
		entries.push(seededEntry(i * 2, 'user_action'));
		entries.push(seededEntry(i * 2 + 1, 'narration'));
	}

	const projectionEntries = entries.slice(-entryLimit);
	const promptEntries = entries.slice(-promptLimit);
	const stableSegments = [
		{ key: 'rules_pack:core', hash: 'rules_v1', tokens: 1_200 },
		{ key: 'tool_schemas:engine', hash: 'tools_v1', tokens: 900 },
		{ key: 'lore_brief:world', hash: 'lore_v1', tokens: 1_100 },
		{ key: 'character_sheet:party', hash: 'characters_v1', tokens: 1_400 },
	];
	const cache = new Map();
	const coldAssembly = assemblePromptSegments(stableSegments, cache);
	const warmAssembly = assemblePromptSegments(stableSegments, cache);
	const afterCharacterEdit = assemblePromptSegments(
		stableSegments.map((segment) => segment.key === 'character_sheet:party'
			? { ...segment, hash: 'characters_v2' }
			: segment),
		cache,
	);

	const durationMs = Math.round(nowMs() - started);
	const heapAfter = heapUsedBytes();
	const heapDeltaBytes = heapBefore == null || heapAfter == null ? null : heapAfter - heapBefore;
	const ok = projectionEntries.length <= entryLimit
		&& promptEntries.length <= promptLimit
		&& warmAssembly.hits === stableSegments.length
		&& afterCharacterEdit.changedKeys.length === 1
		&& afterCharacterEdit.changedKeys[0] === 'character_sheet:party';

	return {
		mode: 'long-campaign',
		ok,
		turns,
		entryCount: entries.length,
		durationMs,
		heapDeltaBytes,
		projection: {
			limit: entryLimit,
			selected: projectionEntries.length,
			firstPosition: projectionEntries[0]?.position ?? null,
			lastPosition: projectionEntries[projectionEntries.length - 1]?.position ?? null,
		},
		prompt: {
			limit: promptLimit,
			selected: promptEntries.length,
			firstPosition: promptEntries[0]?.position ?? null,
			lastPosition: promptEntries[promptEntries.length - 1]?.position ?? null,
			tokenEstimate: promptEntries.reduce((sum, entry) => sum + Math.ceil(entry.content.length / 4), 0),
		},
		cache: {
			stableSegmentCount: stableSegments.length,
			coldAssembly,
			warmAssembly,
			afterCharacterEdit,
		},
	};
}

/**
 * @param {Record<string, unknown>} input
 * @returns {{ requestPath: string; timeoutMs: number; body: Record<string, unknown> }}
 */
export function buildBenchTurnCommandRequest(input) {
	const args = asRecord(input);
	const storyId = optionalString(args.storyId);
	if (!storyId) throw new Error('--story-id is required.');
	const clientTurnId = optionalString(args.clientTurnId) || `bench_${Date.now()}`;
	return {
		requestPath: '/api/engine/command',
		timeoutMs: 180_000,
		body: {
			storyId,
			command: 'turn.submit',
			clientCommandId: clientTurnId,
			args: {
				storyId,
				clientTurnId,
				playerText: optionalString(args.playerText) || 'Look around and let the world respond.',
				localVersion: nonnegativeInteger(args.localVersion, 0),
				clientContext: asRecord(args.clientContext),
			},
		},
	};
}

/**
 * @param {Record<string, unknown>} input
 * @returns {{ requestPath: string; body: Record<string, unknown> }}
 */
export function buildBenchCampaignStatusCommandRequest(input) {
	const args = asRecord(input);
	const storyId = optionalString(args.storyId);
	if (!storyId) throw new Error('--story-id is required.');
	return {
		requestPath: '/api/engine/command',
		body: {
			storyId,
			command: 'campaign.status',
			clientCommandId: optionalString(args.clientCommandId) || `bench_status_${Date.now()}`,
			args: {
				entryLimit: positiveIntegerCapped(args.entryLimit, 80, 200),
			},
		},
	};
}

/**
 * @param {Record<string, unknown>} input
 * @returns {{ requestPath: string; body: Record<string, unknown> }}
 */
export function buildBenchCampaignBootstrapCommandRequest(input) {
	const args = asRecord(input);
	const storyId = optionalString(args.storyId);
	if (!storyId) throw new Error('--story-id is required.');
	return {
		requestPath: '/api/engine/command',
		body: {
			storyId,
			command: 'campaign.bootstrap',
			clientCommandId: optionalString(args.clientCommandId) || `bench_bootstrap_${Date.now()}`,
			args: {
				entryLimit: positiveIntegerCapped(args.entryLimit, 80, 200),
				entityLimit: 1,
				relationshipLimit: 1,
				factionLimit: 1,
				factionMembershipLimit: 1,
				factionResourceLimit: 1,
				factionGoalLimit: 1,
				agreementLimit: 1,
				npcBeliefLimit: 1,
				threadLimit: 1,
				chapterLimit: 1,
				arcLimit: 1,
				sagaLimit: 1,
				eventLimit: 1,
				patchLimit: 1,
				memoryNodeLimit: 1,
			},
		},
	};
}

/**
 * @param {Record<string, unknown>} input
 * @returns {{ requestPath: string; body: Record<string, unknown> }}
 */
export function buildBenchTranscriptPageCommandRequest(input) {
	const args = asRecord(input);
	const storyId = optionalString(args.storyId);
	if (!storyId) throw new Error('--story-id is required.');
	return {
		requestPath: '/api/engine/command',
		body: {
			storyId,
			command: 'campaign.transcriptPage',
			clientCommandId: optionalString(args.clientCommandId) || `bench_transcript_${Date.now()}`,
			args: {
				limit: positiveIntegerCapped(args.limit ?? args.entryLimit, 80, 200),
			},
		},
	};
}

/**
 * @param {unknown} payload
 * @param {string} fallbackCommand
 * @returns {Record<string, unknown>}
 */
function unwrapEngineCommandPayload(payload, fallbackCommand) {
	const response = asRecord(payload);
	if (response.status !== 'succeeded') {
		const command = optionalString(response.command) || fallbackCommand;
		throw new Error(optionalString(response.error) || `Engine command failed: ${command}`);
	}
	const result = asRecord(response.result);
	if (Object.keys(result).length === 0) throw new Error(`Engine command returned no result: ${fallbackCommand}`);
	return result;
}

/**
 * @param {unknown} payload
 * @param {string} fallbackCommand
 * @returns {Record<string, unknown>}
 */
export function unwrapBenchEngineCommandPayload(payload, fallbackCommand) {
	return unwrapEngineCommandPayload(payload, fallbackCommand);
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function asArray(value) {
	return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown[]} rows
 * @returns {{ length: number; firstPosition: number | null; lastPosition: number | null }}
 */
function entryWindowSummary(rows) {
	const first = asRecord(rows[0]);
	const last = asRecord(rows[rows.length - 1]);
	return {
		length: rows.length,
		firstPosition: asNumber(first.position),
		lastPosition: asNumber(last.position),
	};
}

/**
 * @param {Record<string, unknown>} input
 * @returns {{ ok: boolean; errors: string[]; entryCount: number; expectedEntryCount: number; projection: Record<string, unknown>; transcript: Record<string, unknown>; bootstrap: Record<string, unknown> | null }}
 */
export function verifyDbLongCampaignBenchmark(input) {
	const args = asRecord(input);
	const turns = positiveInteger(args.turns, 10_000);
	const entryLimit = positiveIntegerCapped(args.entryLimit, 80, 200);
	const transcriptLimit = positiveIntegerCapped(args.transcriptLimit ?? args.entryLimit, 80, 200);
	const expectedEntryCount = turns * 2;
	const projectionExpected = Math.min(entryLimit, expectedEntryCount);
	const transcriptExpected = Math.min(transcriptLimit, expectedEntryCount);
	const expectedProjectionFirst = expectedEntryCount - projectionExpected;
	const expectedTranscriptFirst = expectedEntryCount - transcriptExpected;
	const errors = [];

	const status = asRecord(args.status);
	const statusCounts = asRecord(status.counts);
	const projectionEntries = asArray(status.entries);
	const projectionSummary = entryWindowSummary(projectionEntries);
	const projectionEntryCount = asNumber(statusCounts.entries);
	if (projectionEntryCount !== expectedEntryCount) {
		errors.push(`campaign.status counts.entries ${projectionEntryCount} !== ${expectedEntryCount}`);
	}
	if (projectionSummary.length !== projectionExpected) {
		errors.push(`campaign.status entries length ${projectionSummary.length} !== ${projectionExpected}`);
	}
	if (projectionSummary.firstPosition !== expectedProjectionFirst || projectionSummary.lastPosition !== expectedEntryCount - 1) {
		errors.push(`campaign.status window ${projectionSummary.firstPosition}-${projectionSummary.lastPosition} !== ${expectedProjectionFirst}-${expectedEntryCount - 1}`);
	}

	const transcript = asRecord(args.transcript);
	const transcriptEntries = asArray(transcript.entries);
	const transcriptSummary = entryWindowSummary(transcriptEntries);
	const transcriptEntryCount = asNumber(transcript.entryCount);
	if (transcriptEntryCount !== expectedEntryCount) {
		errors.push(`campaign.transcriptPage entryCount ${transcriptEntryCount} !== ${expectedEntryCount}`);
	}
	if (transcriptSummary.length !== transcriptExpected) {
		errors.push(`campaign.transcriptPage entries length ${transcriptSummary.length} !== ${transcriptExpected}`);
	}
	if (transcriptSummary.firstPosition !== expectedTranscriptFirst || transcriptSummary.lastPosition !== expectedEntryCount - 1) {
		errors.push(`campaign.transcriptPage window ${transcriptSummary.firstPosition}-${transcriptSummary.lastPosition} !== ${expectedTranscriptFirst}-${expectedEntryCount - 1}`);
	}
	if (expectedEntryCount > transcriptLimit && transcript.hasMore !== true) {
		errors.push('campaign.transcriptPage hasMore should be true for a bounded first page');
	}

	const bootstrap = args.bootstrap ? asRecord(args.bootstrap) : null;
	if (bootstrap) {
		const bootstrapProjection = asRecord(bootstrap.projection);
		const bootstrapCounts = asRecord(bootstrapProjection.counts);
		const bootstrapProjectionEntries = asArray(bootstrapProjection.entries);
		const bootstrapEntries = bootstrapProjectionEntries.length ? bootstrapProjectionEntries : asArray(bootstrap.entries);
		const bootstrapSummary = entryWindowSummary(bootstrapEntries);
		if (asNumber(bootstrap.entryCount) !== expectedEntryCount) {
			errors.push(`campaign.bootstrap entryCount ${asNumber(bootstrap.entryCount)} !== ${expectedEntryCount}`);
		}
		if (asNumber(bootstrapCounts.entries) !== expectedEntryCount) {
			errors.push(`campaign.bootstrap projection counts.entries ${asNumber(bootstrapCounts.entries)} !== ${expectedEntryCount}`);
		}
		if (bootstrapSummary.length !== projectionExpected) {
			errors.push(`campaign.bootstrap entries length ${bootstrapSummary.length} !== ${projectionExpected}`);
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		entryCount: projectionEntryCount ?? transcriptEntryCount ?? 0,
		expectedEntryCount,
		projection: {
			limit: entryLimit,
			...projectionSummary,
		},
		transcript: {
			limit: transcriptLimit,
			hasMore: transcript.hasMore === true,
			nextBeforePosition: asNumber(transcript.nextBeforePosition),
			...transcriptSummary,
		},
		bootstrap: bootstrap ? {
			entryCount: asNumber(bootstrap.entryCount),
			projectionCountEntries: asNumber(asRecord(asRecord(bootstrap.projection).counts).entries),
			selectedLength: entryWindowSummary(asArray(asRecord(bootstrap.projection).entries)).length
				|| entryWindowSummary(asArray(bootstrap.entries)).length,
		} : null,
	};
}

/**
 * @param {Record<string, unknown>} input
 * @returns {{ requestPath: string; body: Record<string, unknown> }}
 */
export function buildBenchWorldSimCommandRequest(input) {
	const args = asRecord(input);
	const storyId = optionalString(args.storyId);
	if (!storyId) throw new Error('--story-id is required.');
	return {
		requestPath: '/api/engine/command',
		body: {
			storyId,
			command: 'jobs.worldSim',
			args: {
				workerId: optionalString(args.workerId) || `bench_generation_${Date.now()}`,
				localVersion: nonnegativeInteger(args.localVersion, 0),
				force: true,
			},
		},
	};
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
export function unwrapBenchTurnPayload(payload) {
	return unwrapEngineCommandPayload(payload, 'turn.submit');
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
export function unwrapBenchWorldSimPayload(payload) {
	return unwrapEngineCommandPayload(payload, 'jobs.worldSim');
}
