/**
 * Shared lifecycle for archival chapter memory windows. The live chapter worker,
 * the reviewed chapter-only runner and historical rebuilds record their windows
 * here. A window revision is frozen once — exact source entry IDs, a transcript
 * fingerprint and, when generation starts, the exact summarizer inputs — so a
 * restart reproduces the same request and reuses its checkpointed result. Only an
 * explicit invalidation (source edit, boundary change, operator decision)
 * produces a new revision; new turns never change a frozen window.
 *
 * A memory window is archival bookkeeping, not a narrative chapter ending: the
 * narrator keeps the last exchanges across the boundary (see promptPacket).
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { backendJobs, chapterWindowAttempts, chapterWindows, chapters, storyEntries, summaryGenerationCheckpoints } from '$lib/server/db/schema';
import { CHAPTER_TURN_COUNT, selectCompletedChapterTurns, type ChapterSourceEntry } from '$lib/services/chapterCadence';
import { classifyBackendJobFailure } from './failureClassification';
import { findMemoryCoverageGaps, type MemoryCoverageEntry } from './memoryCoverage';
import { SummaryGenerationError } from './summaryCheckpoints';
import { enqueueChapterFollowUpJobs } from './outbox';

export const CHAPTER_WINDOW_STATES = ['waiting', 'ready', 'generating', 'validated', 'committed',
	'retryable_failure', 'needs_configuration', 'uncertain_dispatch', 'invalidated'] as const;
export type ChapterWindowState = typeof CHAPTER_WINDOW_STATES[number];
/** live: present-day consumers run after commit. reviewed: operator-approved runner.
 * historical: rebuild of past summaries; never applies present-day changes. */
export type ChapterWindowPolicy = 'live' | 'reviewed' | 'historical';
export type ChapterWindowAttempt = typeof chapterWindowAttempts.$inferSelect;

/** Committed and invalidated are terminal; uncertain dispatch leaves only by reconciliation. */
export const CHAPTER_WINDOW_TRANSITIONS: Readonly<Record<ChapterWindowState, readonly ChapterWindowState[]>> = Object.freeze({
	waiting: ['waiting', 'ready', 'generating', 'invalidated'],
	ready: ['waiting', 'generating', 'invalidated'],
	generating: ['validated', 'retryable_failure', 'needs_configuration', 'uncertain_dispatch', 'invalidated'],
	validated: ['committed', 'invalidated'],
	retryable_failure: ['waiting', 'ready', 'generating', 'invalidated'],
	needs_configuration: ['waiting', 'ready', 'generating', 'invalidated'],
	uncertain_dispatch: ['ready', 'invalidated'],
	committed: [],
	invalidated: [],
});
export const OPEN_CHAPTER_WINDOW_STATES: readonly ChapterWindowState[] = CHAPTER_WINDOW_STATES.filter(state => state !== 'committed' && state !== 'invalidated');
/** Bounded wait for classifier work on the window's turns; afterwards the transcript summary proceeds and the gap is recorded. */
export const CHAPTER_WINDOW_EXTRACTION_WAITS = 8;
export const CHAPTER_WINDOW_EXTRACTION_WAIT_MS = 45_000;
export const CHAPTER_WINDOW_LEASE_MS = 10 * 60_000;

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type ChapterWindowDb = Db | Tx;
type TranscriptRow = Pick<ChapterSourceEntry, 'id' | 'type' | 'content' | 'position' | 'parentId' | 'branchId' | 'metadata'>;

const nowIso = () => new Date().toISOString();
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
	return value;
}
export const chapterWindowHash = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value)) ?? 'null').digest('hex');

export function chapterWindowId(storyId: string, number: number, scope = 'primary'): string {
	return `chapter_window_${chapterWindowHash({ storyId, scope, number }).slice(0, 40)}`;
}

/** Metadata that decides eligibility, pairing, attribution or summarized text. Turn
 * receipts and other bookkeeping written after narration do not change the source. */
const TRANSCRIPT_METADATA_KEYS = ['nonCanon', 'actionType', 'narrativeMode', 'parallelPov', 'pov'] as const;

export function transcriptSourceRow(entry: TranscriptRow) {
	const metadata = asRecord(entry.metadata);
	return { id: entry.id, position: entry.position, type: entry.type, content: entry.content,
		parentId: entry.parentId ?? null, branchId: entry.branchId ?? null,
		metadata: Object.fromEntries(TRANSCRIPT_METADATA_KEYS.filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]])) };
}

/** Row hashes for the frozen sources plus every other row in the window's range, so an
 * eligibility change of an ignored row cannot go unnoticed. */
export function chapterWindowSourceRows(sources: TranscriptRow[], rangeRows: TranscriptRow[]): Record<string, string> {
	const rows: Record<string, string> = {};
	for (const row of [...sources, ...rangeRows]) rows[row.id] ??= chapterWindowHash(transcriptSourceRow(row));
	return rows;
}

