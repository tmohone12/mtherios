/**
 * Chapter commit and its durable consumers, split from processor.ts. The commit
 * freezes and records the chapter window (chapterWindows.ts) and writes the chapter,
 * its memory projection, completion receipt and consumer jobs in one transaction;
 * each consumer (threads, characters) applies to one committed chapter revision.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { backendJobs, chapters, entities, stories, storyEvents, storyThreads } from '$lib/server/db/schema';
import { applyChapterCampaignFactReview, readCampaignState } from '$lib/contracts/campaignState';
import { CHAPTER_TURN_COUNT, selectCompletedChapterTurns, selectNextChapterWindow } from '$lib/services/chapterCadence';
import type { TimingRecorder } from '$lib/server/performance/timing';
import { buildChapterThreadPlan, chapterThreadMetadata, type ChapterThreadPlan } from '$lib/server/plotBrain/chapterThreads';
import { chapterFollowUpJobId, chapterFollowUpKinds, enqueueChapterFollowUpJobs, enqueueChapterSummaryJob, enqueuePlotBrainJob } from './outbox';
import { CHAPTER_SUMMARIZER_REVISION, type MemoryInput } from './summaryGeneration';
import { CHAPTER_WINDOW_EXTRACTION_WAITS, CHAPTER_WINDOW_EXTRACTION_WAIT_MS, changedChapterWindowRows, chapterWindowDraftHash, chapterWindowExtraction, chapterWindowFailure,
	chapterWindowFrozenRows, chapterWindowIsOpen, chapterWindowLeaseActive, chapterWindowSourceRows, claimChapterWindowGeneration, ensureReviewedChapterFollowUps,
	freezeChapterWindow, invalidateChapterWindow, latestChapterWindowAttempt, loadChapterWindowRows, markChapterWindowCommitted, transitionChapterWindow,
	type ChapterWindowAttempt } from './chapterWindows';
import {
	CHAPTER_PROJECTION_COMPILER, CHARACTER_CONTEXT_AUTO_APPLY_CHAPTER_INTERVAL, asNumber, asRecord, asStringArray, autoApplyChapterCharacterContextUpdates,
	chapterMemoryEntityIds, chapterMemoryInput, createChapterCharacterContextUpdateProposals, createChapterCharacterReferenceProposals,
	isNarrativeChapterEvent, lastChapterBoundary, loadEntriesAfter, loadEventsForEntries, nowIso, persistChapterThreadPlan, projectionFingerprint,
	requirePayloadString, shouldAutoApplyChapterCharacterContext, stableId, storedChapterMemoryDigest, summarizeChapterMemoryFromInput, timePhase,
	uniqueStrings, upsertChapterMemoryNode, type BackendJobRow, type ChapterMemoryDigest, type ChapterRow, type StoryEntryRow, type StoryEventRow,
} from './processor';

export async function createChapterCheckpoint(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const threshold = CHAPTER_TURN_COUNT;
	const buffer = 0;
	const db = getDb();
	const { chapter: previousChapter, endPosition } = await timePhase(recorder, 'job.summarize_chapter.load_boundary', {}, () => lastChapterBoundary(job.storyId));
	const number = (previousChapter?.number ?? 0) + 1;
	const afterChapterId = previousChapter?.id ?? null;
	// Chapters committed by the reviewed runner get their index and arc consumers here.
	await timePhase(recorder, 'job.summarize_chapter.reviewed_follow_ups', {}, () => ensureReviewedChapterFollowUps(job.storyId));
	const latest = await latestChapterWindowAttempt(db, job.storyId, number);
	if (latest && chapterWindowIsOpen(latest) && latest.policy === 'reviewed') {
		return { created: false, reason: 'window_owned_by_reviewed_runner', windowId: latest.windowId, revision: latest.revision, state: latest.state };
	}
	let attempt: ChapterWindowAttempt | null = chapterWindowIsOpen(latest) ? latest : null;
	let chapterEntries: StoryEntryRow[] = [];
	const invalidations: Array<Record<string, unknown>> = [];
	if (attempt && attempt.afterChapterId !== afterChapterId) {
		await invalidateChapterWindow(db, attempt, { reason: 'boundary_changed', detail: `Frozen after ${attempt.afterChapterId ?? 'the story start'}; the boundary is now ${afterChapterId ?? 'the story start'}.` });
		invalidations.push({ revision: attempt.revision, reason: 'boundary_changed' });
		attempt = null;
	}
	if (attempt) {
		// A frozen window keeps its exact sources; new turns never change it. Only an
		// edit to those sources (or to an ignored row in its range) produces a new revision.
		const frozen = attempt;
		const current = await timePhase(recorder, 'job.summarize_chapter.load_window', { revision: frozen.revision }, () => loadChapterWindowRows<StoryEntryRow>(db, frozen));
		const changedEntryIds = changedChapterWindowRows(chapterWindowFrozenRows(frozen), current.sourceRows);
		if (changedEntryIds.length) {
			await invalidateChapterWindow(db, frozen, { reason: 'source_changed', changedEntryIds });
			invalidations.push({ revision: frozen.revision, reason: 'source_changed', changedEntryIds });
			attempt = null;
		} else chapterEntries = current.sources;
	}
	if (!attempt) {
		const entries = await timePhase(recorder, 'job.summarize_chapter.load_entries', { endPosition }, () => loadEntriesAfter(job.storyId, endPosition, threshold * 2));
		const window = selectNextChapterWindow(entries);
		if (!window) {
			return { created: false, reason: 'chapter_threshold_not_met', completedTurns: selectCompletedChapterTurns(entries).length, threshold, buffer,
				...(invalidations.length ? { invalidations } : {}) };
		}
		const rangeRows = entries.filter(entry => entry.position > endPosition && entry.position <= window.endPosition);
		const frozen = await timePhase(recorder, 'job.summarize_chapter.freeze_window', { entries: window.entries.length }, () => freezeChapterWindow(db, {
			storyId: job.storyId, number, policy: 'live', afterChapterId, rangeAfter: endPosition,
			startPosition: window.startPosition, endPosition: window.endPosition,
			sourceEntryIds: window.entries.map(entry => entry.id), sourceRows: chapterWindowSourceRows(window.entries, rangeRows),
			compiler: CHAPTER_PROJECTION_COMPILER, summarizerRevision: CHAPTER_SUMMARIZER_REVISION,
			expectedRevision: latest?.revision ?? 0, reference: { jobId: job.id },
		}));
		// A concurrent job froze this slot first; it owns the window.
		if (!frozen.frozen || !frozen.attempt) {
			return { created: false, reason: 'window_generating', windowNumber: number,
				...(frozen.attempt ? { windowId: frozen.attempt.windowId, revision: frozen.attempt.revision } : {}) };
		}
		attempt = frozen.attempt;
		chapterEntries = window.entries;
	}
	const windowRef = { windowId: attempt.windowId, revision: attempt.revision };
	if (chapterWindowLeaseActive(attempt, job.id)) return { created: false, reason: 'window_generating', ...windowRef, ownerJobId: attempt.ownerJobId };
	if (attempt.state === 'uncertain_dispatch') return { created: false, reason: 'window_needs_reconciliation', ...windowRef, failure: attempt.failure };
	const sourceEntryIds = chapterEntries.map((entry) => entry.id);

	let digest = attempt.state === 'validated' ? storedChapterDigest(attempt, chapterEntries) : null;
	if (attempt.state === 'validated' && !digest) {
		await invalidateChapterWindow(db, attempt, { reason: 'draft_invalid', detail: 'The validated draft no longer matches its hash or sources.' });
		return { created: false, reason: 'window_draft_invalid', ...windowRef };
	}
	if (!digest) {
		// Classifier work on these turns finishes first (bounded). Failed, missing or outdated
		// extraction never consumes or blocks the window; it is recorded with the chapter.
		const extraction = await timePhase(recorder, 'job.summarize_chapter.extraction_status', {}, () => chapterWindowExtraction(db, job.storyId, chapterEntries));
		const waits = asNumber(attempt.extraction.waits, 0);
		if (extraction.pendingEntryIds.length && waits < CHAPTER_WINDOW_EXTRACTION_WAITS) {
			await transitionChapterWindow(db, attempt, 'waiting', { extraction: { ...extraction, waits: waits + 1 } });
			await enqueueChapterSummaryJob({ storyId: job.storyId, serverVersion: asNumber(asRecord(job.payload).serverVersion, 0),
				dedupeKey: `${attempt.windowId}-r${attempt.revision}-wait-${waits + 1}`,
				runAfter: new Date(Date.now() + CHAPTER_WINDOW_EXTRACTION_WAIT_MS).toISOString() });
			return { created: false, reason: 'extraction_pending', ...windowRef, pendingEntryIds: extraction.pendingEntryIds };
		}
		const extractionRecord = { ...extraction, waits, ...(extraction.pendingEntryIds.length ? { proceededWithPending: true } : {}) };
		// The exact summarizer request is frozen on first claim; a retry or restart repeats it,
		// so a checkpointed provider result is reused instead of bought again.
		const inputs = attempt.inputs ? null : await timePhase(recorder, 'job.summarize_chapter.freeze_inputs', { entries: chapterEntries.length }, async () => {
			const [events, existingThreads, [campaignStory]] = await Promise.all([
				loadEventsForEntries(job.storyId, sourceEntryIds),
				db.select().from(storyThreads).where(eq(storyThreads.storyId, job.storyId))
					.orderBy(sql`case when ${storyThreads.status} = 'closed' then 1 else 0 end`, desc(storyThreads.updatedAt)).limit(200),
				db.select({ metadata: stories.metadata }).from(stories).where(eq(stories.id, job.storyId)).limit(1),
			]);
			return chapterMemoryInput(chapterEntries, events, existingThreads, readCampaignState(campaignStory?.metadata));
		});
		const claimed = await claimChapterWindowGeneration(db, attempt, job.id, inputs as unknown as Record<string, unknown> | null, { extraction: extractionRecord });
		if (!claimed) return { created: false, reason: 'window_generating', ...windowRef };
		attempt = claimed;
		try {
			digest = await timePhase(recorder, 'job.summarize_chapter.llm_memory_digest', { entries: chapterEntries.length },
				() => summarizeChapterMemoryFromInput(claimed.inputs as unknown as MemoryInput, chapterEntries));
		} catch (error) {
			const outcome = chapterWindowFailure(error);
			await transitionChapterWindow(db, claimed, outcome.state, { failure: outcome.failure, ownerJobId: null, leaseUntil: null }, ['generating'])
				.catch(stateError => console.warn('[jobs] chapter window failure state could not be saved:', stateError));
			throw error;
		}
		const validated = await transitionChapterWindow(db, claimed, 'validated', { draft: digest as unknown as Record<string, unknown>,
			draftHash: chapterWindowDraftHash(digest), ownerJobId: null, leaseUntil: null }, ['generating']);
		if (!validated) return { created: false, reason: 'window_superseded', ...windowRef };
		attempt = validated;
	}
	const committedAttempt = attempt;
	const { title, summary } = digest;
	const canonicalCharacters = await timePhase(recorder, 'job.summarize_chapter.resolve_character_tags', {
		keyCharacters: digest.keyCharacters.length,
	}, () => db.select().from(entities).where(and(
		eq(entities.storyId, job.storyId),
		eq(entities.type, 'character'),
	)));
	const entityIds = chapterMemoryEntityIds({
		eventEntityIds: [],
		keyCharacters: digest.keyCharacters,
		canonicalCharacters,
	});
	const first = chapterEntries[0];
	const last = chapterEntries[chapterEntries.length - 1];
	const chapterId = stableId('chapter', [first.id, last.id]);
	const branchIds = uniqueStrings(chapterEntries.map(entry => entry.branchId ?? 'primary'));
	const memoryNodeId = `mem_chapter_${chapterId}`;
	const savedDigest = digest;

	let changedBeforeCommit: string[] = [];
	let committed: { chapter: ChapterRow; serverVersion: number; followUps: Record<string, string>; eventCount: number } | null = null;
	await timePhase(recorder, 'job.summarize_chapter.persist_projection', {}, () => db.transaction(async (tx) => {
		await tx.select({ id: stories.id }).from(stories).where(eq(stories.id, job.storyId)).for('update');
		const [boundary] = await tx.select({ id: chapters.id }).from(chapters).where(eq(chapters.storyId, job.storyId)).orderBy(desc(chapters.number)).limit(1);
		if ((boundary?.id ?? null) !== afterChapterId) return;
		// A checkpoint is derived evidence: hold the frozen transcript rows until the
		// canonical commit, including when a prior attempt supplied the validated draft.
		const current = await loadChapterWindowRows<StoryEntryRow>(tx, committedAttempt, true);
		changedBeforeCommit = changedChapterWindowRows(chapterWindowFrozenRows(committedAttempt), current.sourceRows);
		if (changedBeforeCommit.length) return;
		// Extracted events are evidence attached at commit. A late extraction joins the
		// chapter instead of discarding its transcript summary.
		const events = await loadEventsForEntries(job.storyId, sourceEntryIds, tx);
		const sourceEventIds = events.map((event) => event.id);
		const existingThreads = await tx.select().from(storyThreads).where(eq(storyThreads.storyId, job.storyId))
			.orderBy(sql`case when ${storyThreads.status} = 'closed' then 1 else 0 end`, desc(storyThreads.updatedAt)).limit(200);
		const now = nowIso();
		const sourceFingerprint = projectionFingerprint({
			compiler: CHAPTER_PROJECTION_COMPILER,
			campaignId: job.storyId,
			sourceStart: first.position,
			sourceEnd: last.position,
			branchIds,
			pov: 'primary',
			entries: current.sources.map(entry => ({ id: entry.id, position: entry.position, content: entry.content })),
			events: events.map(event => ({ id: event.id, status: event.status, title: event.title, body: event.body, sourceEntryIds: event.sourceEntryIds })),
		});
		// The revision is allocated inside the commit, so a superseded attempt consumes none.
		const [version] = await tx.update(stories).set({ serverVersion: sql`${stories.serverVersion} + 1`, updatedAt: now })
			.where(eq(stories.id, job.storyId)).returning({ serverVersion: stories.serverVersion });
		const serverVersion = version?.serverVersion ?? 1;
		const followUpJobIds = Object.fromEntries(chapterFollowUpKinds
			.filter(kind => kind !== 'factionPressure' || sourceEventIds.length > 0)
			.map(kind => [kind, chapterFollowUpJobId(job.storyId, chapterId, serverVersion, kind)]));
		const threadPlan = buildChapterThreadPlan({
			storyId: job.storyId,
			chapterId,
			existingThreads,
			events: events.map((event) => ({ id: event.id, threadIds: asStringArray(event.threadIds) })),
			directives: {
				threadChanges: savedDigest.threadChanges ?? [],
				newThreads: savedDigest.newThreads ?? [],
			},
			sourceEntryIds,
			serverVersion,
			now,
		});
		const chapterMetadata = {
			sourceType: 'terminal_chapter_job',
			jobId: job.id,
			projectionCompiler: CHAPTER_PROJECTION_COMPILER,
			projectionFingerprint: sourceFingerprint,
			campaignId: job.storyId,
			summarySource: savedDigest.source,
			sourceAccounts: savedDigest.sourceAccounts,
			turnCount: CHAPTER_TURN_COUNT,
			summaryModel: savedDigest.model ?? null,
			entryCount: chapterEntries.length,
			startPosition: first.position,
			endPosition: last.position,
			branchIds,
			pov: 'primary',
			threshold,
			postChapterBuffer: buffer,
			trackedEntityIds: entityIds,
			legacyKeywords: savedDigest.keywords,
			legacyCharacters: savedDigest.keyCharacters,
			legacyLocations: savedDigest.keyLocations,
			emotionalTone: savedDigest.emotionalTone,
			...chapterThreadMetadata(threadPlan.openThreadIds),
			// Written once with the chapter. Consumers report on their own job rows, so this
			// row (and the arc revalidation that compares it) never changes after commit.
			completion: { state: 'committed', committedAt: now, jobId: job.id, memoryNodeId, followUpJobIds,
				window: { id: committedAttempt.windowId, revision: committedAttempt.revision, policy: committedAttempt.policy,
					sourceFingerprint: committedAttempt.sourceFingerprint, summarizerRevision: committedAttempt.summarizerRevision },
				extraction: committedAttempt.extraction },
		};
		const [savedChapter] = await tx.insert(chapters).values({
			id: chapterId,
			storyId: job.storyId,
			number,
			title,
			sceneOutcome: summary,
			irreversibleChanges: [],
			npcKnowledgeChanges: [],
			// Factual changes live in the complete transcript-derived account; extracted event titles are not history.
			promisesDebtsOaths: [],
			discoveredClues: [],
			relationshipChanges: [],
			factionChanges: [],
			openThreads: savedDigest.plotThreads,
			sourceEntryIds,
			sourceEventIds,
			metadata: chapterMetadata,
			serverVersion,
			createdAt: now,
			updatedAt: now,
		}).onConflictDoNothing().returning();
		// Roll back the version allocation when a competing job already saved this chapter.
		if (!savedChapter) throw new ChapterCommitSuperseded();
		if (savedDigest.campaignFactReview?.length) {
			const [currentStory] = await tx.select({ metadata: stories.metadata }).from(stories).where(eq(stories.id, job.storyId));
			const metadata = asRecord(currentStory?.metadata);
			const before = readCampaignState(metadata);
			const review = applyChapterCampaignFactReview(before, savedDigest.campaignFactReview, current.sources);
			if (review.accepted.length) {
				const history = Array.isArray(metadata.campaignStateReviewHistory) ? metadata.campaignStateReviewHistory : [];
				await tx.update(stories).set({ metadata: { ...metadata, campaignState: review.facts,
					campaignStateReviewHistory: [...history, { chapterId, accepted: review.accepted, warnings: review.warnings,
						before: before.filter(fact => review.accepted.some(action => action.key === fact.key)), reviewedAt: now }].slice(-100) },
					updatedAt: now }).where(eq(stories.id, job.storyId));
			}
		}
		await upsertChapterMemoryNode({
			db: tx,
			storyId: job.storyId,
			chapterId,
			title,
			summary,
			keywords: savedDigest.keywords,
			entityIds,
			sourceEntryIds,
			sourceEventIds,
			threadIds: threadPlan.openThreadIds,
			serverVersion,
			now,
			jobId: job.id,
			sourceFingerprint,
			sourceStart: first.position,
			sourceEnd: last.position,
			branchIds,
		});
		// Every consumer is durable before the chapter counts as complete: a later
		// thread, character, faction or index failure is retried on its own row.
		const followUps = await enqueueChapterFollowUpJobs({
			storyId: job.storyId,
			chapterId,
			chapterNumber: number,
			chapterServerVersion: serverVersion,
			projectionFingerprint: sourceFingerprint,
			sourceJobId: job.id,
			sourceEventIds,
			memoryNodeId,
			threadPlan,
		}, tx);
		if (JSON.stringify(followUps) !== JSON.stringify(followUpJobIds)) throw new Error('Chapter follow-up identities changed during commit.');
		// The window and its chapter commit together; a window that left `validated` cannot publish.
		if (!await markChapterWindowCommitted(tx, committedAttempt, chapterId, now)) throw new ChapterCommitSuperseded();
		committed = { chapter: savedChapter, serverVersion, followUps, eventCount: events.length };
	}).catch(error => { if (!(error instanceof ChapterCommitSuperseded)) throw error; }));
	if (changedBeforeCommit.length) {
		await invalidateChapterWindow(db, committedAttempt, { reason: 'source_changed', changedEntryIds: changedBeforeCommit });
		return { created: false, reason: 'projection_sources_changed', ...windowRef, changedEntryIds: changedBeforeCommit, entryCount: chapterEntries.length };
	}
	const saved = committed as { chapter: ChapterRow; serverVersion: number; followUps: Record<string, string>; eventCount: number } | null;
	if (!saved) return { created: false, reason: 'projection_superseded', chapterId, ...windowRef };
	return {
		created: true,
		chapterId: saved.chapter.id,
		number: saved.chapter.number,
		serverVersion: saved.serverVersion,
		entryCount: chapterEntries.length,
		eventCount: saved.eventCount,
		completion: 'committed',
		followUpJobIds: saved.followUps,
		window: windowRef,
		...(invalidations.length ? { invalidations } : {}),
	};
}

/** A validated draft is reused only when it is intact and still covers the frozen turns. */
function storedChapterDigest(attempt: ChapterWindowAttempt, entries: StoryEntryRow[]): ChapterMemoryDigest | null {
	const draft = attempt.draft as unknown as ChapterMemoryDigest | null;
	if (!draft || !attempt.draftHash || chapterWindowDraftHash(draft) !== attempt.draftHash) return null;
	if (typeof draft.title !== 'string' || typeof draft.summary !== 'string' || !Array.isArray(draft.keywords) || !Array.isArray(draft.keyCharacters)) return null;
	const narrationIds = selectCompletedChapterTurns(entries).map(turn => turn.narration.id);
	const accountIds = (draft.sourceAccounts ?? []).map(account => account.sourceId);
	return JSON.stringify(accountIds) === JSON.stringify(narrationIds) ? draft : null;
}

