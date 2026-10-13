import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { getDb } from '$lib/server/db/client';
import { arcs, backendJobs, chapters, entities, memoryNodes, sagas, stories, storyEntries, storyEvents, storyThreads } from '$lib/server/db/schema';
import { CHAPTERS_PER_ARC, CHAPTER_TURN_COUNT, selectCompletedChapterTurns, selectNextChapterWindow } from '$lib/services/chapterCadence';
import { SUMMARY_REBUILD_GENERATION_POLICY } from '$lib/contracts/engine';
import {
	ARC_PROJECTION_COMPILER, CHAPTER_PROJECTION_COMPILER, SAGA_ROLLUP_ARCS,
	buildArcMemoryFields, buildChapterMemoryDigest, canonicalArcOpenThreadIds,
	chapterMemoryEntityIds, isNarrativeChapterEvent, projectionFingerprint, stableId,
	summarizeArcMemoryWithLlm, summarizeChapterMemoryWithLlm,
	upsertArcMemoryNode, upsertChapterMemoryNode,
} from './processor';
import { enqueueBackendJob } from './outbox';
import { generateReadableNarrative } from './summaryGeneration';
import { recordHistoricalChapterWindows } from './chapterWindows';
import { replaceMtheriosStoryNarrative } from '$lib/services/ai/context/mtheriosSummaryFormat';

type Job = typeof backendJobs.$inferSelect & { storyId: string };
type Entry = typeof storyEntries.$inferSelect;
type Chapter = typeof chapters.$inferSelect;
type Arc = typeof arcs.$inferSelect;
type Saga = typeof sagas.$inferSelect;
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const SUMMARY_SOURCE_TYPES = ['terminal_chapter_job', 'terminal_arc_job', 'terminal_saga_job', 'chapter_import'];
const unique = (values: string[]) => [...new Set(values)];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function reusableAccounts(row: Chapter | undefined, sourceEntryIds: string[], accountIds: string[]) {
	if (!row || row.sourceEntryIds.length !== sourceEntryIds.length || row.sourceEntryIds.some((id, index) => id !== sourceEntryIds[index])) return null;
	const accounts = row.metadata.sourceAccounts;
	if (!Array.isArray(accounts) || accounts.length !== accountIds.length || accounts.some((account, index) => !account || account.sourceId !== accountIds[index] || typeof account.summary !== 'string' || !account.summary.trim())) return null;
	return accounts;
}

function reusableArcAccounts(row: Arc | undefined, chapterIds: string[]) {
	if (!row || row.chapterIds.length !== chapterIds.length || row.chapterIds.some((id, index) => id !== chapterIds[index])) return null;
	const accounts = row.metadata.sourceAccounts;
	if (!Array.isArray(accounts) || accounts.length !== chapterIds.length || accounts.some((account, index) => !account || account.sourceId !== chapterIds[index] || typeof account.summary !== 'string' || !account.summary.trim())) return null;
	return accounts;
}

function replaceArcOverview(summary: string, narrative: string) {
	const text = summary.trim();
	const start = /^Arc overview:\s*/i.exec(text);
	if (!start) return `Arc overview:\n${narrative.trim()}`;
	const bodyStart = start.index + start[0].length;
	const rest = text.slice(bodyStart);
	const next = rest.search(/\n\n(?:Character movement|Open threads):/i);
	return next < 0 ? `${text.slice(0, bodyStart)}${narrative.trim()}` : `${text.slice(0, bodyStart)}${narrative.trim()}${rest.slice(next)}`;
}

