import { beforeEach, describe, expect, it, vi } from 'vitest';
import { continuityWarnings, entities, entityAliases, memoryNodes, shelves, stories } from './schema';

const dbMocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	enqueueImportProjectionJobs: vi.fn(),
	enqueueStoryVaultSyncJob: vi.fn(),
	deleteStoryVaultArtifacts: vi.fn(),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: dbMocks.getDb,
}));

vi.mock('$lib/server/jobs/outbox', () => ({
	enqueueImportProjectionJobs: dbMocks.enqueueImportProjectionJobs,
	enqueueStoryVaultSyncJob: dbMocks.enqueueStoryVaultSyncJob,
}));

vi.mock('$lib/server/wiki/storyVault', () => ({
	deleteStoryVaultArtifacts: dbMocks.deleteStoryVaultArtifacts,
}));

import { importWorldDatabaseBundle } from './worldDatabaseImport';

describe('world database import', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects duplicate transcript positions instead of silently dropping an entry', async () => {
		const db = {
			select: vi.fn(),
			delete: vi.fn(),
			transaction: vi.fn(),
		};
		dbMocks.getDb.mockReturnValue(db);

		await expect(importWorldDatabaseBundle({
			bundle: {
				worldDatabase: {
					story: { id: 'story_duplicate_positions', title: 'Duplicate Positions' },
					entries: [
						{ id: 'entry_user', type: 'user_action', content: 'Act.', position: 7 },
						{ id: 'entry_assistant', type: 'assistant_narrative', content: 'Result.', position: 7 },
					],
				},
			},
			options: { preserveIds: true, replaceExisting: false, syncWiki: false },
		})).rejects.toThrow('duplicate story entry position 7');
		expect(db.transaction).not.toHaveBeenCalled();
	});

	it('rejects an implicit merge when the source project ID already exists', async () => {
		const db = {
			select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'shelf_existing' }] }) }) })),
			transaction: vi.fn(),
		};
		dbMocks.getDb.mockReturnValue(db);
		await expect(importWorldDatabaseBundle({
			bundle: { shelf: { id: 'shelf_existing', name: 'Existing', slug: 'existing' }, worldDatabase: {
				story: { id: 'story_import', shelfId: 'shelf_existing', title: 'Imported' },
			} },
			options: { preserveIds: true, replaceExisting: false, syncWiki: false },
		})).rejects.toThrow('Project ID already exists');
		expect(db.transaction).not.toHaveBeenCalled();
	});

	it('rejects a bundle whose project and game identities disagree', async () => {
		await expect(importWorldDatabaseBundle({
			bundle: { shelf: { id: 'shelf_a', name: 'A', slug: 'a' }, worldDatabase: {
				story: { id: 'story_import', shelfId: 'shelf_b', title: 'Imported' },
			} },
			options: { preserveIds: true, replaceExisting: false, syncWiki: false },
		})).rejects.toThrow('Bundle project identity does not match its game');
		expect(dbMocks.getDb).not.toHaveBeenCalled();
	});

	it.each([{ schemaVersion: 999 }, { version: 999 }])('rejects a future bundle format before writing anything', async (version) => {
		await expect(importWorldDatabaseBundle({ bundle: {
			...version,
			worldDatabase: { story: { id: 'story_future', title: 'Future' } },
		} })).rejects.toThrow('Update MythEngine before importing');
		expect(dbMocks.getDb).not.toHaveBeenCalled();
	});

	it('creates a distinct shelf when the incoming shelf slug already exists', async () => {
		let shelfSelect = 0;
		const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
		const existingShelf = {
			id: 'shelf_existing',
			name: 'Known Shelf',
			slug: 'known_shelf',
			description: null,
			genre: null,
			coverImageUrl: null,
			settings: {},
			metadata: {},
			serverVersion: 1,
			createdAt: '2026-07-06T00:00:00.000Z',
			updatedAt: '2026-07-06T00:00:00.000Z',
		};
		const tx = {
			execute: vi.fn().mockResolvedValue([]),
			insert: vi.fn((table: unknown) => ({
				values: vi.fn((value: Record<string, unknown>) => {
					inserts.push({ table, value });
					return {
						onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
						onConflictDoUpdate: vi.fn(() => ({
							returning: vi.fn().mockResolvedValue([{ id: existingShelf.id }]),
						})),
					};
				}),
			})),
		};
		const db = {
			select: vi.fn(() => {
				let selectedTable: unknown;
				const chain = {
					from: vi.fn((table: unknown) => {
						selectedTable = table;
						return chain;
					}),
					where: vi.fn(() => chain),
					limit: vi.fn(() => {
						if (selectedTable === stories) return Promise.resolve([]);
						if (selectedTable === shelves) {
							shelfSelect += 1;
							return Promise.resolve(shelfSelect === 1 ? [] : [existingShelf]);
						}
						return Promise.resolve([]);
					}),
				};
				return chain;
			}),
			delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
			transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx)),
		};
		dbMocks.getDb.mockReturnValue(db);

		await importWorldDatabaseBundle({
			bundle: {
				shelf: { id: 'shelf_imported', name: 'Known Shelf', slug: 'known_shelf' },
				worldDatabase: {
					story: { id: 'story_imported', shelfId: 'shelf_imported', title: 'Imported Story' },
				},
			},
			options: { preserveIds: true, replaceExisting: false, syncWiki: false },
		});

		expect(inserts.find((insert) => insert.table === stories)?.value.shelfId).toBe('shelf_imported');
		expect(inserts.find((insert) => insert.table === shelves)?.value.slug).toMatch(/^known_shelf_import_/);
	});

	it.each([
		['story insert', stories],
		['conflicting entity', entities],
	] as const)('rolls back the replacement on a failed %s instead of skipping records', async (_label, failingTable) => {
		let originalStoryExists = true;
		const tx = {
			execute: vi.fn().mockResolvedValue([]),
			delete: vi.fn((table: unknown) => ({
				where: vi.fn(async () => {
					if (table === stories) originalStoryExists = false;
				}),
			})),
			insert: vi.fn((table: unknown) => ({
				values: vi.fn(() => {
					if (table === failingTable) return {
						then: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error('simulated later import failure')),
						onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
					};
					return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
				}),
			})),
		};
		const db = {
			select: vi.fn(() => {
				let selectedTable: unknown;
				const chain = {
					from: vi.fn((table: unknown) => {
						selectedTable = table;
						return chain;
					}),
					where: vi.fn(() => chain),
					limit: vi.fn(() => {
						if (selectedTable === shelves) return Promise.resolve([{ id: 'shelf_default' }]);
						if (selectedTable === stories && originalStoryExists) return Promise.resolve([{ id: 'story_replace', shelfId: 'shelf_default' }]);
						return Promise.resolve([]);
					}),
				};
				return chain;
			}),
			delete: vi.fn(() => {
				throw new Error('delete must not run outside the transaction');
			}),
			transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => {
				const before = originalStoryExists;
				try {
					await callback(tx);
				} catch (error) {
					originalStoryExists = before;
					throw error;
				}
			}),
		};
		dbMocks.getDb.mockReturnValue(db);

		await expect(importWorldDatabaseBundle({
			bundle: {
				worldDatabase: {
					story: { id: 'story_replace', shelfId: 'shelf_default', title: 'Replacement' },
					entities: [{ id: 'entity_existing_elsewhere', type: 'character', name: 'Existing character' }],
				},
			},
			options: { preserveIds: true, replaceExisting: true, syncWiki: false, sourceProjectId: 'shelf_default', destinationProjectId: 'shelf_default' },
		})).rejects.toThrow('simulated later import failure');

		expect(tx.delete).toHaveBeenCalledWith(stories);
		expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(tx.delete.mock.invocationCallOrder[0]);
		expect(db.delete).not.toHaveBeenCalled();
		expect(originalStoryExists).toBe(true);
		expect(dbMocks.deleteStoryVaultArtifacts).not.toHaveBeenCalled();
	});

	it('cleans generated vault artifacts only after commit and reports cleanup failure without losing the import', async () => {
		let committed = false;
		const tx = {
			execute: vi.fn().mockResolvedValue([]),
			delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
			insert: vi.fn(() => ({
				values: vi.fn(() => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) })),
			})),
		};
		const db = {
			select: vi.fn(() => {
				let selectedTable: unknown;
				const chain = {
					from: vi.fn((table: unknown) => {
						selectedTable = table;
						return chain;
					}),
					where: vi.fn(() => chain),
					limit: vi.fn(() => selectedTable === shelves
						? Promise.resolve([{ id: 'shelf_default' }])
					: Promise.resolve([{ id: 'story_replace', shelfId: 'shelf_default' }])),
				};
				return chain;
			}),
			transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => {
				await callback(tx);
				committed = true;
			}),
		};
		dbMocks.getDb.mockReturnValue(db);
		dbMocks.deleteStoryVaultArtifacts.mockImplementation(async () => {
			expect(committed).toBe(true);
			return {
				storyId: 'story_replace',
				vaultPath: 'vault/story_replace',
				collection: 'story_replace',
				vaultDeleted: true,
				qdrantDeleted: null,
				qdrantStatus: 503,
				qdrantError: 'Qdrant cleanup is temporarily unavailable',
			};
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const result = await importWorldDatabaseBundle({
			bundle: {
				worldDatabase: {
					story: { id: 'story_replace', shelfId: 'shelf_default', title: 'Replacement' },
				},
			},
			options: { preserveIds: true, replaceExisting: true, syncWiki: false, sourceProjectId: 'shelf_default', destinationProjectId: 'shelf_default' },
		});

		expect(result.ok).toBe(true);
		expect(result.warnings).toEqual([
			expect.stringContaining('Qdrant cleanup is temporarily unavailable'),
		]);
		expect(dbMocks.deleteStoryVaultArtifacts).toHaveBeenCalledWith('story_replace');
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it.each([true, false])('normalizes MCP-authored memory aliases with preserveIds=%s', async (preserveIds) => {
		const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
		const tx = {
			execute: vi.fn().mockResolvedValue([]),
			insert: vi.fn((table: unknown) => ({
				values: vi.fn((value: Record<string, unknown>) => {
					inserts.push({ table, value });
					return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
				}),
			})),
		};
		const db = {
			select: vi.fn(() => {
				let selectedTable: unknown;
				const chain = {
					from: vi.fn((table: unknown) => {
						selectedTable = table;
						return chain;
					}),
					where: vi.fn(() => chain),
					limit: vi.fn(() => selectedTable === shelves
						? Promise.resolve([{ id: 'shelf_default' }])
						: Promise.resolve([])),
				};
				return chain;
			}),
			delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
			transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx)),
		};
		dbMocks.getDb.mockReturnValue(db);

		await importWorldDatabaseBundle({
			bundle: {
				worldDatabase: {
					story: { id: 'story_agent_import', title: 'Agent Import' },
					entities: [{ id: 'entity_kaelion', type: 'character', name: 'Kaelion' }],
					entityAliases: [{
						id: 'alias_kaelion',
						entityId: 'entity_kaelion',
						alias: 'Kaelion',
						normalizedAlias: 'zorath',
					}],
					continuityWarnings: [{
						id: 'warning_agency',
						warningType: 'agency',
						level: 'high',
						title: 'Agency guardrail',
						details: 'Do not override the player.',
					}],
					memoryNodes: [{
						id: 'memory_world_rules',
						type: 'world',
						title: 'World rules',
						content: 'Durable setting rules.',
						importance: 8,
					}],
				},
			},
			options: { preserveIds, replaceExisting: false, syncWiki: false,
				...(preserveIds ? { sourceProjectId: 'shelf_default', destinationProjectId: 'shelf_default' } : {}) },
		});

		expect(inserts.find((insert) => insert.table === memoryNodes)?.value).toMatchObject({
			type: 'canonical',
			importance: 0.8,
			metadata: { normalizedMemoryTypeFrom: 'world' },
		});
		expect(inserts.find((insert) => insert.table === entityAliases)?.value).toMatchObject({
			alias: 'Kaelion',
			normalizedAlias: 'kaelion',
		});
		expect(inserts.find((insert) => insert.table === continuityWarnings)?.value).toMatchObject({
			level: 'warning',
			status: 'open',
		});
	});
});
