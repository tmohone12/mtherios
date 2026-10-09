import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { SCENE_CHECKPOINT_ENTRY_LIMIT, sceneCheckpointSchema, type SceneCheckpoint, type SceneCheckpointNote, type SceneCheckpointProjection } from '$lib/contracts/sceneCheckpoint';
import { getDb } from '$lib/server/db/client';
import { agreements, backendJobs, facts, npcBeliefs, stories, storyEntries, storyEvents, storyThreads } from '$lib/server/db/schema';
import { isNarrativeCommandInput, isNarrativeControlInput } from '$lib/services/ai/context/controlInput';
import { parseParallelPovCommand } from '$lib/services/ai/context/parallelPov';
import { isNarrativeTimelineEvent, storyEventNarrativeCanonCondition } from '$lib/server/events/timeline';

type Entry = Pick<typeof storyEntries.$inferSelect, 'id' | 'type' | 'content' | 'position' | 'parentId' | 'branchId' | 'metadata'>;
type Story = Pick<typeof stories.$inferSelect, 'id' | 'currentLocationId' | 'metadata'>;
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type SceneEvent = Pick<typeof storyEvents.$inferSelect, 'id' | 'type' | 'title' | 'status' | 'visibility' | 'actorEntityIds' | 'targetEntityIds' | 'sourceEntryIds'>;
type SceneAgreement = Pick<typeof agreements.$inferSelect, 'id' | 'status' | 'parties' | 'terms' | 'sourceEntryIds' | 'sourceEventIds'>;
type SceneThread = Pick<typeof storyThreads.$inferSelect, 'id' | 'status' | 'description' | 'sourceEntryIds' | 'sourceEventIds'>;
type SceneFact = Pick<typeof facts.$inferSelect, 'id' | 'status' | 'visibility' | 'sourceEntryIds' | 'sourceEventIds'>;
type SceneBelief = Pick<typeof npcBeliefs.$inferSelect, 'id' | 'believerEntityId' | 'visibility' | 'sourceEntryIds' | 'sourceEventIds'>;

function isPrimary(entry: Entry): boolean {
	const meta = entry.metadata ?? {};
	return !meta.nonCanon && meta.actionType !== 'ooc' && meta.actionType !== 'think' && meta.narrativeMode !== 'ooc' && meta.narrativeMode !== 'parallel_pov'
		&& isNarrativeTimelineEvent({ status: 'committed', metadata: meta })
		&& meta.visibility !== 'secret' && meta.secrecy !== 'secret'
		&& !meta.parallelPov && !/^\s*###\s*Parallel POV/im.test(entry.content)
		&& !(entry.type === 'user_action' && (isNarrativeControlInput(entry.content) || isNarrativeCommandInput(entry.content)));
}

function narrationHeader(content: string): { text: string; end: number } | null {
	for (const match of content.matchAll(/^\s*\[([^\]\r\n]+)\]/gm)) {
		const end = (match.index ?? 0) + match[0].length;
		if (/(?:\bTime\b|\bLocation\b|📍|🕰️)/iu.test(match[1])) return { text: match[1], end };
		if ((match.index ?? 0) === 0 && /^\r?\n/u.test(content.slice(end))
			&& /\p{L}/u.test(match[1]) && !/^(?:ooc|gm|player|system|private thought|roll)\b/iu.test(match[1].trim()))
			return { text: match[1], end };
	}
	return null;
}

function location(entry: Entry): string {
	const header = narrationHeader(entry.content)?.text ?? '';
	const explicit = header.match(/(?:📍\s*(?:Location\b\s*)?|\bLocation\s*):?\s*([^|]+)/iu)?.[1];
	const bare = header.split('|').map(part => part.replace(/^[^\p{L}\p{N}]+/u, '').trim()).find(part => part && !/^(?:Time|Weather|Day|Date|\d)/i.test(part));
	return (explicit ?? bare ?? '').trim().toLowerCase().slice(0, 200);
}