/** Main is the legacy label on imported opening narration; other branches require a separate rebuild. */
export function buildSummaryRebuildPlan(entries: Entry[]) {
	const unsupportedBranches = unique(entries.map(entry => entry.branchId).filter((branch): branch is string => Boolean(branch) && branch !== 'main' && branch !== 'primary'));
	if (unsupportedBranches.length) throw new Error(`Summary rebuild requires one primary history; alternate branches need separate review: ${unsupportedBranches.join(', ')}`);
	const windows: Array<NonNullable<ReturnType<typeof selectNextChapterWindow<Entry>>>> = [];
	let remaining = entries;
	while (true) {
		const window = selectNextChapterWindow(remaining);
		if (!window) break;
		windows.push(window);
		const consumed = new Set(window.entries.map(entry => entry.id));
		remaining = remaining.filter(entry => !consumed.has(entry.id));
	}
	const completedTurns = selectCompletedChapterTurns(entries).length;
	const remainingTurns = selectCompletedChapterTurns(remaining).length;
	if (completedTurns !== windows.length * CHAPTER_TURN_COUNT + remainingTurns) {
		throw new Error('Summary rebuild could not preserve every completed turn in exactly one chapter or the remaining source window.');
	}
	return {
		windows,
		completedTurns,
		remainingTurns,
		chapterCount: windows.length,
		arcCount: Math.floor(windows.length / CHAPTERS_PER_ARC),
		sagaCount: Math.floor(windows.length / CHAPTERS_PER_ARC / SAGA_ROLLUP_ARCS),
	};
}

function summaryNodeWhere(storyId: string, chapterRows: Chapter[], arcRows: Arc[], sagaRows: Saga[]) {
	const ids = [...chapterRows.map(row => `mem_chapter_${row.id}`), ...arcRows.map(row => `mem_arc_${row.id}`), ...sagaRows.map(row => `mem_saga_${row.id}`)];
	return and(eq(memoryNodes.storyId, storyId), or(
		ids.length ? inArray(memoryNodes.id, ids) : undefined,
		inArray(sql<string>`${memoryNodes.metadata}->>'sourceType'`, SUMMARY_SOURCE_TYPES),
	));
}

async function loadSnapshot(db: Db | Tx, storyId: string, lock = false) {
	const storyQuery = db.select().from(stories).where(eq(stories.id, storyId));
	const [story] = await (lock ? storyQuery.for('update') : storyQuery);
	if (!story) throw new Error(`Story not found: ${storyId}`);
	const entriesQuery = db.select().from(storyEntries).where(eq(storyEntries.storyId, storyId)).orderBy(asc(storyEntries.position));
	const eventsQuery = db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId)).orderBy(asc(storyEvents.id));
	const chaptersQuery = db.select().from(chapters).where(eq(chapters.storyId, storyId)).orderBy(asc(chapters.number), asc(chapters.id));
	const arcsQuery = db.select().from(arcs).where(eq(arcs.storyId, storyId)).orderBy(asc(arcs.number), asc(arcs.id));
	const sagasQuery = db.select().from(sagas).where(eq(sagas.storyId, storyId)).orderBy(asc(sagas.number), asc(sagas.id));
	const threadsQuery = db.select().from(storyThreads).where(eq(storyThreads.storyId, storyId)).orderBy(asc(storyThreads.id));
	const charactersQuery = db.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.type, 'character'))).orderBy(asc(entities.id));
	const [entries, events, chapterRows, arcRows, sagaRows, threads, characters] = await Promise.all([
		lock ? entriesQuery.for('update') : entriesQuery,
		lock ? eventsQuery.for('update') : eventsQuery,
		lock ? chaptersQuery.for('update') : chaptersQuery,
		lock ? arcsQuery.for('update') : arcsQuery,
		lock ? sagasQuery.for('update') : sagasQuery,
		lock ? threadsQuery.for('update') : threadsQuery,
		lock ? charactersQuery.for('update') : charactersQuery,
	]);
	const nodesQuery = db.select().from(memoryNodes).where(summaryNodeWhere(storyId, chapterRows, arcRows, sagaRows)).orderBy(asc(memoryNodes.id));
	const nodes = await (lock ? nodesQuery.for('update') : nodesQuery);
	return { story, entries, events, chapters: chapterRows, arcs: arcRows, sagas: sagaRows, threads, characters, memoryNodes: nodes };
}

export function assertSummaryRebuildUnchanged(expected: unknown, actual: unknown): void {
	if (projectionFingerprint(expected) !== projectionFingerprint(actual)) {
		throw new Error('Summary rebuild sources or existing projections changed during generation. The saved drafts were retained; no summaries were replaced.');
	}
}

