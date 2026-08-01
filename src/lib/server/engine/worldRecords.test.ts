import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listWorldRecords, patchWorldRecord } from './worldRecords';

const dbMocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	enqueueBackendJob: vi.fn(),
	enqueueStoryVaultSyncJob: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: dbMocks.getDb,
}));

vi.mock('$lib/server/jobs/outbox', () => ({
	enqueueBackendJob: dbMocks.enqueueBackendJob,
	enqueueStoryVaultSyncJob: dbMocks.enqueueStoryVaultSyncJob,
}));

beforeEach(() => {
	vi.clearAllMocks();
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
			.mockResolvedValueOnce([{ server_version: 12 }])
			.mockResolvedValueOnce([{
				id: 'npc_mira',
				story_id: 'story_alpha',
				type: 'character',
				name: 'Mira',
				state: { currentAction: 'Guarding the quay.' },
			}]);
		const tx = {
			execute,
			insert: (table: unknown) => ({
				values: async (value: unknown) => {
					inserts.push({ table, value });
				},
			}),
		};
		dbMocks.getDb.mockReturnValue({
			transaction: (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
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

	it('normalizes memory aliases before writing the record and audit trail', async () => {
		const inserts: Array<{ value: Record<string, unknown> }> = [];
		const execute = vi.fn()
			.mockResolvedValueOnce([{
				id: 'memory_rules',
				story_id: 'story_alpha',
				type: 'canonical',
			}])
			.mockResolvedValueOnce([{ server_version: 12 }])
			.mockResolvedValueOnce([{
				id: 'memory_rules',
				story_id: 'story_alpha',
				type: 'canonical',
				importance: 0.8,
			}]);
		const tx = {
			execute,
			insert: () => ({
				values: async (value: Record<string, unknown>) => {
					inserts.push({ value });
				},
			}),
		};
		dbMocks.getDb.mockReturnValue({
			transaction: (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
		});

		await patchWorldRecord('memoryNodes', 'memory_rules', {
			updates: { type: 'world', importance: 8 },
			reason: 'MCP memory edit.',
		});

		const auditedOperations = inserts
			.flatMap((insert) => Array.isArray(insert.value.operations) ? insert.value.operations : []);
		expect(auditedOperations).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: '/memoryNodes/memory_rules/type', value: 'canonical' }),
			expect.objectContaining({ path: '/memoryNodes/memory_rules/importance', value: 0.8 }),
		]));
	});

	it('rejects unknown memory types before opening a write transaction', async () => {
		const transaction = vi.fn();
		dbMocks.getDb.mockReturnValue({ transaction });

		await expect(patchWorldRecord('memoryNodes', 'memory_rules', {
			updates: { type: 'invented_memory_kind' },
			reason: 'MCP memory edit.',
		})).rejects.toThrow('Invalid option');
		expect(transaction).not.toHaveBeenCalled();
	});
});
