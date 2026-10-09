import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entities, factions, factionGoals, factionMemberships, factionResources, factionProjects, relationships, stories, storyEntries, storyEvents } from '$lib/server/db/schema';
import { buildStrategicWorldBrainUserPrompt } from '$lib/services/ai/context/strategicWorldBrainInput';
import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import { loadStrategicWorldBrainInputFromDb, mapFactionEntry } from './serviceCommands';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), loadCharacters: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/turn/context', async (original) => ({ ...await original<Record<string, unknown>>(), loadCanonicalCharacters: mocks.loadCharacters }));

const now = '2026-09-05T12:00:00.000Z';
const row = (value: Record<string, unknown>) => ({ storyId: 'story', createdAt: now, updatedAt: now, serverVersion: 1, metadata: {}, sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [], ...value });
const faction = (id: string, extra: Record<string, unknown> = {}) => row({ id, name: id, entityId: null, goals: [], resources: {}, memberEntityIds: [], territoryIds: [], allies: [], enemies: [], pressure: 90, ...extra });
const entity = (id: string, type: string, name: string, state: Record<string, unknown> = {}) => row({ id, type, name, description: '', status: 'active', visibility: 'player_known', state });

function containsValue(value: unknown, target: string, seen = new WeakSet<object>()): boolean {
	if (value === target) return true;
	if (!value || typeof value !== 'object' || seen.has(value)) return false;
	seen.add(value);
	return Object.values(value).some(child => containsValue(child, target, seen));
}

function database(tables: Map<unknown, Array<Record<string, unknown>>>) {
	return { select: () => ({ from: (table: unknown) => {
		let values = tables.get(table) ?? [];
		let limit = Infinity;
		const query = {
			where: (condition: unknown) => {
				// Model the targeted linked-entity query as well as the original broad page.
				if (table === entities) {
					const targeted = values.filter(value => containsValue(condition, String(value.id)));
					if (targeted.length) values = targeted;
				}
				return query;
			},
			orderBy: () => query,
			limit: (count: number) => { limit = count; return query; },
			then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(values.slice(0, limit)).then(resolve, reject),
		};
		return query;
	} }) };
}

