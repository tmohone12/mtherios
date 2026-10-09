import { randomUUID } from 'node:crypto';
import {
	engineOrchestratorRunArgsSchema,
	type EngineCommandResponse,
	type EngineOrchestratorAgentRole,
	type EngineOrchestratorContext,
	type EngineOrchestratorMode,
	type EngineOrchestratorRunArgs,
} from '$lib/contracts/engine';

type JsonRecord = Record<string, unknown>;

export interface EngineOrchestratorAgentDefinition {
	id: EngineOrchestratorAgentRole;
	name: string;
	responsibilities: string[];
}

export interface EngineOrchestratorToolCall {
	id: string;
	agentRole: EngineOrchestratorAgentRole;
	command: string;
	args: JsonRecord;
	reason: string;
}

export interface EngineOrchestratorStep {
	id: string;
	title: string;
	focus: string;
	toolCallIds: string[];
}

export interface EngineOrchestratorPlan {
	runId: string;
	storyId: string;
	mode: EngineOrchestratorMode;
	goal: string;
	roles: EngineOrchestratorAgentDefinition[];
	steps: EngineOrchestratorStep[];
	toolCalls: EngineOrchestratorToolCall[];
	warnings: string[];
	createdAt: string;
}

export interface EngineOrchestratorToolResult {
	toolCallId: string;
	agentRole: EngineOrchestratorAgentRole;
	command: string;
	status: EngineCommandResponse['status'];
	commandId: string | null;
	error: string | null;
	summary: JsonRecord | null;
}

export interface EngineOrchestratorRunInput extends Partial<Omit<EngineOrchestratorRunArgs, 'context'>> {
	storyId: string;
	goal: string;
	context?: Partial<EngineOrchestratorContext>;
	clientCommandId?: string | null;
}

type ParsedEngineOrchestratorRunInput = EngineOrchestratorRunArgs & {
	storyId: string;
	clientCommandId?: string | null;
};

export interface EngineOrchestratorRunResult extends EngineOrchestratorPlan {
	executed: boolean;
	toolResults: EngineOrchestratorToolResult[];
}

export type EngineOrchestratorToolRunner = (call: EngineOrchestratorToolCall) => Promise<EngineCommandResponse>;

export const ORCHESTRATOR_AGENT_ROLES: EngineOrchestratorAgentDefinition[] = [
	{
		id: 'game_master',
		name: 'GameMaster',
		responsibilities: [
			'Own the authoritative turn and use rules, world state, faction, and continuity tools.',
			'Ground player-facing prose in current canon and visible evidence.',
		],
	},
	{
		id: 'memory_context',
		name: 'Memory & Context subagent',
		responsibilities: [
			'Retrieve source-linked memory and lore with visibility boundaries.',
			'Coordinate completed-turn state extraction and chapter, arc, and saga history.',
		],
	},
	{
		id: 'player_guidance',
		name: 'Player Guidance subagent',
		responsibilities: [
			'Offer optional suggestions from player-visible scene evidence.',
			'Leave player intent and turn submission to the player and GameMaster.',
		],
	},
];

function nowIso(): string {
	return new Date().toISOString();
}

function runId(): string {
	return `orch_${randomUUID()}`;
}

function toolCallId(index: number): string {
	return `orch_tool_${index + 1}`;
}

function cleanStringArray(values: string[] | undefined): string[] {
	return Array.isArray(values)
		? [...new Set(values.map((item) => item.trim()).filter(Boolean))]
		: [];
}

function compactRecord(record: JsonRecord): JsonRecord {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => {
		if (value === undefined) return false;
		if (Array.isArray(value) && value.length === 0) return false;
		if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
		return true;
	}));
}

function turnClientContext(context: EngineOrchestratorContext): JsonRecord {
	return compactRecord({
		locationId: context.locationId,
		sceneEntityIds: cleanStringArray(context.sceneEntityIds),
		presentNpcIds: cleanStringArray(context.presentNpcIds),
		threadIds: cleanStringArray(context.threadIds),
		currentFactionId: context.currentFactionId,
		memoryTokenBudget: context.memoryTokenBudget,
		contextBudget: context.contextBudget,
		recentDialogueTokens: context.recentDialogueTokens,
		recentDialogueTurns: context.recentDialogueTurns,
	});
}

