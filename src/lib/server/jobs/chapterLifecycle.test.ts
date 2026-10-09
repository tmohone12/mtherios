import { describe, expect, it, vi } from 'vitest';
import { arcs, backendJobs, chapters, memoryNodes, stories, storyEntries } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), generate: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('./summaryGeneration', async original => ({
	...await original<typeof import('./summaryGeneration')>(), generateChronologicalMemory: mocks.generate,
}));

import { createChapterCheckpoint, loadEntriesAfter, rollupArc, stableId } from './processor';
import { selectCompletedChapterTurns, selectNextChapterWindow } from '$lib/services/chapterCadence';

it('commits the tenth chapter and its arc job together before fallible thread work', async () => {
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
			if (++transactionCount === 2) throw new Error('Injected thread reconciliation failure');
			activeTransaction = transactionCount;
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
		update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ serverVersion: 2 }] }) }) }),
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
	await expect(createChapterCheckpoint(job)).rejects.toThrow('Injected thread reconciliation failure');

	expect(committed.map(write => write.table)).toEqual([chapters, memoryNodes, backendJobs]);
	expect(committed.every(write => write.transaction === 1)).toBe(true);
	expect(committed[0].value).toMatchObject({ number: 10 });
	expect(committed[2].value).toMatchObject({
		type: 'rollup_arc', status: 'queued', payload: { chapterId: committed[0].value.id },
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
