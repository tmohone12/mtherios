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
import { auditDueFactionProjects, dueFactionProjectFingerprint, evaluateProjectCosts } from './projects';

type Table = unknown;

function createDbMock(options: {
	story?: Partial<typeof stories.$inferSelect>;
	projects?: Array<Partial<typeof factionProjects.$inferSelect>>;
	factions?: Array<Partial<typeof factions.$inferSelect>>;
	resources?: Array<Partial<typeof factionResources.$inferSelect>>;
}) {
	const insertCalls: Array<{ table: Table; value: unknown }> = [];
	const updateCalls: Array<{ table: Table; value: unknown }> = [];
	const insertedIds = new Set<string>();

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
				onConflictDoNothing: () => {
					insertCalls.push({ table, value });
					const inserted = (value as Array<{ id: string }>).filter(row => !insertedIds.has(row.id));
					for (const row of inserted) insertedIds.add(row.id);
					return { returning: async () => inserted.map(row => ({ id: row.id })) };
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
	const resource: typeof factionResources.$inferSelect = { id: 'grain_1', storyId: 'story_1', factionId: 'faction_1', kind: 'grain', name: 'Granary',
		amount: 10, status: 'available', locationId: null, visibility: 'public', sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [],
		metadata: { reservedGrain: 4 }, serverVersion: 1, createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z' };
	const project: typeof factionProjects.$inferSelect = { id: 'aid_1', storyId: 'story_1', factionId: 'faction_1', project: 'Offer relief', status: 'active',
		progress: 1, dueTurn: 1, costs: { grain: 7 }, gains: {}, risks: [], sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [],
		priority: 5, worldTime: null, visibility: 'public', metadata: {},
		serverVersion: 1, createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z' };

	it('keeps reserved inventory unavailable and sums aliases of the same resource', () => {
		expect(evaluateProjectCosts(project, [resource])).toMatchObject({ ok: false, costs: [{ available: 6, required: 7 }] });
		expect(evaluateProjectCosts({ ...project, costs: { grain: 4, Granary: 4 } }, [resource]).ok).toBe(false);
		expect(evaluateProjectCosts({ ...project, costs: { grain_1: 6 } }, [resource]).ok).toBe(true);
	});
	it('holds ambiguous, unavailable and invalid resource pools', () => {
		for (const resources of [
			[resource, { ...resource, id: 'grain_2' }],
			[{ ...resource, status: 'depleted' }],
			[{ ...resource, metadata: { reservedGrain: 20 } }],
		]) expect(evaluateProjectCosts({ ...project, costs: { grain: 1 } }, resources).ok).toBe(false);
	});
	it.each(['7', -1, Infinity, NaN])('does not treat invalid cost %s as free', amount => {
		expect(evaluateProjectCosts({ ...project, costs: { grain: amount } }, [resource]).ok).toBe(false);
	});
	it('deduplicates identical audits and creates a fresh review when resources recover', async () => {
		const resources = [{ ...resource }];
		const { db, insertCalls } = createDbMock({ story: { currentTurn: 10 }, projects: [project], resources });
		const first = await auditDueFactionProjects({ storyId: 'story_1', db: db as never });
		expect(first).toMatchObject({ proposalCount: 1, warningCount: 1 });
		expect(await auditDueFactionProjects({ storyId: 'story_1', db: db as never })).toMatchObject({ proposalCount: 0, warningCount: 0, proposalIds: [] });
		resources[0] = { ...resource, metadata: { reservedGrain: 0 }, serverVersion: 2 };
		const recovered = await auditDueFactionProjects({ storyId: 'story_1', db: db as never });
		expect(recovered).toMatchObject({ proposalCount: 1, warningCount: 0 });
		expect(recovered.proposalIds[0]).not.toBe(first.proposalIds[0]);
		const last = insertCalls.filter(call => call.table === patchProposals).at(-1)?.value as Array<Record<string, unknown>>;
		expect(last[0]).toMatchObject({ proposalType: 'faction_project_due_resolution', status: 'pending' });
	});
	it('binds review identity to the exact project and resource revisions', () => {
		const initial = dueFactionProjectFingerprint(project, [resource]);
		expect(dueFactionProjectFingerprint({ ...project, status: 'cancelled' }, [resource])).not.toBe(initial);
		expect(dueFactionProjectFingerprint({ ...project, costs: { grain: 1 } }, [resource])).not.toBe(initial);
		expect(dueFactionProjectFingerprint(project, [{ ...resource, serverVersion: 2 }])).not.toBe(initial);
	});
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
				{ id: 'res_coin', storyId: 'story_1', factionId: 'faction_harbor', kind: 'coin', name: 'Coin', amount: 100, status: 'available' },
				{ id: 'res_ships', storyId: 'story_1', factionId: 'faction_harbor', kind: 'ships', name: 'Ships', amount: 4, status: 'available' },
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
			warningCount: 1,
			proposalIds: [expect.stringMatching(/^proposal_due_project_project_harbor_blockade_[a-f0-9]{24}$/)],
		});
		expect(proposal).toMatchObject({
			id: result.proposalIds[0],
			storyId: 'story_1',
			proposalType: 'faction_project_deadline_review',
			targetTable: 'faction_projects',
			targetRecordId: 'project_harbor_blockade',
			status: 'needs_review',
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
		expect(insertCalls.find((call) => call.table === continuityWarnings)?.value).toEqual([
			expect.objectContaining({
				warningType: 'faction_project_deadline_missed',
				factionIds: ['faction_harbor'],
				details: 'Deadline reached at 65% progress.',
			}),
		]);
		expect(insertCalls.find((call) => call.table === sourceRefs)?.value).toHaveLength(3);
	});
});