function selectedRoles(roleIds: EngineOrchestratorAgentRole[] | undefined): EngineOrchestratorAgentDefinition[] {
	const allowed = roleIds?.length ? new Set(roleIds) : null;
	return ORCHESTRATOR_AGENT_ROLES.filter((role) => !allowed || allowed.has(role.id));
}

function makeToolCall(
	index: number,
	agentRole: EngineOrchestratorAgentRole,
	command: string,
	args: JsonRecord,
	reason: string,
): EngineOrchestratorToolCall {
	return {
		id: toolCallId(index),
		agentRole,
		command,
		args: compactRecord(args),
		reason,
	};
}

function buildTurnToolCalls(input: ParsedEngineOrchestratorRunInput): EngineOrchestratorToolCall[] {
	const context = input.context;
	const query = input.playerText ?? input.goal;
	return [
		makeToolCall(0, 'memory_context', 'campaign.status', {
			entryLimit: context.entryLimit ?? 80,
		}, 'Load the bounded current-state projection for the control surface and agents.'),
		makeToolCall(1, 'game_master', 'campaign.page.read', {
			kind: 'rules_page',
			path: 'rules/default.md',
			missingOk: true,
		}, 'Load the default rules pack when present; continue with system defaults if the vault page has not been created.'),
		makeToolCall(2, 'game_master', 'timeline.brief', {
			currentTurn: context.currentTurn,
			presentNpcIds: cleanStringArray(context.presentNpcIds),
			sceneEntityIds: cleanStringArray(context.sceneEntityIds),
			includeSecret: context.includeSecret,
			recentLimit: 12,
			dueLimit: 12,
			scheduledLimit: 8,
			npcEventLimit: 12,
		}, 'Inspect due, recent, and NPC-linked events before any state changes are proposed.'),
		makeToolCall(3, 'game_master', 'timeline.brief', {
			currentTurn: context.currentTurn,
			presentNpcIds: cleanStringArray(context.presentNpcIds),
			sceneEntityIds: cleanStringArray(context.sceneEntityIds),
			includeSecret: context.includeSecret,
			recentLimit: 8,
			dueLimit: 8,
			scheduledLimit: 12,
			npcLimit: 12,
			npcEventLimit: 8,
		}, 'Inspect delayed and off-screen faction pressure without advancing the clock.'),
		makeToolCall(4, 'memory_context', 'memory.retrieve', {
			query,
			sceneEntityIds: cleanStringArray(context.sceneEntityIds),
			presentNpcIds: cleanStringArray(context.presentNpcIds),
			locationId: context.locationId ?? null,
			threadIds: cleanStringArray(context.threadIds),
			currentFactionId: context.currentFactionId ?? null,
			tokenBudget: context.memoryTokenBudget,
		}, 'Retrieve only the memory packet needed for the current action.'),
		makeToolCall(5, 'game_master', 'turn.prepare', {
			playerText: input.playerText ?? input.goal,
			clientTurnId: input.clientTurnId ?? input.clientCommandId ?? undefined,
			clientContext: turnClientContext(context),
		}, 'Prepare bounded turn context, prompt segments, timeline, and cache diagnostics without generating narration.'),
		makeToolCall(6, 'game_master', 'campaign.cacheStatus', {
			includeSegments: false,
		}, 'Check prompt/cache health without exposing cached values.'),
		makeToolCall(7, 'game_master', 'turn.submit', {
			playerText: input.playerText ?? input.goal,
			clientTurnId: input.clientTurnId ?? input.clientCommandId ?? undefined,
			clientContext: turnClientContext(context),
		}, 'Generate and persist the authoritative narration after the exploration steps finish.'),
	];
}