function proseMoveDestination(entry: Entry, parent: Entry | undefined): string {
	if (!parent || parent.type !== 'user_action' || !isPrimary(parent)) return '';
	const opening = /^\s*(?:at|inside|within)\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N}'’ -]{1,79}),/iu.exec(entry.content);
	if (!opening) return '';
	const place = opening[1].trim();
	const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`\\b(?:I|we)\\s+(?:(?:leave|stand|rise)\\b[^.!?]{0,80}\\band\\s+)?(?:go|head|walk|move|cross|step|return|travel)\\s+(?:(?:back|over|up|down)\\s+)?(?:to|into|towards?|across)\\s+(?:the\\s+)?${escaped}\\b`, 'iu')
		.test(parent.content) ? place.toLowerCase() : '';
}

/** Stop at the most recent primary scene/branch boundary; interludes cannot supply knowledge. */
export function sceneCheckpointSources(entries: Entry[]): { scene: string; entries: Entry[] } {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const primary = entries.filter(entry => isPrimary(entry) && (!entry.parentId || (byId.has(entry.parentId) && isPrimary(byId.get(entry.parentId)!))));
	const latest = primary.findLast(entry => entry.type === 'narration');
	if (!latest) return { scene: '', entries: [] };
	const scenes = new Map<Entry, string>();
	let observedScene = '';
	let branchId = primary[0]?.branchId;
	for (const entry of primary) {
		if (entry.branchId !== branchId) { observedScene = ''; branchId = entry.branchId; }
		if (entry.type === 'narration') {
			observedScene = location(entry) || proseMoveDestination(entry, byId.get(entry.parentId ?? '')) || observedScene;
			scenes.set(entry, observedScene);
		}
	}
	const scene = scenes.get(latest) ?? '';
	let start = 0;
	for (let index = primary.indexOf(latest); index >= 0; index--) {
		const entry = primary[index];
		if (entry.branchId !== latest.branchId || (entry.type === 'narration' && scenes.get(entry) !== scene)) {
			start = index + 1;
			break;
		}
	}
	return { scene, entries: primary.slice(start).filter(entry => entry.position <= latest.position) };
}

function noteKind(text: string): SceneCheckpointNote['kind'] {
	if (/\b(promis\w*|swore|swear\w*|agreed?|oath|refus\w*|accept\w*|condition|unless|in exchange|must|owe\w*|deadline|by dawn|by sunset)\b/i.test(text)) return 'commitment';
	return text.includes('?') ? 'question' : 'statement';
}

function noteScore(note: SceneCheckpointNote): number {
	return note.kind === 'commitment' ? 4 : note.kind === 'last_beat' ? 3 : note.kind === 'question' ? 2 : 1;
}

function uniqueStrings(values: unknown[], limit = 64): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean))].slice(0, limit);
}

function concise(value: string, limit: number): string {
	const text = value.replace(/\s+/g, ' ').trim();
	return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;
}

function sourceOverlap(values: string[] | null | undefined, sourceIds: Set<string>): boolean {
	return (values ?? []).some(value => sourceIds.has(value));
}

export interface SceneProjectionInput {
	sourceEntries: Array<Pick<Entry, 'id' | 'position'>>;
	events: SceneEvent[];
	agreements: SceneAgreement[];
	threads: SceneThread[];
	facts: SceneFact[];
	beliefs: SceneBelief[];
}

