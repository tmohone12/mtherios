import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arcs, backendJobs, chapters, memoryNodes, stories, storyEntries } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), generate: vi.fn(), windows: [] as Array<Record<string, unknown>> }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('./summaryGeneration', async original => ({
	...await original<typeof import('./summaryGeneration')>(), generateChronologicalMemory: mocks.generate,
}));
// The window ledger is exercised against PostgreSQL in chapterWindows.integration.test.ts;
// here an in-memory ledger keeps these tests on the chapter tables.
vi.mock('./chapterWindows', async original => {
	const actual = await original<typeof import('./chapterWindows')>();
	type Attempt = import('./chapterWindows').ChapterWindowAttempt;
	const find = (ref: { windowId: string; revision: number }) => mocks.windows.find(row => row.windowId === ref.windowId && row.revision === ref.revision) as Attempt | undefined;
	const transition = async (_db: unknown, ref: { windowId: string; revision: number }, to: string, patch: Record<string, unknown> = {}, from?: readonly string[]) => {
		const row = find(ref);
		const allowed = from ?? actual.CHAPTER_WINDOW_STATES.filter(state => actual.CHAPTER_WINDOW_TRANSITIONS[state].includes(to as never));
		if (!row || !allowed.includes(row.state as never)) return null;
		Object.assign(row, patch, { state: to });
		return { ...row };
	};
	return {
		...actual,
		latestChapterWindowAttempt: async (_db: unknown, storyId: string, number: number) => {
			const rows = mocks.windows.filter(row => row.windowId === actual.chapterWindowId(storyId, number));
			return (rows.at(-1) as Attempt | undefined) ?? null;
		},
		freezeChapterWindow: async (_db: unknown, input: import('./chapterWindows').FreezeChapterWindowInput) => {
			const windowId = actual.chapterWindowId(input.storyId, input.number);
			const row = { windowId, revision: input.expectedRevision + 1, storyId: input.storyId, policy: input.policy, state: input.state ?? 'ready',
				afterChapterId: input.afterChapterId, startPosition: input.startPosition, endPosition: input.endPosition, sourceEntryIds: input.sourceEntryIds,
				sourceFingerprint: 'fixture', compiler: input.compiler, summarizerRevision: input.summarizerRevision, inputs: null, draft: null, draftHash: null,
				ownerJobId: null, leaseUntil: null, extraction: {}, failure: null, invalidation: null, reconciliations: [],
				reference: { rangeAfter: input.rangeAfter, sourceRows: input.sourceRows }, chapterId: null, committedAt: null };
			mocks.windows.push(row);
			return { frozen: true, attempt: { ...row } };
		},
		transitionChapterWindow: transition,
		invalidateChapterWindow: (db: unknown, ref: { windowId: string; revision: number }, invalidation: Record<string, unknown>) => transition(db, ref, 'invalidated', { invalidation }),
		claimChapterWindowGeneration: async (_db: unknown, ref: { windowId: string; revision: number }, ownerJobId: string, inputs: Record<string, unknown> | null, patch = {}) => {
			const row = find(ref);
			if (!row || !['waiting', 'ready', 'retryable_failure', 'needs_configuration'].includes(row.state)) return null;
			Object.assign(row, patch, { state: 'generating', ownerJobId, inputs: row.inputs ?? inputs });
			return { ...row };
		},
		markChapterWindowCommitted: (db: unknown, ref: { windowId: string; revision: number }, chapterId: string, committedAt: string) =>
			transition(db, ref, 'committed', { chapterId, committedAt }, ['validated']),
	};
});
beforeEach(() => { mocks.windows.length = 0; });

import { applyChapterCharacterFollowUp, applyChapterThreadFollowUp, createChapterCheckpoint, loadEntriesAfter, rollupArc, stableId } from './processor';
import { selectCompletedChapterTurns, selectNextChapterWindow } from '$lib/services/chapterCadence';

