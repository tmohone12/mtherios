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

/**
 * @param {Record<string, unknown>} turnArgs
 * @returns {{ requestPath: string; body: Record<string, unknown> }}
 */
export function buildStoryTurnCommandRequest(turnArgs) {
	const args = asRecord(turnArgs);
	const storyId = optionalString(args.storyId);
	const clientTurnId = optionalString(args.clientTurnId);
	if (!storyId) throw new Error('storyId is required.');
	if (!clientTurnId) throw new Error('clientTurnId is required.');
	return {
		requestPath: '/api/engine/command',
		body: {
			storyId,
			command: 'turn.submit',
			clientCommandId: clientTurnId,
			args,
		},
	};
}

/**
 * @param {Record<string, unknown>} memoryArgs
 * @returns {{ requestPath: string; body: Record<string, unknown> }}
 */
export function buildStoryMemoryCommandRequest(memoryArgs) {
	const args = asRecord(memoryArgs);
	const storyId = optionalString(args.storyId);
	if (!storyId) throw new Error('storyId is required.');
	return {
		requestPath: '/api/engine/command',
		body: {
			storyId,
			command: 'memory.retrieve',
			args,
		},
	};
}

/**
 * @param {Record<string, unknown>} bootstrapArgs
 * @returns {{ requestPath: string; body: Record<string, unknown> }}
 */
export function buildStoryBootstrapCommandRequest(bootstrapArgs) {
	const args = asRecord(bootstrapArgs);
	const storyId = optionalString(args.storyId);
	if (!storyId) throw new Error('storyId is required.');
	const commandArgs = /** @type {Record<string, unknown>} */ ({});
	for (const key of BOOTSTRAP_LIMIT_KEYS) {
		const value = args[key];
		if (typeof value === 'number' && Number.isFinite(value)) commandArgs[key] = Math.trunc(value);
	}
	return {
		requestPath: '/api/engine/command',
		body: {
			storyId,
			command: 'campaign.bootstrap',
			args: commandArgs,
		},
	};
}

/**
 * @param {Record<string, unknown>} entriesArgs
 * @returns {{ requestPath: string; body: Record<string, unknown> }}
 */
export function buildStoryEntriesCommandRequest(entriesArgs) {
	const args = asRecord(entriesArgs);
	const storyId = optionalString(args.storyId);
	if (!storyId) throw new Error('storyId is required.');
	const commandArgs = /** @type {Record<string, unknown>} */ ({});
	if (typeof args.limit === 'number' && Number.isFinite(args.limit)) commandArgs.limit = Math.trunc(args.limit);
	if (typeof args.beforePosition === 'number' && Number.isFinite(args.beforePosition)) commandArgs.beforePosition = Math.trunc(args.beforePosition);
	const branchId = optionalString(args.branchId);
	if (branchId) commandArgs.branchId = branchId;
	return {
		requestPath: '/api/engine/command',
		body: {
			storyId,
			command: 'campaign.transcriptPage',
			args: commandArgs,
		},
	};
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
export function unwrapEngineTurnCommand(payload) {
	const response = asRecord(payload);
	if (response.status !== 'succeeded') {
		throw new Error(optionalString(response.error) || `Engine command failed: ${optionalString(response.command) || 'turn.submit'}`);
	}
	const result = asRecord(response.result);
	if (Object.keys(result).length === 0) throw new Error('Engine turn command returned no result.');
	return result;
}
