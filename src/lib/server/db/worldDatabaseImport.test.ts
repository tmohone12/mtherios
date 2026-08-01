import { describe, expect, it, vi } from 'vitest';
import { continuityWarnings, entityAliases, memoryNodes, shelves, stories } from './schema';

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
	it('points imported stories at an existing shelf when the incoming shelf slug already exists', async () => {
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

		expect(inserts.find((insert) => insert.table === stories)?.value.shelfId).toBe('shelf_existing');
	});

	it('normalizes MCP-authored memory aliases before they reach Postgres', async () => {
		const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
		const tx = {
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
			options: { preserveIds: true, replaceExisting: false, syncWiki: false },
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
