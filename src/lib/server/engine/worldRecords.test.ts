import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listWorldRecords, patchWorldRecord } from './worldRecords';
import { PgDialect } from 'drizzle-orm/pg-core';

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
	it('fails stale writes before changing canon, audit or jobs', async () => {
		const execute = vi.fn().mockResolvedValue([{ id: 'npc', story_id: 'story_alpha', type: 'character', server_version: 12 }]);
		const insert = vi.fn();
		const tx = { execute, insert };
		dbMocks.getDb.mockReturnValue({ transaction: (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) });
		await expect(patchWorldRecord('story_alpha', 'characters', 'npc', { updates: { name: 'Stale' }, reason: 'Test', expectedVersion: 11 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
		expect(execute).toHaveBeenCalledTimes(1);
		expect(insert).not.toHaveBeenCalled();
		expect(dbMocks.enqueueBackendJob).not.toHaveBeenCalled();
	});

	it('rejects cross-game references before writes and checks adapter type', async () => {
		const execute = vi.fn().mockResolvedValueOnce([{ id: 'npc', story_id: 'story_alpha', type: 'character', server_version: 12 }]).mockResolvedValueOnce([]);
		const insert = vi.fn(); const tx = { execute, insert };
		dbMocks.getDb.mockReturnValue({ transaction: (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) });
		await expect(patchWorldRecord('story_alpha', 'characters', 'npc', { updates: { sourceEntryIds: ['other_game_entry'] }, reason: 'Test', expectedVersion: 12 })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
		expect(insert).not.toHaveBeenCalled();
		const dialect = new PgDialect();
		expect(dialect.sqlToQuery(execute.mock.calls[0][0]).params).toContain('character');
		expect(dialect.sqlToQuery(execute.mock.calls[1][0]).params).toContain('story_alpha');
	});

	it('propagates outbox failures out of the transaction rather than committing an unprojected edit', async () => {
		const execute = vi.fn().mockResolvedValueOnce([{ id: 'npc', story_id: 'story_alpha', type: 'character', server_version: 1, state: { bio: 'Keep', stats: { hp: 12, ac: 16 } } }]).mockResolvedValueOnce([{ server_version: 2 }]).mockResolvedValueOnce([{ id: 'npc' }]);
		const audits: any[] = []; const tx = { execute, insert: () => ({ values: async (row: any) => { audits.push(row); } }) };
		dbMocks.getDb.mockReturnValue({ transaction: (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) });
		dbMocks.enqueueBackendJob.mockRejectedValueOnce(new Error('Outbox unavailable'));
		await expect(patchWorldRecord('story_alpha', 'characters', 'npc', { updates: { state: { stats: { hp: 10 } } }, reason: 'Test', expectedVersion: 1 })).rejects.toThrow('Outbox unavailable');
		expect(audits[1].metadata.before.state.stats.hp).toBe(12);
		expect(audits[1].metadata.after.state).toEqual({ bio: 'Keep', stats: { hp: 10, ac: 16 } });
		expect(audits[1]).toMatchObject({ proposedBy: 'client', validatedBy: 'schema_validator' });
		expect(dbMocks.enqueueBackendJob.mock.calls[0][1]).toBe(tx);
	});

	it('merges one capability list under the row lock while retaining stats and the other list', async () => {
		const state = { relationship: 'self', bio: 'A harbor scout.', playerSheet: { abilities: { cha: 16 } }, playerCapabilities: { abilities: ['Keen senses'], buffs: ['Old ward'] } };
		const expected = { ...state, playerCapabilities: { abilities: ['Keen senses'], buffs: [] } };
		const inserts: any[] = [];
		const execute = vi.fn().mockResolvedValueOnce([{ id: 'player', server_version: 11, story_id: 'story_alpha', type: 'character', state }]).mockResolvedValueOnce([{ server_version: 12 }]).mockResolvedValueOnce([{ id: 'player', server_version: 11, story_id: 'story_alpha', type: 'character', state: expected }]);
		const tx = { execute, insert: () => ({ values: async (value: any) => { inserts.push(value); } }) };
		dbMocks.getDb.mockReturnValue({ transaction: (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) });
		await patchWorldRecord('story_alpha', 'characters', 'player', { expectedVersion: 11, updates: { playerCapabilities: { buffs: [] } }, reason: 'Ward ended' });
		const dialect = new PgDialect();
		expect(dialect.sqlToQuery(execute.mock.calls[0][0]).sql).toContain('for update');
		expect(dialect.sqlToQuery(execute.mock.calls[0][0]).params).toContain('story_alpha');
		expect(dialect.sqlToQuery(execute.mock.calls[2][0]).params).toContain(JSON.stringify(expected));
		expect(inserts[0].operations).toEqual([{ op: 'replace', path: '/characters/player/state/playerCapabilities', value: expected.playerCapabilities, source: 'manual_edit', previousValue: state.playerCapabilities }]);
	});

	it.each([{}, { buffs: null }, { buffs: ['x'.repeat(301)] }, { abilities: Array(13).fill('Power') }])('rejects invalid capability updates before a write transaction %#', async playerCapabilities => {
		const transaction = vi.fn();
		dbMocks.getDb.mockReturnValue({ transaction });
		await expect(patchWorldRecord('story_alpha', 'characters', 'player', { expectedVersion: 11, updates: { playerCapabilities }, reason: 'Test' })).rejects.toThrow();
		expect(transaction).not.toHaveBeenCalled();
	});

	it('rejects capabilities on NPCs before changing the story version', async () => {
		const execute = vi.fn().mockResolvedValueOnce([{ id: 'npc', server_version: 11, story_id: 'story_alpha', type: 'character', state: { relationship: 'ally' } }]);
		const insert = vi.fn();
		const tx = { execute, insert };
		dbMocks.getDb.mockReturnValue({ transaction: (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) });
		await expect(patchWorldRecord('story_alpha', 'characters', 'npc', { expectedVersion: 11, updates: { playerCapabilities: { buffs: [] } }, reason: 'Test' })).rejects.toThrow('canonical player character ID');
		expect(execute).toHaveBeenCalledTimes(1);
		expect(insert).not.toHaveBeenCalled();
	});

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
				server_version: 11, story_id: 'story_alpha',
				type: 'character',
				name: 'Mira',
			}])
			.mockResolvedValueOnce([{ server_version: 12 }])
			.mockResolvedValueOnce([{
				id: 'npc_mira',
				server_version: 11, story_id: 'story_alpha',
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

		const result = await patchWorldRecord('story_alpha', 'characters', 'npc_mira', {
			expectedVersion: 11,
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
		}, tx);
		expect(dbMocks.enqueueBackendJob).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_alpha',
			type: 'index_canonical_records',
			dedupeKey: 'record-edit-index-story_alpha-characters-npc_mira-12',
			payload: {
				recordTypes: ['entities'],
				recordId: 'npc_mira',
				reason: 'manual_record_edit',
			},
		}), tx);
	});

	it('lists concepts as their own filtered lore section', async () => {
		const execute = vi.fn().mockResolvedValue([]);
		dbMocks.getDb.mockReturnValue({ execute });

		await listWorldRecords('story_alpha', { type: 'concepts' });

		const query = JSON.stringify(execute.mock.calls[0][0]);
		expect(query).toContain('entities');
		expect(query).toContain('concept');
	});

	it('normalizes memory aliases before writing the record and audit trail', async () => {
		const inserts: Array<{ value: Record<string, unknown> }> = [];
		const execute = vi.fn()
			.mockResolvedValueOnce([{
				id: 'memory_rules',
				server_version: 11, story_id: 'story_alpha',
				type: 'canonical',
			}])
			.mockResolvedValueOnce([{ server_version: 12 }])
			.mockResolvedValueOnce([{
				id: 'memory_rules',
				server_version: 11, story_id: 'story_alpha',
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

		await patchWorldRecord('story_alpha', 'memoryNodes', 'memory_rules', {
			expectedVersion: 11,
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

		await expect(patchWorldRecord('story_alpha', 'memoryNodes', 'memory_rules', {
			expectedVersion: 11,
			updates: { type: 'invented_memory_kind' },
			reason: 'MCP memory edit.',
		})).rejects.toThrow('Invalid option');
		expect(transaction).not.toHaveBeenCalled();
	});
});