it('commits the tenth chapter, its memory, receipt and every follow-up job in one transaction', async () => {
	const entries = Array.from({ length: 20 }, (_, index) => [
		{ id: `player-${index}`, storyId: 'story', type: 'user_action', content: `I ask question ${index}.`, position: index * 2 + 1, parentId: null, metadata: {}, serverVersion: 1, branchId: null },
		{ id: `answer-${index}`, storyId: 'story', type: 'narration', content: `The envoy answers question ${index}.`, position: index * 2 + 2, parentId: `player-${index}`, metadata: {}, serverVersion: 1, branchId: null },
	]).flat();
	const records = new Map<unknown, unknown[]>([
		[storyEntries, entries],
		[stories, [{ id: 'story', serverVersion: 2 }]],
		[chapters, [{ id: 'chapter-9', number: 9, metadata: { endPosition: 0 }, sourceEntryIds: [] }]],
	]);
	const committed: Array<{ table: unknown; value: Record<string, unknown>; transaction: number }> = [];
	let pending: typeof committed = [];
	let transactionCount = 0;
	let activeTransaction = 0;
	const db = {
		transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
			activeTransaction = ++transactionCount;
			pending = [];
			try {
				const result = await callback(db);
				committed.push(...pending);
				return result;
			} finally { activeTransaction = 0; }
		},
		select: () => {
			let table: unknown;
			const query = {
				from: (value: unknown) => { table = value; return query; }, where: () => query,
				orderBy: () => query, limit: () => query, for: () => query,
				then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(records.get(table) ?? []).then(resolve),
			};
			return query;
		},
		update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ serverVersion: 3 }] }) }) }),
		insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
			pending.push({ table, value, transaction: activeTransaction });
			const result = { returning: async () => [value], then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([value]).then(resolve) };
			return { onConflictDoNothing: () => result, onConflictDoUpdate: () => result };
		} }),
	};
	mocks.getDb.mockReturnValue(db);
	mocks.generate.mockResolvedValue({
		title: 'Twenty answers', narrative: 'The twenty answers accumulate into a coherent chapter, with each reply changing the situation before the next question is asked.', accounts: entries.filter(entry => entry.type === 'narration').map(entry => ({ sourceId: entry.id, summary: entry.content })),
		characters: [], openThreads: [], locations: [], keywords: [], model: 'fixture',
	});
	const job = { id: 'summary-job', storyId: 'story', payload: {}, type: 'summarize_chapter' } as Parameters<typeof createChapterCheckpoint>[0];
	const result = await createChapterCheckpoint(job);

	// Thread, character, faction and index work is no longer inline: the job reports completion.
	expect(result).toMatchObject({ created: true, number: 10, serverVersion: 3, completion: 'committed' });
	expect(transactionCount).toBe(1);
	expect(committed.every(write => write.transaction === 1)).toBe(true);
	expect(committed.map(write => write.table)).toEqual([chapters, memoryNodes, backendJobs, backendJobs, backendJobs, backendJobs, backendJobs]);
	const chapter = committed[0].value;
	expect(chapter).toMatchObject({ number: 10, serverVersion: 3 });
	const jobs = committed.filter(write => write.table === backendJobs).map(write => write.value);
	// No source events: a campaign-wide faction scan would be unrelated to this chapter.
	expect(jobs.map(row => row.type)).toEqual(['rollup_arc', 'chapter_threads', 'chapter_characters', 'embed_memory_nodes', 'sync_story_vault']);
	expect(jobs[0]).toMatchObject({ status: 'queued', payload: { chapterId: chapter.id } });
	for (const row of jobs.slice(1)) {
		expect(row.payload).toMatchObject({ chapterId: chapter.id, chapterNumber: 10, chapterServerVersion: 3,
			projectionFingerprint: (chapter.metadata as Record<string, unknown>).projectionFingerprint });
	}
	expect(jobs[1].payload).toHaveProperty('threadPlan');
	expect(jobs[3].payload).toMatchObject({ memoryNodeIds: [`mem_chapter_${chapter.id}`] });
	expect((chapter.metadata as Record<string, unknown>).completion).toMatchObject({
		state: 'committed', jobId: 'summary-job', followUpJobIds: Object.fromEntries(
			['arcRollup', 'threads', 'characters', 'embedding', 'vault'].map((kind, index) => [kind, jobs[index].id])),
	});
	expect(result.followUpJobIds).toEqual((chapter.metadata as { completion: { followUpJobIds: unknown } }).completion.followUpJobIds);
	// The frozen window commits with the chapter and records its exact revision.
	expect(mocks.windows).toEqual([expect.objectContaining({ revision: 1, state: 'committed', chapterId: chapter.id, afterChapterId: 'chapter-9' })]);
	expect((chapter.metadata as { completion: { window: unknown } }).completion.window).toMatchObject({ revision: 1, policy: 'live' });
});

