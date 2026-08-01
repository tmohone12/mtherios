import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { arcs, chapters, entities, patchProposals, storyEntries } from '$lib/server/db/schema';
import { bumpStoryVersion } from '$lib/server/memory/canonical';
import { selectStoryMemory } from '$lib/services/ai/context/storyMemorySelector';
import { recordApiCallLog } from './apiCallLogs';
import { resolveServiceGeneration } from './llmSettings';
import {
	ServerGenerationError,
	generateServerTextWithMetrics,
	parseJsonFromGeneratedText,
	type ServerGenerationResult,
} from '$lib/server/turn/provider';

type JsonRecord = Record<string, unknown>;
type ResolvedServiceGeneration = Awaited<ReturnType<typeof resolveServiceGeneration>>;
type AvailableServiceGeneration = ResolvedServiceGeneration & {
	profile: NonNullable<ResolvedServiceGeneration['profile']>;
};

const CHARACTER_UPDATE_SERVICE_ID = 'characterUpdate';
const CHARACTER_UPDATE_SYSTEM_PROMPT = [
	'You maintain structured character continuity for a text RPG.',
	'Use only supplied canon and chapter evidence. Never invent facts or characters.',
	'Return strict JSON only.',
].join(' ');

export interface CharacterDraftUpdateArgs {
	recordId: string;
	instructions: string;
	recentLimit: number;
}

export interface ChapterCharacterUpdateCandidate {
	entityId: string;
	name: string;
	state: JsonRecord;
}

export interface ChapterCharacterUpdateBatchArgs {
	storyId: string;
	chapterWindow: [number, number];
	chapterEvidence?: Array<{ number: number; title: string; summary: string }>;
	candidates: ChapterCharacterUpdateCandidate[];
}

export interface ChapterCharacterUpdateBatchResult {
	status: 'generated' | 'skipped';
	reason: string | null;
	requestedServiceId: typeof CHARACTER_UPDATE_SERVICE_ID;
	effectiveServiceId: string | null;
	model: string | null;
	promptChars: number;
	responseChars: number;
	updates: Array<{ entityId: string; state: JsonRecord }>;
}

interface CharacterUpdateServiceResolution {
	serviceId: string | null;
	resolved: AvailableServiceGeneration | null;
	reason: string | null;
}

function nowIso(): string {
	return new Date().toISOString();
}

function id(prefix: string): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
		: [];
}