function buildWorldTickToolCalls(input: ParsedEngineOrchestratorRunInput): EngineOrchestratorToolCall[] {
	const context = input.context;
	return [
		makeToolCall(0, 'memory_context', 'timeline.brief', {
			currentTurn: context.currentTurn,
			presentNpcIds: cleanStringArray(context.presentNpcIds),
			sceneEntityIds: cleanStringArray(context.sceneEntityIds),
			includeSecret: context.includeSecret,
		}, 'Query due, scheduled, recent, and NPC-linked events before world simulation.'),
		makeToolCall(1, 'game_master', 'jobs.worldSim', {
			force: true,
		}, 'Run the backend world-sim job through the shared service command.'),
		makeToolCall(2, 'game_master', 'campaign.status', {
			entryLimit: context.entryLimit ?? 80,
		}, 'Refresh bounded projection after world simulation.'),
	];
}

function buildAuditToolCalls(input: ParsedEngineOrchestratorRunInput): EngineOrchestratorToolCall[] {
	const context = input.context;
	return [
		makeToolCall(0, 'memory_context', 'campaign.status', {
			entryLimit: context.entryLimit ?? 80,
		}, 'Inspect bounded current-state projection.'),
		makeToolCall(1, 'game_master', 'campaign.cacheStatus', {
			includeSegments: true,
			segmentLimit: 25,
		}, 'Inspect cache diagnostics without cached values.'),
		makeToolCall(2, 'memory_context', 'timeline.brief', {
			currentTurn: context.currentTurn,
			presentNpcIds: cleanStringArray(context.presentNpcIds),
			sceneEntityIds: cleanStringArray(context.sceneEntityIds),
			includeSecret: context.includeSecret,
		}, 'Inspect timeline continuity and delayed event state.'),
	];
}

function buildMemoryToolCalls(input: ParsedEngineOrchestratorRunInput): EngineOrchestratorToolCall[] {
	const context = input.context;
	return [
		makeToolCall(0, 'memory_context', 'memory.retrieve', {
			query: input.playerText ?? input.goal,
			sceneEntityIds: cleanStringArray(context.sceneEntityIds),
			presentNpcIds: cleanStringArray(context.presentNpcIds),
			locationId: context.locationId ?? null,
			threadIds: cleanStringArray(context.threadIds),
			currentFactionId: context.currentFactionId ?? null,
			tokenBudget: context.memoryTokenBudget,
		}, 'Retrieve the bounded memory packet for an NPC or scene question.'),
		makeToolCall(1, 'memory_context', 'timeline.brief', {
			presentNpcIds: cleanStringArray(context.presentNpcIds),
			sceneEntityIds: cleanStringArray(context.sceneEntityIds),
			includeSecret: context.includeSecret,
		}, 'Attach NPC-linked timeline memory to the retrieval context.'),
	];
}

function buildLoreCurationToolCalls(input: ParsedEngineOrchestratorRunInput): EngineOrchestratorToolCall[] {
	const context = input.context;
	const query = input.playerText ?? input.goal;
	return [
		makeToolCall(0, 'memory_context', 'wiki.brief', {
			query,
			limit: 8,
			followDepth: 2,
			pageLimit: 24,
			maxChars: context.contextBudget ?? 36000,
		}, 'Explore the linked markdown wiki around the lore question and collect a bounded roleplay context pack.'),
		makeToolCall(1, 'memory_context', 'wiki.pages', {
			orphans: true,
			limit: 80,
			sort: 'title',
		}, 'Find orphaned or thin lore pages that a curator should connect before agents rely on them.'),
		makeToolCall(2, 'memory_context', 'campaign.status', {
			entryLimit: context.entryLimit ?? 80,
		}, 'Compare wiki lore against bounded canonical campaign state before proposing any durable page edit.'),
		makeToolCall(3, 'memory_context', 'memory.retrieve', {
			query,
			sceneEntityIds: cleanStringArray(context.sceneEntityIds),
			presentNpcIds: cleanStringArray(context.presentNpcIds),
			locationId: context.locationId ?? null,
			threadIds: cleanStringArray(context.threadIds),
			currentFactionId: context.currentFactionId ?? null,
			tokenBudget: context.memoryTokenBudget,
		}, 'Check source-linked memory nodes so wiki curation does not overwrite temporal or perspectival memory.'),
	];
}

