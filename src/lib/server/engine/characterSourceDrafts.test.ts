import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { entities, entityAliases, patchProposals, stories, storyEntries, storyEvents } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), resolve: vi.fn(), generate: vi.fn(), log: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('./llmSettings', () => ({ resolveServiceGeneration: mocks.resolve }));
vi.mock('./apiCallLogs', () => ({ recordApiCallLog: mocks.log }));
vi.mock('$lib/server/turn/provider', () => ({
	ServerGenerationError: class extends Error {},
	generateServerTextWithMetrics: mocks.generate,
	parseJsonFromGeneratedText: JSON.parse,
}));
import { draftCharacterFromCandidateSources, validatedCharacterSourceFacts } from './characterDrafts';

const quote = 'Mara served as the harbor pilot and guided the ship through the reef.';
const proposal = {
	id: 'candidate_mara', storyId: 'story_a', proposalType: 'character_reference_review', targetTable: 'entities',
	targetRecordId: 'unresolved_mara', proposedBy: 'chapter_scribe', status: 'pending', serverVersion: 7,
	operations: [{ op: 'review', path: '/entities/character', value: { storyId: 'story_a', type: 'character', name: 'Mara', description: 'Chapter-important character.', state: { type: 'character', firstSeenChapterNumber: 1 } } }],
	sourceEntryIds: ['entry_mara', 'entry_ooc', 'entry_reply'], sourceEventIds: ['event_secret', 'event_proposed'], metadata: { sourceName: 'Mara', chapterId: 'chapter_1' },
	updatedAt: '2026-09-05T21:00:00Z',
};

function database() {
	const state = {
		proposal: structuredClone(proposal),
		characters: [] as Array<{ id: string; name: string; storyId?: string; serverVersion?: number; state?: Record<string, unknown> }>,
		aliases: [] as Array<{ entityId: string; alias: string }>,
		entries: [
			{ id: 'entry_mara', storyId: 'story_a', type: 'narration', position: 1, content: quote, metadata: null, parentId: null },
			{ id: 'entry_ooc', storyId: 'story_a', type: 'user_action', position: 2, content: 'OOC: Give Mara red eyes.', metadata: { actionType: 'ooc' }, parentId: null },
			{ id: 'entry_reply', storyId: 'story_a', type: 'narration', position: 3, content: 'Mara has red eyes.', metadata: null, parentId: 'entry_ooc' },
		],
		events: [
			{ id: 'event_secret', storyId: 'story_a', status: 'committed', visibility: 'secret', title: 'Mara', body: 'Mara secretly serves the assassin.', metadata: {} },
			{ id: 'event_proposed', storyId: 'story_a', status: 'proposed', visibility: 'player_known', title: 'Mara', body: 'Mara will become queen.', metadata: {} },
		],
	};
	const writes: Array<{ table: unknown; value: Record<string, unknown> }> = [];
	const db = {
		select: () => {
			let table: unknown;
			let params: unknown[] = [];
			const read = () => {
				let rows: unknown[] = table === patchProposals ? [state.proposal] : table === entities ? state.characters : table === entityAliases ? state.aliases : table === storyEntries ? state.entries.filter((row) => params.includes(row.id)) : table === storyEvents ? state.events.filter((row) => params.includes(row.id)) : [];
				if (table === patchProposals && !params.includes(state.proposal.storyId)) rows = [];
				if (table === entities && params.some((value) => typeof value === 'string' && value.startsWith('npc_'))) rows = state.characters.filter((row) => params.includes(row.id));
				return structuredClone(rows);
			};
			const query = {
				from: (value: unknown) => { table = value; return query; },
				where: (value: SQL) => { params = new PgDialect().sqlToQuery(value).params; return query; },
				orderBy: () => query,
				limit: (limit: number) => Promise.resolve(read().slice(0, limit)),
				for: () => Promise.resolve(read()),
				then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(read()).then(resolve),
			};
			return query;
		},
		update: (table: unknown) => ({ set: (value: Record<string, unknown>) => ({ where: () => {
			writes.push({ table, value });
			if (table === patchProposals) Object.assign(state.proposal, value);
			return { returning: () => Promise.resolve([{ serverVersion: 8 }]) };
		} }) }),
		transaction: async (callback: (tx: unknown) => unknown): Promise<unknown> => callback(db),
	};
	mocks.getDb.mockReturnValue(db);
	return { state, writes };
}

function result(facts: unknown[] = [{ field: 'bio', value: quote, sourceId: 'entry_mara', quote }]) {
	return { text: JSON.stringify({ facts }), model: 'mock', endpoint: 'mock', durationMs: 1, promptChars: 120, responseChars: 120 };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolve.mockResolvedValue({ setting: null, profile: { id: 'mock', providerType: 'openrouter' }, generation: { model: 'mock', temperature: 0.2, maxTokens: 2200 }, systemPromptOverride: 'Configured character preferences.' });
	mocks.generate.mockResolvedValue(result());
	mocks.log.mockResolvedValue(null);
});