function compact(value: string, max = 500): string {
	const text = value.replace(/\s+/g, ' ').trim();
	return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

function compactJson(value: unknown, max = 300): string {
	const text = JSON.stringify(value);
	return !text || text === '[]' || text === '{}' ? '' : compact(text, max);
}

function hasAvailableProfile(resolved: ResolvedServiceGeneration): resolved is AvailableServiceGeneration {
	return Boolean(resolved.profile);
}

async function resolveCharacterUpdateService(): Promise<CharacterUpdateServiceResolution> {
	const primary = await resolveServiceGeneration(CHARACTER_UPDATE_SERVICE_ID);
	if (hasAvailableProfile(primary)) {
		return { serviceId: CHARACTER_UPDATE_SERVICE_ID, resolved: primary, reason: null };
	}

	// A persisted row is an explicit operator choice. Disabled or invalid means skip/fail visibly,
	// rather than silently spending money on a different model.
	if (primary.setting !== null) {
		return {
			serviceId: CHARACTER_UPDATE_SERVICE_ID,
			resolved: null,
			reason: primary.missingReason ?? 'Character Update service is unavailable.',
		};
	}

	// Upgrade compatibility for installations that have not saved the new service row yet.
	const fallback = await resolveServiceGeneration('classifier');
	if (hasAvailableProfile(fallback)) {
		return { serviceId: 'classifier', resolved: fallback, reason: primary.missingReason };
	}
	return {
		serviceId: null,
		resolved: null,
		reason: primary.missingReason ?? fallback.missingReason ?? 'No character update model is configured.',
	};
}

async function logCharacterUpdateCall(input: {
	storyId: string;
	operation: string;
	service: CharacterUpdateServiceResolution & { serviceId: string; resolved: AvailableServiceGeneration };
	status: 'success' | 'error';
	result: ServerGenerationResult | ServerGenerationError['result'];
	error?: unknown;
	metadata?: JsonRecord;
}): Promise<void> {
	const usage = 'usage' in input.result ? input.result.usage : undefined;
	await recordApiCallLog({
		storyId: input.storyId,
		serviceId: CHARACTER_UPDATE_SERVICE_ID,
		operation: input.operation,
		providerType: input.service.resolved.profile.providerType,
		providerName: input.service.resolved.profile.name ?? null,
		profileId: input.service.resolved.profile.id ?? null,
		model: input.result.model,
		endpoint: input.result.endpoint,
		status: input.status,
		durationMs: input.result.durationMs,
		requestTokens: usage?.requestTokens ?? null,
		responseTokens: usage?.responseTokens ?? null,
		totalTokens: usage?.totalTokens ?? null,
		promptChars: input.result.promptChars,
		responseChars: 'responseChars' in input.result ? input.result.responseChars ?? null : null,
		error: input.error instanceof Error ? input.error.message : input.error ? String(input.error) : null,
		metadata: {
			requestedServiceId: CHARACTER_UPDATE_SERVICE_ID,
			effectiveServiceId: input.service.serviceId,
			fallback: input.service.serviceId !== CHARACTER_UPDATE_SERVICE_ID,
			...(input.metadata ?? {}),
		},
	});
}

async function generateCharacterUpdateText(input: {
	storyId: string;
	operation: string;
	service: CharacterUpdateServiceResolution & { serviceId: string; resolved: AvailableServiceGeneration };
	prompt: string;
	maxTokens: number;
	metadata?: JsonRecord;
}): Promise<ServerGenerationResult> {
	const { resolved } = input.service;
	try {
		const result = await generateServerTextWithMetrics({
			profile: resolved.profile,
			model: resolved.generation.model,
			temperature: Math.min(resolved.generation.temperature ?? 0.2, 0.4),
			maxTokens: Math.max(512, Math.min(resolved.generation.maxTokens ?? input.maxTokens, input.maxTokens)),
			reasoningEffort: 'off',
			timeoutMs: 90000,
			system: resolved.systemPromptOverride?.trim() || CHARACTER_UPDATE_SYSTEM_PROMPT,
			prompt: input.prompt,
			responseFormat: 'json_object',
		});
		return result;
	} catch (error) {
		const failed = error instanceof ServerGenerationError ? error.result : null;
		if (failed) {
			await logCharacterUpdateCall({
				storyId: input.storyId,
				operation: input.operation,
				service: input.service,
				status: 'error',
				result: failed,
				error,
				metadata: input.metadata,
			});
		}
		throw error;
	}
}

async function parseCharacterUpdateResult(input: {
	storyId: string;
	operation: string;
	service: CharacterUpdateServiceResolution & { serviceId: string; resolved: AvailableServiceGeneration };
	result: ServerGenerationResult;
	metadata?: JsonRecord;
}): Promise<unknown> {
	try {
		const parsed = parseJsonFromGeneratedText(input.result.text);
		await logCharacterUpdateCall({
			storyId: input.storyId,
			operation: input.operation,
			service: input.service,
			status: 'success',
			result: input.result,
			metadata: { parseOutcome: 'parsed', ...(input.metadata ?? {}) },
		});
		return parsed;
	} catch (error) {
		await logCharacterUpdateCall({
			storyId: input.storyId,
			operation: input.operation,
			service: input.service,
			status: 'error',
			result: input.result,
			error,
			metadata: { parseOutcome: 'invalid_json', ...(input.metadata ?? {}) },
		});
		throw error;
	}
}

function characterSearchTerms(name: string, state: JsonRecord, metadata: JsonRecord): string[] {
	const fullName = name.trim();
	const firstName = fullName.split(/\s+/).find((part) => part.length > 2) ?? '';
	const terms = [fullName, ...stringArray(state.aliases), ...stringArray(metadata.localAliases), ...stringArray(metadata.sourceKeys), firstName].filter((term) => term.length > 2);
	return [...new Map(terms.map((term) => [term.toLowerCase(), term])).values()].slice(0, 4);
}

function renderChapterContext(row: typeof chapters.$inferSelect): string {
	return `Chapter ${row.number}: ${row.title ?? 'Untitled'}\n${compact([
		row.sceneOutcome,
		compactJson(row.npcKnowledgeChanges),
		...row.irreversibleChanges,
		...row.relationshipChanges,
		...row.openThreads,
	].filter(Boolean).join(' '), 600)}`;
}

function renderArcContext(row: typeof arcs.$inferSelect): string {
	return `Arc ${row.number}: ${row.title}\n${compact(row.summary, 600)}`;
}

function renderEntryContext(entry: typeof storyEntries.$inferSelect): string {
	return `${entry.type}: ${compact(entry.content, 500)}`;
}

function metadataStateSeed(metadata: JsonRecord): JsonRecord {
	const seed: JsonRecord = {};
	for (const key of ['bio', 'rank', 'appearance', 'personality', 'currentDisposition']) {
		const value = metadata[key];
		if (typeof value === 'string' && value.trim()) seed[key] = value.trim();
	}
	if (asRecord(metadata.relationship).status) seed.relationship = metadata.relationship;
	for (const key of ['knownFacts', 'factionTags', 'motivations']) {
		const values = stringArray(metadata[key]);
		if (values.length) seed[key] = values;
	}
	return seed;
}

function coerceDraft(value: unknown): JsonRecord {
	const draft = asRecord(value);
	const relationship = asRecord(draft.relationship);
	const affinity = typeof draft.affinity === 'number'
		? draft.affinity
		: typeof relationship.level === 'number'
			? relationship.level
			: null;
	return {
		bio: typeof draft.bio === 'string' ? draft.bio : '',
		rank: typeof draft.rank === 'string' ? draft.rank : '',
		appearance: typeof draft.appearance === 'string' ? draft.appearance : '',
		personality: typeof draft.personality === 'string' ? draft.personality : '',
		currentDisposition: typeof draft.currentDisposition === 'string' ? draft.currentDisposition : '',
		affinity: affinity == null ? null : Math.min(100, Math.max(-100, affinity)),
		motivations: stringArray(draft.motivations ?? draft.goals),
		factionTags: stringArray(draft.factionTags),
		knownFacts: stringArray(draft.knownFacts),
	};
}

function mergeStringLists(previous: unknown, next: string[], max = 12): string[] {
	const values = [...stringArray(previous), ...next];
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const value of values) {
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(value);
	}
	return merged.slice(-max);
}