describe('chapter follow-up jobs', () => {
	const chapterRow = { id: 'chapter-10', storyId: 'story', number: 10, title: 'Ten', sceneOutcome: 'CHARACTER STATE\nEnvoy: answered.',
		serverVersion: 3, sourceEntryIds: ['answer-1'], sourceEventIds: [], openThreads: [], metadata: { projectionFingerprint: 'fp-10' } };
	const followUp = (type: string, payload: Record<string, unknown>, metadata: Record<string, unknown> = {}) =>
		({ id: `${type}-job`, storyId: 'story', type, payload, metadata }) as unknown as Parameters<typeof applyChapterThreadFollowUp>[0];

	function followUpDb(options: { failTransaction?: boolean; chapter?: Record<string, unknown> | null } = {}) {
		const writes: Array<{ table: unknown; values: Record<string, unknown> }> = [];
		const db = {
			transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
				if (options.failTransaction) throw new Error('Injected thread reconciliation failure');
				return callback(db);
			},
			select: () => {
				let table: unknown;
				const query = {
					from: (value: unknown) => { table = value; return query; }, where: () => query, orderBy: () => query, limit: () => query, for: () => query,
					then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(table === chapters ? (options.chapter === null ? [] : [options.chapter ?? chapterRow])
						: table === stories ? [{ id: 'story', metadata: {}, currentTurn: 4 }] : []).then(resolve),
				};
				return query;
			},
			update: (table: unknown) => ({ set: (values: Record<string, unknown>) => {
				writes.push({ table, values });
				const where = { returning: async () => [{ id: 'row' }], then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve) };
				return { where: () => where };
			} }),
			insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
				writes.push({ table, values });
				const result = { returning: async () => [values], then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([values]).then(resolve) };
				return { onConflictDoNothing: () => result, onConflictDoUpdate: () => result };
			} }),
		};
		mocks.getDb.mockReturnValue(db);
		return writes;
	}
	const plan = { updates: [], inserts: [], eventUpdates: [], openThreadIds: [] };

	it('fails only its own job when thread reconciliation fails, without touching the committed chapter', async () => {
		const writes = followUpDb({ failTransaction: true });
		await expect(applyChapterThreadFollowUp(followUp('chapter_threads', { chapterId: 'chapter-10', chapterServerVersion: 3, projectionFingerprint: 'fp-10', threadPlan: plan })))
			.rejects.toThrow('Injected thread reconciliation failure');
		expect(writes.some(write => write.table === chapters)).toBe(false);
	});

	it('commits the thread receipt and Director review with the thread writes, and reuses that receipt on retry', async () => {
		const writes = followUpDb();
		const job = followUp('chapter_threads', { chapterId: 'chapter-10', chapterServerVersion: 3, projectionFingerprint: 'fp-10', threadPlan: plan });
		const applied = await applyChapterThreadFollowUp(job);
		expect(applied).toMatchObject({ applied: true, chapterId: 'chapter-10' });
		const receipt = writes.find(write => write.table === backendJobs && 'metadata' in write.values);
		expect(receipt).toBeDefined();
		expect(writes.some(write => write.table === backendJobs && (write.values as { type?: string }).type === 'plan_plot_brain')).toBe(true);

		const retried = followUpDb();
		await expect(applyChapterThreadFollowUp(followUp('chapter_threads', job.payload as Record<string, unknown>, { chapterThreadsReceipt: applied })))
			.resolves.toMatchObject({ applied: true, reused: true });
		expect(retried).toHaveLength(0);
	});

	it.each([
		['a missing chapter', null, 'chapter_missing'],
		['a rebuilt chapter revision', { ...chapterRow, serverVersion: 9 }, 'chapter_revision_changed'],
	])('skips %s instead of applying stale chapter effects', async (_label, chapter, reason) => {
		const writes = followUpDb({ chapter });
		await expect(applyChapterCharacterFollowUp(followUp('chapter_characters', { chapterId: 'chapter-10', chapterServerVersion: 3, projectionFingerprint: 'fp-10' })))
			.resolves.toMatchObject({ applied: false, reason });
		expect(writes).toHaveLength(0);
	});
});