function buildToolCalls(input: ParsedEngineOrchestratorRunInput): EngineOrchestratorToolCall[] {
	switch (input.mode) {
		case 'world_tick':
			return buildWorldTickToolCalls(input);
		case 'audit':
			return buildAuditToolCalls(input);
		case 'memory':
			return buildMemoryToolCalls(input);
		case 'lore_curation':
			return buildLoreCurationToolCalls(input);
		case 'custom':
			return buildAuditToolCalls(input);
		case 'turn':
		default:
			return buildTurnToolCalls(input);
	}
}

function parseInput(input: EngineOrchestratorRunInput): ParsedEngineOrchestratorRunInput {
	return {
		...engineOrchestratorRunArgsSchema.parse(input),
		storyId: input.storyId,
		clientCommandId: input.clientCommandId ?? null,
	};
}

function buildSteps(mode: EngineOrchestratorMode, calls: EngineOrchestratorToolCall[]): EngineOrchestratorStep[] {
	const step = (id: string, title: string, focus: string, indexes: number[]): EngineOrchestratorStep => ({
		id,
		title,
		focus,
		toolCallIds: indexes.map((index) => calls.find((call) => call.id === toolCallId(index))?.id).filter((id): id is string => Boolean(id)),
	});
	const keepUsed = (steps: EngineOrchestratorStep[]) => steps.filter((item) => item.toolCallIds.length > 0);

	if (mode === 'turn') {
		return keepUsed([
			step('situation', 'Situation', 'Establish immediate canon, rules, and timeline stakes.', [0, 1, 2]),
			step('dialogue', 'Dialogue', 'Load the present actors\' memories, knowledge, and pressures.', [4]),
			step('location', 'Location', 'Prepare the bounded scene, place, clock, and narration context.', [5]),
			step('plot', 'Plot', 'Check off-screen pressure and prompt health before the next turn boundary.', [3, 6]),
			step('narrate', 'Narrate', 'Weave the inspected evidence into the authoritative scene and persist the turn.', [7]),
		]);
	}
	if (mode === 'world_tick') {
		return keepUsed([
			step('inspect', 'Inspect', 'Read the current timeline before changing it.', [0]),
			step('advance', 'Advance', 'Run the bounded off-screen simulation.', [1]),
			step('verify', 'Verify', 'Refresh the projection after simulation.', [2]),
		]);
	}
	if (mode === 'lore_curation') {
		return keepUsed([
			step('explore', 'Explore', 'Search and inspect the linked wiki graph.', [0, 1]),
			step('verify', 'Verify', 'Cross-check lore against canon and source-linked memory.', [2, 3]),
		]);
	}
	return keepUsed([
		step('inspect', 'Inspect', 'Run the mode\'s independent read tools.', calls.map((_, index) => index)),
	]);
}

export function buildEngineOrchestratorPlan(input: EngineOrchestratorRunInput): EngineOrchestratorPlan {
	const parsed = parseInput(input);
	const warnings: string[] = [];
	const availableToolCalls = buildToolCalls(parsed);
	const submitCall = parsed.mode === 'turn' ? availableToolCalls.find((call) => call.command === 'turn.submit') : null;
	const toolCalls = submitCall && parsed.maxToolCalls < availableToolCalls.length
		? [...availableToolCalls.filter((call) => call !== submitCall).slice(0, parsed.maxToolCalls - 1), submitCall]
		: availableToolCalls.slice(0, parsed.maxToolCalls);
	if (parsed.mode === 'turn' && !parsed.playerText) {
		warnings.push('Turn orchestration used goal text as playerText because playerText was omitted.');
	}

	return {
		runId: runId(),
		storyId: parsed.storyId,
		mode: parsed.mode,
		goal: parsed.goal,
		roles: selectedRoles(parsed.roles),
		steps: buildSteps(parsed.mode, toolCalls),
		toolCalls,
		warnings,
		createdAt: nowIso(),
	};
}

