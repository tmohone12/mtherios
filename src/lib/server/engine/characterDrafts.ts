import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { arcs, chapters, entities, patchProposals, storyEntries } from '$lib/server/db/schema';
import { bumpStoryVersion } from '$lib/server/memory/canonical';
import { selectStoryMemory } from '$lib/services/ai/context/storyMemorySelector';
import { resolveServiceGeneration } from './llmSettings';
import { generateServerTextWithMetrics, parseJsonFromGeneratedText } from '$lib/server/turn/provider';

type JsonRecord = Record<string, unknown>;

export interface CharacterDraftUpdateArgs {
	recordId: string;
	instructions: string;
	recentLimit: number;
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

	let generation: Awaited<ReturnType<typeof resolveServiceGeneration>> | null = null;
	let serviceId = '';
	const missingReasons: string[] = [];
	for (const candidateServiceId of ['memory', 'loreManagement', 'classifier', 'narrative']) {
		const resolved = await resolveServiceGeneration(candidateServiceId);
		if (resolved.profile) {
			generation = resolved;
			serviceId = candidateServiceId;
			break;
		}
		if (resolved.missingReason) missingReasons.push(resolved.missingReason);
	}
	if (!generation?.profile) throw new Error(missingReasons[0] ?? 'No LLM profile is configured.');

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
	const result = await generateServerTextWithMetrics({
		profile: generation.profile,
		model: generation.generation.model,
		temperature: Math.min(generation.generation.temperature ?? 0.2, 0.4),
		maxTokens: Math.min(generation.generation.maxTokens ?? 1600, 1600),
		system: generation.systemPromptOverride?.trim() || 'You update structured NPC canon from text RPG context. Return strict JSON only.',
		prompt,
		responseFormat: 'json_object',
	});
	const draft = coerceDraft(parseJsonFromGeneratedText(result.text));
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
			serviceId,
			model: result.model,
			promptChars: result.promptChars,
		},
		serverVersion,
		createdAt: updatedAt,
		updatedAt,
	}).onConflictDoNothing();
	return { storyId, recordId: character.id, proposalId, status: 'pending' };
}