describe('chapter canonical commit guards', () => {
	it.each(['content', 'metadata', 'boundary'] as const)('does not commit stale generated evidence when %s changes after preflight', async change => {
		const entries = Array.from({ length: 20 }, (_, index) => [
			{ id: `guard-player-${index}`, storyId: 'story', type: 'user_action', content: `Question ${index}`, position: index * 2 + 1, parentId: null, metadata: {}, serverVersion: 1, branchId: null },
			{ id: `guard-answer-${index}`, storyId: 'story', type: 'narration', content: `Answer ${index}`, position: index * 2 + 2, parentId: `guard-player-${index}`, metadata: {}, serverVersion: 1, branchId: null },
		]).flat();
		let currentEntries = structuredClone(entries);
		let boundary = { id: 'chapter-9', number: 9, metadata: { endPosition: 0 }, sourceEntryIds: [] };
		let inTransaction = false;
		let lockedSources = false;
		const insert = vi.fn();
		const db = {
			transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
				inTransaction = true;
				if (change === 'boundary') boundary = { ...boundary, id: 'competing-chapter-10', number: 10 };
				else currentEntries = currentEntries.map((entry, index) => index === 1
					? change === 'content' ? { ...entry, content: 'Edited after preflight' } : { ...entry, metadata: { nonCanon: true } }
					: entry);
				try { return await callback(db); } finally { inTransaction = false; }
			},
			select: () => {
				let table: unknown;
				const query = {
					from: (value: unknown) => { table = value; return query; }, where: () => query, orderBy: () => query, limit: () => query,
					for: (mode: string) => { if (table === storyEntries) { expect(inTransaction).toBe(true); expect(mode).toBe('share'); lockedSources = true; } return query; },
					then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(table === storyEntries ? structuredClone(currentEntries)
						: table === stories ? [{ id: 'story', serverVersion: 2 }] : table === chapters ? [structuredClone(boundary)] : []).then(resolve),
				};
				return query;
			},
			update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ serverVersion: 2 }] }) }) }),
			insert,
		};
		mocks.getDb.mockReturnValue(db);
		mocks.generate.mockResolvedValue({ title: 'Generated checkpoint', narrative: 'A complete account of twenty completed turns.',
			accounts: entries.filter(entry => entry.type === 'narration').map(entry => ({ sourceId: entry.id, summary: entry.content })),
			characters: [], openThreads: [], locations: [], keywords: [], model: 'fixture' });
		const job = { id: 'guard-job', storyId: 'story', payload: {}, type: 'summarize_chapter' } as Parameters<typeof createChapterCheckpoint>[0];
		await expect(createChapterCheckpoint(job)).resolves.toMatchObject({ created: false,
			reason: change === 'boundary' ? 'projection_superseded' : 'projection_sources_changed' });
		expect(insert).not.toHaveBeenCalled();
		expect(lockedSources).toBe(change !== 'boundary');
	});
});

describe('chapter sources after an existing boundary', () => {
	it.each([true, false])('counts a late reply only if its earlier action is still uncovered (covered=%s)', async covered => {
		const oldAction = { id: 'old-action', type: 'user_action', content: 'I ask the envoy.', position: 2, parentId: null };
		const newEntries = Array.from({ length: 19 }, (_, index) => [
			{ id: `new-player-${index}`, type: 'user_action', content: `Question ${index}`, position: 41 + index * 2, parentId: null },
			{ id: `new-reply-${index}`, type: 'narration', content: `Answer ${index}`, position: 42 + index * 2, parentId: `new-player-${index}` },
		]).flat();
		newEntries.push({ id: 'late-reply', type: 'narration', content: 'The envoy finally answers.', position: 79, parentId: oldAction.id });
		mocks.getDb.mockReturnValue({ select: () => {
			let table: unknown;
			let paged = false;
			const query = {
				from: (value: unknown) => { table = value; return query; }, where: () => query,
				orderBy: () => query, limit: () => { paged = true; return query; },
				then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(table === chapters
					? covered ? [{ sourceEntryIds: [oldAction.id, 'first-reply'] }] : []
					: paged ? newEntries : [oldAction]).then(resolve),
			};
			return query;
		} });
		const sources = await loadEntriesAfter('story', 40, 40);
		expect(selectCompletedChapterTurns(sources)).toHaveLength(covered ? 19 : 20);
		if (covered) {
			expect(selectNextChapterWindow(sources)).toBeNull();
			expect(sources.map(entry => entry.id)).not.toContain(oldAction.id);
		} else {
			expect(selectNextChapterWindow(sources)?.entries.map(entry => entry.id)).toContain(oldAction.id);
		}
		expect(sources.map(entry => entry.id)).toContain('late-reply');
	});
});