/** Build only source-linked canonical pointers; absence never implies an unresolved answer. */
export function buildSceneProjection(input: SceneProjectionInput): SceneCheckpointProjection {
	const sourceIds = new Set(input.sourceEntries.map(entry => entry.id));
	const positionByEntryId = new Map(input.sourceEntries.map(entry => [entry.id, entry.position]));
	const events = input.events
		.filter(event => event.status === 'committed' && (event.visibility === 'public' || event.visibility === 'player_known') && sourceOverlap(event.sourceEntryIds, sourceIds))
		.sort((left, right) => Math.min(...(left.sourceEntryIds ?? []).map(id => positionByEntryId.get(id) ?? Number.MAX_SAFE_INTEGER))
			- Math.min(...(right.sourceEntryIds ?? []).map(id => positionByEntryId.get(id) ?? Number.MAX_SAFE_INTEGER)));
	const eventIds = new Set(events.map(event => event.id));
	const linkedEntryIds = (values: string[] | null | undefined) => uniqueStrings((values ?? []).filter(value => sourceIds.has(value)), 32);
	const linkedEventIds = (values: string[] | null | undefined) => uniqueStrings((values ?? []).filter(value => eventIds.has(value)), 32);

	const participantMap = new Map<string, { roles: Set<'actor' | 'target'>; sourceEventIds: Set<string> }>();
	for (const event of events) {
		for (const [role, ids] of [['actor', event.actorEntityIds], ['target', event.targetEntityIds]] as const) {
			for (const entityId of uniqueStrings(ids ?? [], 32)) {
				const current = participantMap.get(entityId) ?? { roles: new Set<'actor' | 'target'>(), sourceEventIds: new Set<string>() };
				current.roles.add(role);
				current.sourceEventIds.add(event.id);
				participantMap.set(entityId, current);
			}
		}
	}

	const relevantAgreements = input.agreements.filter(agreement => (agreement.status === 'active' || agreement.status === 'contested')
		&& (sourceOverlap(agreement.sourceEntryIds, sourceIds) || sourceOverlap(agreement.sourceEventIds, eventIds)));
	const relevantThreads = input.threads.filter(thread => thread.status !== 'closed' && thread.status !== 'abandoned'
		&& (sourceOverlap(thread.sourceEntryIds, sourceIds) || sourceOverlap(thread.sourceEventIds, eventIds)));

	return {
		compilerVersion: 'scene-projection-v1',
		participants: [...participantMap.entries()].slice(0, 32).map(([entityId, value]) => ({
			entityId,
			roles: [...value.roles],
			sourceEventIds: [...value.sourceEventIds].slice(0, 8),
		})),
		completedBeats: events
			.filter(event => event.title.trim() && event.title.trim().toLowerCase() !== 'turn resolved')
			.slice(-24)
			.map(event => ({
				sourceEventId: event.id,
				sourceEntryIds: linkedEntryIds(event.sourceEntryIds).slice(0, 8),
				type: concise(event.type, 80),
				title: concise(event.title, 220),
			})),
		unresolvedActions: [
			...relevantThreads.map(thread => ({
				id: thread.id,
				kind: 'thread' as const,
				summary: concise(thread.description, 360),
				sourceEntryIds: linkedEntryIds(thread.sourceEntryIds),
				sourceEventIds: linkedEventIds(thread.sourceEventIds),
			})),
			...relevantAgreements.map(agreement => ({
				id: agreement.id,
				kind: 'agreement' as const,
				summary: concise(agreement.terms, 360),
				sourceEntryIds: linkedEntryIds(agreement.sourceEntryIds),
				sourceEventIds: linkedEventIds(agreement.sourceEventIds),
			})),
		].slice(0, 24),
		commitments: relevantAgreements.slice(0, 16).map(agreement => ({
			agreementId: agreement.id,
			status: agreement.status as 'active' | 'contested',
			parties: uniqueStrings(agreement.parties, 12),
			sourceEntryIds: linkedEntryIds(agreement.sourceEntryIds),
			sourceEventIds: linkedEventIds(agreement.sourceEventIds),
		})),
		factIds: uniqueStrings(input.facts.filter(fact => (fact.status === 'active' || fact.status === 'contested')
			&& (fact.visibility === 'public' || fact.visibility === 'player_known')
			&& (sourceOverlap(fact.sourceEntryIds, sourceIds) || sourceOverlap(fact.sourceEventIds, eventIds))).map(fact => fact.id), 32),
		beliefIds: uniqueStrings(input.beliefs.filter(belief => (belief.visibility === 'public' || belief.visibility === 'player_known')
			&& (sourceOverlap(belief.sourceEntryIds, sourceIds) || sourceOverlap(belief.sourceEventIds, eventIds))).map(belief => belief.id), 32),
	};
}

