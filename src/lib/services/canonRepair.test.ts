import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addEntityAlias,
	createEntityThroughResolver,
	lintCanonWiki,
	mergeEntities,
	previewEntityResolution,
	readCanonPage,
	reviewPatchProposal,
	runContinuityAudit,
	searchCanonPages,
} from './canonRepair';

const fetchMock = vi.fn();

function engineResponse(command: string, result: unknown, status: 'succeeded' | 'failed' = 'succeeded'): Response {
	return new Response(JSON.stringify({
		commandId: `cmd_${command}`,
		clientCommandId: null,
		storyId: 'story_alpha',
		command,
		status,
		result,
		projectionChanges: {},
		error: status === 'failed' ? 'nope' : null,
		createdAt: '2026-06-09T00:00:00.000Z',
		updatedAt: '2026-06-09T00:00:00.000Z',
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

async function postedCommand(): Promise<Record<string, unknown>> {
	expect(fetchMock).toHaveBeenCalledWith('/api/engine/command', expect.objectContaining({
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
	}));
	const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
	return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('canon repair engine gateway client', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('routes wiki search, page reads, and lint through the shared engine command gateway', async () => {
		fetchMock
			.mockResolvedValueOnce(engineResponse('wiki.search', {
				query: 'Mira',
				results: [{ path: 'characters/mira.md', title: 'Mira' }],
			}))
			.mockResolvedValueOnce(engineResponse('wiki.page', {
				path: 'characters/mira.md',
				title: 'Mira',
				text: 'Mira is a courier.',
			}))
			.mockResolvedValueOnce(engineResponse('wiki.lint', {
				ok: true,
				summary: { brokenLinks: 0 },
			}));

		await searchCanonPages('story_alpha', 'Mira');
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'wiki.search',
			args: { storyId: 'story_alpha', q: 'Mira', limit: 12 },
		});

		await readCanonPage('story_alpha', 'characters/mira.md');
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'wiki.page',
			args: { storyId: 'story_alpha', page: 'characters/mira.md' },
		});

		await lintCanonWiki('story_alpha');
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'wiki.lint',
			args: { storyId: 'story_alpha' },
		});
	});

	it('routes resolver, merge, alias, review, create, and audit actions through the shared engine command gateway', async () => {
		fetchMock
			.mockResolvedValueOnce(engineResponse('entity.resolve', { resolution: { decision: 'update' } }))
			.mockResolvedValueOnce(engineResponse('entity.resolve', { resolution: { decision: 'create' } }))
			.mockResolvedValueOnce(engineResponse('entity.upsert', { entity: { id: 'entity_mira' }, serverVersion: 22 }))
			.mockResolvedValueOnce(engineResponse('entity.alias.add', { entityId: 'entity_mira', alias: 'Mira' }))
			.mockResolvedValueOnce(engineResponse('entity.merge', { keepEntityId: 'entity_keep', mergeEntityId: 'entity_dup' }))
			.mockResolvedValueOnce(engineResponse('patchProposal.review', { proposalId: 'proposal_1', status: 'approved' }))
			.mockResolvedValueOnce(engineResponse('continuity.audit', { summary: { openWarnings: 1 } }));

		await previewEntityResolution('story_alpha', { type: 'character', name: 'Mira' });
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'entity.resolve',
			args: {
				candidate: { type: 'character', name: 'Mira' },
				includeSemantic: true,
			},
		});

		const created = await createEntityThroughResolver('story_alpha', { type: 'character', name: 'Mira' });
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'entity.upsert',
			args: { entry: { type: 'character', name: 'Mira', description: null, aliases: [], sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [] } },
		});
		expect(created.operation).toBe('created');

		await addEntityAlias('story_alpha', 'entity_mira', 'Lady Mira');
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'entity.alias.add',
			args: {
				entityId: 'entity_mira',
				alias: 'Lady Mira',
				sourceEntryIds: [],
				sourceEventIds: [],
				sourcePatchIds: [],
			},
		});

		await mergeEntities('story_alpha', 'entity_keep', 'entity_dup');
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'entity.merge',
			args: {
				keepEntityId: 'entity_keep',
				mergeEntityId: 'entity_dup',
				reason: 'Manual entity merge.',
			},
		});

		await reviewPatchProposal('story_alpha', 'proposal_1', 'approved');
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'patchProposal.review',
			args: {
				proposalId: 'proposal_1',
				decision: 'approved',
				reviewer: 'human',
				notes: '',
			},
		});

		await runContinuityAudit('story_alpha');
		expect(await postedCommand()).toEqual({
			storyId: 'story_alpha',
			command: 'continuity.audit',
			args: { limit: 10 },
		});
	});
});
