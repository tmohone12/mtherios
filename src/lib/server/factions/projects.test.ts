import { describe, expect, it } from 'vitest';
import {
	continuityWarnings,
	factionProjects,
	factionResources,
	factions,
	patchProposals,
	sourceRefs,
	stories,
} from '$lib/server/db/schema';
import { auditDueFactionProjects } from './projects';

type Table = unknown;

function createDbMock(options: {
	story?: Partial<typeof stories.$inferSelect>;
	projects?: Array<Partial<typeof factionProjects.$inferSelect>>;
	factions?: Array<Partial<typeof factions.$inferSelect>>;
	resources?: Array<Partial<typeof factionResources.$inferSelect>>;
}) {
	const insertCalls: Array<{ table: Table; value: unknown }> = [];
	const updateCalls: Array<{ table: Table; value: unknown }> = [];

	function rowsFor(table: Table) {
		if (table === stories) {
			return options.story ? [{
				id: 'story_1',
				currentTurn: 12,
				...options.story,
			}] : [];
		}
		if (table === factionProjects) return options.projects ?? [];
		if (table === factions) return options.factions ?? [];
		if (table === factionResources) return options.resources ?? [];
		return [];
	}

	function createSelectChain() {
		let selectedTable: Table;
		const chain = {
			from: (table: Table) => {
				selectedTable = table;
				return chain;
			},
			where: () => chain,
			limit: (limit: number) => Promise.resolve(rowsFor(selectedTable).slice(0, limit)),
			then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
				Promise.resolve(rowsFor(selectedTable)).then(resolve, reject),
		};
		return chain;
	}

	const db = {
		select: () => createSelectChain(),
		insert: (table: Table) => ({
			values: (value: unknown) => ({
				onConflictDoNothing: async () => {
					insertCalls.push({ table, value });
				},
			}),
		}),
		update: (table: Table) => ({
			set: (value: unknown) => ({
				where: async () => {
					updateCalls.push({ table, value });
				},
			}),
		}),
	};

	return { db, insertCalls, updateCalls };
}

describe('auditDueFactionProjects', () => {
	it('keeps due faction project resolution proposal-first with complete review context', async () => {
		const project = {
			id: 'project_harbor_blockade',
			storyId: 'story_1',
			factionId: 'faction_harbor',
			project: 'Blockade the harbor before the wedding fleet arrives',
			status: 'active',
			progress: 0.65,
			priority: 8,
			dueTurn: 10,
			worldTime: 'Day 12, midnight tide',
			costs: { coin: 40, ships: 3 },
			gains: { pressure: 'Control food prices', leverage: 2 },
			risks: ['Smugglers defect', 'City guard notices missing ships'],
			visibility: 'secret',
			metadata: { planner: 'dock council' },
			sourceEntryIds: ['entry_order'],
			sourceEventIds: ['event_pact'],
			sourcePatchIds: ['patch_project'],
			serverVersion: 4,
			createdAt: '2026-06-13T00:00:00.000Z',
			updatedAt: '2026-06-13T00:00:00.000Z',
		};
		const { db, insertCalls, updateCalls } = createDbMock({
			story: { id: 'story_1', currentTurn: 12 },
			projects: [project],
			factions: [{ id: 'faction_harbor', storyId: 'story_1', name: 'Harbor Compact' }],
			resources: [
				{ id: 'res_coin', storyId: 'story_1', factionId: 'faction_harbor', kind: 'coin', name: 'Coin', amount: 100 },
				{ id: 'res_ships', storyId: 'story_1', factionId: 'faction_harbor', kind: 'ships', name: 'Ships', amount: 4 },
			],
		});

		const result = await auditDueFactionProjects({ storyId: 'story_1', db: db as never });

		const proposalInsert = insertCalls.find((call) => call.table === patchProposals)?.value as Array<Record<string, unknown>>;
		const proposal = proposalInsert[0];
		const operations = proposal.operations as Array<Record<string, unknown>>;
		const eventValue = operations.find((operation) => operation.path === '/story_events')?.value as Record<string, unknown>;

		expect(updateCalls).toEqual([]);
		expect(result).toMatchObject({
			storyId: 'story_1',
			currentTurn: 12,
			dueProjectCount: 1,
			proposalCount: 1,
			warningCount: 0,
			proposalIds: ['proposal_due_project_project_harbor_blockade'],
		});
		expect(proposal).toMatchObject({
			id: 'proposal_due_project_project_harbor_blockade',
			storyId: 'story_1',
			proposalType: 'faction_project_due_resolution',
			targetTable: 'faction_projects',
			targetRecordId: 'project_harbor_blockade',
			status: 'pending',
			metadata: {
				sourceType: 'due_faction_project_audit',
				projectId: 'project_harbor_blockade',
				project: 'Blockade the harbor before the wedding fleet arrives',
				projectStatus: 'active',
				progress: 0.65,
				priority: 8,
				visibility: 'secret',
				worldTime: 'Day 12, midnight tide',
				dueTurn: 10,
				currentTurn: 12,
				factionId: 'faction_harbor',
				factionName: 'Harbor Compact',
				costs: [
					{ key: 'coin', required: 40, available: 100, resourceId: 'res_coin' },
					{ key: 'ships', required: 3, available: 4, resourceId: 'res_ships' },
				],
				gains: { pressure: 'Control food prices', leverage: 2 },
				risks: ['Smugglers defect', 'City guard notices missing ships'],
				sourceEntryIds: ['entry_order'],
				sourceEventIds: ['event_pact'],
				sourcePatchIds: ['patch_project'],
			},
		});
		expect(eventValue).toMatchObject({
			type: 'faction_move',
			status: 'proposed',
			title: 'Harbor Compact: Blockade the harbor before the wedding fleet arrives',
			factionIds: ['faction_harbor'],
			visibility: 'secret',
			createdTurn: 12,
			metadata: {
				sourceType: 'due_faction_project_audit',
				projectId: 'project_harbor_blockade',
				progress: 0.65,
				priority: 8,
				costs: [
					{ key: 'coin', required: 40, available: 100, resourceId: 'res_coin' },
					{ key: 'ships', required: 3, available: 4, resourceId: 'res_ships' },
				],
				gains: { pressure: 'Control food prices', leverage: 2 },
				risks: ['Smugglers defect', 'City guard notices missing ships'],
			},
		});
		expect(insertCalls.find((call) => call.table === continuityWarnings)).toBeUndefined();
		expect(insertCalls.find((call) => call.table === sourceRefs)?.value).toHaveLength(3);
	});
});