export async function loadSummaryResume(job: Job, snapshot: unknown): Promise<{ jobId: string; backupPath: string } | null> {
	if (typeof job.payload.resumeJobId !== 'string') return null;
	const [previous] = await getDb().select().from(backendJobs).where(and(eq(backendJobs.id, job.payload.resumeJobId), eq(backendJobs.storyId, job.storyId))).limit(1);
	if (!previous || previous.storyId !== job.storyId || previous.type !== 'rebuild_summaries' || previous.status !== 'failed'
		|| previous.metadata.summaryGenerationPolicy !== SUMMARY_REBUILD_GENERATION_POLICY) {
		throw new Error('Summary resume requires a failed rebuild of this story using the current historical source policy.');
	}
	const progress = previous.metadata.summaryRebuild as Record<string, unknown> | undefined;
	if (typeof progress?.backupPath !== 'string') throw new Error('Summary resume backup path is missing.');
	const exportsRoot = path.resolve(getMtheriosAppConfig().dataRoot, 'exports');
	const backupPath = path.resolve(progress.backupPath);
	const relative = path.relative(exportsRoot, backupPath);
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Summary resume backup must be inside the data exports directory.');
	const { jobId: producingJobId, capturedAt: _capturedAt, ...previousSnapshot } = JSON.parse(await readFile(path.join(backupPath, 'snapshot.json'), 'utf8'));
	if (producingJobId !== previous.id) throw new Error('Summary resume snapshot does not belong to the requested job.');
	assertSummaryRebuildUnchanged(previousSnapshot, snapshot);
	return { jobId: previous.id, backupPath };
}

