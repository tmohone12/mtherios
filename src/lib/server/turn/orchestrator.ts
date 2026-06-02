import { desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { storyEntries, syncOps } from '$lib/server/db/schema';
import { turnRequestSchema, type TurnRequest, type TurnResponse } from '$lib/contracts/memory';
import { bumpStoryVersion, getSyncChanges } from '$lib/server/memory/canonical';
import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { worldStateUpdateSchema } from '$lib/services/ai/tools/schemas';
import { contextWiki } from '$lib/server/wiki/wikiCore';
import { loadTurnContext } from './context';
import { buildServerTurnPrompt, buildStateExtractionPrompt } from './promptPacket';
import {
	ServerGenerationError,
	generateServerTextWithMetrics,
	parseJsonFromGeneratedText,
	type ServerGenerationResult,
} from './provider';
import { applyValidatedTurnUpdate, parseTurnUpdate } from './patchValidator';
import { requireResolvedServiceProfile, resolveServiceGeneration } from '$lib/server/engine/llmSettings';
import { recordApiCallLog } from '$lib/server/engine/apiCallLogs';
import { buildTurnDebugSnapshot } from './debugSnapshot';

function nowIso(): string {
	return new Date().toISOString();
}

type ProviderProfile = NonNullable<TurnRequest['providerProfile']>;
type GenerationTiming = NonNullable<TurnResponse['generationTimings']>[number];

interface ServerWikiContext {
	markdown: string;
	citations: string[];
	pageCount: number;
	seedCount: number;
	semanticError?: string | null;
}

const DEFAULT_MEMORY_TOKEN_BUDGET = 800;
const MAX_CLASSIFIER_TOKENS = 2048;
const WIKI_CONTEXT_LIMIT = 4;
const WIKI_CONTEXT_PAGE_LIMIT = 6;
const WIKI_CONTEXT_PAGE_CHARS = 700;
const WIKI_CONTEXT_MAX_CHARS = 4000;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampInt(value: number | null | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function generationErrorResult(error: unknown): ServerGenerationError['result'] | null {
	return error instanceof ServerGenerationError ? error.result : null;
}

function timingFromResult(
	operation: string,
	serviceId: string,
	result: ServerGenerationResult | ServerGenerationError['result'],
	status: 'success' | 'error',
): GenerationTiming {
	const usage = 'usage' in result ? result.usage : undefined;
	return {
		operation,
		serviceId,
		model: result.model ?? null,
		status,
		durationMs: Math.max(0, Math.trunc(result.durationMs)),
		requestTokens: usage?.requestTokens ?? null,
		responseTokens: usage?.responseTokens ?? null,
		totalTokens: usage?.totalTokens ?? null,
	};
}

async function logGenerationCall(options: {
	storyId: string;
	clientTurnId: string;
	serviceId: string;
	operation: string;
	profile: ProviderProfile;
	result: ServerGenerationResult | ServerGenerationError['result'];
	status: 'success' | 'error';
	error?: unknown;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	const usage = 'usage' in options.result ? options.result.usage : undefined;
	await recordApiCallLog({
		storyId: options.storyId,
		serviceId: options.serviceId,
		operation: options.operation,
		providerType: options.profile.providerType,
		providerName: options.profile.name ?? null,
		profileId: options.profile.id ?? null,
		model: options.result.model,
		endpoint: options.result.endpoint,
		status: options.status,
		durationMs: options.result.durationMs,
		requestTokens: usage?.requestTokens ?? null,
		responseTokens: usage?.responseTokens ?? null,
		totalTokens: usage?.totalTokens ?? null,
		promptChars: options.result.promptChars,
		responseChars: 'responseChars' in options.result ? options.result.responseChars ?? null : null,
		error: options.error ? (options.error instanceof Error ? options.error.message : String(options.error)) : null,
		metadata: {
			clientTurnId: options.clientTurnId,
			...options.metadata,
		},
	});
}

function extractServerWikiContext(result: unknown): ServerWikiContext {
	const record = asRecord(result);
	return {
		markdown: typeof record.contextMarkdown === 'string' ? record.contextMarkdown : '',
		citations: asStringArray(record.citations),
		pageCount: asNumber(record.pageCount),
		seedCount: asNumber(record.seedCount),
		semanticError: typeof record.semanticError === 'string' ? record.semanticError : null,
	};
}

function turnContextCounts(ctx: Awaited<ReturnType<typeof loadTurnContext>>): Record<string, number> {
	return {
		recentEntries: ctx.recentEntries.length,
		entities: ctx.entities.length,
		factions: ctx.factions.length,
		factionMemberships: ctx.factionMemberships.length,
		factionResources: ctx.factionResources.length,
		factionGoals: ctx.factionGoals.length,
		agreements: ctx.agreements.length,
		threads: ctx.threads.length,
		events: ctx.events.length,
		beliefs: ctx.beliefs.length,
	};
}

async function loadServerWikiContext(storyId: string, query: string): Promise<ServerWikiContext> {
	return extractServerWikiContext(await contextWiki({
		storyId,
		query,
		limit: WIKI_CONTEXT_LIMIT,
		followDepth: 1,
		pageLimit: WIKI_CONTEXT_PAGE_LIMIT,
		pageChars: WIKI_CONTEXT_PAGE_CHARS,
		maxChars: WIKI_CONTEXT_MAX_CHARS,
	}));
}

async function nextEntryPosition(storyId: string): Promise<number> {
	const db = getDb();
	const [last] = await db
		.select({ position: storyEntries.position })
		.from(storyEntries)
		.where(eq(storyEntries.storyId, storyId))
		.orderBy(desc(storyEntries.position))
		.limit(1);
	return (last?.position ?? -1) + 1;
}

async function existingTurn(storyId: string, clientTurnId: string): Promise<TurnResponse | null> {
	const db = getDb();
	const playerEntryId = `entry_${clientTurnId}`;
	const assistantEntryId = `narration_${clientTurnId}`;
	const rows = await db
		.select()
		.from(storyEntries)
		.where(eq(storyEntries.storyId, storyId))
		.limit(200);
	const player = rows.find((entry) => entry.id === playerEntryId);
	const assistant = rows.find((entry) => entry.id === assistantEntryId);
	if (!player && !assistant) return null;
	const serverVersion = Math.max(player?.serverVersion ?? 0, assistant?.serverVersion ?? 0);
	return {
		narration: assistant?.content ?? '',
		entries: [player, assistant].filter(Boolean) as Array<Record<string, unknown>>,
		playerEntryId: player?.id ?? null,
		assistantEntryId: assistant?.id ?? null,
		statePatchIds: [],
		eventIds: [],
		retrievedMemoryIds: [],
		memoryNodeIds: [],
		serverVersion,
		syncChanges: await getSyncChanges(storyId, 0),
		warnings: ['Turn was already processed; returning existing backend entries.'],
		generationTimings: [],
	};
}

export async function processServerTurn(input: unknown): Promise<TurnResponse> {
	const request = turnRequestSchema.parse(input);
	const existing = await existingTurn(request.storyId, request.clientTurnId);
	if (existing) return existing;

	const db = getDb();
	const createdAt = nowIso();
	const playerEntryId = `entry_${request.clientTurnId}`;
	const assistantEntryId = `narration_${request.clientTurnId}`;
	const warnings: string[] = [];
	const narrativeService = await resolveServiceGeneration('narrative');
	const narrativeProfile = requireResolvedServiceProfile('narrative', narrativeService);
	const narrativeGeneration = narrativeService.generation;
	const classifierService = await resolveServiceGeneration('classifier');
	const classifierProfile = classifierService.profile ?? narrativeProfile;
	const classifierGeneration = classifierService.profile
		? {
			...classifierService.generation,
			temperature: classifierService.generation.temperature ?? 0.2,
			maxTokens: Math.min(classifierService.generation.maxTokens ?? MAX_CLASSIFIER_TOKENS, MAX_CLASSIFIER_TOKENS),
		}
		: {
			model: narrativeGeneration.model,
			temperature: 0.2,
			maxTokens: Math.min(narrativeGeneration.maxTokens ?? MAX_CLASSIFIER_TOKENS, MAX_CLASSIFIER_TOKENS),
		};
	if (classifierService.missingReason) {
		warnings.push(`Classifier service fallback: ${classifierService.missingReason}`);
	}
	const generationTimings: GenerationTiming[] = [];
	const memoryTokenBudget = clampInt(request.clientContext?.memoryTokenBudget, 160, 2400, DEFAULT_MEMORY_TOKEN_BUDGET);
	const memorySettings = {
		chapterThreshold: clampInt(request.clientContext?.chapterThreshold, 5, 200, 20),
		postChapterBuffer: clampInt(request.clientContext?.postChapterBuffer, 0, 100, 10),
		chaptersPerArc: clampInt(request.clientContext?.chaptersPerArc, 2, 50, 5),
	};

	const retrievalRequest = {
		storyId: request.storyId,
		query: request.playerText,
		sceneEntityIds: request.clientContext?.sceneEntityIds ?? [],
		presentNpcIds: request.clientContext?.presentNpcIds ?? [],
		locationId: request.clientContext?.locationId ?? null,
		threadIds: request.clientContext?.threadIds ?? [],
		currentFactionId: request.clientContext?.currentFactionId ?? null,
		tokenBudget: memoryTokenBudget,
	};
	const retrieved = await retrieveMemoryPacket(retrievalRequest);
	const ctx = await loadTurnContext(request.storyId, request.clientContext?.presentNpcIds ?? []);
	let wikiContext: ServerWikiContext | null = null;
	try {
		wikiContext = await loadServerWikiContext(request.storyId, request.playerText);
		if (wikiContext.semanticError) warnings.push(`Terminal wiki semantic search warning: ${wikiContext.semanticError}`);
	} catch (error) {
		warnings.push(`Terminal wiki context unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const prompt = buildServerTurnPrompt(ctx, retrieved, playerEntryId, {
		currentFactionId: request.clientContext?.currentFactionId ?? null,
		sceneEntityIds: request.clientContext?.sceneEntityIds ?? [],
		wikiContextMarkdown: wikiContext?.markdown ?? null,
	});
	const narrativeSystem = narrativeService.systemPromptOverride?.trim() || prompt.system;
	const narrativePrompt = `${prompt.prompt}\n\nPlayer action:\n${request.playerText}`;
	const narrativeDebugBase = {
		kind: 'narration' as const,
		playerText: request.playerText,
		system: narrativeSystem,
		messages: prompt.messages,
		prompt: narrativePrompt,
		retrievedMemory: retrieved,
		wikiContext,
		contextCounts: turnContextCounts(ctx),
	};

	let narration = '';
	try {
		const result = await generateServerTextWithMetrics({
			profile: narrativeProfile,
			model: narrativeGeneration.model,
			temperature: narrativeGeneration.temperature,
			maxTokens: narrativeGeneration.maxTokens,
			system: narrativeSystem,
			messages: prompt.messages,
			prompt: narrativePrompt,
		});
		narration = result.text;
		generationTimings.push(timingFromResult('turn.narration', 'narrative', result, 'success'));
		await logGenerationCall({
			storyId: request.storyId,
			clientTurnId: request.clientTurnId,
			serviceId: 'narrative',
			operation: 'turn.narration',
			profile: narrativeProfile,
			result,
			status: 'success',
			metadata: {
				wikiContextPageCount: wikiContext?.pageCount ?? 0,
				wikiContextSeedCount: wikiContext?.seedCount ?? 0,
				retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
				debugSnapshot: buildTurnDebugSnapshot({
					...narrativeDebugBase,
					output: narration,
				}),
			},
		});
	} catch (error) {
		const failedResult = generationErrorResult(error);
		if (failedResult) {
			generationTimings.push(timingFromResult('turn.narration', 'narrative', failedResult, 'error'));
			await logGenerationCall({
				storyId: request.storyId,
				clientTurnId: request.clientTurnId,
				serviceId: 'narrative',
				operation: 'turn.narration',
				profile: narrativeProfile,
				result: failedResult,
				status: 'error',
				error,
				metadata: {
					statusCode: failedResult.statusCode ?? null,
					retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
					debugSnapshot: buildTurnDebugSnapshot(narrativeDebugBase),
				},
			});
		}
		throw error;
	}

	if (!narration.trim()) {
		throw new Error('Terminal narrative generation returned an empty response. No backend turn was persisted.');
	}

	const position = await nextEntryPosition(request.storyId);
	const turnVersion = await bumpStoryVersion(request.storyId);

	await db.insert(syncOps).values({
		id: `turn_${request.clientTurnId}`,
		storyId: request.storyId,
		type: 'turn_command',
		payload: { playerText: request.playerText, clientContext: request.clientContext ?? null },
		clientVersion: request.localVersion,
		status: 'applied',
		createdAt,
	}).onConflictDoNothing();

	await db.insert(storyEntries).values({
		id: playerEntryId,
		storyId: request.storyId,
		type: 'user_action',
		content: request.playerText,
		position,
		parentId: null,
		branchId: null,
		metadata: { clientTurnId: request.clientTurnId, source: 'server_turn' },
		serverVersion: turnVersion,
		createdAt,
		updatedAt: createdAt,
	}).onConflictDoNothing();

	await db.insert(storyEntries).values({
		id: assistantEntryId,
		storyId: request.storyId,
		type: 'narration',
		content: narration,
		position: position + 1,
		parentId: playerEntryId,
		branchId: null,
		metadata: {
			clientTurnId: request.clientTurnId,
			source: 'server_turn',
			retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
			wikiContextCitations: wikiContext?.citations ?? [],
			wikiContextPageCount: wikiContext?.pageCount ?? 0,
			wikiContextSeedCount: wikiContext?.seedCount ?? 0,
			generationTimings,
			memoryTokenBudget,
		},
		serverVersion: turnVersion,
		createdAt,
		updatedAt: createdAt,
	}).onConflictDoNothing();

	let rawUpdate: unknown = { update: worldStateUpdateSchema.parse({}) };
	if (classifierProfile) {
		const classifierSystem = classifierService.systemPromptOverride?.trim() || 'You extract canonical state changes for a text adventure. Return strict JSON only.';
		const extractionPrompt = buildStateExtractionPrompt(request.playerText, narration);
		try {
			const extractionResult = await generateServerTextWithMetrics({
				profile: classifierProfile,
				model: classifierGeneration.model,
				temperature: classifierGeneration.temperature,
				maxTokens: classifierGeneration.maxTokens,
				system: classifierSystem,
				prompt: extractionPrompt,
				responseFormat: 'json_object',
			});
			generationTimings.push(timingFromResult('turn.state_extraction', 'classifier', extractionResult, 'success'));
			await logGenerationCall({
				storyId: request.storyId,
				clientTurnId: request.clientTurnId,
				serviceId: 'classifier',
				operation: 'turn.state_extraction',
				profile: classifierProfile,
				result: extractionResult,
				status: 'success',
				metadata: {
					responseFormat: 'json_object',
					debugSnapshot: buildTurnDebugSnapshot({
						kind: 'state_extraction',
						playerText: request.playerText,
						system: classifierSystem,
						prompt: extractionPrompt,
						output: extractionResult.text,
					}),
				},
			});
			rawUpdate = parseJsonFromGeneratedText(extractionResult.text);
		} catch (error) {
			const failedResult = generationErrorResult(error);
			if (failedResult) {
				generationTimings.push(timingFromResult('turn.state_extraction', 'classifier', failedResult, 'error'));
				await logGenerationCall({
					storyId: request.storyId,
					clientTurnId: request.clientTurnId,
					serviceId: 'classifier',
					operation: 'turn.state_extraction',
					profile: classifierProfile,
					result: failedResult,
					status: 'error',
					error,
					metadata: {
						responseFormat: 'json_object',
						statusCode: failedResult.statusCode ?? null,
						debugSnapshot: buildTurnDebugSnapshot({
							kind: 'state_extraction',
							playerText: request.playerText,
							system: classifierSystem,
							prompt: extractionPrompt,
						}),
					},
				});
			}
			warnings.push(`State extraction failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const parsedUpdate = parseTurnUpdate(rawUpdate);
	warnings.push(...parsedUpdate.warnings);
	const applied = await applyValidatedTurnUpdate({
		storyId: request.storyId,
		playerEntryId,
		assistantEntryId,
		narration,
		update: parsedUpdate.update,
		parseWarnings: parsedUpdate.warnings,
		retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
		serverVersion: turnVersion,
		memorySettings,
	});
	warnings.push(...applied.warnings);

	const entries = await db
		.select()
		.from(storyEntries)
		.where(eq(storyEntries.storyId, request.storyId))
		.orderBy(desc(storyEntries.position))
		.limit(2);
	const syncChanges = await getSyncChanges(request.storyId, request.localVersion);
	const maxVersion = syncChanges.reduce((max, change) => Math.max(max, change.version), turnVersion);

	return {
		narration,
		entries: entries.reverse(),
		playerEntryId,
		assistantEntryId,
		statePatchIds: applied.patchIds,
		eventIds: applied.eventIds,
		retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
		memoryNodeIds: applied.memoryNodeIds,
		serverVersion: maxVersion,
		syncChanges,
		warnings,
		generationTimings,
	};
}
