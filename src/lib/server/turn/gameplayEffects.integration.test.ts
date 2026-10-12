import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { backendJobs, entities, gameplayEffects, shelves, statePatches, stories, storyEntries } from '$lib/server/db/schema';
import { enqueueTurnStateExtractionJob, releaseEarlierTurnStateExtractions, unsettledTurnStateExtractions } from '$lib/server/jobs/outbox';
import { worldStateUpdateSchema } from '$lib/services/ai/tools/schemas';
import { readCampaignMeters, readCharacterConditions } from '$lib/contracts/gameplayEffects';
import { normalizePlayerSheet } from '$lib/utils/playerSheet';
import { projectItemState } from '$lib/utils/itemProjection';

vi.mock('$lib/server/turn/provider', async original => ({
	...await original<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: vi.fn(() => { throw new Error('Provider calls forbidden'); }),
}));
import { applyValidatedTurnUpdate } from './patchValidator';
import { loadTurnContext } from './context';
import { buildServerTurnPrompt, buildStateExtractionPrompt } from './promptPacket';
import { getCampaignProjection } from '$lib/server/engine/projections';
import { loadGameplayItems, loadCanonicalCharacters } from './context';
import { unsettledStateNotice } from './orchestrator';

/**
 * Gameplay effects against a disposable PostgreSQL database (SUMMARY_CHECKPOINT_TEST_DATABASE_URL,
 * a database whose name contains "test"). No provider is called: each turn applies the update an
 * extraction would have produced.
 */
const databaseUrl = process.env.SUMMARY_CHECKPOINT_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
afterAll(async () => { if (databaseUrl) await closeDb(); });

interface Fixture { storyId: string; mira: string; bram: string }

async function fixture(run: (f: Fixture) => Promise<void>) {
	if (!databaseUrl || !/summary_repair|test/i.test(new URL(databaseUrl).pathname)) throw new Error('Disposable test database required');
	const db = getDb();
	const [current] = await db.execute(sql`select current_database() as name`);
	if (current.name !== decodeURIComponent(new URL(databaseUrl).pathname.slice(1))) throw new Error('Database target differs from disposable test database');
	const storyId = `story_effects_${randomUUID()}`;
	const shelfId = `shelf_${storyId}`;
	const mira = `${storyId}_mira`, bram = `${storyId}_bram`;
	try {
		await db.insert(shelves).values({ id: shelfId, name: 'Disposable effects test', slug: shelfId });
		await db.insert(stories).values({ id: storyId, shelfId, title: 'Disposable effects test', currentTurn: 4 });
		await db.insert(entities).values([
			{ id: mira, storyId, type: 'character', name: 'Mira', description: 'A ranger.', status: 'active', visibility: 'player_known',
				state: { relationship: 'self', playerSheet: { abilities: { str: 12, dex: 16, con: 14, int: 10, wis: 13, cha: 8 }, armorClass: 14,
					hitPoints: { current: 18, max: 18 }, speed: 30, proficiencyBonus: 2 } }, serverVersion: 1 },
			{ id: bram, storyId, type: 'character', name: 'Bram', description: 'A smith.', status: 'active', visibility: 'player_known', state: {}, serverVersion: 1 },
		]);
		await run({ storyId, mira, bram });
	} finally {
		await db.delete(shelves).where(eq(shelves.id, shelfId));
	}
}

let position = 0;
async function turn(storyId: string, narration: string, update: Record<string, unknown>, options: { metadata?: Record<string, unknown>; assistantEntryId?: string; at?: number } = {}) {
	let assistantEntryId = options.assistantEntryId;
	let playerEntryId = assistantEntryId ? assistantEntryId.replace('_n_', '_p_') : '';
	if (!assistantEntryId) {
		const at = options.at ?? (position += 2);
		playerEntryId = `${storyId}_p_${at}`;
		assistantEntryId = `${storyId}_n_${at}`;
		await getDb().insert(storyEntries).values([
			{ id: playerEntryId, storyId, type: 'user_action', content: 'I press on.', position: at, metadata: options.metadata ?? {} },
			{ id: assistantEntryId, storyId, type: 'narration', content: narration, position: at + 1, parentId: playerEntryId, metadata: options.metadata ?? {} },
		]);
	}
	const result = await applyValidatedTurnUpdate({ storyId, playerEntryId, assistantEntryId, narration, update: worldStateUpdateSchema.parse(update),
		parseWarnings: [], retrievedMemoryIds: [], serverVersion: 2, mode: 'supplemental', timelineTurn: 4 }, { enqueueProjectionJobs: false });
	return { ...result, assistantEntryId };
}