function hasUsefulDraft(draft: JsonRecord): boolean {
	for (const key of ['bio', 'rank', 'appearance', 'personality', 'currentDisposition']) {
		if (typeof draft[key] === 'string' && draft[key].trim()) return true;
	}
	if (typeof draft.affinity === 'number') return true;
	for (const key of ['knownFacts', 'factionTags', 'motivations']) {
		if (stringArray(draft[key]).length) return true;
	}
	return false;
}

function mergeDraftIntoState(currentState: JsonRecord, draft: JsonRecord): JsonRecord {
	const next = { ...currentState };
	for (const key of ['bio', 'rank', 'appearance', 'personality', 'currentDisposition']) {
		const value = typeof draft[key] === 'string' ? draft[key].trim() : '';
		if (value) next[key] = value;
	}
	if (typeof draft.affinity === 'number') {
		next.relationship = { status: 'unknown', history: [], ...asRecord(currentState.relationship), level: draft.affinity };
	}
	for (const key of ['knownFacts', 'factionTags', 'motivations']) {
		const values = stringArray(draft[key]);
		if (values.length) next[key] = mergeStringLists(currentState[key], values);
	}
	return next;
}

function currentStateWithMetadataSeed(state: JsonRecord, metadata: JsonRecord): JsonRecord {
	const seed = metadataStateSeed(metadata);
	const merged = { ...seed, ...state };
	const relationship = asRecord(merged.relationship);
	const relationshipStatus = typeof merged.relationship === 'string' && merged.relationship.trim()
		? merged.relationship.trim()
		: typeof relationship.status === 'string' && relationship.status.trim()
			? relationship.status.trim()
			: 'unknown';
	const next: JsonRecord = {
		type: 'character',
		isPresent: typeof merged.isPresent === 'boolean' ? merged.isPresent : false,
		relationship: {
			level: typeof relationship.level === 'number' ? Math.min(100, Math.max(-100, relationship.level)) : 0,
			status: relationshipStatus,
			history: Array.isArray(relationship.history) ? relationship.history : [],
		},
		knownFacts: stringArray(merged.knownFacts),
	};
	for (const key of ['bio', 'rank', 'appearance', 'personality', 'currentDisposition']) {
		const value = merged[key];
		if (typeof value === 'string' && value.trim()) next[key] = value.trim();
		else if (value === null) next[key] = null;
	}
	for (const key of ['knownFacts', 'factionTags', 'motivations']) {
		const values = mergeStringLists(state[key], stringArray(seed[key]));
		if (values.length) next[key] = values;
	}
	return next;
}

