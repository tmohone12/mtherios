import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { arcs, chapters, entities, facts, factions, memoryNodes, stories, storyEntries, storyEvents } from '$lib/server/db/schema';
import type { SmallBrainRunRequest, SmallBrainRunResponse } from '$lib/contracts/engine';
import { smallBrainResultSchema, type SmallBrainResult } from '$lib/services/ai/sdk/schemas/smallBrain';
import { generateServerTextWithMetrics, parseJsonFromGeneratedText } from '$lib/server/turn/provider';
import { resolveServiceGeneration } from './llmSettings';

type ResolvedGeneration = Awaited<ReturnType<typeof resolveServiceGeneration>>;

const DEFAULT_SYSTEM = 'You are a cheap structured reasoning worker for a text RPG engine. No canon writes. JSON proposals only.';

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function compact(value: unknown, max = 450): string {
	const text = typeof value === 'string'
		? value
		: JSON.stringify(value);
	const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
		: [];
}

function ids(rows: Array<{ id: string }>): string[] {
	return rows.map((row) => row.id);
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
	const seen = new Set<string>();
	const kept: T[] = [];
	for (const row of rows) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		kept.push(row);
	}
	return kept;
}

function warn(warnings: string[], message: string): void {
	if (!warnings.includes(message)) warnings.push(message);
}

function fail(request: SmallBrainRunRequest, model: string, warnings: string[]): SmallBrainRunResponse {
	return {
		ok: false,
		storyId: request.storyId,
		mode: request.mode,
		model,
		result: null,
		warnings,
	};
}

async function resolveGeneration(warnings: string[]): Promise<ResolvedGeneration | null> {
	let primaryReason = '';
	try {
		const primary = await resolveServiceGeneration('smallBrain');
		if (primary.profile && primary.generation.model?.trim()) return primary;
		primaryReason = primary.profile
			? 'smallBrain profile has no configured model.'
			: primary.missingReason ?? 'smallBrain profile is unavailable.';
	} catch (error) {
		primaryReason = `smallBrain resolution failed: ${message(error)}`;
	}

	let fallback: ResolvedGeneration;
	try {
		fallback = await resolveServiceGeneration('classifier');
	} catch (error) {
		warn(warnings, primaryReason);
		warn(warnings, `classifier resolution failed: ${message(error)}`);
		return null;
	}
	if (fallback.profile && fallback.generation.model?.trim()) {
		warn(warnings, `smallBrain unavailable; using classifier fallback: ${primaryReason}`);
		return fallback;
	}

	warn(warnings, primaryReason);
	warn(warnings, fallback.profile
		? 'classifier profile has no configured model.'
		: fallback.missingReason ?? 'classifier profile is unavailable.');
	return null;
}

function renderEntries(rows: Array<typeof storyEntries.$inferSelect>): string {
	return rows.map((entry) => `- ${entry.id} [${entry.type} #${entry.position}]: ${compact(entry.content)}`).join('\n');
}

function renderEntities(rows: Array<typeof entities.$inferSelect>): string {
	return rows.map((entity) => `- ${entity.id} ${entity.name} (${entity.type}, ${entity.status}): ${compact([
		entity.description,
		compact(entity.state, 220),
		compact(entity.metadata, 180),
	].filter(Boolean).join(' | '))}`).join('\n');
}

function renderFactions(rows: Array<typeof factions.$inferSelect>): string {
	return rows.map((faction) => `- ${faction.id} ${faction.name}: pressure=${faction.pressure}; goals=${compact(faction.goals, 220)}`).join('\n');
}

function renderEvents(rows: Array<typeof storyEvents.$inferSelect>): string {
	return rows.map((event) => `- ${event.id} ${event.title}: ${compact(event.body)} sourceEntries=${stringArray(event.sourceEntryIds).join(',')}`).join('\n');
}

function renderFacts(rows: Array<typeof facts.$inferSelect>): string {
	return rows.map((fact) => `- ${fact.id} ${fact.title}: ${compact(fact.statement)} sourceEntries=${stringArray(fact.sourceEntryIds).join(',')}`).join('\n');
}

function renderMemory(rows: Array<typeof memoryNodes.$inferSelect>): string {
	return rows.map((memory) => `- ${memory.id} ${memory.title}: ${compact(memory.summary || memory.content)} sourceEntries=${stringArray(memory.sourceEntryIds).join(',')}`).join('\n');
}

function renderChapters(rows: Array<typeof chapters.$inferSelect>): string {
	return rows.map((chapter) => `- ${chapter.id} Chapter ${chapter.number}: ${chapter.title ?? 'Untitled'}; ${compact(chapter.sceneOutcome)} sourceEntries=${stringArray(chapter.sourceEntryIds).join(',')}`).join('\n');
}

function renderArcs(rows: Array<typeof arcs.$inferSelect>): string {
	return rows.map((arc) => `- ${arc.id} Arc ${arc.number}: ${arc.title}; ${compact(arc.summary)}`).join('\n');
}

