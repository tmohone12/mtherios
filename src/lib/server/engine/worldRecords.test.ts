import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listWorldRecords, patchWorldRecord } from './worldRecords';

const dbMocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	bumpStoryVersion: vi.fn(),
	enqueueBackendJob: vi.fn(),
	enqueueStoryVaultSyncJob: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: dbMocks.getDb,
}));

vi.mock('$lib/server/memory/canonical', () => ({
	bumpStoryVersion: dbMocks.bumpStoryVersion,
}));

vi.mock('$lib/server/jobs/outbox', () => ({
	enqueueBackendJob: dbMocks.enqueueBackendJob,
	enqueueStoryVaultSyncJob: dbMocks.enqueueStoryVaultSyncJob,
}));

beforeEach(() => {
	vi.clearAllMocks();
	dbMocks.bumpStoryVersion.mockResolvedValue(12);
	dbMocks.enqueueBackendJob.mockResolvedValue('job_index');
	dbMocks.enqueueStoryVaultSyncJob.mockResolvedValue('job_vault');
});

describe('patchWorldRecord', () => {
	it('keeps review listings focused on actionable patch proposals', async () => {
		const execute = vi.fn().mockResolvedValue([]);
		dbMocks.getDb.mockReturnValue({ execute });

		await listWorldRecords('story_alpha', { type: 'patchProposals' });

		const query = JSON.stringify(execute.mock.calls[0][0]);
		expect(query).toContain("in ('pending', 'needs_review')");
		expect(query).toContain('character_context_update');
		expect(query).not.toContain('turn_summary');
	});

	it('queues vault sync and canonical indexing after manual character edits', async () => {
		const inserts: unknown[] = [];
		const execute = vi.fn()
			.mockResolvedValueOnce([{
				id: 'npc_mira',
				story_id: 'story_alpha',
				type: 'character',
				name: 'Mira',
			}])
			.mockResolvedValueOnce([{
				id: 'npc_mira',
				story_id: 'story_alpha',
				type: 'character',
				name: 'Mira',
				state: { currentAction: 'Guarding the quay.' },
			}]);
		dbMocks.getDb.mockReturnValue({
			execute,
			insert: (table: unknown) => ({
				values: async (value: unknown) => {
					inserts.push({ table, value });
				},
			}),
		});

		const result = await patchWorldRecord('characters', 'npc_mira', {
			updates: { state: { currentAction: 'Guarding the quay.' } },
			reason: 'Manual explorer edit.',
		});

		expect(result).toMatchObject({
			storyId: 'story_alpha',
			type: 'characters',
			record: {
				id: 'npc_mira',
				state: { currentAction: 'Guarding the quay.' },
			},
			serverVersion: 12,
		});
		expect(inserts.length).toBe(4);
		expect(dbMocks.enqueueStoryVaultSyncJob).toHaveBeenCalledWith({
			storyId: 'story_alpha',
			serverVersion: 12,
			reason: 'manual-record-edit',
			payload: { recordType: 'characters', recordId: 'npc_mira' },
		});
		expect(dbMocks.enqueueBackendJob).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_alpha',
			type: 'index_canonical_records',
			dedupeKey: 'manual-record-edit-index-story_alpha-characters-npc_mira',
			payload: {
				recordTypes: ['entities'],
				recordId: 'npc_mira',
				reason: 'manual_record_edit',
			},
		}));
	});
});