it('refreshes arc coverage and numbers under the story lock after a competing job wins the first batch', async () => {
	const sourceChapters = Array.from({ length: 20 }, (_, index) => ({
		id: `chapter-${index + 1}`, storyId: 'story', number: index + 1, title: `Chapter ${index + 1}`,
		sceneOutcome: `Distinct events in chapter ${index + 1}.`, serverVersion: 1,
		sourceEntryIds: [`entry-${index + 1}`], sourceEventIds: [], openThreads: [],
		irreversibleChanges: [], npcKnowledgeChanges: [], promisesDebtsOaths: [], discoveredClues: [], relationshipChanges: [], factionChanges: [],
		metadata: { startPosition: index * 40, endPosition: (index + 1) * 40, projectionFingerprint: `source-${index + 1}` },
	}));
	const savedArcs: Array<{ id: string; number: number; chapterIds: string[] }> = [];
	const firstIds = sourceChapters.slice(0, 10).map(chapter => chapter.id);
	let activeSourceIds: string[] | null = null;
	let inTransaction = false;
	let storyLocked = false;
	let coverageReads = 0;
	const insertedArcs: Array<Record<string, unknown>> = [];
	const db = {
		transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
			inTransaction = true; storyLocked = false;
			try { return await callback(db); } finally { inTransaction = false; }
		},
		select: () => {
			let table: unknown;
			const query = {
				from: (value: unknown) => { table = value; return query; }, where: () => query,
				orderBy: () => query, limit: () => query,
				for: () => { if (table === stories) storyLocked = true; return query; },
				then: (resolve: (value: unknown[]) => unknown) => {
					if (table === arcs && inTransaction) { expect(storyLocked).toBe(true); coverageReads++; }
					const rows = table === chapters ? sourceChapters.filter(chapter => !activeSourceIds || activeSourceIds.includes(chapter.id))
						: table === arcs ? savedArcs : table === stories ? [{ id: 'story', serverVersion: 2 }] : [];
					return Promise.resolve(structuredClone(rows)).then(resolve);
				},
			};
			return query;
		},
		update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ serverVersion: 2 }] }) }) }),
		insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
			const conflict = table === arcs && savedArcs.some(arc => arc.id === value.id);
			if (table === arcs && !conflict) {
				expect(inTransaction && storyLocked).toBe(true);
				insertedArcs.push(value);
				savedArcs.push(value as { id: string; number: number; chapterIds: string[] });
			}
			const rows = conflict ? [] : [value];
			const result = { returning: async () => rows, then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
			return { onConflictDoNothing: () => result, onConflictDoUpdate: () => result };
		} }),
	};
	mocks.getDb.mockReturnValue(db);
	mocks.generate.mockImplementation(async ({ sources }: { sources: Array<{ id: string; text: string }> }) => {
		activeSourceIds = sources.map(source => source.id);
		if (savedArcs.length === 0) savedArcs.push({ id: stableId('arc', [firstIds[0], firstIds[9]]), number: 1, chapterIds: firstIds });
		return {
			title: 'Ten chapter progression', narrative: 'The ten chapters form one continuous progression, with each decision changing the pressure that follows.', model: 'fixture', accounts: sources.map(source => ({ sourceId: source.id, summary: source.text })),
			characters: [], openThreads: [], locations: [], keywords: [],
		};
	});
	const job = { id: 'arc-job', storyId: 'story', payload: {}, type: 'rollup_arc' } as Parameters<typeof rollupArc>[0];
	const result = await rollupArc(job, undefined, { enqueuePlotBrain: false });
	expect(result).toMatchObject({ created: true, arcCount: 1, number: 2 });
	expect(coverageReads).toBe(2);
	expect(insertedArcs).toHaveLength(1);
	expect(insertedArcs[0]).toMatchObject({ number: 2, chapterIds: sourceChapters.slice(10).map(chapter => chapter.id) });
	expect(savedArcs.map(arc => arc.number)).toEqual([1, 2]);
	expect(new Set(savedArcs.flatMap(arc => arc.chapterIds)).size).toBe(20);
});