async function readReusableDraft<T extends Chapter | Arc>(resume: { backupPath: string } | null, kind: 'chapter' | 'arc', number: number,
	expected: { id: string; storyId: string; compiler: string; accountIds: string[]; fingerprint: string }): Promise<T | null> {
	if (!resume) return null;
	let row: T;
	try { row = JSON.parse(await readFile(path.join(resume.backupPath, `${kind}-${number}.json`), 'utf8')); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
	const accounts = row?.metadata?.sourceAccounts as Array<{ sourceId: string; summary: string }> | undefined;
	const text = row && ('sceneOutcome' in row ? row.sceneOutcome : row.summary);
	if (!row || typeof row.id !== 'string' || !row.id || row.storyId !== expected.storyId || row.number !== number || typeof text !== 'string' || !text.trim()
		|| row.metadata.projectionCompiler !== expected.compiler || typeof row.metadata.projectionFingerprint !== 'string' || !row.metadata.projectionFingerprint || row.metadata.summarySource !== 'llm'
		|| !Array.isArray(accounts) || accounts.length !== expected.accountIds.length
		|| accounts.some(account => !account || typeof account.sourceId !== 'string' || !account.sourceId || typeof account.summary !== 'string' || !account.summary.trim())
		|| new Set(accounts.map(account => account.sourceId)).size !== accounts.length) {
		throw new Error(`Saved ${kind} ${number} does not match its complete source window and current summary compiler.`);
	}
	// A corrected source-window selector can add evidence without changing the captured transcript.
	// Regenerate that window and its dependent arcs while retaining exact unaffected drafts.
	if (row.id !== expected.id || row.metadata.projectionFingerprint !== expected.fingerprint) return null;
	if (accounts.some((account, index) => account.sourceId !== expected.accountIds[index])) {
		throw new Error(`Saved ${kind} ${number} does not match its complete source window and current summary compiler.`);
	}
	return row;
}

function leaseWhere(job: Job) {
	if (!job.lockedAt || !job.lockedBy) throw new Error('Summary rebuild requires a claimed backend job.');
	return and(eq(backendJobs.id, job.id), eq(backendJobs.storyId, job.storyId), eq(backendJobs.status, 'running'), eq(backendJobs.lockedAt, job.lockedAt), eq(backendJobs.lockedBy, job.lockedBy));
}

async function recordProgress(job: Job, progress: Record<string, unknown>): Promise<void> {
	const now = new Date().toISOString();
	const [claim] = await getDb().update(backendJobs).set({
		lockedAt: now,
		updatedAt: now,
		metadata: sql`${backendJobs.metadata} || ${JSON.stringify({ summaryRebuild: progress })}::jsonb`,
	}).where(leaseWhere(job)).returning({ lockedAt: backendJobs.lockedAt });
	if (!claim?.lockedAt) throw new Error('Summary rebuild lost its worker lease. No summaries were replaced.');
	// The worker completes this same job object; retain the renewed claim timestamp.
	job.lockedAt = claim.lockedAt;
}

export async function rebuildStorySummaries(job: Job): Promise<Record<string, unknown>> {
	const db = getDb();
	const snapshot = await db.transaction(tx => loadSnapshot(tx, job.storyId), { isolationLevel: 'repeatable read', accessMode: 'read only' });
	const resume = await loadSummaryResume(job, snapshot);
	const plan = buildSummaryRebuildPlan(snapshot.entries);
	const ranges = plan.windows.map((window, index) => ({ number: index + 1, startTurn: index * CHAPTER_TURN_COUNT + 1, endTurn: (index + 1) * CHAPTER_TURN_COUNT, startPosition: window.startPosition, endPosition: window.endPosition, entryCount: window.entries.length, unmatchedEntryIds: window.unmatchedEntryIds }));
	const preview = { storyId: job.storyId, completedTurns: plan.completedTurns, remainingTurns: plan.remainingTurns, chapters: plan.chapterCount, arcs: plan.arcCount, sagas: plan.sagaCount, ranges, previous: { chapters: snapshot.chapters.length, arcs: snapshot.arcs.length, sagas: snapshot.sagas.length }, worldAdvanced: false, ...(resume ? { resumedFromJobId: resume.jobId } : {}) };
	if (job.payload.dryRun !== false) {
		const result = { ...preview, dryRun: true, applied: false };
		await recordProgress(job, result);
		return result;
	}
	if (!plan.windows.length && (snapshot.chapters.length || snapshot.arcs.length || snapshot.sagas.length)) {
		throw new Error('No complete 20-turn chapter windows could be established; existing summaries were preserved.');
	}
	const backupPath = path.join(getMtheriosAppConfig().dataRoot, 'exports', `summary-rebuild-${job.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
	await mkdir(backupPath, { recursive: true });
	await writeFile(path.join(backupPath, 'snapshot.json'), JSON.stringify({ jobId: job.id, capturedAt: new Date().toISOString(), ...snapshot }, null, 2), { flag: 'wx' });
	await writeFile(path.join(backupPath, 'plan.json'), JSON.stringify(preview, null, 2), { flag: 'wx' });
	const draftChapters: Chapter[] = [];
	const draftArcs: Arc[] = [];
	const now = new Date().toISOString();
	const serverVersion = snapshot.story.serverVersion + 1;
	const originalEntries = new Map(snapshot.entries.map(entry => [entry.id, entry]));
	let reusedChapters = 0;
	let reusedArcs = 0;
	const progress = () => ({ ...preview, backupPath, dryRun: false, applied: false, draftedChapters: draftChapters.length, draftedArcs: draftArcs.length, reusedChapters, reusedArcs });
	await recordProgress(job, progress());

	for (let offset = 0; offset < plan.windows.length; offset += 2) {
		const outcomes = await Promise.allSettled(plan.windows.slice(offset, offset + 2).map(async (window, batchIndex) => {
			const number = offset + batchIndex + 1;
			const entries = window.entries.map(entry => originalEntries.get(entry.id)!);
			const sourceEntryIds = entries.map(entry => entry.id);
			const sourceIds = new Set(sourceEntryIds);
			const events = snapshot.events.filter(event => isNarrativeChapterEvent(event) && event.sourceEntryIds.some(id => sourceIds.has(id))).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
			const chapterId = stableId('chapter', [entries[0].id, entries[entries.length - 1].id]);
			const sourceFingerprint = projectionFingerprint({ compiler: CHAPTER_PROJECTION_COMPILER, entries, events });
			const reused = await readReusableDraft<Chapter>(resume, 'chapter', number, { id: chapterId, storyId: job.storyId, compiler: CHAPTER_PROJECTION_COMPILER,
				accountIds: window.turns.map(turn => turn.narration.id), fingerprint: sourceFingerprint });
			if (reused) {
				await writeFile(path.join(backupPath, `chapter-${number}.json`), JSON.stringify(reused, null, 2), { flag: 'wx' });
				reusedChapters++;
				return reused;
			}
			const previous = snapshot.chapters.find(chapter => chapter.number === number);
			const accounts = reusableAccounts(previous, sourceEntryIds, window.turns.map(turn => turn.narration.id));
			// Existing validated accounts are the factual record. Reword only their reader-facing chapter narrative.
			const digest = accounts && previous
				? await (async () => {
					const readable = await generateReadableNarrative({ storyId: job.storyId, kind: 'chapter', sources: accounts.map(account => ({ id: account.sourceId, text: account.summary })) });
					return {
						title: previous.title,
						summary: replaceMtheriosStoryNarrative(previous.sceneOutcome, readable.narrative),
						keywords: strings(previous.metadata.legacyKeywords), keyCharacters: strings(previous.metadata.legacyCharacters), keyLocations: strings(previous.metadata.legacyLocations),
						plotThreads: previous.openThreads, emotionalTone: String(previous.metadata.emotionalTone ?? ''), source: 'llm' as const, model: readable.model,
						sourceAccounts: accounts, characterStates: [], threadPlan: { updates: [], inserts: [], eventUpdates: [] },
					};
				})()
				: await summarizeChapterMemoryWithLlm(entries, [], buildChapterMemoryDigest(number, entries, []), []);
			if (digest.source !== 'llm' || !digest.summary.trim()) throw new Error(`Chapter ${number} did not produce a validated model summary.`);
			const entityIds = chapterMemoryEntityIds({ eventEntityIds: [], keyCharacters: digest.keyCharacters, canonicalCharacters: snapshot.characters });
			const openThreadIds: string[] = [];
			const metadata = {
				sourceType: 'terminal_chapter_job', jobId: job.id, rebuild: true, projectionCompiler: CHAPTER_PROJECTION_COMPILER,
				projectionFingerprint: sourceFingerprint,
				campaignId: job.storyId, summarySource: digest.source, summaryModel: digest.model ?? null,
				turnCount: window.turns.length, startTurn: ranges[number - 1].startTurn, endTurn: ranges[number - 1].endTurn,
				entryCount: entries.length, startPosition: window.startPosition, endPosition: window.endPosition,
				branchIds: unique(entries.map(entry => entry.branchId ?? 'primary')), pov: 'primary', threshold: CHAPTER_TURN_COUNT, postChapterBuffer: 0,
				trackedEntityIds: entityIds, legacyKeywords: digest.keywords, legacyCharacters: digest.keyCharacters, legacyLocations: digest.keyLocations,
				emotionalTone: digest.emotionalTone, openThreadIds, sourceAccounts: digest.sourceAccounts, unmatchedEntryIds: window.unmatchedEntryIds,
			};
			const row: Chapter = {
				id: chapterId, storyId: job.storyId, number, title: digest.title, sceneOutcome: digest.summary,
				// Historical event projections may contain later or mistaken interpretations.
				// The transcript-derived accounts carry facts; retain event IDs only as attribution.
				irreversibleChanges: [], npcKnowledgeChanges: [], promisesDebtsOaths: [], discoveredClues: [], relationshipChanges: [], factionChanges: [], openThreads: digest.plotThreads,
				sourceEntryIds, sourceEventIds: events.map(event => event.id), metadata, serverVersion, createdAt: now, updatedAt: now,
			};
			await writeFile(path.join(backupPath, `chapter-${number}.json`), JSON.stringify(row, null, 2), { flag: 'wx' });
			return row;
		}));
		for (const outcome of outcomes) if (outcome.status === 'fulfilled') draftChapters.push(outcome.value);
		await recordProgress(job, progress());
		const failed = outcomes.find(outcome => outcome.status === 'rejected');
		if (failed?.status === 'rejected') throw failed.reason;
	}
	draftChapters.sort((left, right) => left.number - right.number);
	for (let offset = 0; offset < plan.arcCount; offset += 2) {
		const numbers = Array.from({ length: Math.min(2, plan.arcCount - offset) }, (_, index) => offset + index + 1);
		const outcomes = await Promise.allSettled(numbers.map(async number => {
			const sourceChapters = draftChapters.slice((number - 1) * CHAPTERS_PER_ARC, number * CHAPTERS_PER_ARC);
			const chapterIds = sourceChapters.map(chapter => chapter.id);
			const arcId = stableId('arc', [chapterIds[0], chapterIds[chapterIds.length - 1]]);
			const sourceFingerprint = projectionFingerprint({ compiler: ARC_PROJECTION_COMPILER, sourceChapters });
			const reused = await readReusableDraft<Arc>(resume, 'arc', number, { id: arcId, storyId: job.storyId, compiler: ARC_PROJECTION_COMPILER, accountIds: chapterIds, fingerprint: sourceFingerprint });
			if (reused) {
				await writeFile(path.join(backupPath, `arc-${number}.json`), JSON.stringify(reused, null, 2), { flag: 'wx' });
				reusedArcs++;
				return reused;
			}
			const previous = snapshot.arcs.find(arc => reusableArcAccounts(arc, chapterIds));
			const accounts = reusableArcAccounts(previous, chapterIds);
			const generated = accounts && previous
				? await (async () => {
					const readable = await generateReadableNarrative({ storyId: job.storyId, kind: 'arc', sources: accounts.map(account => ({ id: account.sourceId, text: account.summary })) });
					return { title: previous.title, summary: replaceArcOverview(previous.summary, readable.narrative), model: readable.model,
						fields: buildArcMemoryFields(sourceChapters), sourceAccounts: accounts };
				})()
				: await summarizeArcMemoryWithLlm(job.storyId, sourceChapters);
			const sourceEntryIds = unique(sourceChapters.flatMap(chapter => chapter.sourceEntryIds));
			const row: Arc = {
				id: arcId, storyId: job.storyId, number,
				title: generated.title, summary: generated.summary, chapterIds,
				sourceEventIds: unique(sourceChapters.flatMap(chapter => chapter.sourceEventIds)), openThreadIds: canonicalArcOpenThreadIds(sourceChapters, snapshot.threads),
				metadata: {
					sourceType: 'terminal_arc_job', jobId: job.id, rebuild: true, projectionCompiler: ARC_PROJECTION_COMPILER,
					projectionFingerprint: sourceFingerprint, campaignId: job.storyId,
					summarySource: 'llm', summaryModel: generated.model, sourceAccounts: generated.sourceAccounts,
					sourceStart: sourceChapters[0].metadata.startPosition, sourceEnd: sourceChapters[sourceChapters.length - 1].metadata.endPosition,
					branchIds: unique(sourceChapters.flatMap(chapter => strings(chapter.metadata.branchIds))), pov: 'primary', sourceEntryIds,
					chapterCount: sourceChapters.length, startChapterNumber: sourceChapters[0].number, endChapterNumber: sourceChapters[sourceChapters.length - 1].number,
					...generated.fields,
				}, serverVersion, createdAt: now, updatedAt: now,
			};
			await writeFile(path.join(backupPath, `arc-${number}.json`), JSON.stringify(row, null, 2), { flag: 'wx' });
			return row;
		}));
		for (const outcome of outcomes) if (outcome.status === 'fulfilled') draftArcs.push(outcome.value);
		await recordProgress(job, progress());
		const failed = outcomes.find(outcome => outcome.status === 'rejected');
		if (failed?.status === 'rejected') throw failed.reason;
	}
	draftArcs.sort((left, right) => left.number - right.number);
	const result = { ...preview, backupPath, dryRun: false, applied: true, serverVersion, reusedChapters, reusedArcs };
	await db.transaction(async tx => {
		const [claim] = await tx.select({ id: backendJobs.id }).from(backendJobs).where(leaseWhere(job)).for('update');
		if (!claim) throw new Error('Summary rebuild lost its worker lease. No summaries were replaced.');
		const current = await loadSnapshot(tx, job.storyId, true);
		assertSummaryRebuildUnchanged(snapshot, current);
		const competing = await tx.select({ id: backendJobs.id }).from(backendJobs).where(and(eq(backendJobs.storyId, job.storyId), eq(backendJobs.status, 'running'), inArray(backendJobs.type, ['summarize_chapter', 'rollup_arc', 'rollup_saga'])));
		if (competing.length) throw new Error('Summary jobs are still running for this story. No summaries were replaced.');
		await tx.delete(sagas).where(eq(sagas.storyId, job.storyId));
		await tx.delete(arcs).where(eq(arcs.storyId, job.storyId));
		await tx.delete(chapters).where(eq(chapters.storyId, job.storyId));
		if (snapshot.memoryNodes.length) await tx.delete(memoryNodes).where(and(eq(memoryNodes.storyId, job.storyId), inArray(memoryNodes.id, snapshot.memoryNodes.map(node => node.id))));
		if (draftChapters.length) await tx.insert(chapters).values(draftChapters);
		// Historical windows only: no consumer jobs, no present-day character/faction changes, no clock.
		await recordHistoricalChapterWindows(tx, { storyId: job.storyId, jobId: job.id, committedAt: now,
			chapters: draftChapters.map(row => ({ id: row.id, number: row.number, sourceEntryIds: row.sourceEntryIds, metadata: row.metadata })), entries: current.entries });
		if (draftArcs.length) await tx.insert(arcs).values(draftArcs);
		// The model writes sagas after the rebuild commits; until then the arcs stand in for them.
		if (draftArcs.length >= SAGA_ROLLUP_ARCS) await enqueueBackendJob({ storyId: job.storyId, type: 'rollup_saga', dedupeKey: `saga-rollup-rebuild-${job.id}`,
			payload: { sourceJobId: job.id, rebuild: true }, maxAttempts: 3, requeueExisting: false }, tx);
		const shared = { db: tx, storyId: job.storyId, serverVersion, now, jobId: job.id };
		for (const row of draftChapters) await upsertChapterMemoryNode({ ...shared, chapterId: row.id, title: row.title ?? `Chapter ${row.number}`, summary: row.sceneOutcome,
			keywords: strings(row.metadata.legacyKeywords), entityIds: strings(row.metadata.trackedEntityIds), sourceEntryIds: row.sourceEntryIds, sourceEventIds: row.sourceEventIds,
			threadIds: strings(row.metadata.openThreadIds), sourceFingerprint: String(row.metadata.projectionFingerprint), sourceStart: Number(row.metadata.startPosition), sourceEnd: Number(row.metadata.endPosition), branchIds: strings(row.metadata.branchIds) });
		for (const row of draftArcs) await upsertArcMemoryNode({ ...shared, arcId: row.id, title: row.title, summary: row.summary, chapterIds: row.chapterIds,
			entityIds: strings(row.metadata.trackedEntityIds), sourceEntryIds: strings(row.metadata.sourceEntryIds), sourceEventIds: row.sourceEventIds, openThreadIds: row.openThreadIds,
			sourceFingerprint: String(row.metadata.projectionFingerprint), sourceStart: Number(row.metadata.sourceStart), sourceEnd: Number(row.metadata.sourceEnd), branchIds: strings(row.metadata.branchIds) });
		await tx.update(stories).set({ serverVersion, updatedAt: new Date().toISOString() }).where(and(eq(stories.id, job.storyId), eq(stories.serverVersion, snapshot.story.serverVersion)));
		await tx.update(backendJobs).set({ metadata: sql`${backendJobs.metadata} || ${JSON.stringify({ summaryRebuild: result })}::jsonb` }).where(leaseWhere(job));
	});
	await writeFile(path.join(backupPath, 'result.json'), JSON.stringify(result, null, 2)).catch(error => console.warn('[jobs] Rebuild applied; result file could not be written:', error));
	return result;
}