function resultSummary(command: string, result: unknown): JsonRecord | null {
	const record = result && typeof result === 'object' && !Array.isArray(result)
		? result as JsonRecord
		: {};
	if (command === 'campaign.status') {
		return { counts: record.counts ?? null, mode: record.mode ?? null };
	}
	if (command === 'campaign.cacheStatus') {
		return {
			entryCount: record.entryCount ?? 0,
			hitCount: record.hitCount ?? 0,
			missCount: record.missCount ?? 0,
			tokenEstimate: record.tokenEstimate ?? 0,
		};
	}
	if (command === 'campaign.page.read') {
		return {
			kind: record.kind ?? null,
			relativePath: record.relativePath ?? null,
			byteLength: record.byteLength ?? 0,
			missing: record.missing === true,
		};
	}
	if (command === 'memory.retrieve') {
		const nodes = Array.isArray(record.nodes) ? record.nodes : [];
		return { nodeCount: nodes.length, tokenEstimate: record.tokenEstimate ?? 0 };
	}
	if (command === 'turn.prepare') {
		const prompt = record.prompt && typeof record.prompt === 'object' ? record.prompt as JsonRecord : {};
		const cache = record.cache && typeof record.cache === 'object' ? record.cache as JsonRecord : null;
		return {
			clientTurnId: record.clientTurnId ?? null,
			prompt: {
				tokenEstimate: prompt.tokenEstimate ?? 0,
				totalChars: prompt.totalChars ?? 0,
				messageCount: prompt.messageCount ?? 0,
			},
			cache: cache ? {
				hitCount: cache.hitCount ?? 0,
				missCount: cache.missCount ?? 0,
			} : null,
		};
	}
	if (command === 'turn.submit') {
		return {
			assistantEntryId: record.assistantEntryId ?? null,
			serverVersion: record.serverVersion ?? null,
			statePatchCount: Array.isArray(record.statePatchIds) ? record.statePatchIds.length : 0,
			eventCount: Array.isArray(record.eventIds) ? record.eventIds.length : 0,
			warningCount: Array.isArray(record.warnings) ? record.warnings.length : 0,
		};
	}
	if (command === 'timeline.brief') {
		return {
			currentTurn: record.currentTurn ?? null,
			dueEventCount: Array.isArray(record.dueEvents) ? record.dueEvents.length : 0,
			scheduledEventCount: Array.isArray(record.scheduledEvents) ? record.scheduledEvents.length : 0,
			npcEventCount: Array.isArray(record.npcEvents) ? record.npcEvents.length : 0,
		};
	}
	if (command === 'jobs.worldSim') {
		return {
			ok: record.ok === true,
			jobId: record.jobId ?? null,
		};
	}
	if (command === 'plotBrain.plan') {
		return {
			ok: record.ok !== false,
			frameId: record.frameId ?? null,
			plotCardCount: record.plotCardCount ?? 0,
			threadCount: record.threadCount ?? 0,
			eventCount: record.eventCount ?? 0,
			executed: record.executed === true,
		};
	}
	return null;
}

export async function runEngineOrchestrator(
	input: EngineOrchestratorRunInput,
	options: { runTool?: EngineOrchestratorToolRunner } = {},
): Promise<EngineOrchestratorRunResult> {
	const parsed = parseInput(input);
	const plan = buildEngineOrchestratorPlan(parsed);
	if (!parsed.execute) {
		return { ...plan, executed: false, toolResults: [] };
	}
	if (!options.runTool) throw new Error('Orchestrator execution requires a backend tool runner.');

	const callsById = new Map(plan.toolCalls.map((call) => [call.id, call]));
	const toolResults: EngineOrchestratorToolResult[] = [];
	for (const step of plan.steps) {
		const stepResults = await Promise.all(step.toolCallIds.map(async (toolCallId) => {
			const call = callsById.get(toolCallId);
			if (!call) throw new Error(`Orchestrator step ${step.id} references missing tool call ${toolCallId}.`);
			const response = await options.runTool!(call);
			return {
				toolCallId: call.id,
				agentRole: call.agentRole,
				command: call.command,
				status: response.status,
				commandId: response.commandId ?? null,
				error: response.error ?? null,
				summary: response.status === 'succeeded' ? resultSummary(call.command, response.result) : null,
			} satisfies EngineOrchestratorToolResult;
		}));
		toolResults.push(...stepResults);
	}

	return {
		...plan,
		executed: true,
		toolResults,
	};
}
