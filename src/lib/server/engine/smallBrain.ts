import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { arcs, chapters, entities, facts, factions, memoryNodes, stories, storyEntries, storyEvents } from '$lib/server/db/schema';
import type { SmallBrainRunRequest, SmallBrainRunResponse } from '$lib/contracts/engine';
import type { GmTimelineBrief, RetrievedMemoryPacket } from '$lib/contracts/memory';
import { smallBrainResultSchema, type SmallBrainResult } from '$lib/services/ai/sdk/schemas/smallBrain';
import { loadGmTimelineBrief } from '$lib/server/events/timeline';
import { lookupMentioned, memoryQueryTokens } from '$lib/server/memory/ranking';
import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { generateServerTextWithMetrics, parseJsonFromGeneratedText } from '$lib/server/turn/provider';
import { resolveServiceGeneration } from './llmSettings';

type ResolvedGeneration = Awaited<ReturnType<typeof resolveServiceGeneration>>;

const DEFAULT_SYSTEM = 'You are a cheap structured reasoning worker for a text RPG engine. No canon writes. JSON proposals only.';

const OUTPUT_SHAPES = {
	context: '{"mode":"context","brief":"...","relevantEntryIds":[],"relevantEntityIds":[],"relevantFactionIds":[],"promptNotes":[],"uncertainties":[],"evidence":[{"statement":"...","sourceIds":["exact_source_id"]}]}',
	canon: '{"mode":"canon","proposals":[],"rejected":[]}',
	world: '{"mode":"world","npcIntents":[],"strategicPulse":[],"wikiDrafts":[]}',
} as const;

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

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function visibleRows<T extends { visibility: string }>(rows: T[], includeSecret: boolean): T[] {
	// ponytail: bounded post-filter; move into SQL only if hidden rows measurably starve context.
	return includeSecret ? rows : rows.filter((row) => row.visibility === 'public' || row.visibility === 'player_known');
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

function retrievedPacketLines(retrieved: RetrievedMemoryPacket | null): string[] {
	return (retrieved?.packet ?? '').split(/\r?\n/).filter((line) => line.trimStart().startsWith('- '));
}

function renderRetrievedMemoryLine(node: RetrievedMemoryPacket['nodes'][number], packetLine = ''): string {
	const renderedMemory = packetLine.trim().replace(/^-\s*/, '')
		|| `${node.title}: ${compact(node.summary || node.content, 900)}`;
	return [
		`- sourceId=${node.id}`,
		node.entityIds.length ? `linkedEntityIds=${node.entityIds.join(',')}` : '',
		node.factionIds.length ? `linkedFactionIds=${node.factionIds.join(',')}` : '',
		renderedMemory,
	].filter(Boolean).join('; ');
}

function renderRetrievedMemory(retrieved: RetrievedMemoryPacket | null): string {
	const packetLines = retrievedPacketLines(retrieved);
	return (retrieved?.nodes ?? []).map((node, index) => renderRetrievedMemoryLine(node, packetLines[index])).join('\n');
}

function renderNpcTimelineLine(item: GmTimelineBrief['npcEvents'][number], eventId: string): string {
	return `- sourceId=${eventId}; linkedEntityIds=${item.npcEntityId}; ${compact(item.summary, 900)}`;
}

function renderNpcTimeline(timeline: GmTimelineBrief | null): string {
	return (timeline?.npcEvents ?? []).flatMap((item) => item.eventIds.map((eventId) =>
		renderNpcTimelineLine(item, eventId),
	)).join('\n');
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
	retrieved: RetrievedMemoryPacket | null;
	timeline: GmTimelineBrief | null;
}): string {
	const knownEntryIds = new Set(ids(args.entries));
	const knownEntityIds = new Set(ids(args.entities));
	const knownFactionIds = new Set(ids(args.factions));
	for (const node of args.retrieved?.nodes ?? []) {
		addRelatedIds(knownEntryIds, node.sourceEntryIds);
		addRelatedIds(knownEntityIds, node.entityIds);
		addRelatedIds(knownFactionIds, node.factionIds);
	}
	const contextSources = args.request.mode === 'context'
		? [
			`Focused entity identities (identity only, not evidence):\n${renderEntities(args.entities) || '(none)'}`,
			`Target entry candidates:\n${args.entries.map((entry) => `- sourceId=${entry.id}; ${compact(entry.content, 900)}`).join('\n') || '(none)'}`,
			`Retrieved candidates:\n${renderRetrievedMemory(args.retrieved) || '(none)'}`,
			`Focused NPC timeline candidates:\n${renderNpcTimeline(args.timeline) || '(none)'}`,
		]
		: [
			`Recent entries:\n${renderEntries(args.entries) || '(none)'}`,
			`Entities:\n${renderEntities(args.entities) || '(none)'}`,
			`Factions:\n${renderFactions(args.factions) || '(none)'}`,
			`Events:\n${renderEvents(args.events) || '(none)'}`,
			`Facts:\n${renderFacts(args.facts) || '(none)'}`,
			`Memory:\n${renderMemory(args.memories) || '(none)'}`,
			`Chapters:\n${renderChapters(args.chapters) || '(none)'}`,
			`Arcs:\n${renderArcs(args.arcs) || '(none)'}`,
		];
	return [
		`Story ${args.story.id}: ${args.story.title}`,
		`Mode requested: ${args.request.mode}`,
		args.request.query?.trim() ? `Query focus: ${args.request.query.trim()}` : '',
		'context mode: return a brief, relevant entry/entity/faction ids, and atomic evidence statements. Put one source-stated fact in each evidence statement and reuse source wording closely. promptNotes and uncertainties must be empty arrays until those fields carry citations. Name focused entities explicitly; do not use pronouns for them.',
		'canon mode: return reviewable fact/event/memory/relationship/contradiction proposals with source ids only; do not write canon.',
		'world mode: return npc intents, faction strategic pulse, and wiki drafts as proposals only.',
		`Known entry ids: ${[...knownEntryIds].join(', ') || '(none)'}`,
		`Known entity ids: ${[...knownEntityIds].join(', ') || '(none)'}`,
		`Known faction ids: ${[...knownFactionIds].join(', ') || '(none)'}`,
		`Return exactly this JSON shape with no extra fields: ${OUTPUT_SHAPES[args.request.mode]}`,
		'Relevant entry/entity/faction arrays may use only their matching Known ids above. Evidence sourceIds may use only sourceId values printed at the start of candidate lines below; never cite ids inside entries/events/patches metadata.',
		'',
		...contextSources,
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
	arcs: Array<typeof arcs.$inferSelect>;
}): { entryIds: Set<string>; entityIds: Set<string>; factionIds: Set<string>; sourceIds: Set<string> } {
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
	return {
		entryIds,
		entityIds,
		factionIds,
		sourceIds: new Set([
			...ids(context.entries),
			...ids(context.events),
			...ids(context.facts),
			...ids(context.memories),
			...ids(context.chapters),
			...ids(context.arcs),
		]),
	};
}