function chapterCharacterPromptState(state: JsonRecord): JsonRecord {
	const memory = asRecord(state.eventMemory ?? state.npcEventMemory);
	const next: JsonRecord = {};
	for (const key of [
		'bio',
		'rank',
		'appearance',
		'personality',
		'currentDisposition',
		'currentLocation',
		'currentAction',
		'emotionalState',
		'relationship',
	]) {
		const value = state[key];
		if (typeof value === 'string' && value.trim()) next[key] = value.trim();
		else if (key === 'relationship' && Object.keys(asRecord(value)).length) next[key] = value;
	}
	for (const key of ['motivations', 'goals', 'factionTags', 'knownFacts', 'traits', 'pressures']) {
		const values = stringArray(state[key]).slice(-12);
		if (values.length) next[key] = values;
	}
	const eventMemory = Object.fromEntries(
		['did', 'saw', 'knew', 'knows']
			.map((key) => [key, stringArray(memory[key]).slice(-8)] as const)
			.filter(([, values]) => values.length),
	);
	if (Object.keys(eventMemory).length) next.eventMemory = eventMemory;
	return next;
}

export async function refineChapterCharacterUpdates(
	args: ChapterCharacterUpdateBatchArgs,
): Promise<ChapterCharacterUpdateBatchResult> {
	const candidates = [...new Map(
		args.candidates
			.filter((candidate) => candidate.entityId.trim() && candidate.name.trim())
			.map((candidate) => [candidate.entityId, candidate]),
	).values()].slice(0, 16);
	if (candidates.length === 0) {
		return {
			status: 'skipped',
			reason: 'No chapter character candidates were available.',
			requestedServiceId: CHARACTER_UPDATE_SERVICE_ID,
			effectiveServiceId: null,
			model: null,
			promptChars: 0,
			responseChars: 0,
			updates: [],
		};
	}

	const service = await resolveCharacterUpdateService();
	if (!service.serviceId || !service.resolved) {
		return {
			status: 'skipped',
			reason: service.reason ?? 'Character Update service is unavailable.',
			requestedServiceId: CHARACTER_UPDATE_SERVICE_ID,
			effectiveServiceId: service.serviceId,
			model: null,
			promptChars: 0,
			responseChars: 0,
			updates: [],
		};
	}
	const availableService = { ...service, serviceId: service.serviceId, resolved: service.resolved };
	const candidatePayload = candidates.map((candidate) => ({
		entityId: candidate.entityId,
		name: candidate.name,
		stateAndChapterEvidence: chapterCharacterPromptState(candidate.state),
	}));
	const chapterEvidence = (args.chapterEvidence ?? []).slice(-2).map((chapter) => ({
		number: chapter.number,
		title: chapter.title,
		summary: compact(chapter.summary, 2600),
	}));
	const prompt = [
		`Chapter window: ${args.chapterWindow[0]}-${args.chapterWindow[1]}`,
		`Two-chapter continuity digests JSON: ${JSON.stringify(chapterEvidence)}`,
		`Known character candidates JSON: ${JSON.stringify(candidatePayload)}`,
		'Return exactly {"updates":[{"entityId":"known id","patch":{...},"evidence":["short supplied fact"],"confidence":0.0}]}',
		'Allowed patch keys only: bio, appearance, personality, rank, currentDisposition, affinity, motivations, factionTags, knownFacts.',
		'Use affinity only for a clearly evidenced -100..100 relationship shift. Use motivations for durable goals.',
		'Do not return currentAction, currentLocation, emotionalState, relationship objects, eventMemory, aliases, status, or presence; deterministic extraction owns those fields.',
		'Only use an entityId from the candidate list. Omit unchanged characters and unsupported or uncertain claims.',
		'Appearance, bio, rank, and personality require explicit supplied evidence; never infer them from genre or names.',
	].join('\n\n');
	const result = await generateCharacterUpdateText({
		storyId: args.storyId,
		operation: 'chapter.character_update',
		service: availableService,
		prompt,
		maxTokens: 8192,
		metadata: { chapterWindow: args.chapterWindow, candidateCount: candidates.length },
	});
	const parsed = asRecord(await parseCharacterUpdateResult({
		storyId: args.storyId,
		operation: 'chapter.character_update',
		service: availableService,
		result,
		metadata: { chapterWindow: args.chapterWindow, candidateCount: candidates.length },
	}));
	const known = new Map(candidates.map((candidate) => [candidate.entityId, candidate]));
	const updates: Array<{ entityId: string; state: JsonRecord }> = [];
	const seen = new Set<string>();
	for (const value of Array.isArray(parsed.updates) ? parsed.updates : []) {
		const update = asRecord(value);
		const entityId = typeof update.entityId === 'string' ? update.entityId.trim() : '';
		const candidate = known.get(entityId);
		if (!candidate || seen.has(entityId)) continue;
		const draft = coerceDraft(update.patch);
		if (!hasUsefulDraft(draft)) continue;
		seen.add(entityId);
		updates.push({ entityId, state: mergeDraftIntoState(candidate.state, draft) });
	}

	return {
		status: 'generated',
		reason: updates.length ? null : 'The model found no supported durable character changes.',
		requestedServiceId: CHARACTER_UPDATE_SERVICE_ID,
		effectiveServiceId: service.serviceId,
		model: result.model,
		promptChars: result.promptChars,
		responseChars: result.responseChars,
		updates,
	};
}