export function chapterWindowFingerprint(input: { sourceEntryIds: string[]; sourceRows: Record<string, string>; scope: string; pov: string;
	compiler: string; summarizerRevision: string }): string {
	return chapterWindowHash({ version: 'chapter-window-v1', scope: input.scope, pov: input.pov, compiler: input.compiler,
		summarizerRevision: input.summarizerRevision, sourceEntryIds: input.sourceEntryIds,
		rows: Object.keys(input.sourceRows).sort().map(id => [id, input.sourceRows[id]]) });
}

export function changedChapterWindowRows(frozen: Record<string, string>, current: Record<string, string>): string[] {
	return [...new Set([...Object.keys(frozen), ...Object.keys(current)])].filter(id => frozen[id] !== current[id]).sort();
}

export function chapterWindowIsOpen(attempt: Pick<ChapterWindowAttempt, 'state'> | null | undefined): boolean {
	return Boolean(attempt && OPEN_CHAPTER_WINDOW_STATES.includes(attempt.state as ChapterWindowState));
}

export function chapterWindowFrozenRows(attempt: Pick<ChapterWindowAttempt, 'reference'>): Record<string, string> {
	const rows = asRecord(asRecord(attempt.reference).sourceRows);
	return Object.fromEntries(Object.entries(rows).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
}

export function chapterWindowRangeAfter(attempt: Pick<ChapterWindowAttempt, 'reference' | 'startPosition'>): number {
	const value = Number(asRecord(attempt.reference).rangeAfter);
	return Number.isInteger(value) ? value : attempt.startPosition - 1;
}

export async function latestChapterWindowAttempt(db: ChapterWindowDb, storyId: string, number: number, scope = 'primary'): Promise<ChapterWindowAttempt | null> {
	const [row] = await db.select().from(chapterWindowAttempts)
		.where(eq(chapterWindowAttempts.windowId, chapterWindowId(storyId, number, scope)))
		.orderBy(desc(chapterWindowAttempts.revision)).limit(1);
	return row ?? null;
}

/** Current transcript rows for a frozen window: its sources by ID plus its position range. */
export async function loadChapterWindowRows<T extends TranscriptRow = typeof storyEntries.$inferSelect>(db: ChapterWindowDb, attempt: Pick<ChapterWindowAttempt,
	'storyId' | 'sourceEntryIds' | 'reference' | 'startPosition' | 'endPosition'>, lock = false): Promise<{ sources: T[]; rangeRows: T[]; sourceRows: Record<string, string> }> {
	const rangeAfter = chapterWindowRangeAfter(attempt);
	const query = db.select().from(storyEntries).where(and(eq(storyEntries.storyId, attempt.storyId), or(
		attempt.sourceEntryIds.length ? inArray(storyEntries.id, attempt.sourceEntryIds) : undefined,
		and(sql`${storyEntries.position} > ${rangeAfter}`, lte(storyEntries.position, attempt.endPosition)),
	))).orderBy(asc(storyEntries.position));
	const rows = (lock ? await query.for('share') : await query) as unknown as T[];
	const byId = new Map(rows.map(row => [row.id, row]));
	const sources = attempt.sourceEntryIds.map(id => byId.get(id)).filter((row): row is T => Boolean(row));
	const rangeRows = rows.filter(row => row.position > rangeAfter && row.position <= attempt.endPosition);
	// A missing source must count as a change; absent IDs keep no row hash.
	return { sources, rangeRows, sourceRows: chapterWindowSourceRows(sources, rangeRows) };
}

export interface FreezeChapterWindowInput {
	storyId: string; number: number; scope?: string; pov?: string; policy: ChapterWindowPolicy;
	afterChapterId: string | null; rangeAfter: number; startPosition: number; endPosition: number;
	sourceEntryIds: string[]; sourceRows: Record<string, string>; compiler: string; summarizerRevision: string;
	/** Revision the caller observed; a concurrent freeze of the same slot wins and is returned instead. */
	expectedRevision: number;
	state?: ChapterWindowState; extraction?: Record<string, unknown>; reference?: Record<string, unknown>;
	inputs?: Record<string, unknown> | null; draft?: Record<string, unknown> | null; draftHash?: string | null;
	chapterId?: string | null; committedAt?: string | null; ownerJobId?: string | null;
}

/** Freeze a new revision. Returns `frozen: false` with the winning attempt when another worker froze the slot first. */
export async function freezeChapterWindow(db: ChapterWindowDb, input: FreezeChapterWindowInput): Promise<{ frozen: boolean; attempt: ChapterWindowAttempt | null }> {
	const scope = input.scope ?? 'primary';
	const windowId = chapterWindowId(input.storyId, input.number, scope);
	const now = nowIso();
	const sourceFingerprint = chapterWindowFingerprint({ sourceEntryIds: input.sourceEntryIds, sourceRows: input.sourceRows, scope,
		pov: input.pov ?? 'primary', compiler: input.compiler, summarizerRevision: input.summarizerRevision });
	const attempt = await db.transaction(async tx => {
		const [slot] = input.expectedRevision === 0
			? await tx.insert(chapterWindows).values({ id: windowId, storyId: input.storyId, scope, number: input.number, revision: 1,
				chapterId: input.chapterId ?? null, createdAt: now, updatedAt: now }).onConflictDoNothing().returning({ revision: chapterWindows.revision })
			: await tx.update(chapterWindows).set({ revision: input.expectedRevision + 1, updatedAt: now,
				...(input.chapterId ? { chapterId: input.chapterId } : {}) })
				.where(and(eq(chapterWindows.id, windowId), eq(chapterWindows.revision, input.expectedRevision)))
				.returning({ revision: chapterWindows.revision });
		if (!slot) return null;
		const [row] = await tx.insert(chapterWindowAttempts).values({
			windowId, revision: slot.revision, storyId: input.storyId, policy: input.policy, state: input.state ?? 'ready',
			afterChapterId: input.afterChapterId, startPosition: input.startPosition, endPosition: input.endPosition,
			sourceEntryIds: input.sourceEntryIds, sourceFingerprint, scope, pov: input.pov ?? 'primary',
			compiler: input.compiler, summarizerRevision: input.summarizerRevision,
			inputs: input.inputs ?? null, draft: input.draft ?? null, draftHash: input.draftHash ?? null,
			ownerJobId: input.ownerJobId ?? null, extraction: input.extraction ?? {},
			reference: { ...(input.reference ?? {}), rangeAfter: input.rangeAfter, sourceRows: input.sourceRows },
			chapterId: input.chapterId ?? null, committedAt: input.committedAt ?? null, createdAt: now, updatedAt: now,
		}).returning();
		return row;
	});
	if (attempt) return { frozen: true, attempt };
	return { frozen: false, attempt: await latestChapterWindowAttempt(db, input.storyId, input.number, scope) };
}

/** Guarded transition; null when the attempt already left every state that may move to `to`. */
export async function transitionChapterWindow(db: ChapterWindowDb, attempt: Pick<ChapterWindowAttempt, 'windowId' | 'revision'>,
	to: ChapterWindowState, patch: Partial<typeof chapterWindowAttempts.$inferInsert> = {}, from?: readonly ChapterWindowState[]): Promise<ChapterWindowAttempt | null> {
	const allowed = from ?? CHAPTER_WINDOW_STATES.filter(state => CHAPTER_WINDOW_TRANSITIONS[state].includes(to));
	const [row] = await db.update(chapterWindowAttempts).set({ ...patch, state: to, updatedAt: nowIso() })
		.where(and(eq(chapterWindowAttempts.windowId, attempt.windowId), eq(chapterWindowAttempts.revision, attempt.revision),
			inArray(chapterWindowAttempts.state, [...allowed]))).returning();
	return row ?? null;
}

/** Inside the canonical commit transaction: the window and its chapter commit together. */
export async function markChapterWindowCommitted(tx: ChapterWindowDb, attempt: Pick<ChapterWindowAttempt, 'windowId' | 'revision'>,
	chapterId: string, committedAt: string): Promise<ChapterWindowAttempt | null> {
	const row = await transitionChapterWindow(tx, attempt, 'committed', { chapterId, committedAt, ownerJobId: null, leaseUntil: null }, ['validated']);
	if (row) await tx.update(chapterWindows).set({ chapterId, updatedAt: committedAt }).where(eq(chapterWindows.id, attempt.windowId));
	return row;
}

export async function invalidateChapterWindow(db: ChapterWindowDb, attempt: Pick<ChapterWindowAttempt, 'windowId' | 'revision'>,
	invalidation: { reason: 'source_changed' | 'boundary_changed' | 'draft_invalid' | 'summary_rebuild' | 'operator'; changedEntryIds?: string[]; detail?: string }) {
	return transitionChapterWindow(db, attempt, 'invalidated', { invalidation: { ...invalidation, at: nowIso() }, ownerJobId: null, leaseUntil: null });
}

/** One generator per window. Freezes the generation inputs on first claim (first write wins). */
export async function claimChapterWindowGeneration(db: ChapterWindowDb, attempt: Pick<ChapterWindowAttempt, 'windowId' | 'revision'>,
	ownerJobId: string, inputs: Record<string, unknown> | null, patch: Partial<typeof chapterWindowAttempts.$inferInsert> = {},
	leaseMs = CHAPTER_WINDOW_LEASE_MS): Promise<ChapterWindowAttempt | null> {
	const now = nowIso();
	const [row] = await db.update(chapterWindowAttempts).set({
		...patch, state: 'generating', ownerJobId, leaseUntil: new Date(Date.now() + leaseMs).toISOString(), failure: null, updatedAt: now,
		...(inputs ? { inputs: sql`coalesce(${chapterWindowAttempts.inputs}, ${JSON.stringify(inputs)}::jsonb)` } : {}),
	}).where(and(eq(chapterWindowAttempts.windowId, attempt.windowId), eq(chapterWindowAttempts.revision, attempt.revision), or(
		inArray(chapterWindowAttempts.state, ['waiting', 'ready', 'retryable_failure', 'needs_configuration']),
		// A reclaimed job resumes its own window; an expired lease is resumable through the
		// summary checkpoints, which refuse to buy an interrupted provider call again.
		and(eq(chapterWindowAttempts.state, 'generating'), or(eq(chapterWindowAttempts.ownerJobId, ownerJobId), lte(chapterWindowAttempts.leaseUntil, now))),
	))).returning();
	return row ?? null;
}

export function chapterWindowLeaseActive(attempt: Pick<ChapterWindowAttempt, 'state' | 'leaseUntil' | 'ownerJobId'>, ownerJobId: string): boolean {
	return attempt.state === 'generating' && attempt.ownerJobId !== ownerJobId && Boolean(attempt.leaseUntil && Date.parse(attempt.leaseUntil) > Date.now());
}

/** Lifecycle state for a failed generation. Unknown provider outcomes require reconciliation. */
export function chapterWindowFailure(error: unknown): { state: 'needs_configuration' | 'uncertain_dispatch' | 'retryable_failure'; failure: Record<string, unknown> } {
	const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
	const classification = classifyBackendJobFailure(message);
	const code = error instanceof SummaryGenerationError ? error.code : `summary_${classification.cause}`;
	const retryable = error instanceof SummaryGenerationError ? error.retryable : classification.retryable;
	const uncertain = ['summary_interrupted', 'summary_checkpoint_lost', 'summary_checkpoint_accounting'].includes(code)
		|| (code === 'summary_checkpoint_storage' && !retryable);
	const state = code === 'summary_configuration' || classification.cause === 'configuration' ? 'needs_configuration'
		: uncertain ? 'uncertain_dispatch' : 'retryable_failure';
	return { state, failure: { code, message, retryable: state === 'retryable_failure' && retryable, at: nowIso() } };
}

/** Classifier work on the window's turns. Waiting/running extraction holds the window
 * (bounded); failed or outdated extraction is recorded and never blocks it. Turns with no
 * extraction record (imports, inline or skipped extraction) are only counted. */
export async function chapterWindowExtraction(db: ChapterWindowDb, storyId: string, entries: TranscriptRow[]): Promise<{
	pendingEntryIds: string[]; gaps: Array<{ entryId: string; reason: string }>; unrecordedTurns: number;
}> {
	const narrationIds = entries.filter(entry => entry.type === 'narration').map(entry => entry.id);
	if (!narrationIds.length) return { pendingEntryIds: [], gaps: [], unrecordedTurns: 0 };
	const jobs = await db.select({ status: backendJobs.status, createdAt: backendJobs.createdAt, updatedAt: backendJobs.updatedAt,
		lastError: backendJobs.lastError, payload: backendJobs.payload }).from(backendJobs)
		.where(and(eq(backendJobs.storyId, storyId), eq(backendJobs.type, 'extract_turn_state'),
			inArray(sql`${backendJobs.payload}->>'assistantEntryId'`, narrationIds)));
	const gaps = findMemoryCoverageGaps(entries.map(entry => ({ ...entry, parentId: entry.parentId ?? null,
		metadata: asRecord(entry.metadata) })) as MemoryCoverageEntry[], jobs as Parameters<typeof findMemoryCoverageGaps>[1]);
	const pending = gaps.filter(gap => gap.reason === 'waiting' || gap.reason === 'running');
	return { pendingEntryIds: pending.map(gap => gap.assistant.id),
		gaps: gaps.filter(gap => gap.reason === 'failed' || gap.reason === 'outdated').map(gap => ({ entryId: gap.assistant.id, reason: gap.reason })),
		unrecordedTurns: gaps.filter(gap => gap.reason === 'missing').length };
}

/**
 * A summary rebuild replaces past chapters as historical projections. Open windows are
 * invalidated and each rebuilt chapter is recorded as a committed historical revision of
 * its slot. Nothing here enqueues consumers: a rebuild never applies present-day
 * thread, character or faction changes and never advances the world clock.
 */
export async function recordHistoricalChapterWindows(tx: ChapterWindowDb, input: { storyId: string; jobId: string; committedAt: string;
	chapters: Array<{ id: string; number: number; sourceEntryIds: string[]; metadata: Record<string, unknown> }>; entries: TranscriptRow[] }): Promise<number> {
	const at = input.committedAt;
	await tx.update(chapterWindowAttempts).set({ state: 'invalidated', ownerJobId: null, leaseUntil: null, updatedAt: at,
		invalidation: { reason: 'summary_rebuild', jobId: input.jobId, at } })
		.where(and(eq(chapterWindowAttempts.storyId, input.storyId), inArray(chapterWindowAttempts.state, [...OPEN_CHAPTER_WINDOW_STATES])));
	if (!input.chapters.length) return 0;
	const slots = await tx.select({ id: chapterWindows.id, revision: chapterWindows.revision }).from(chapterWindows).where(eq(chapterWindows.storyId, input.storyId));
	const revisions = new Map(slots.map(slot => [slot.id, slot.revision]));
	const byId = new Map(input.entries.map(entry => [entry.id, entry]));
	const ordered = [...input.chapters].sort((left, right) => left.number - right.number);
	const rows = ordered.map((chapter, index) => {
		const windowId = chapterWindowId(input.storyId, chapter.number);
		const revision = (revisions.get(windowId) ?? 0) + 1;
		const startPosition = Number(chapter.metadata.startPosition);
		const endPosition = Number(chapter.metadata.endPosition);
		const sources = chapter.sourceEntryIds.map(id => byId.get(id)).filter((row): row is TranscriptRow => Boolean(row));
		const rangeAfter = Math.min(startPosition, ...sources.map(row => row.position)) - 1;
		const sourceRows = chapterWindowSourceRows(sources, input.entries.filter(row => row.position > rangeAfter && row.position <= endPosition));
		const compiler = String(chapter.metadata.projectionCompiler ?? 'unknown');
		const summarizerRevision = String(chapter.metadata.summaryGenerationPolicy ?? chapter.metadata.projectionCompiler ?? 'unknown');
		return {
			slot: { id: windowId, storyId: input.storyId, scope: 'primary', number: chapter.number, revision, chapterId: chapter.id, createdAt: at, updatedAt: at },
			attempt: { windowId, revision, storyId: input.storyId, policy: 'historical', state: 'committed', afterChapterId: ordered[index - 1]?.id ?? null,
				startPosition, endPosition, sourceEntryIds: chapter.sourceEntryIds,
				sourceFingerprint: chapterWindowFingerprint({ sourceEntryIds: chapter.sourceEntryIds, sourceRows, scope: 'primary', pov: 'primary', compiler, summarizerRevision }),
				compiler, summarizerRevision, reference: { jobId: input.jobId, rangeAfter, sourceRows }, chapterId: chapter.id, committedAt: at, createdAt: at, updatedAt: at },
		};
	});
	for (let offset = 0; offset < rows.length; offset += 200) {
		const batch = rows.slice(offset, offset + 200);
		await tx.insert(chapterWindows).values(batch.map(row => row.slot)).onConflictDoUpdate({ target: chapterWindows.id,
			set: { revision: sql`excluded.revision`, chapterId: sql`excluded.chapter_id`, updatedAt: at } });
		await tx.insert(chapterWindowAttempts).values(batch.map(row => row.attempt));
	}
	return rows.length;
}

/** postgres.js access used by the reviewed chapter-only runner inside its own transactions. */
type RawQuery = { unsafe(query: string, params?: unknown[]): PromiseLike<ArrayLike<Record<string, any>>> };
const rawRows = async (q: RawQuery, query: string, params: unknown[]) => Array.from(await q.unsafe(query, params as never[]));

/** Why the runner must not take this slot now: the live worker is generating or holds a validated draft. */
export async function reviewedChapterWindowBlocked(q: RawQuery, storyId: string, number: number): Promise<string | null> {
	const [row] = await rawRows(q, `select policy, state, lease_until > now() as leased from chapter_window_attempts
		where window_id=$1 order by revision desc limit 1`, [chapterWindowId(storyId, number)]);
	if (!row || row.policy !== 'live') return null;
	if (row.state === 'validated' || (row.state === 'generating' && row.leased === true)) return `The live chapter worker is summarizing chapter ${number}.`;
	return null;
}

/**
 * Record the runner's manifest as a reviewed revision of its slot (same lifecycle as the
 * live worker). An idle live revision is superseded; a resumed manifest keeps its revision.
 */
export async function recordReviewedChapterWindow(q: RawQuery, input: { storyId: string; number: number; manifestId: string;
	startPosition: number; endPosition: number; sourceEntryIds: string[]; owner: string; compiler: string; summarizerRevision: string }): Promise<{ revision: number }> {
	const windowId = chapterWindowId(input.storyId, input.number);
	const now = nowIso();
	const [latest] = await rawRows(q, 'select revision, state, reference from chapter_window_attempts where window_id=$1 order by revision desc limit 1 for update', [windowId]);
	if (latest && OPEN_CHAPTER_WINDOW_STATES.includes(latest.state) && asRecord(latest.reference).manifestId === input.manifestId) {
		await q.unsafe(`update chapter_window_attempts set state='generating', owner_job_id=$3, updated_at=$4
			where window_id=$1 and revision=$2 and state in ('waiting','ready','generating','retryable_failure','needs_configuration')`, [windowId, latest.revision, input.owner, now]);
		return { revision: Number(latest.revision) };
	}
	if (latest && OPEN_CHAPTER_WINDOW_STATES.includes(latest.state)) {
		await q.unsafe(`update chapter_window_attempts set state='invalidated', owner_job_id=null, lease_until=null, updated_at=$3,
			invalidation=$4::text::jsonb where window_id=$1 and revision=$2`, [windowId, latest.revision, now,
			JSON.stringify({ reason: 'operator', detail: 'The reviewed chapter-only runner took this window.', at: now })]);
	}
	const rangeAfter = input.startPosition - 1;
	const entries = await rawRows(q, `select id, type, content, position, parent_id, branch_id, metadata from story_entries
		where story_id=$1 and (id = any($2::text[]) or (position > $3 and position <= $4)) order by position`,
		[input.storyId, input.sourceEntryIds, rangeAfter, input.endPosition]);
	const rows = entries.map(row => ({ id: row.id, type: row.type, content: row.content, position: Number(row.position),
		parentId: row.parent_id, branchId: row.branch_id, metadata: row.metadata })) as TranscriptRow[];
	const byId = new Map(rows.map(row => [row.id, row]));
	const sourceRows = chapterWindowSourceRows(input.sourceEntryIds.map(id => byId.get(id)).filter((row): row is TranscriptRow => Boolean(row)),
		rows.filter(row => row.position > rangeAfter && row.position <= input.endPosition));
	const [boundary] = await rawRows(q, 'select id from chapters where story_id=$1 order by number desc limit 1', [input.storyId]);
	const [slot] = await rawRows(q, `insert into chapter_windows(id, story_id, scope, number, revision, created_at, updated_at) values($1,$2,'primary',$3,1,$4,$4)
		on conflict (id) do update set revision=chapter_windows.revision+1, updated_at=excluded.updated_at returning revision`, [windowId, input.storyId, input.number, now]);
	const revision = Number(slot.revision);
	await q.unsafe(`insert into chapter_window_attempts(window_id, revision, story_id, policy, state, after_chapter_id, start_position, end_position,
		source_entry_ids, source_fingerprint, compiler, summarizer_revision, owner_job_id, reference, created_at, updated_at)
		values($1,$2,$3,'reviewed','generating',$4,$5,$6,$7::text::jsonb,$8,$9,$10,$11,$12::text::jsonb,$13,$13)`, [
		windowId, revision, input.storyId, boundary?.id ?? null, input.startPosition, input.endPosition, JSON.stringify(input.sourceEntryIds),
		chapterWindowFingerprint({ sourceEntryIds: input.sourceEntryIds, sourceRows, scope: 'primary', pov: 'primary', compiler: input.compiler, summarizerRevision: input.summarizerRevision }),
		input.compiler, input.summarizerRevision, input.owner, JSON.stringify({ manifestId: input.manifestId, rangeAfter, sourceRows }), now]);
	return { revision };
}

/** Guarded state change for the runner's revision of a slot (identified by its manifest). */
export async function setReviewedChapterWindowState(q: RawQuery, input: { storyId: string; number: number; manifestId: string;
	state: 'validated' | 'committed' | 'retryable_failure' | 'uncertain_dispatch' | 'invalidated'; failure?: Record<string, unknown>; draftHash?: string;
	invalidation?: { reason: 'operator'; detail: string };
	commit?: { chapterId: string; committedAt: string; chapterServerVersion: number; projectionFingerprint: string; memoryNodeId: string };
	/** Only for an operator reconciliation that verified an external reviewed commit. */
	from?: readonly ChapterWindowState[] }): Promise<boolean> {
	const windowId = chapterWindowId(input.storyId, input.number);
	const from = input.from ?? CHAPTER_WINDOW_STATES.filter(state => CHAPTER_WINDOW_TRANSITIONS[state].includes(input.state));
	const now = nowIso();
	const updated = await rawRows(q, `update chapter_window_attempts set state=$3, updated_at=$4, invalidation=coalesce($11::text::jsonb, invalidation),
		failure=coalesce($5::text::jsonb, failure), draft_hash=coalesce($6, draft_hash), chapter_id=coalesce($7, chapter_id),
		committed_at=coalesce($8::timestamptz, committed_at), owner_job_id=case when $3 in ('validated','generating') then owner_job_id else null end,
		reference=reference || $9::text::jsonb
		where window_id=$1 and reference->>'manifestId'=$2 and state = any($10::text[]) returning revision`, [
		windowId, input.manifestId, input.state, now, input.failure ? JSON.stringify({ ...input.failure, at: now }) : null, input.draftHash ?? null,
		input.commit?.chapterId ?? null, input.commit?.committedAt ?? null,
		// Consumers are enqueued by the lifecycle owner; the runner itself never writes backend jobs.
		JSON.stringify(input.commit ? { followUps: { pending: true, chapterServerVersion: input.commit.chapterServerVersion,
			projectionFingerprint: input.commit.projectionFingerprint, memoryNodeId: input.commit.memoryNodeId } } : {}), from,
		input.invalidation ? JSON.stringify({ ...input.invalidation, at: now }) : null]);
	if (input.commit && updated.length) await q.unsafe('update chapter_windows set chapter_id=$2, updated_at=$3 where id=$1', [windowId, input.commit.chapterId, now]);
	return updated.length > 0;
}

/** Index and arc consumers for chapters committed by the reviewed runner. Thread,
 * character and faction consumers are not applied: the runner extracts none. */
export const REVIEWED_CHAPTER_FOLLOW_UPS = ['arcRollup', 'embedding', 'vault'] as const;

export async function ensureReviewedChapterFollowUps(storyId: string, db: Db = getDb()): Promise<number> {
	const pending = await db.select().from(chapterWindowAttempts).where(and(eq(chapterWindowAttempts.storyId, storyId),
		eq(chapterWindowAttempts.state, 'committed'), eq(chapterWindowAttempts.policy, 'reviewed'),
		sql`${chapterWindowAttempts.reference}->'followUps'->>'pending' = 'true'`));
	let enqueued = 0;
	for (const attempt of pending) {
		const followUps = asRecord(asRecord(attempt.reference).followUps);
		await db.transaction(async tx => {
			const [chapter] = await tx.select({ id: chapters.id, number: chapters.number, serverVersion: chapters.serverVersion, metadata: chapters.metadata })
				.from(chapters).where(and(eq(chapters.storyId, storyId), eq(chapters.id, attempt.chapterId ?? ''))).limit(1);
			const current = Boolean(chapter && chapter.serverVersion === Number(followUps.chapterServerVersion)
				&& asRecord(chapter.metadata).projectionFingerprint === followUps.projectionFingerprint);
			const jobIds = current ? await enqueueChapterFollowUpJobs({ storyId, chapterId: chapter.id, chapterNumber: chapter.number,
				chapterServerVersion: chapter.serverVersion, projectionFingerprint: String(followUps.projectionFingerprint),
				sourceJobId: String(asRecord(attempt.reference).manifestId ?? ''), sourceEventIds: [], memoryNodeId: String(followUps.memoryNodeId),
				threadPlan: null, kinds: REVIEWED_CHAPTER_FOLLOW_UPS }, tx) : {};
			await tx.update(chapterWindowAttempts).set({ updatedAt: nowIso(),
				reference: { ...attempt.reference, followUps: { ...followUps, pending: false, ...(current ? { jobIds } : { skipped: 'chapter_revision_changed' }) } } })
				.where(and(eq(chapterWindowAttempts.windowId, attempt.windowId), eq(chapterWindowAttempts.revision, attempt.revision)));
			if (current) enqueued++;
		});
	}
	return enqueued;
}

export function chapterWindowDraftHash(draft: unknown): string {
	return chapterWindowHash(draft);
}

/** Contiguous summarized coverage over completed primary turns. Read-only. */
export function summarizedChapterCoverage(entries: TranscriptRow[], chapterRows: Array<{ sourceEntryIds: unknown }>) {
	const covered = new Set(chapterRows.flatMap(row => Array.isArray(row.sourceEntryIds) ? row.sourceEntryIds.map(String) : []));
	const turns = selectCompletedChapterTurns(entries as ChapterSourceEntry[]);
	let contiguousThroughPosition: number | null = null;
	let contiguous = true;
	const uncovered: Array<{ narrationId: string; playerId: string; position: number }> = [];
	let lastCoveredPosition: number | null = null;
	for (const turn of turns) {
		const isCovered = covered.has(turn.narration.id) && covered.has(turn.player.id);
		if (isCovered) {
			lastCoveredPosition = turn.narration.position;
			if (contiguous) contiguousThroughPosition = turn.narration.position;
		} else {
			contiguous = false;
			uncovered.push({ narrationId: turn.narration.id, playerId: turn.player.id, position: turn.narration.position });
		}
	}
	// Uncovered turns before the last summarized turn are gaps in history, not pending work.
	const gaps = lastCoveredPosition === null ? [] : uncovered.filter(turn => turn.position < lastCoveredPosition!);
	return { completedTurns: turns.length, summarizedTurns: turns.length - uncovered.length, contiguousThroughPosition,
		pendingTurns: uncovered.length - gaps.length, gaps };
}

export type ChapterWindowSummary = {
	windowId: string; number: number; revision: number; state: ChapterWindowState; policy: ChapterWindowPolicy;
	startPosition: number; endPosition: number; sourceCount: number; ownerJobId: string | null; leaseUntil: string | null;
	extraction: Record<string, unknown>; failure: Record<string, unknown> | null; invalidation: Record<string, unknown> | null;
	reconciliations: number; chapterId: string | null; committedAt: string | null; updatedAt: string;
};

function summarizeAttempt(attempt: ChapterWindowAttempt, number: number): ChapterWindowSummary {
	return { windowId: attempt.windowId, number, revision: attempt.revision, state: attempt.state as ChapterWindowState,
		policy: attempt.policy as ChapterWindowPolicy, startPosition: attempt.startPosition, endPosition: attempt.endPosition,
		sourceCount: attempt.sourceEntryIds.length, ownerJobId: attempt.ownerJobId, leaseUntil: attempt.leaseUntil,
		extraction: attempt.extraction, failure: attempt.failure, invalidation: attempt.invalidation,
		reconciliations: attempt.reconciliations.length, chapterId: attempt.chapterId, committedAt: attempt.committedAt, updatedAt: attempt.updatedAt };
}

/** Chapter progress for the UI, CLI and MCP. Read-only. */
export async function chapterWindowStatus(storyId: string, db: ChapterWindowDb = getDb()) {
	const [chapterRows, entryRows, attempts] = await Promise.all([
		db.select({ id: chapters.id, number: chapters.number, sourceEntryIds: chapters.sourceEntryIds, metadata: chapters.metadata })
			.from(chapters).where(eq(chapters.storyId, storyId)).orderBy(asc(chapters.number)),
		db.select({ id: storyEntries.id, type: storyEntries.type, content: storyEntries.content, position: storyEntries.position,
			parentId: storyEntries.parentId, branchId: storyEntries.branchId, metadata: storyEntries.metadata })
			.from(storyEntries).where(eq(storyEntries.storyId, storyId)).orderBy(asc(storyEntries.position)),
		db.select({ attempt: chapterWindowAttempts, number: chapterWindows.number }).from(chapterWindowAttempts)
			.innerJoin(chapterWindows, eq(chapterWindows.id, chapterWindowAttempts.windowId))
			.where(eq(chapterWindowAttempts.storyId, storyId)).orderBy(desc(chapterWindowAttempts.updatedAt)).limit(12),
	]);
	const last = chapterRows.at(-1);
	const nextNumber = (last?.number ?? 0) + 1;
	const coverage = summarizedChapterCoverage(entryRows, chapterRows);
	const current = attempts.find(row => row.number === nextNumber && chapterWindowIsOpen(row.attempt));
	return {
		storyId, turnsPerChapter: CHAPTER_TURN_COUNT, chapters: chapterRows.length,
		boundary: { chapterId: last?.id ?? null, number: last?.number ?? 0, endPosition: Number(asRecord(last?.metadata).endPosition ?? -1) },
		coverage,
		next: current ? summarizeAttempt(current.attempt, current.number)
			: { number: nextNumber, state: coverage.pendingTurns >= CHAPTER_TURN_COUNT ? 'ready' : 'waiting' as const,
				completedTurns: coverage.pendingTurns, requiredTurns: CHAPTER_TURN_COUNT },
		recent: attempts.map(row => summarizeAttempt(row.attempt, row.number)),
	};
}

/**
 * Operator decision for a window blocked by an uncertain provider outcome or a
 * non-retryable generation failure. `redispatch` permits one new request for the
 * same frozen inputs: the blocking summary checkpoints are kept (with their
 * receipts) and marked retryable with the reconciliation note. `invalidate`
 * discards the revision so the next attempt refreezes the current transcript.
 */
export async function reconcileChapterWindow(input: { storyId: string; windowId: string; revision: number;
	decision: 'redispatch' | 'invalidate'; reviewedBy: string; note?: string }, db: Db = getDb()) {
	if (!input.reviewedBy.trim()) throw new Error('Chapter window reconciliation requires a reviewer.');
	return db.transaction(async tx => {
		const [attempt] = await tx.select().from(chapterWindowAttempts).where(and(eq(chapterWindowAttempts.storyId, input.storyId),
			eq(chapterWindowAttempts.windowId, input.windowId), eq(chapterWindowAttempts.revision, input.revision))).for('update');
		if (!attempt) throw new Error('Chapter window revision not found for this story.');
		const at = nowIso();
		const record = { decision: input.decision, reviewedBy: input.reviewedBy.trim(), note: input.note?.trim() || null, at,
			fromState: attempt.state, failure: attempt.failure };
		if (input.decision === 'invalidate') {
			if (!chapterWindowIsOpen(attempt)) throw new Error(`Chapter window is ${attempt.state}; only an open window can be invalidated.`);
			const row = await transitionChapterWindow(tx, attempt, 'invalidated', { reconciliations: [...attempt.reconciliations, record],
				invalidation: { reason: 'operator', detail: record.note, at }, ownerJobId: null, leaseUntil: null });
			return { attempt: row, releasedCheckpoints: 0 };
		}
		const blockedFailure = attempt.state === 'retryable_failure' && asRecord(attempt.failure).retryable !== true;
		if (attempt.state !== 'uncertain_dispatch' && !blockedFailure) {
			throw new Error(`Chapter window is ${attempt.state}; redispatch reconciles only an uncertain dispatch or a blocked failure.`);
		}
		// Expired provider claims (uncertain) and permanent failures for this story's chapter
		// summaries. Rows and receipts are retained; only their retry eligibility changes.
		const released = await tx.update(summaryGenerationCheckpoints).set({
			status: 'failed', leaseOwner: null, leaseUntil: null, updatedAt: at,
			failure: sql`jsonb_build_object('message', ${`Reconciled by ${record.reviewedBy}: one new dispatch permitted.`}::text, 'code', 'summary_reconciled',
				'retryable', true, 'responseReceived', false, 'reconciledAt', ${at}::text, 'previous', coalesce(${summaryGenerationCheckpoints.failure}, 'null'::jsonb))`,
		}).where(and(eq(summaryGenerationCheckpoints.storyId, input.storyId), eq(summaryGenerationCheckpoints.kind, 'chapter'), or(
			and(eq(summaryGenerationCheckpoints.status, 'running'), eq(summaryGenerationCheckpoints.dispatchesProvider, true), lte(summaryGenerationCheckpoints.leaseUntil, at)),
			and(eq(summaryGenerationCheckpoints.status, 'failed'), sql`coalesce(${summaryGenerationCheckpoints.failure}->>'retryable','false') <> 'true'`),
		))).returning({ fingerprint: summaryGenerationCheckpoints.fingerprint });
		const row = await transitionChapterWindow(tx, attempt, 'ready', { reconciliations: [...attempt.reconciliations, record],
			failure: null, ownerJobId: null, leaseUntil: null }, ['uncertain_dispatch', 'retryable_failure']);
		return { attempt: row, releasedCheckpoints: released.length };
	});
}