function warnUnknownIds(warnings: string[], kind: 'entry' | 'entity' | 'faction' | 'source', values: unknown, known: Set<string>): void {
	for (const id of stringArray(values)) {
		if (!known.has(id)) warn(warnings, `Unknown referenced ${kind} id: ${id}`);
	}
}

function addReferenceWarnings(
	result: SmallBrainResult,
	warnings: string[],
	known: { entryIds: Set<string>; entityIds: Set<string>; factionIds: Set<string>; sourceIds: Set<string> },
): void {
	if (result.mode === 'context') {
		warnUnknownIds(warnings, 'entry', result.relevantEntryIds, known.entryIds);
		warnUnknownIds(warnings, 'entity', result.relevantEntityIds, known.entityIds);
		warnUnknownIds(warnings, 'faction', result.relevantFactionIds, known.factionIds);
		for (const evidence of result.evidence) warnUnknownIds(warnings, 'source', evidence.sourceIds, known.sourceIds);
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

type EvidenceSource = { text: string; entityIds: Set<string> };

function entityNames(entity: typeof entities.$inferSelect): string[] {
	const state = record(entity.state);
	const metadata = record(entity.metadata);
	const canonicalParts = entity.name.trim().split(/\s+/);
	return [...new Set([
		entity.name,
		canonicalParts.length > 1 ? canonicalParts[0] : '',
		...stringArray(state.aliases),
		...stringArray(metadata.aliases),
	].map((name) => name.trim()).filter((name) => name.length >= 3))];
}

function mentionsEntity(text: string, entity: typeof entities.$inferSelect): boolean {
	return entityNames(entity).some((name) => lookupMentioned(text, name));
}

function supportToken(token: string): string {
	const stemmed = token.length > 5 ? token.replace(/(?:ing|ed|es|s)$/, '') : token;
	return stemmed.length > 4 ? stemmed.replace(/e$/, '') : stemmed;
}

function contextEvidenceSources(args: {
	entries: Array<typeof storyEntries.$inferSelect>;
	retrieved: RetrievedMemoryPacket | null;
	timeline: GmTimelineBrief | null;
}): Map<string, EvidenceSource> {
	const sources = new Map<string, EvidenceSource>();
	for (const entry of args.entries) {
		sources.set(entry.id, { text: compact(entry.content, 900), entityIds: new Set() });
	}
	const packetLines = retrievedPacketLines(args.retrieved);
	for (const [index, node] of (args.retrieved?.nodes ?? []).entries()) {
		sources.set(node.id, { text: renderRetrievedMemoryLine(node, packetLines[index]), entityIds: new Set(node.entityIds) });
	}
	for (const item of args.timeline?.npcEvents ?? []) {
		for (const eventId of item.eventIds) {
			const existing = sources.get(eventId);
			if (existing) {
				existing.entityIds.add(item.npcEntityId);
				existing.text += `\n${renderNpcTimelineLine(item, eventId)}`;
			} else {
				sources.set(eventId, {
					text: renderNpcTimelineLine(item, eventId),
					entityIds: new Set([item.npcEntityId]),
				});
			}
		}
	}
	return sources;
}

function addContextEvidenceSupportWarnings(
	result: Extract<SmallBrainResult, { mode: 'context' }>,
	warnings: string[],
	focusEntities: Array<typeof entities.$inferSelect>,
	sources: Map<string, EvidenceSource>,
): boolean {
	let invalid = false;
	for (const evidence of result.evidence) {
		const cited = evidence.sourceIds.map((id) => sources.get(id)).filter((source): source is EvidenceSource => Boolean(source));
		if (cited.length === 0) continue;
		const mentionedEntities = focusEntities.filter((entity) => mentionsEntity(evidence.statement, entity));
		for (const entity of mentionedEntities) {
			if (cited.some((source) => source.entityIds.has(entity.id) || mentionsEntity(source.text, entity))) continue;
			warn(warnings, `Unsupported evidence attribution for ${entity.name}: ${evidence.statement}`);
			invalid = true;
		}
		const claimTokens = memoryQueryTokens(evidence.statement);
		const sourceChecks = cited.map((source) => {
			const sourceTokens = new Set(memoryQueryTokens(source.text, 256).map(supportToken));
			const unsupportedTokens = claimTokens.filter((token) => !sourceTokens.has(supportToken(token)));
			const supportsEntities = mentionedEntities.every((entity) => source.entityIds.has(entity.id) || mentionsEntity(source.text, entity));
			return { unsupportedTokens, supportsEntities };
		});
		if (claimTokens.length > 0 && !sourceChecks.some((check) => check.supportsEntities && check.unsupportedTokens.length === 0)) {
			const closest = sourceChecks.sort((left, right) => left.unsupportedTokens.length - right.unsupportedTokens.length)[0];
			warn(warnings, `Unsupported evidence details (${closest?.unsupportedTokens.slice(0, 6).join(', ') || 'no matching source'}): ${evidence.statement}`);
			invalid = true;
		}
	}
	return invalid;
}

function compileSupportedContextResult(
	result: Extract<SmallBrainResult, { mode: 'context' }>,
	warnings: string[],
): Extract<SmallBrainResult, { mode: 'context' }> {
	if (result.promptNotes.length > 0 || result.uncertainties.length > 0) {
		warn(warnings, 'Discarded uncited promptNotes or uncertainties from context result.');
	}
	return {
		...result,
		brief: result.evidence.map((evidence) => evidence.statement.trim()).filter(Boolean).join(' '),
		promptNotes: [],
		uncertainties: [],
	};
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

	const contextMode = request.mode === 'context';
	const limit = clamp(request.limit ?? 12, 1, 50);
	const targetEntries = request.entryId
		? await db.select().from(storyEntries)
			.where(and(eq(storyEntries.storyId, request.storyId), eq(storyEntries.id, request.entryId)))
			.limit(1)
		: [];
	if (request.entryId && targetEntries.length === 0) warn(warnings, `Entry not found: ${request.entryId}`);
	const recentEntries = !contextMode || !request.query?.trim()
		? await db.select().from(storyEntries)
			.where(eq(storyEntries.storyId, request.storyId))
			.orderBy(desc(storyEntries.position))
			.limit(contextMode ? 1 : limit)
		: [];
	const entries = dedupeById([...targetEntries, ...recentEntries]);
	const query = request.query?.trim() || entries[0]?.content || '';
	const promptEntries = contextMode
		? (targetEntries.length > 0 ? targetEntries : recentEntries.slice(0, 1))
		: entries;
	const focusEntityIds = [...new Set([
		...(request.sceneEntityIds ?? []),
		...(request.presentNpcIds ?? []),
	])];

	const [rawEntityRows, factionRows, rawEventRows, rawFactRows, rawMemoryRows, chapterRows, arcRows, retrieved, timeline] = await Promise.all([
		contextMode
			? focusEntityIds.length > 0
				? db.select().from(entities).where(and(eq(entities.storyId, request.storyId), inArray(entities.id, focusEntityIds))).limit(focusEntityIds.length)
				: db.select().from(entities).where(eq(entities.storyId, request.storyId)).limit(240)
			: db.select().from(entities).where(eq(entities.storyId, request.storyId)).orderBy(desc(entities.updatedAt)).limit(20),
		contextMode ? Promise.resolve([]) : db.select().from(factions).where(eq(factions.storyId, request.storyId)).orderBy(desc(factions.updatedAt)).limit(12),
		contextMode ? Promise.resolve([]) : db.select().from(storyEvents).where(eq(storyEvents.storyId, request.storyId)).orderBy(desc(storyEvents.updatedAt)).limit(12),
		contextMode ? Promise.resolve([]) : db.select().from(facts).where(eq(facts.storyId, request.storyId)).orderBy(desc(facts.updatedAt)).limit(12),
		contextMode ? Promise.resolve([]) : db.select().from(memoryNodes).where(eq(memoryNodes.storyId, request.storyId)).orderBy(desc(memoryNodes.updatedAt)).limit(12),
		contextMode ? Promise.resolve([]) : db.select().from(chapters).where(eq(chapters.storyId, request.storyId)).orderBy(desc(chapters.number)).limit(6),
		contextMode ? Promise.resolve([]) : db.select().from(arcs).where(eq(arcs.storyId, request.storyId)).orderBy(desc(arcs.number)).limit(4),
		contextMode ? retrieveMemoryPacket({
			storyId: request.storyId,
			query,
			currentTurn: story.currentTurn,
			sceneEntityIds: request.sceneEntityIds ?? [],
			presentNpcIds: request.presentNpcIds ?? [],
			locationId: request.locationId ?? story.currentLocationId ?? null,
			threadIds: request.threadIds ?? [],
			currentFactionId: request.currentFactionId ?? null,
			includeSecret: request.includeSecret === true,
			tokenBudget: request.tokenBudget ?? 1200,
		}) : Promise.resolve(null),
		contextMode ? loadGmTimelineBrief({
			storyId: request.storyId,
			sceneEntityIds: request.sceneEntityIds ?? [],
			presentNpcIds: request.presentNpcIds ?? [],
			includeSecret: request.includeSecret === true,
		}) : Promise.resolve(null),
	]);
	const includeSecret = request.includeSecret === true;
	const retrievedEntityIds = new Set((retrieved?.nodes ?? []).flatMap((node) => node.entityIds));
	const loadedEntityIds = new Set(rawEntityRows.map((entity) => entity.id));
	const missingRetrievedEntityIds = [...retrievedEntityIds].filter((id) => !loadedEntityIds.has(id));
	const retrievedEntityRows = contextMode && missingRetrievedEntityIds.length > 0
		? await db.select().from(entities)
			.where(and(eq(entities.storyId, request.storyId), inArray(entities.id, missingRetrievedEntityIds)))
			.limit(missingRetrievedEntityIds.length)
		: [];
	const contextEntityRows = dedupeById([...rawEntityRows, ...retrievedEntityRows]);
	const focusEntityIdSet = new Set(focusEntityIds);
	const entityRows = contextMode
		? visibleRows(contextEntityRows, includeSecret).filter((entity) =>
			focusEntityIdSet.has(entity.id) || retrievedEntityIds.has(entity.id) || mentionsEntity(query, entity),
		)
		: rawEntityRows;
	const eventRows = contextMode ? visibleRows(rawEventRows, includeSecret) : rawEventRows;
	const factRows = contextMode ? visibleRows(rawFactRows, includeSecret) : rawFactRows;
	const memoryRows = contextMode ? visibleRows(rawMemoryRows, includeSecret) : rawMemoryRows;

	const generation = await resolveGeneration(warnings);
	if (!generation?.profile) return fail(request, generation?.generation.model ?? '', warnings);

	const prompt = buildPrompt({
		request,
		story,
		entries: promptEntries,
		entities: entityRows,
		factions: factionRows,
		events: eventRows,
		facts: factRows,
		memories: memoryRows,
		chapters: chapterRows,
		arcs: arcRows,
		retrieved,
		timeline,
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

	const known = knownContextIds({
		entries: promptEntries,
		entities: entityRows,
		factions: factionRows,
		events: eventRows,
		facts: factRows,
		memories: memoryRows,
		chapters: chapterRows,
		arcs: arcRows,
	});
	for (const node of retrieved?.nodes ?? []) {
		known.sourceIds.add(node.id);
		addRelatedIds(known.entryIds, node.sourceEntryIds);
		addRelatedIds(known.entityIds, node.entityIds);
		addRelatedIds(known.factionIds, node.factionIds);
	}
	for (const npcEvent of timeline?.npcEvents ?? []) addRelatedIds(known.sourceIds, npcEvent.eventIds);
	addReferenceWarnings(result.data, warnings, known);
	let responseResult: SmallBrainResult = result.data;
	if (result.data.mode === 'context') {
		const contextResult = result.data;
		const sources = contextEvidenceSources({ entries: promptEntries, retrieved, timeline });
		const supportedEvidence = contextResult.evidence.filter((evidence) => {
			const unknownCitation = evidence.sourceIds.some((id) => !sources.has(id));
			const unsupported = addContextEvidenceSupportWarnings({ ...contextResult, evidence: [evidence] }, warnings, entityRows, sources);
			return !unknownCitation && !unsupported;
		});
		if (supportedEvidence.length === 0) warn(warnings, 'Context result contained no supported cited evidence.');
		if (supportedEvidence.length === 0) return fail(request, model, warnings);
		responseResult = compileSupportedContextResult({ ...contextResult, evidence: supportedEvidence }, warnings);
	}
	return {
		ok: true,
		storyId: request.storyId,
		mode: request.mode,
		model,
		result: responseResult,
		warnings,
	};
}