describe('Director faction input fidelity', () => {
	beforeEach(() => vi.clearAllMocks());

	it('loads linked canon beyond the mixed-entity page, preserves normalized state, and retains eligible off-dossier events', async () => {
		const characters = Array.from({ length: 120 }, (_, i) => entity(`character_${i}`, 'character', `Courtier ${i}`));
		characters.push(entity('mara', 'character', 'Captain Mara'));
		const harbor = { ...entity('entity_harbor', 'faction', 'Harbor Council', {
			status: 'allied', playerStanding: 65, disposition: 'defensive', knownMembers: ['departed'],
			resources: { military: 12, wealth: 50, morale: 0 }, interFactionRelations: { 'Eastern House': { standing: 75, affinity: 15 } },
		}), description: 'An elected council bound by the public harbor charter.' };
		const factionRows = [...Array.from({ length: 45 }, (_, i) => faction(`remote_${i}`)),
			faction('harbor', { name: 'Harbor Council', entityId: 'entity_harbor', pressure: 1, territoryIds: ['quay'], goals: ['Recover the old charter.'], allies: ['remote_0'] }),
			faction('secret_court', { entityId: 'entity_secret' })];
		const events = Array.from({ length: 45 }, (_, i) => row({ id: `move_${i}`, type: 'faction_move', title: `Move ${i}`, body: `Council ${i} changed its tariffs.`, status: 'committed', visibility: 'player_known', factionIds: [`remote_${i}`], entityIds: [], locationIds: [], threadIds: [], turn: 5, metadata: {} }));
		const tables = new Map<unknown, Array<Record<string, unknown>>>([
			[stories, [row({ id: 'story', title: 'Harbor', mode: 'adventure', currentTurn: 5, currentLocationId: 'quay' })]],
			[entities, [...characters, harbor, entity('quay', 'location', 'Salt Quay'), { ...entity('entity_secret', 'faction', 'Secret Court'), visibility: 'secret' }]],
			[factions, factionRows],
			[storyEntries, [row({ id: 'scene', type: 'narration', content: 'At Salt Quay, Captain Mara accepts the charter.', position: 5, parentId: null })]],
			[storyEvents, events],
			[factionGoals, [
				row({ id: 'closed', factionId: 'harbor', goal: 'Recover the old charter.', status: 'completed', priority: 10, secrecy: 'player_known' }),
				row({ id: 'secret_goal', factionId: 'harbor', goal: 'Poison the visiting envoy.', status: 'active', priority: 9, secrecy: 'secret' }),
				row({ id: 'open', factionId: 'harbor', goal: 'Honor the signed compact.', status: 'active', priority: 5, secrecy: 'player_known', metadata: { type: 'diplomatic', progress: 25, deadline: 'before winter' } }),
			]],
			[factionMemberships, [
				row({ id: 'member', factionId: 'harbor', entityId: 'mara', status: 'active', visibility: 'player_known' }),
				row({ id: 'old_member', factionId: 'harbor', entityId: 'departed', status: 'inactive', visibility: 'player_known' }),
				row({ id: 'secret_member', factionId: 'harbor', entityId: 'spy', status: 'active', visibility: 'secret' }),
			]],
			[factionResources, [
				row({ id: 'coin', factionId: 'harbor', name: 'Treasury', kind: 'wealth', amount: 7, status: 'available', visibility: 'player_known' }),
				row({ id: 'hidden_force', factionId: 'harbor', name: 'Hidden reserve', kind: 'military', amount: 88, status: 'available', visibility: 'secret' }),
			]],
			[relationships, [row({ id: 'relation', sourceEntityId: 'entity_harbor', targetEntityId: 'mara', type: 'command', label: 'commands', strength: 0.7, bidirectional: false })]],
			[factionProjects, [row({ id: 'cancelled_project', factionId: 'harbor', project: 'An abandoned levy.', status: 'cancelled', progress: 0, priority: 10, visibility: 'player_known' })]],
		]);
		mocks.getDb.mockReturnValue(database(tables));
		mocks.loadCharacters.mockResolvedValue(characters);
		const input = await loadStrategicWorldBrainInputFromDb({ storyId: 'story', trigger: 'manual', includeSecret: false } as never);
		expect(input.factions).toHaveLength(40);
		expect(input.factions[0].name).toBe('Harbor Council');
		expect(input.knownFactionIds).toHaveLength(46);
		expect(input.knownFactionIds).not.toContain('secret_court');
		expect(input.factions.some(value => value.id === 'remote_44')).toBe(false);
		expect(input.worldEvents.some(value => value.id === 'move_44')).toBe(true);
		expect(input.activeSchemes).toHaveLength(0);
		expect(input.recentlyResolvedSchemes[0].status).toBe('abandoned');
		const prompt = buildStrategicWorldBrainUserPrompt(input);
		for (const expected of ['An elected council bound by the public harbor charter.', 'allied, player standing 65', 'disposition: defensive', 'Eastern House: standing 75, affinity 15', 'wealth 7', 'morale 0', 'military unknown', 'Members: Captain Mara', 'commands: Captain Mara', 'territory: Salt Quay', 'Honor the signed compact.', 'diplomatic, priority 5, progress 25, deadline before winter']) expect(prompt).toContain(expected);
		for (const forbidden of ['Recover the old charter.', 'Poison the visiting envoy.', 'Hidden reserve', 'Secret Court', 'Members: departed']) expect(prompt).not.toContain(forbidden);
		const secretInput = await loadStrategicWorldBrainInputFromDb({ storyId: 'story', trigger: 'manual', includeSecret: true } as never);
		const secretPrompt = buildStrategicWorldBrainUserPrompt(secretInput);
		expect(secretPrompt).toContain('Poison the visiting envoy.');
		expect(secretPrompt).toContain('military 88');
	});

	it('does not resurrect legacy goals when normalized goals are terminal or hidden', () => {
		const current = faction('faction', { goals: ['Old objective.'] });
		const storedGoals = [row({ goal: 'Old objective.', status: 'completed', secrecy: 'player_known', priority: 9 })];
		const mapped = mapFactionEntry(current as never, new Map(), new Map([['faction', storedGoals as never]]));
		expect((mapped.state as { goals: unknown[] }).goals).toEqual([]);
		expect(mapped.description).toBe('');
	});

	it('does not feed closed or deleted cards back into Director planning', async () => {
		const frame = strategicWorldFrameSchema.parse({ id: 'prior_frame', storyId: 'story',
			hiddenStrategicSummary: 'Private harbor informant is concealed.',
			plotCards: [
				{ id: 'closed', title: 'Closed Demand', logline: 'Replay the settled demand.', storyThreadId: 'thread_closed',
					sourceRefs: [{ sourceType: 'thread', sourceId: 'thread_closed', label: 'Closed thread' }] },
				{ id: 'deleted', title: 'Deleted Promise', logline: 'Replay the removed promise.',
					sourceRefs: [{ sourceType: 'agreement', sourceId: 'agreement_deleted', label: 'Removed agreement' }] },
				{ id: 'active', title: 'Current Harbor Step', logline: 'Harbor workers ask about cargo.',
					sourceRefs: [{ sourceType: 'world_event', sourceId: 'event_active', label: 'Current event' }] },
			], activationPlan: { activateNow: ['closed', 'deleted', 'active'] },
		});
		const story = row({ id: 'story', title: 'Harbor', mode: 'adventure',
			metadata: { plotBrain: { lastFrame: frame, closedThreadIds: ['thread_closed'] },
				deletedCommitments: { 'agreement:agreement_deleted': true } },
		});
		mocks.getDb.mockReturnValue(database(new Map([[stories, [story]]])));
		mocks.loadCharacters.mockResolvedValue([]);
		const input = await loadStrategicWorldBrainInputFromDb({ storyId: 'story', trigger: 'manual', includeSecret: true } as never);
		expect(input.previousStrategicFrame?.plotCards.map(card => card.id)).toEqual(['active']);
		expect(input.previousStrategicFrame?.activationPlan.activateNow).toEqual(['active']);
		const prompt = buildStrategicWorldBrainUserPrompt(input);
		expect(prompt).toContain('Current Harbor Step');
		expect(prompt).not.toContain('Replay the settled demand.');
		expect(prompt).not.toContain('Replay the removed promise.');
		const publicInput = await loadStrategicWorldBrainInputFromDb({ storyId: 'story', trigger: 'manual', includeSecret: false } as never);
		expect(publicInput.previousStrategicFrame).toBeNull();
		expect(buildStrategicWorldBrainUserPrompt(publicInput)).not.toContain('Private harbor informant is concealed.');
	});
});