describe('story-sourced character candidates', () => {
	it('enriches the same pending candidate using only canonical named evidence, preserving provenance and review', async () => {
		mocks.resolve.mockResolvedValueOnce({ setting: null, profile: { id: 'mock', providerType: 'openrouter' }, generation: { model: 'mock', temperature: 0.2, maxTokens: 4096, reasoningEffort: 'high' }, systemPromptOverride: 'Configured character preferences.' });
		const { state, writes } = database();
		const response = await draftCharacterFromCandidateSources('story_a', { proposalId: proposal.id, expectedProposalVersion: 7 });
		expect(response).toMatchObject({ proposalId: proposal.id, status: 'pending', serverVersion: 8 });
		const request = mocks.generate.mock.calls[0][0];
		expect(request).toMatchObject({ maxTokens: 4096, reasoningEffort: 'off' });
		expect(request.system).toContain('Never invent');
		expect(request.prompt).toContain(quote);
		expect(request.prompt).not.toMatch(/red eyes|assassin|become queen/);
		expect(state.proposal.operations[0].value.state).toMatchObject({ firstSeenChapterNumber: 1, bio: quote });
		expect(state.proposal.metadata).toMatchObject({ sourceName: 'Mara', sourceDraft: { mode: 'evidence_only', evidence: [{ field: 'bio', sourceId: 'entry_mara', quote }] } });
		expect(state.proposal.status).toBe('pending');
		expect(writes.map((write) => write.table)).toEqual([stories, patchProposals]);
	});

	it('drops unsupported fields and returns sparse evidence instead of inventing defaults', async () => {
		const { writes } = database();
		expect(validatedCharacterSourceFacts({ facts: [
			{ field: 'bio', value: 'harbor pilot', sourceId: 'entry_mara', quote },
			{ field: 'appearance', value: 'Red eyes.', sourceId: 'entry_mara', quote: 'Mara has bright red eyes.' },
			{ field: 'personality', value: 'Fearless.', sourceId: 'missing_id', quote },
			{ field: 'knownFacts', value: 'Mara knows Veyra poisoned the envoy.', sourceId: 'entry_mara', quote },
			{ field: 'appearance', value: 'Mara has red eyes.', sourceId: 'entry_mara', quote },
		] }, [{ id: 'entry_mara', content: quote }])).toEqual([{ field: 'bio', value: 'harbor pilot', sourceId: 'entry_mara', quote }]);
		mocks.generate.mockResolvedValue(result([]));
		expect(await draftCharacterFromCandidateSources('story_a', { proposalId: proposal.id })).toMatchObject({ status: 'skipped' });
		expect(writes).toEqual([]);
	});

	it('targets an exact canonical alias beyond the former identity cap and preserves the current sheet for review', async () => {
		const { state, writes } = database();
		state.characters = Array.from({ length: 300 }, (_, index) => ({ id: `npc_${index}`, name: `Character ${index}`, serverVersion: 4, state: { appearance: 'A scar from an earlier voyage.' } }));
		state.aliases = [{ entityId: 'npc_299', alias: 'Mara' }];
		expect(await draftCharacterFromCandidateSources('story_a', { proposalId: proposal.id })).toMatchObject({ status: 'pending' });
		expect(state.proposal.metadata).toMatchObject({ sourceDraft: { targetEntityId: 'npc_299', targetServerVersion: 4, currentCharacter: { id: 'npc_299', state: { appearance: 'A scar from an earlier voyage.' } } } });
		expect(state.proposal.operations[0].value.state).toMatchObject({ appearance: 'A scar from an earlier voyage.', bio: expect.any(String) });
		expect(writes.map((write) => write.table)).toEqual([stories, patchProposals]);
	});

	it.each(['proposal', 'source'])('refuses a stale generated draft after the %s changes', async (changed) => {
		const { state, writes } = database();
		mocks.generate.mockImplementation(async () => {
			if (changed === 'proposal') { state.proposal.serverVersion = 9; state.proposal.operations[0].value.name = 'Mara Edited'; }
			else state.entries[0].content = 'Mara was never a pilot.';
			return result();
		});
		await expect(draftCharacterFromCandidateSources('story_a', { proposalId: proposal.id })).rejects.toThrow(/changed while the draft was running/);
		expect(writes).toEqual([]);
	});

	it('rejects cross-story, stale or closed candidates before generation', async () => {
		const { state } = database();
		await expect(draftCharacterFromCandidateSources('story_b', { proposalId: proposal.id })).rejects.toThrow(/missing/);
		await expect(draftCharacterFromCandidateSources('story_a', { proposalId: proposal.id, expectedProposalVersion: 6 })).rejects.toThrow(/changed/);
		state.proposal.status = 'rejected';
		await expect(draftCharacterFromCandidateSources('story_a', { proposalId: proposal.id })).rejects.toThrow(/no longer/);
		expect(mocks.generate).not.toHaveBeenCalled();
	});
});