const quote = (text: string) => ({ quote: text });
const entity = async (id: string) => (await getDb().select().from(entities).where(eq(entities.id, id)))[0];
const hp = async (id: string) => (await entity(id)).state as Record<string, any>;
const receipts = (storyId: string) => getDb().select().from(gameplayEffects).where(eq(gameplayEffects.storyId, storyId)).orderBy(asc(gameplayEffects.createdAt), asc(gameplayEffects.id));
const items = async (storyId: string) => getDb().select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.type, 'item')));

integration('gameplay effects in disposable PostgreSQL', () => {
	it('18 HP takes 7 damage: canonical HP, receipt, API/UI projection and the next GM turn all show 11', async () => {
		await fixture(async ({ storyId, mira }) => {
			const narration = 'The ambush comes fast. The arrow strikes Mira in the shoulder for 7 damage, and she staggers behind the cart.';
			const result = await turn(storyId, narration, { effects: [{ op: 'resource_delta', entityId: mira, resource: 'hp', delta: -7,
				mechanics: { roll: '1d8+2 = 7' }, source: quote('The arrow strikes Mira in the shoulder for 7 damage') }] });
			expect((await hp(mira)).playerSheet.hitPoints).toEqual({ current: 11, max: 18 });
			expect((await hp(mira)).playerSheet.armorClass).toBe(14);
			expect(result.effects).toEqual([expect.objectContaining({ op: 'resource_delta', status: 'applied', targetId: mira,
				before: { current: 18, max: 18 }, after: { current: 11, max: 18 }, revision: 1 })]);
			expect(await receipts(storyId)).toEqual([expect.objectContaining({ status: 'applied', sourceEntryId: result.assistantEntryId, subject: 'resource:hp',
				before: { current: 18, max: 18 }, after: { current: 11, max: 18 }, evidence: expect.objectContaining({ quote: 'The arrow strikes Mira in the shoulder for 7 damage' }) })]);
			// API projection the browser loads, then the browser's sheet view.
			const projection = await getCampaignProjection(storyId);
			const projected = projection.entities.find(row => row.id === mira)!;
			expect(normalizePlayerSheet((projected.state as Record<string, unknown>).playerSheet).hitPoints).toEqual({ current: 11, max: 18 });
			// Next GM turn reads canonical HP.
			const ctx = await loadTurnContext(storyId, [], [], 'I bind the wound.');
			const prompt = buildServerTurnPrompt(ctx, { storyId, query: '', packet: '', nodes: [], tokenEstimate: 0, retrievalDebug: [], retrievalTrace: [] } as any,
				'next', { playerAction: 'I bind the wound.' });
			expect(JSON.stringify(prompt)).toContain('[Hit Points]: 11/18');
			// The classifier's state packet for the next turn shows it too.
			const extraction = buildStateExtractionPrompt('I bind the wound.', 'Mira binds the wound.', undefined, await loadCanonicalCharacters(storyId), [], [], [], undefined, [], await loadGameplayItems(storyId));
			expect(extraction).toContain(`"entityId":"${mira}","name":"Mira","player":true,"hp":"11/18"`);
		});
	}, 30_000);

	it('a retried extraction of the same passage applies nothing twice; a restarted re-extraction is refused', async () => {
		await fixture(async ({ storyId, mira }) => {
			const narration = 'The arrow strikes Mira for 7 damage.';
			const effect = { op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -7, source: quote('The arrow strikes Mira for 7 damage') };
			const first = await turn(storyId, narration, { effects: [effect] });
			const retry = await turn(storyId, narration, { effects: [effect] }, { assistantEntryId: first.assistantEntryId });
			expect(retry.effects).toEqual([expect.objectContaining({ status: 'already_applied', after: { current: 11, max: 18 } })]);
			// After a restart the model reads the passage differently: the passage is already settled.
			const restarted = await turn(storyId, narration, { effects: [{ ...effect, delta: -8, source: quote('strikes Mira for 7 damage') }] }, { assistantEntryId: first.assistantEntryId });
			expect(restarted.effects).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.stringContaining('already settled') })]);
			expect((await hp(mira)).playerSheet.hitPoints).toEqual({ current: 11, max: 18 });
			expect((await receipts(storyId)).filter(row => row.status === 'applied')).toHaveLength(1);
		});
	}, 30_000);

	it('healing stops at the maximum and reports the difference; healing at full is no change', async () => {
		await fixture(async ({ storyId, mira }) => {
			await turn(storyId, 'A blade cuts Mira for 7 damage.', { effects: [{ op: 'resource_delta', target: 'player', resource: 'hp', delta: -7, source: quote('A blade cuts Mira for 7 damage.') }] });
			const healed = await turn(storyId, 'Mira drinks the potion and heals 10 hit points.', { effects: [{ op: 'resource_delta', target: 'player', resource: 'hit points', delta: 10,
				source: quote('Mira drinks the potion and heals 10 hit points.') }] });
			expect(healed.effects[0]).toMatchObject({ status: 'applied', before: { current: 11 }, after: { current: 18, max: 18 }, reason: 'requested +10, applied +7 (limits 0-18)' });
			const again = await turn(storyId, 'A second draught heals Mira 4 more.', { effects: [{ op: 'resource_delta', target: 'player', resource: 'hp', delta: 4,
				source: quote('A second draught heals Mira 4 more.') }] });
			expect(again.effects[0]).toMatchObject({ status: 'no_change', reason: expect.stringContaining('already at its maximum') });
			// Zero HP is a value, not death.
			const down = await turn(storyId, 'The troll crushes Mira for 30 damage; she collapses, still breathing.', { effects: [{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -30,
				source: quote('The troll crushes Mira for 30 damage') }] });
			expect(down.effects[0]).toMatchObject({ status: 'applied', after: { current: 0, max: 18 }, reason: expect.stringContaining('status unchanged') });
			expect((await entity(mira)).status).toBe('active');
		});
	}, 30_000);

	it('a qualitative injury is a condition only; changing clothes keeps it; healing one condition leaves the other', async () => {
		await fixture(async ({ storyId, mira }) => {
			await turn(storyId, 'Mira lands badly and her left arm snaps. The spider\'s bite leaves her poisoned.', { effects: [
				{ op: 'condition_add', target: 'Mira', condition: 'broken left arm', severity: 'severe', source: quote('Mira lands badly and her left arm snaps.') },
				{ op: 'condition_add', target: 'Mira', condition: 'poisoned', severity: 'moderate', source: quote("The spider's bite leaves her poisoned.") },
			] });
			expect((await hp(mira)).playerSheet.hitPoints).toEqual({ current: 18, max: 18 });
			await turn(storyId, 'Mira trades her torn coat for a clean grey cloak.', { characters: [{ name: 'Mira', presentation: 'a clean grey cloak over travel leathers' }] });
			expect(readCharacterConditions(await hp(mira)).map(condition => condition.name)).toEqual(['broken left arm', 'poisoned']);
			expect((await hp(mira)).presentation).toBe('a clean grey cloak over travel leathers');
			const cured = await turn(storyId, 'The antidote burns, and the poison leaves Mira\'s blood.', { effects: [
				{ op: 'condition_remove', target: 'Mira', condition: 'poisoned', source: quote("the poison leaves Mira's blood") }] });
			expect(cured.effects[0]).toMatchObject({ status: 'applied' });
			const state = await hp(mira);
			expect(readCharacterConditions(state).map(condition => condition.name)).toEqual(['broken left arm']);
			expect(state.resolvedConditions).toEqual([expect.objectContaining({ name: 'poisoned', resolvedEntryId: cured.assistantEntryId })]);
		});
	}, 30_000);

	it('the last potion goes to 0 (not 1) in canon, receipt and the inventory view', async () => {
		await fixture(async ({ storyId, mira }) => {
			const got = await turn(storyId, 'The merchant hands Mira a healing potion.', { effects: [{ op: 'item_acquire', target: 'Mira', item: 'Healing Potion', quantity: 1,
				source: quote('The merchant hands Mira a healing potion.') }] });
			const potionId = got.effects[0].targetId!;
			const used = await turn(storyId, 'Mira drinks her last healing potion.', { effects: [{ op: 'item_consume', target: 'Mira', item: 'healing potion', quantity: 1,
				source: quote('Mira drinks her last healing potion.') }] });
			expect(used.effects[0]).toMatchObject({ status: 'applied', targetId: potionId, before: { quantity: 1 }, after: { quantity: 0 } });
			const [potion] = await items(storyId);
			expect(potion.state).toMatchObject({ ownerId: mira, quantity: 0, equipped: false });
			expect(projectItemState(potion.state)).toMatchObject({ quantity: 0, quantityKnown: true, ownerId: mira });
			const again = await turn(storyId, 'Mira reaches for another potion and finds none.', { effects: [{ op: 'item_consume', target: 'Mira', item: 'Healing Potion',
				source: quote('Mira reaches for another potion') }] });
			expect(again.effects[0]).toMatchObject({ status: 'no_change' });
		});
	}, 30_000);

	it('picking up an item that lies somewhere makes it held, not still on the altar', async () => {
		await fixture(async ({ storyId, mira }) => {
			const idolId = `${storyId}_idol`;
			await getDb().insert(entities).values({ id: idolId, storyId, type: 'item', name: 'Jade Idol', status: 'active', visibility: 'player_known',
				state: { type: 'item', location: 'the altar', quantity: 1 }, serverVersion: 1 });
			const taken = await turn(storyId, 'Mira lifts the jade idol from the altar.', { effects: [{ op: 'item_acquire', target: 'Mira', item: 'Jade Idol', quantity: 1,
				source: quote('Mira lifts the jade idol from the altar.') }] });
			expect(taken.effects[0]).toMatchObject({ status: 'applied', targetId: idolId, after: { ownerId: mira, quantity: 1 } });
			expect(projectItemState((await entity(idolId)).state)).toMatchObject({ ownerId: mira, quantity: 1, location: 'inventory' });
		});
	}, 30_000);

	it('a transfer moves part of a stack atomically to the recipient', async () => {
		await fixture(async ({ storyId, mira, bram }) => {
			await turn(storyId, 'Mira buys three coils of rope.', { effects: [{ op: 'item_acquire', target: 'Mira', item: 'Rope', quantity: 3, source: quote('Mira buys three coils of rope.') }] });
			const moved = await turn(storyId, 'Mira tosses two coils of rope to Bram.', { effects: [{ op: 'item_transfer', target: 'Mira', item: 'Rope', to: 'Bram', quantity: 2,
				source: quote('Mira tosses two coils of rope to Bram.') }] });
			expect(moved.effects).toEqual([expect.objectContaining({ status: 'applied', before: expect.objectContaining({ quantity: 3 }), after: expect.objectContaining({ quantity: 1 }) })]);
			const stacks = (await items(storyId)).map(row => ({ owner: (row.state as any).ownerId, quantity: (row.state as any).quantity }));
			expect(stacks.sort((a, b) => a.quantity - b.quantity)).toEqual([{ owner: mira, quantity: 1 }, { owner: bram, quantity: 2 }]);
			// An unknown recipient moves nothing.
			const tooMany = await turn(storyId, 'Bram hands the rope to Mira.', { effects: [{ op: 'item_transfer', target: 'Bram', item: 'Rope', to: 'Nobody', source: quote('Bram hands the rope to Mira.') }] });
			expect(tooMany.effects[0]).toMatchObject({ status: 'unresolved', reason: expect.stringContaining('Recipient') });
			expect((await items(storyId)).map(row => (row.state as any).quantity).sort()).toEqual([1, 2]);
		});
	}, 30_000);

	it('unequipping a legacy carried item keeps it carried and stops showing it as equipped', async () => {
		await fixture(async ({ storyId, mira }) => {
			const legacyId = `${storyId}_sword`;
			await getDb().insert(entities).values({ id: legacyId, storyId, type: 'item', name: 'Old Sword', status: 'active', visibility: 'player_known',
				state: { type: 'item', inInventory: true, equipped: true, currentLocation: 'inventory' }, serverVersion: 1 });
			const result = await turn(storyId, 'Mira unbuckles the old sword and slings it across her pack.', { effects: [{ op: 'item_unequip', target: 'Mira', item: 'Old Sword',
				source: quote('Mira unbuckles the old sword') }] });
			expect(result.effects[0]).toMatchObject({ status: 'applied', before: { ownerId: mira, quantity: 1, equipped: true }, after: { equipped: false } });
			const sword = await entity(legacyId);
			expect(sword.state).toMatchObject({ inInventory: true, equipped: false, ownerId: mira });
			expect(projectItemState(sword.state)).toMatchObject({ equipped: false, location: 'inventory', quantity: 1 });
		});
	}, 30_000);

	it('captures a consequence quoted from the middle of a long narration', async () => {
		await fixture(async ({ storyId, mira }) => {
			const middle = 'Somewhere in the long fight a goblin\'s knife catches Mira for 4 damage.';
			const narration = `${'The battle rolls across the field. '.repeat(250)}${middle} ${'Smoke drifts over the ruined wagons. '.repeat(250)}`;
			expect(narration.length).toBeGreaterThan(12_000);
			expect(buildStateExtractionPrompt('I fight.', narration)).toContain(middle);
			const result = await turn(storyId, narration, { effects: [{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -4, source: quote(middle) }] });
			expect(result.effects[0]).toMatchObject({ status: 'applied', after: { current: 14 } });
			expect((await hp(mira)).playerSheet.hitPoints.current).toBe(14);
		});
	}, 30_000);

	it('back-to-back turns apply in order; a delayed earlier injury never lands after later healing', async () => {
		await fixture(async ({ storyId, mira }) => {
			await turn(storyId, 'A dart hits Mira for 3 damage.', { effects: [{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -3, source: quote('A dart hits Mira for 3 damage.') }] });
			await turn(storyId, 'A second dart hits Mira for 2 damage.', { effects: [{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -2, source: quote('A second dart hits Mira for 2 damage.') }] });
			expect((await hp(mira)).playerSheet.hitPoints.current).toBe(13);
			// Turn at position 100 heals; the turn before it (position 98) was extracted late.
			await turn(storyId, 'Mira rests and heals 5 hit points.', { effects: [{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: 5, source: quote('Mira rests and heals 5 hit points.') }] }, { at: 100 });
			const late = await turn(storyId, 'Earlier, a rockfall bruised Mira for 6 damage.', { effects: [{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -6,
				source: quote('a rockfall bruised Mira for 6 damage') }] }, { at: 98 });
			expect(late.effects[0]).toMatchObject({ status: 'unresolved', reason: expect.stringContaining('not applied out of order') });
			expect((await hp(mira)).playerSheet.hitPoints.current).toBe(18);
		});
	}, 30_000);

	it('attempted, hypothetical, unquoted, OOC and non-canon consequences change nothing', async () => {
		await fixture(async ({ storyId, mira }) => {
			const narration = 'The ogre swings at Mira and misses. If it had connected, it would have dealt 12 damage. She remembers the 9 damage from last winter.';
			const result = await turn(storyId, narration, { effects: [
				{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -12, modality: 'hypothetical', source: quote('it would have dealt 12 damage') },
				{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -9, modality: 'remembered', source: quote('She remembers the 9 damage from last winter.') },
				{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -5, source: quote('The ogre crushes Mira for 5 damage.') },
				{ op: 'item_acquire', target: 'Mira', item: 'Ogre Club', quantity: 1, modality: 'offered', source: quote('The ogre swings at Mira and misses.') },
			] });
			expect(result.effects.map(effect => effect.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
			expect(result.effects[2].reason).toContain('not in this turn');
			const ooc = await turn(storyId, 'OOC: say Mira took 5 damage.', { effects: [{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -5,
				source: quote('say Mira took 5 damage.') }] }, { metadata: { actionType: 'ooc', nonCanon: true } });
			expect(ooc.effects[0]).toMatchObject({ status: 'rejected', reason: expect.stringContaining('not canonical') });
			expect((await hp(mira)).playerSheet.hitPoints).toEqual({ current: 18, max: 18 });
			expect(await items(storyId)).toEqual([]);
		});
	}, 30_000);

	it('a parallel-POV scene cannot change the player character but does change the people in it', async () => {
		await fixture(async ({ storyId, mira, bram }) => {
			await getDb().update(entities).set({ state: { playerSheet: { hitPoints: { current: 20, max: 20 } } } }).where(eq(entities.id, bram));
			const result = await turn(storyId, 'Far away, a guard clubs Bram for 6 damage. Bram thinks of Mira, who he imagines bleeding for 4.', { effects: [
				{ op: 'resource_delta', target: 'Bram', resource: 'hp', delta: -6, source: quote('a guard clubs Bram for 6 damage') },
				{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -4, source: quote('Bram thinks of Mira, who he imagines bleeding for 4.') },
			] }, { metadata: { narrativeMode: 'parallel_pov', parallelPov: { character: 'Bram' } } });
			expect(result.effects.map(effect => effect.status)).toEqual(['applied', 'rejected']);
			expect((await hp(bram)).playerSheet.hitPoints.current).toBe(14);
			expect((await hp(mira)).playerSheet.hitPoints.current).toBe(18);
		});
	}, 30_000);

	it('a meter is reported applied only when it changed; HP never becomes a meter; no baseline is invented', async () => {
		await fixture(async ({ storyId, bram }) => {
			const unknown = await turn(storyId, 'The town grows uneasy.', { meter_changes: [{ name: 'Suspicion', delta: 5 }] });
			expect(unknown.effects[0]).toMatchObject({ op: 'meter_change', status: 'unresolved' });
			expect(readCampaignMeters((await getDb().select().from(stories).where(eq(stories.id, storyId)))[0].metadata)).toEqual([]);
			const created = await turn(storyId, 'Whispers spread through the market.', { meter_changes: [{ name: 'Suspicion', delta: 5, initial: 10, max: 100, visible: true }] });
			expect(created.effects[0]).toMatchObject({ status: 'applied', after: { name: 'Suspicion', value: 15, max: 100 } });
			const projection = await getCampaignProjection(storyId);
			expect(readCampaignMeters((projection.story as Record<string, unknown>).metadata)).toEqual([{ name: 'Suspicion', value: 15, max: 100, visible: true }]);
			const health = await turn(storyId, 'Mira feels weaker.', { meter_changes: [{ name: 'Health', delta: -5, initial: 20, max: 20 }] });
			expect(health.effects[0]).toMatchObject({ status: 'rejected', reason: expect.stringContaining('character sheet') });
			// Bram has no recorded HP: a stated wound cannot invent his starting value.
			const npc = await turn(storyId, 'A stone strikes Bram for 3 damage.', { effects: [{ op: 'resource_delta', target: 'Bram', resource: 'hp', delta: -3, source: quote('A stone strikes Bram for 3 damage.') }] });
			expect(npc.effects[0]).toMatchObject({ status: 'unresolved', reason: expect.stringContaining('no recorded HP') });
			expect((await hp(bram)).playerSheet).toBeUndefined();
		});
	}, 30_000);

	it('an edited source invalidates evidence that is no longer in it', async () => {
		await fixture(async ({ storyId, mira }) => {
			const first = await turn(storyId, 'The wolf bites Mira for 5 damage.', {});
			await getDb().update(storyEntries).set({ content: 'The wolf snaps at Mira and misses.' }).where(eq(storyEntries.id, first.assistantEntryId));
			const late = await turn(storyId, 'The wolf bites Mira for 5 damage.', { effects: [{ op: 'resource_delta', target: 'Mira', resource: 'hp', delta: -5,
				source: quote('The wolf bites Mira for 5 damage.') }] }, { assistantEntryId: first.assistantEntryId });
			expect(late.effects[0]).toMatchObject({ status: 'rejected', reason: expect.stringContaining('not in this turn') });
			expect((await hp(mira)).playerSheet.hitPoints.current).toBe(18);
		});
	}, 30_000);

	it('before a turn, extractions held or backing off for earlier turns become due, and a failed one is reported', async () => {
		await fixture(async ({ storyId }) => {
			const earlier = await turn(storyId, 'The bridge holds.', {});
			const jobId = await enqueueTurnStateExtractionJob({ storyId, playerEntryId: earlier.assistantEntryId.replace('_n_', '_p_'), assistantEntryId: earlier.assistantEntryId,
				playerText: 'I press on.', narration: 'The bridge holds.', clientTurnId: 'client_held', timelineTurn: 4, serverVersion: 2, retrievedMemoryIds: [], hold: true });
			const job = async () => (await getDb().select().from(backendJobs).where(eq(backendJobs.id, jobId)))[0];
			expect(Date.parse((await job()).runAfter)).toBeGreaterThan(Date.now() + 60_000);
			// The turn ended without releasing it (a stop): the next turn's boundary releases it.
			expect(await releaseEarlierTurnStateExtractions(storyId)).toBe(1);
			expect(Date.parse((await job()).runAfter)).toBeLessThanOrEqual(Date.now());
			expect(await unsettledTurnStateExtractions(storyId)).toEqual([{ assistantEntryId: earlier.assistantEntryId, status: 'queued', lastError: null }]);
			await getDb().update(backendJobs).set({ status: 'failed', lastError: 'Provider returned 402' }).where(eq(backendJobs.id, jobId));
			expect(unsettledStateNotice(await unsettledTurnStateExtractions(storyId))).toContain('could not be saved (Provider returned 402)');
			await getDb().update(backendJobs).set({ status: 'completed' }).where(eq(backendJobs.id, jobId));
			expect(await unsettledTurnStateExtractions(storyId)).toEqual([]);
		});
	}, 30_000);

	it('a misplaced nested HP value is reported, not applied, and the patch needs repair', async () => {
		await fixture(async ({ storyId, mira }) => {
			const { parseStateExtractionResult } = await import('./orchestrator');
			const parsed = parseStateExtractionResult(JSON.stringify({ update: { characters: [{ name: 'Mira', hp: 11, injuries: ['arrow wound'], presentation: 'bloodied' }] }, dueEventFeedback: [] }));
			expect(parsed.warnings[0]).toContain('characters[0].hp');
			const result = await applyValidatedTurnUpdate({ storyId, playerEntryId: 'missing_p', assistantEntryId: 'missing_n', narration: 'Mira is hit.', update: parsed.update,
				parseWarnings: parsed.warnings, retrievedMemoryIds: [], serverVersion: 2, mode: 'supplemental', timelineTurn: 4 }, { enqueueProjectionJobs: false });
			expect(result.warnings.join(' ')).toContain('Mechanical changes outside effects were not applied');
			expect((await hp(mira)).playerSheet.hitPoints.current).toBe(18);
			const [patch] = await getDb().select().from(statePatches).where(eq(statePatches.storyId, storyId));
			expect(patch.status).toBe('needs_repair');
		});
	}, 30_000);
});