export async function draftCharacterUpdateFromStoryContext(storyId: string, args: CharacterDraftUpdateArgs): Promise<JsonRecord> {
	const db = getDb();
	const [character] = await db.select().from(entities).where(eq(entities.id, args.recordId)).limit(1);
	if (!character || character.storyId !== storyId || character.type !== 'character') {
		throw new Error(`Character not found: ${args.recordId}`);
	}

	const metadata = asRecord(character.metadata);
	const currentState = currentStateWithMetadataSeed(asRecord(character.state), metadata);
	const searchTerms = characterSearchTerms(character.name, currentState, metadata);
	const searchTerm = searchTerms[0] ?? character.name;
	const likes = (searchTerms.length ? searchTerms : [character.name || character.id]).map((term) => `%${term}%`);
	const recentLimit = Math.min(Math.max(0, args.recentLimit), 8);
	const recentRows = await db.select().from(storyEntries)
		.where(eq(storyEntries.storyId, storyId))
		.orderBy(desc(storyEntries.position))
		.limit(recentLimit);
	const searchedEntries = await db.select().from(storyEntries)
		.where(and(eq(storyEntries.storyId, storyId), or(...likes.map((like) => ilike(storyEntries.content, like)))))
		.orderBy(desc(storyEntries.position))
		.limit(8);
	const searchedChapters = await db.select().from(chapters)
		.where(and(
			eq(chapters.storyId, storyId),
			or(
				...likes.flatMap((like) => [
					ilike(chapters.title, like),
					ilike(chapters.sceneOutcome, like),
					sql`${chapters.npcKnowledgeChanges}::text ilike ${like}`,
					sql`${chapters.relationshipChanges}::text ilike ${like}`,
					sql`${chapters.openThreads}::text ilike ${like}`,
				]),
			),
		))
		.orderBy(desc(chapters.number))
		.limit(5);
	const searchedArcs = await db.select().from(arcs)
		.where(and(
			eq(arcs.storyId, storyId),
			or(
				...likes.flatMap((like) => [
					ilike(arcs.title, like),
					ilike(arcs.summary, like),
					sql`${arcs.metadata}::text ilike ${like}`,
				]),
			),
		))
		.orderBy(desc(arcs.number))
		.limit(3);
	const memoryChapters = await db.select().from(chapters)
		.where(eq(chapters.storyId, storyId))
		.orderBy(desc(chapters.number))
		.limit(120);
	const memoryArcs = await db.select().from(arcs)
		.where(eq(arcs.storyId, storyId))
		.orderBy(desc(arcs.number))
		.limit(40);
	const memorySelection = selectStoryMemory(memoryChapters, memoryArcs, {
		query: [character.name, ...searchTerms, args.instructions, character.description ?? ''].join(' '),
		sceneEntityNames: [character.name, ...searchTerms],
		tokenBudget: 2600,
		recentCount: 5,
		relevantCount: 8,
		resurfacedCount: 2,
		perItemTokenBudget: 220,
		seed: character.id,
	});
	const recent = [...recentRows].reverse();
	const storyMatches = [...searchedEntries].reverse();
	const context = [
		memorySelection.block,
		searchedChapters.length ? `Name-matched chapters for "${searchTerms.join(', ')}":\n${[...searchedChapters].reverse().map(renderChapterContext).join('\n\n')}` : '',
		searchedArcs.length ? `Name-matched arcs for "${searchTerms.join(', ')}":\n${[...searchedArcs].reverse().map(renderArcContext).join('\n\n')}` : '',
		storyMatches.length ? `Name-matched story entries for "${searchTerms.join(', ')}":\n${storyMatches.map(renderEntryContext).join('\n\n')}` : '',
		recent.length ? `Recent transcript:\n${recent.map(renderEntryContext).join('\n\n')}` : '',
	].filter(Boolean).join('\n\n');

	const service = await resolveCharacterUpdateService();
	if (!service.serviceId || !service.resolved) {
		throw new Error(service.reason ?? 'No character update model is configured.');
	}
	const availableService = { ...service, serviceId: service.serviceId, resolved: service.resolved };

	const prompt = [
		`Character id: ${character.id}`,
		`Name: ${character.name}`,
		`Description: ${character.description ?? ''}`,
		`Current state JSON: ${JSON.stringify(currentState)}`,
		`Instructions: ${args.instructions}`,
		'Story context:',
		context || '(no recent transcript)',
		'Return JSON with only these character state keys: bio, appearance, personality, rank, currentDisposition, affinity, motivations, factionTags, knownFacts.',
		'Use motivations for goals. Use affinity as a -100..100 number. If the evidence has no update, return {}.',
		'Use only supported facts. Empty string or empty array is better than guessing. For list fields, include durable current facts the reviewer should keep.',
	].join('\n\n');
	const result = await generateCharacterUpdateText({
		storyId,
		operation: 'character.draft_update',
		service: availableService,
		prompt,
		maxTokens: 1600,
		metadata: { recordId: character.id, characterName: character.name },
	});
	const draft = coerceDraft(await parseCharacterUpdateResult({
		storyId,
		operation: 'character.draft_update',
		service: availableService,
		result,
		metadata: { recordId: character.id, characterName: character.name },
	}));
	if (!hasUsefulDraft(draft)) {
		return {
			storyId,
			recordId: character.id,
			proposalId: null,
			status: 'skipped',
			reason: 'No supported character changes found.',
		};
	}
	const state = mergeDraftIntoState(currentState, draft);
	const updatedAt = nowIso();
	const serverVersion = await bumpStoryVersion(storyId);
	const proposalId = id('character_update_proposal');
	await db.insert(patchProposals).values({
		id: proposalId,
		storyId,
		proposalType: 'character_context_update',
		targetTable: 'entities',
		targetRecordId: character.id,
		proposedBy: 'llm',
		operations: [{ op: 'replace', path: `/characters/${character.id}/state`, value: state }],
		reason: args.instructions || 'Draft character update from story context.',
		suggestion: 'Review this NPC update before applying it to canon.',
		status: 'pending',
		decision: null,
		validatedBy: null,
		affectedEntityIds: [character.id],
		confidence: 0.75,
		sourceEntryIds: [...new Set([
			...storyMatches.map((entry) => entry.id),
			...recent.map((entry) => entry.id),
			...searchedChapters.flatMap((chapter) => chapter.sourceEntryIds),
		])].slice(-16),
		sourceEventIds: [],
		sourcePatchIds: [],
		metadata: {
			sourceType: 'character_context_update',
			characterName: character.name,
			searchTerm,
			searchTerms,
			sourceChapterIds: searchedChapters.map((chapter) => chapter.id),
			sourceArcIds: searchedArcs.map((arc) => arc.id),
			selectedMemoryIds: memorySelection.selectedIds,
			serviceId: service.serviceId,
			model: result.model,
			promptChars: result.promptChars,
		},
		serverVersion,
		createdAt: updatedAt,
		updatedAt,
	}).onConflictDoNothing();
	return { storyId, recordId: character.id, proposalId, status: 'pending' };
}