function buildPrompt(args: {
	request: SmallBrainRunRequest;
	story: typeof stories.$inferSelect;
	entries: Array<typeof storyEntries.$inferSelect>;
	entities: Array<typeof entities.$inferSelect>;
	factions: Array<typeof factions.$inferSelect>;
	events: Array<typeof storyEvents.$inferSelect>;
	facts: Array<typeof facts.$inferSelect>;
	memories: Array<typeof memoryNodes.$inferSelect>;
	chapters: Array<typeof chapters.$inferSelect>;
	arcs: Array<typeof arcs.$inferSelect>;
}): string {
	return [
		`Story ${args.story.id}: ${args.story.title}`,
		`Mode requested: ${args.request.mode}`,
		'context mode: return a brief, relevant entry/entity/faction ids, prompt notes, and uncertainties.',
		'canon mode: return reviewable fact/event/memory/relationship/contradiction proposals with source ids only; do not write canon.',
		'world mode: return npc intents, faction strategic pulse, and wiki drafts as proposals only.',
		`Known entry ids: ${ids(args.entries).join(', ') || '(none)'}`,
		`Known entity ids: ${ids(args.entities).join(', ') || '(none)'}`,
		`Known faction ids: ${ids(args.factions).join(', ') || '(none)'}`,
		'Return strict JSON matching the requested mode. Use only ids shown in this context.',
		'',
		`Recent entries:\n${renderEntries(args.entries) || '(none)'}`,
		`Entities:\n${renderEntities(args.entities) || '(none)'}`,
		`Factions:\n${renderFactions(args.factions) || '(none)'}`,
		`Events:\n${renderEvents(args.events) || '(none)'}`,
		`Facts:\n${renderFacts(args.facts) || '(none)'}`,
		`Memory:\n${renderMemory(args.memories) || '(none)'}`,
		`Chapters:\n${renderChapters(args.chapters) || '(none)'}`,
		`Arcs:\n${renderArcs(args.arcs) || '(none)'}`,
	].join('\n');
}

function addRelatedIds(set: Set<string>, value: unknown): void {
	for (const id of stringArray(value)) set.add(id);
}

function knownContextIds(context: {
	entries: Array<typeof storyEntries.$inferSelect>;
	entities: Array<typeof entities.$inferSelect>;
	factions: Array<typeof factions.$inferSelect>;
	events: Array<typeof storyEvents.$inferSelect>;
	facts: Array<typeof facts.$inferSelect>;
	memories: Array<typeof memoryNodes.$inferSelect>;
	chapters: Array<typeof chapters.$inferSelect>;
}): { entryIds: Set<string>; entityIds: Set<string>; factionIds: Set<string> } {
	const entryIds = new Set(ids(context.entries));
	const entityIds = new Set(ids(context.entities));
	const factionIds = new Set(ids(context.factions));
	for (const row of context.events) {
		addRelatedIds(entryIds, row.sourceEntryIds);
		addRelatedIds(entityIds, row.actorEntityIds);
		addRelatedIds(entityIds, row.targetEntityIds);
		addRelatedIds(factionIds, row.factionIds);
	}
	for (const row of context.facts) {
		addRelatedIds(entryIds, row.sourceEntryIds);
		if (row.subjectEntityId) entityIds.add(row.subjectEntityId);
		if (row.targetEntityId) entityIds.add(row.targetEntityId);
	}
	for (const row of context.memories) {
		addRelatedIds(entryIds, row.sourceEntryIds);
		addRelatedIds(entityIds, row.entityIds);
		addRelatedIds(factionIds, row.factionIds);
	}
	for (const row of context.chapters) addRelatedIds(entryIds, row.sourceEntryIds);
	return { entryIds, entityIds, factionIds };
}

function warnUnknownIds(warnings: string[], kind: 'entry' | 'entity' | 'faction', values: unknown, known: Set<string>): void {
	for (const id of stringArray(values)) {
		if (!known.has(id)) warn(warnings, `Unknown referenced ${kind} id: ${id}`);
	}
}

function addReferenceWarnings(
	result: SmallBrainResult,
	warnings: string[],
	known: { entryIds: Set<string>; entityIds: Set<string>; factionIds: Set<string> },
): void {
	if (result.mode === 'context') {
		warnUnknownIds(warnings, 'entry', result.relevantEntryIds, known.entryIds);
		warnUnknownIds(warnings, 'entity', result.relevantEntityIds, known.entityIds);
		warnUnknownIds(warnings, 'faction', result.relevantFactionIds, known.factionIds);
		return;
	}
	if (result.mode === 'canon') {
		for (const proposal of result.proposals) {
			warnUnknownIds(warnings, 'entry', proposal.sourceEntryIds, known.entryIds);
			warnUnknownIds(warnings, 'entity', proposal.affectedEntityIds, known.entityIds);
			warnUnknownIds(warnings, 'faction', proposal.affectedFactionIds, known.factionIds);
		}
		return;
	}
	for (const intent of result.npcIntents) {
		if (intent.entityId) warnUnknownIds(warnings, 'entity', [intent.entityId], known.entityIds);
		warnUnknownIds(warnings, 'entry', intent.evidenceEntryIds, known.entryIds);
	}
	for (const pulse of result.strategicPulse) {
		if (pulse.factionId) warnUnknownIds(warnings, 'faction', [pulse.factionId], known.factionIds);
	}
	for (const draft of result.wikiDrafts) warnUnknownIds(warnings, 'entry', draft.sourceEntryIds, known.entryIds);
}