/** Exact sentences throughout the passage, including its middle. No inferred facts or open obligations. */
export function extractSceneNotes(entries: Entry[]): SceneCheckpointNote[] {
	const notes: SceneCheckpointNote[] = [];
	for (const entry of entries) {
		// Player intents/questions are not completed actions; thoughts remain private.
		if (entry.type !== 'narration' || entry.metadata?.actionType === 'think') continue;
		const header = narrationHeader(entry.content);
		const body = header ? entry.content.slice(header.end).trimStart() : entry.content;
		const sentences = body.match(/[^.!?\n]+(?:[.!?]+["'”’]?|$)/g)?.map(text => text.trim()).filter(text => text.length >= 12 && text.length <= 420) ?? [];
		const candidates = sentences.map(text => ({ sourceEntryId: entry.id, position: entry.position, kind: noteKind(text), text }));
		const selected = [...candidates].sort((a, b) => noteScore(b) - noteScore(a)).slice(0, 3);
		const last = candidates.at(-1);
		if (last && !selected.some(note => note.text === last.text)) selected.push({ ...last, kind: 'last_beat' });
		notes.push(...selected);
	}
	// Preserve salient older evidence and spread ordinary beats through the bounded window.
	const ranked = [...notes].sort((a, b) => noteScore(b) - noteScore(a) || b.position - a.position).slice(0, 64);
	const remaining = notes.filter(note => !ranked.includes(note));
	const step = Math.max(1, remaining.length / 64);
	for (let index = 0; index < remaining.length && ranked.length < 128; index += step) ranked.push(remaining[Math.floor(index)]);
	return ranked.sort((a, b) => a.position - b.position);
}

function sourceWhere(storyId: string, start: number, end: number) {
	return and(eq(storyEntries.storyId, storyId), gte(storyEntries.position, start), lte(storyEntries.position, end), inArray(storyEntries.type, ['user_action', 'narration']));
}

function jsonArrayOverlaps(column: unknown, ids: string[]) {
	if (ids.length === 0) return sql`false`;
	return sql`exists (
		select 1 from jsonb_array_elements_text(${column}) as source_id
		where source_id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
	)`;
}

/** Hash only evidence and visibility fields; later receipts/embeddings must not invalidate memory. */
const evidenceMetadataKeys = ['nonCanon', 'non_canon', 'invalidated', 'deleted', 'superseded', 'supersededBy', 'superseded_by', 'supersededById', 'superseded_by_id',
	'actionType', 'action_type', 'narrativeMode', 'narrative_mode', 'sourceType', 'source_type', 'parallelPov', 'visibility', 'secrecy', 'originalMetadata'];
// Avoid transferring hundreds of large prompt/receipt snapshots into the worker.
const evidenceMetadata = sql<Record<string, unknown>>`coalesce((select jsonb_object_agg(key, value)
	from jsonb_each(coalesce(${storyEntries.metadata}, '{}'::jsonb)) where key in (${sql.join(evidenceMetadataKeys.map(key => sql`${key}`), sql`, `)})), '{}'::jsonb)`;
const evidenceSignature = sql<string>`jsonb_build_array(${storyEntries.id}, ${storyEntries.position}, ${storyEntries.type},
	${storyEntries.content}, ${storyEntries.parentId}, ${storyEntries.branchId}, ${evidenceMetadata})::text`;
async function sourceHash(db: Db | Tx, storyId: string, start: number, end: number): Promise<string> {
	const evidence = db.select({ signature: evidenceSignature.as('signature'), position: storyEntries.position }).from(storyEntries)
		.where(sourceWhere(storyId, start, end)).orderBy(storyEntries.position).limit(SCENE_CHECKPOINT_ENTRY_LIMIT + 1).as('scene_evidence');
	const [row] = await db.select({ hash: sql<string>`md5(coalesce(string_agg(${evidence.signature}, '' order by ${evidence.position}), ''))` }).from(evidence);
	return row.hash;
}

/** The worker always reads latest evidence under the story lock, regardless of queued job age. */
export async function refreshSceneCheckpoint(storyId: string): Promise<Record<string, unknown>> {
	const startedAt = new Date().toISOString();
	return getDb().transaction(async tx => {
		const [story] = await tx.select().from(stories).where(eq(stories.id, storyId)).for('update');
		if (!story) return { refreshed: false, reason: 'story_missing' };
		const rows = await tx.select({ id: storyEntries.id, type: storyEntries.type, content: storyEntries.content,
			position: storyEntries.position, parentId: storyEntries.parentId, branchId: storyEntries.branchId,
			metadata: evidenceMetadata, signature: evidenceSignature,
		}).from(storyEntries).where(and(eq(storyEntries.storyId, storyId), inArray(storyEntries.type, ['user_action', 'narration'])))
			.orderBy(desc(storyEntries.position)).limit(SCENE_CHECKPOINT_ENTRY_LIMIT);
		const { scene, entries } = sceneCheckpointSources(rows.reverse());
		const first = entries[0];
		const last = entries.at(-1);
		if (!first || !last) {
			await tx.update(stories).set({ metadata: sql`${stories.metadata} - 'sceneCheckpoint'` }).where(eq(stories.id, storyId));
			await coalesceQueuedSceneCheckpoints(tx, storyId, startedAt);
			return { refreshed: false, reason: 'no_primary_scene' };
		}
		// Sign the very same snapshot used for extraction, including excluded control/POV rows.
		const hash = createHash('md5').update(rows.filter(row => row.position >= first.position && row.position <= last.position).map(row => row.signature).join('')).digest('hex');
		const sourceEntryIds = entries.map(entry => entry.id);
		const eventRows = await tx.select().from(storyEvents).where(and(
			eq(storyEvents.storyId, storyId),
			eq(storyEvents.status, 'committed'),
			inArray(storyEvents.visibility, ['public', 'player_known']),
			jsonArrayOverlaps(storyEvents.sourceEntryIds, sourceEntryIds),
			storyEventNarrativeCanonCondition(),
		)).orderBy(storyEvents.createdTurn, storyEvents.id).limit(96);
		const sourceEventIds = eventRows.map(event => event.id);
		const [agreementRows, threadRows, factRows, beliefRows] = await Promise.all([
			tx.select().from(agreements).where(and(
				eq(agreements.storyId, storyId),
				inArray(agreements.status, ['active', 'contested']),
				sql`(${jsonArrayOverlaps(agreements.sourceEntryIds, sourceEntryIds)} or ${jsonArrayOverlaps(agreements.sourceEventIds, sourceEventIds)})`,
			)).orderBy(agreements.id).limit(64),
			tx.select().from(storyThreads).where(and(
				eq(storyThreads.storyId, storyId),
				sql`${storyThreads.status} not in ('closed', 'abandoned')`,
				sql`(${jsonArrayOverlaps(storyThreads.sourceEntryIds, sourceEntryIds)} or ${jsonArrayOverlaps(storyThreads.sourceEventIds, sourceEventIds)})`,
			)).orderBy(storyThreads.id).limit(64),
			tx.select().from(facts).where(and(
				eq(facts.storyId, storyId),
				inArray(facts.status, ['active', 'contested']),
				inArray(facts.visibility, ['public', 'player_known']),
				sql`(${jsonArrayOverlaps(facts.sourceEntryIds, sourceEntryIds)} or ${jsonArrayOverlaps(facts.sourceEventIds, sourceEventIds)})`,
			)).orderBy(facts.id).limit(96),
			tx.select().from(npcBeliefs).where(and(
				eq(npcBeliefs.storyId, storyId),
				inArray(npcBeliefs.visibility, ['public', 'player_known']),
				sql`(${jsonArrayOverlaps(npcBeliefs.sourceEntryIds, sourceEntryIds)} or ${jsonArrayOverlaps(npcBeliefs.sourceEventIds, sourceEventIds)})`,
			)).orderBy(npcBeliefs.id).limit(96),
		]);
		const projection = buildSceneProjection({
			sourceEntries: entries,
			events: eventRows,
			agreements: agreementRows,
			threads: threadRows,
			facts: factRows,
			beliefs: beliefRows,
		});
		const checkpoint = sceneCheckpointSchema.parse({
			version: 1, id: `scene_${storyId}_${hash}`, storyId, locationId: story.currentLocationId,
			scene, branchId: last.branchId, pov: 'primary', sourceStart: first.position, sourceEnd: last.position,
			sourceEntryIds, sourceHash: hash,
			notes: extractSceneNotes(entries), projection, createdAt: new Date().toISOString(),
		});
		await tx.update(stories).set({ metadata: sql`jsonb_set(${stories.metadata}, '{sceneCheckpoint}', ${JSON.stringify(checkpoint)}::jsonb)` }).where(eq(stories.id, storyId));
		await coalesceQueuedSceneCheckpoints(tx, storyId, startedAt);
		return { refreshed: true, checkpointId: checkpoint.id, sourceCount: entries.length, noteCount: checkpoint.notes.length };
	});
}

async function coalesceQueuedSceneCheckpoints(tx: Tx, storyId: string, startedAt: string): Promise<void> {
	// Every checkpoint job reads the latest scene; older queued refreshes have the same result.
	await tx.update(backendJobs).set({
		status: 'complete', lastError: null, updatedAt: startedAt,
		metadata: sql`${backendJobs.metadata} || '{"coalescedByLatestSceneRefresh":true}'::jsonb`,
	}).where(and(eq(backendJobs.storyId, storyId), eq(backendJobs.type, 'refresh_scene_checkpoint'),
		inArray(backendJobs.status, ['queued', 'retry']), lte(backendJobs.createdAt, startedAt)));
}

/** Never consume an imported, edited, deleted, or previous-scene projection without validation. */
export async function loadSceneCheckpoint(story: Story, recentEntries: Entry[]): Promise<SceneCheckpoint | null> {
	const parsed = sceneCheckpointSchema.safeParse(story.metadata?.sceneCheckpoint);
	if (!parsed.success) return null;
	const checkpoint = parsed.data;
	if (checkpoint.storyId !== story.id || checkpoint.locationId !== story.currentLocationId) return null;
	const { scene, entries } = sceneCheckpointSources(recentEntries);
	const latest = entries.at(-1);
	if (!latest || latest.branchId !== checkpoint.branchId || scene !== checkpoint.scene || latest.position < checkpoint.sourceEnd) return null;
	// A departure followed by a return is a new scene even when the location name matches.
	if (entries[0].position > checkpoint.sourceEnd || entries[0].position < checkpoint.sourceStart) return null;
	return await sourceHash(getDb(), story.id, checkpoint.sourceStart, checkpoint.sourceEnd) === checkpoint.sourceHash ? checkpoint : null;
}

export function selectSceneCheckpointNotes(checkpoint: SceneCheckpoint | null | undefined, firstDialoguePosition: number, action: string): SceneCheckpointNote[] {
	if (!checkpoint || parseParallelPovCommand(action)) return [];
	const candidates = checkpoint.notes.filter(note => note.position < firstDialoguePosition);
	const ranked = [...candidates].sort((a, b) => noteScore(b) - noteScore(a) || b.position - a.position);
	const selected: SceneCheckpointNote[] = [];
	let chars = 0;
	for (const note of ranked) {
		const size = JSON.stringify(note.text).length + note.sourceEntryId.length + 60;
		if (chars + size > 6500 || selected.length >= 24) continue;
		if (selected.some(item => item.text === note.text)) continue;
		selected.push(note);
		chars += size;
	}
	return selected.sort((a, b) => a.position - b.position);
}
