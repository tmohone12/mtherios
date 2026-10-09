import { describe, expect, it } from 'vitest';
import { deriveMemoryCoverage, findMemoryCoverageGaps, type MemoryCoverageEntry, type MemoryCoverageJob } from './memoryCoverage';

function entry(id: string, type: string, position: number, content: string, parentId: string | null = null): MemoryCoverageEntry {
	return { id, type, position, content, parentId, metadata: {} };
}

function job(assistantEntryId: string, playerText: string, narration: string, status: string, createdAt: string): MemoryCoverageJob {
	return { status, createdAt, updatedAt: createdAt, lastError: null, payload: { assistantEntryId, playerText, narration } };
}

describe('deriveMemoryCoverage', () => {
	it('reports missing sources and keeps later successes from hiding the first gap', () => {
		const entries = [
			entry('player_1', 'user_action', 1, 'I open the gate.'),
			entry('assistant_1', 'narration', 2, 'The gate groans open.', 'player_1'),
			entry('player_2', 'user_action', 3, 'I step inside.'),
			entry('assistant_2', 'narration', 4, 'Dust rises around your boots.', 'player_2'),
		];
		const coverage = deriveMemoryCoverage(entries, [job('assistant_1', 'I open the gate.', 'The gate groans open.', 'complete', '2026-09-06T00:00:00Z')]);

		expect(coverage).toMatchObject({
			status: 'attention',
			eligibleSources: 2,
			completeSources: 1,
			missingSources: 1,
			lastContiguousPosition: 2,
			oldestUnresolvedPosition: 4,
			oldestUnresolvedReason: 'missing',
			recentUnresolvedSources: 1,
		});
	});

	it('reopens coverage when a completed job no longer matches edited source text', () => {
		const entries = [
			entry('player_1', 'user_action', 1, 'I open the gate.'),
			entry('assistant_1', 'narration', 2, 'The gate groans open.', 'player_1'),
		];
		const coverage = deriveMemoryCoverage(entries, [job('assistant_1', 'I open the gate.', 'The gate is sealed.', 'complete', '2026-09-06T00:00:00Z')]);

		expect(coverage).toMatchObject({ status: 'attention', outdatedSources: 1, oldestUnresolvedReason: 'outdated' });
	});

	it('distinguishes queued processing from unresolved attention', () => {
		const entries = [
			entry('player_1', 'user_action', 1, 'I wait.'),
			entry('assistant_1', 'narration', 2, 'The bells ring.', 'player_1'),
		];
		const coverage = deriveMemoryCoverage(entries, [job('assistant_1', 'I wait.', 'The bells ring.', 'retry', '2026-09-06T00:00:00Z')]);

		expect(coverage).toMatchObject({ status: 'updating', waitingSources: 1, failedSources: 0, missingSources: 0 });
	});

	it('returns only missing sources as safe recovery candidates', () => {
		const entries = [
			entry('player_1', 'user_action', 1, 'I wait.'),
			entry('assistant_1', 'narration', 2, 'The bells ring.', 'player_1'),
			entry('player_2', 'user_action', 3, 'I listen.'),
			entry('assistant_2', 'narration', 4, 'The bell tower answers.', 'player_2'),
		];
		const gaps = findMemoryCoverageGaps(entries, [job('assistant_1', 'I wait.', 'The bells ring.', 'failed', '2026-09-06T00:00:00Z')]);

		expect(gaps.map((gap) => [gap.assistant.id, gap.reason])).toEqual([
			['assistant_1', 'failed'],
			['assistant_2', 'missing'],
		]);
	});

	it('treats a failed job with stale source text as recoverable', () => {
		const entries = [
			entry('player_1', 'user_action', 1, 'I wait.'),
			entry('assistant_1', 'narration', 2, 'The bells ring.', 'player_1'),
		];
		const gaps = findMemoryCoverageGaps(entries, [job('assistant_1', 'I wait.', 'The bells ring.<turn_memory_update>{}</turn_memory_update>', 'failed', '2026-09-06T00:00:00Z')]);
		expect(gaps.map(gap => gap.reason)).toEqual(['outdated']);
	});
});