/** Thrown only to roll back a commit that lost the chapter-identity race. */
class ChapterCommitSuperseded extends Error {}

type ChapterFollowUpTarget = { ok: true; chapter: ChapterRow; payload: Record<string, unknown> }
	| { ok: false; result: Record<string, unknown> };

/** A follow-up applies only to the exact chapter revision that enqueued it. */
async function loadChapterFollowUpTarget(job: BackendJobRow): Promise<ChapterFollowUpTarget> {
	const payload = asRecord(job.payload);
	const chapterId = requirePayloadString(payload, 'chapterId');
	const [chapter] = await getDb().select().from(chapters).where(and(eq(chapters.storyId, job.storyId), eq(chapters.id, chapterId))).limit(1);
	if (!chapter) return { ok: false, result: { applied: false, reason: 'chapter_missing', chapterId } };
	const fingerprint = asRecord(chapter.metadata).projectionFingerprint;
	if (chapter.serverVersion !== asNumber(payload.chapterServerVersion, -1) || fingerprint !== payload.projectionFingerprint) {
		return { ok: false, result: { applied: false, reason: 'chapter_revision_changed', chapterId, chapterServerVersion: chapter.serverVersion } };
	}
	return { ok: true, chapter, payload };
}

async function loadChapterSourceEvents(storyId: string, eventIds: string[]): Promise<StoryEventRow[]> {
	if (eventIds.length === 0) return [];
	const rows = await getDb().select().from(storyEvents).where(and(eq(storyEvents.storyId, storyId), inArray(storyEvents.id, eventIds)));
	return rows.filter(isNarrativeChapterEvent).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function chapterThreadPlanFromPayload(value: unknown): ChapterThreadPlan {
	const plan = asRecord(value);
	if (!Array.isArray(plan.updates) || !Array.isArray(plan.inserts) || !Array.isArray(plan.eventUpdates)) {
		throw Object.assign(new Error('Chapter thread follow-up has no valid saved plan.'), { retryable: false });
	}
	return { updates: plan.updates, inserts: plan.inserts, eventUpdates: plan.eventUpdates, openThreadIds: asStringArray(plan.openThreadIds) } as ChapterThreadPlan;
}

/** Applies the thread plan saved with the chapter, then queues Director review in the same transaction. */
export async function applyChapterThreadFollowUp(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const receipt = asRecord(asRecord(job.metadata).chapterThreadsReceipt);
	if (typeof receipt.appliedAt === 'string') return { ...receipt, reused: true };
	const target = await loadChapterFollowUpTarget(job);
	if (!target.ok) return target.result;
	const { chapter, payload } = target;
	const plan = chapterThreadPlanFromPayload(payload.threadPlan);
	const now = nowIso();
	const result = await timePhase(recorder, 'job.chapter_threads.reconcile_threads', {
		updates: plan.updates.length,
		inserts: plan.inserts.length,
		openThreads: plan.openThreadIds.length,
	}, () => persistChapterThreadPlan({
		storyId: job.storyId,
		chapterId: chapter.id,
		chapterNumber: chapter.number,
		plan,
		serverVersion: chapter.serverVersion,
		now,
		afterApply: async (tx, applied) => {
			const plotBrainJobId = await enqueuePlotBrainJob({
				storyId: job.storyId, trigger: 'scheduled_refresh', scopeId: chapter.id, skipIfPlanned: true,
			}, tx);
			const result = { applied: true, chapterId: chapter.id, chapterNumber: chapter.number, ...applied, plotBrainJobId: plotBrainJobId || null, appliedAt: now };
			// The receipt commits with the thread writes; a retry after an unrecorded
			// completion returns it instead of re-flagging the Director.
			await tx.update(backendJobs).set({ metadata: sql`${backendJobs.metadata} || ${JSON.stringify({ chapterThreadsReceipt: result })}::jsonb` })
				.where(eq(backendJobs.id, job.id));
			return result;
		},
	}));
	return result ? { ...result } : { applied: false, reason: 'story_missing', chapterId: chapter.id };
}

/** Character continuity maintenance for one committed chapter. Proposal IDs are stable and
 * applications act only on pending proposals, so a retry does not duplicate either. */
export async function applyChapterCharacterFollowUp(job: BackendJobRow, recorder?: TimingRecorder): Promise<Record<string, unknown>> {
	const target = await loadChapterFollowUpTarget(job);
	if (!target.ok) return target.result;
	const { chapter } = target;
	const now = nowIso();
	const sourceEntryIds = asStringArray(chapter.sourceEntryIds);
	const events = await loadChapterSourceEvents(job.storyId, asStringArray(chapter.sourceEventIds));
	const digest = storedChapterMemoryDigest(chapter);
	const characterReferences = await timePhase(recorder, 'job.chapter_characters.character_references', {
		keyCharacters: digest.keyCharacters.length,
	}, () => createChapterCharacterReferenceProposals({
		storyId: job.storyId, chapter, digest, events, sourceEntryIds, serverVersion: chapter.serverVersion, now,
	}));
	const [previousChapter] = chapter.number > 1 && shouldAutoApplyChapterCharacterContext(chapter.number)
		? await getDb().select().from(chapters).where(and(eq(chapters.storyId, job.storyId), eq(chapters.number, chapter.number - 1))).limit(1)
		: [];
	const previousCharacterContextUpdates = previousChapter
		? await timePhase(recorder, 'job.chapter_characters.previous_character_context_updates', {
			chapterNumber: previousChapter.number,
		}, async () => createChapterCharacterContextUpdateProposals({
			storyId: job.storyId,
			chapter: previousChapter,
			digest: storedChapterMemoryDigest(previousChapter),
			events: await loadEventsForEntries(job.storyId, asStringArray(previousChapter.sourceEntryIds)),
			sourceEntryIds: asStringArray(previousChapter.sourceEntryIds),
			serverVersion: chapter.serverVersion,
			now,
		}))
		: { candidates: 0, created: 0, updated: 0, skipped: 0, deferred: true };
	const characterContextUpdates = await timePhase(recorder, 'job.chapter_characters.character_context_updates', {
		events: events.length,
	}, () => createChapterCharacterContextUpdateProposals({
		storyId: job.storyId, chapter, digest, events, sourceEntryIds, serverVersion: chapter.serverVersion, now,
	}));
	const automaticCharacterContextUpdates = await timePhase(recorder, 'job.chapter_characters.auto_apply_character_context', {
		chapterNumber: chapter.number,
		cadence: CHARACTER_CONTEXT_AUTO_APPLY_CHAPTER_INTERVAL,
	}, () => autoApplyChapterCharacterContextUpdates({ storyId: job.storyId, chapterNumber: chapter.number }));
	return {
		applied: true,
		chapterId: chapter.id,
		chapterNumber: chapter.number,
		characterReferences,
		previousCharacterContextUpdates,
		characterContextUpdates,
		automaticCharacterContextUpdates,
	};
}