function message(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

export async function runSmallBrain(request: SmallBrainRunRequest): Promise<SmallBrainRunResponse> {
	const db = getDb();
	const warnings: string[] = [];
	const [story] = await db.select().from(stories).where(eq(stories.id, request.storyId)).limit(1);
	if (!story) {
		return fail(request, '', [`Story not found: ${request.storyId}`]);
	}

	const limit = clamp(request.limit ?? 12, 1, 50);
	const targetEntries = request.entryId
		? await db.select().from(storyEntries)
			.where(and(eq(storyEntries.storyId, request.storyId), eq(storyEntries.id, request.entryId)))
			.limit(1)
		: [];
	if (request.entryId && targetEntries.length === 0) warn(warnings, `Entry not found: ${request.entryId}`);
	const recentEntries = await db.select().from(storyEntries)
		.where(eq(storyEntries.storyId, request.storyId))
		.orderBy(desc(storyEntries.position))
		.limit(limit);
	const entries = dedupeById([...targetEntries, ...recentEntries]);

	const [entityRows, factionRows, eventRows, factRows, memoryRows, chapterRows, arcRows] = await Promise.all([
		db.select().from(entities).where(eq(entities.storyId, request.storyId)).orderBy(desc(entities.updatedAt)).limit(20),
		db.select().from(factions).where(eq(factions.storyId, request.storyId)).orderBy(desc(factions.updatedAt)).limit(12),
		db.select().from(storyEvents).where(eq(storyEvents.storyId, request.storyId)).orderBy(desc(storyEvents.updatedAt)).limit(12),
		db.select().from(facts).where(eq(facts.storyId, request.storyId)).orderBy(desc(facts.updatedAt)).limit(12),
		db.select().from(memoryNodes).where(eq(memoryNodes.storyId, request.storyId)).orderBy(desc(memoryNodes.updatedAt)).limit(12),
		db.select().from(chapters).where(eq(chapters.storyId, request.storyId)).orderBy(desc(chapters.number)).limit(6),
		db.select().from(arcs).where(eq(arcs.storyId, request.storyId)).orderBy(desc(arcs.number)).limit(4),
	]);

	const generation = await resolveGeneration(warnings);
	if (!generation?.profile) return fail(request, generation?.generation.model ?? '', warnings);

	const prompt = buildPrompt({
		request,
		story,
		entries,
		entities: entityRows,
		factions: factionRows,
		events: eventRows,
		facts: factRows,
		memories: memoryRows,
		chapters: chapterRows,
		arcs: arcRows,
	});

	let generated: Awaited<ReturnType<typeof generateServerTextWithMetrics>>;
	try {
		generated = await generateServerTextWithMetrics({
			profile: generation.profile,
			model: generation.generation.model,
			temperature: generation.generation.temperature ?? 0.1,
			maxTokens: generation.generation.maxTokens ?? 900,
			system: generation.systemPromptOverride?.trim() || DEFAULT_SYSTEM,
			prompt,
			responseFormat: 'json_object',
		});
	} catch (error) {
		return fail(request, generation.generation.model ?? '', [...warnings, `Small-brain generation failed: ${message(error)}`]);
	}

	const model = generated.model || generation.generation.model || '';
	let parsed: unknown;
	try {
		parsed = parseJsonFromGeneratedText(generated.text);
	} catch (error) {
		return fail(request, model, [...warnings, `Failed to parse small-brain JSON: ${message(error)}`]);
	}

	const result = smallBrainResultSchema.safeParse(parsed);
	if (!result.success) {
		return fail(request, model, [...warnings, `Small-brain result validation failed: ${result.error.issues[0]?.message ?? 'invalid result'}`]);
	}
	if (result.data.mode !== request.mode) {
		return fail(request, model, [...warnings, `Small-brain mode mismatch: requested ${request.mode}, got ${result.data.mode}`]);
	}

	addReferenceWarnings(result.data, warnings, knownContextIds({
		entries,
		entities: entityRows,
		factions: factionRows,
		events: eventRows,
		facts: factRows,
		memories: memoryRows,
		chapters: chapterRows,
	}));
	return {
		ok: true,
		storyId: request.storyId,
		mode: request.mode,
		model,
		result: result.data,
		warnings,
	};
}
