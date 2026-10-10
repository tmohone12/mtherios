import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';

// Current faction ticks hold intentions; consent, inventory and elapsed world time settle delivery.
export async function runFactionSettlement({ db, schema, load }) {
  const storyId = 'replay_typed_settlement', supplier = `${storyId}_supplier`, recipient = `${storyId}_recipient`;
  const sr = `${storyId}_grain_a`, rr = `${storyId}_grain_b`, route = `${storyId}_route`, authority = `${storyId}_authority`;
  await db.insert(schema.stories).values({ id: storyId, title: 'Disposable typed settlement', currentWorldTime: 'Day 0', metadata: { factionWorkflow: { version: 1 } } });
  await db.insert(schema.factions).values([{ id: supplier, storyId, name: 'Granary League' }, { id: recipient, storyId, name: 'Hillmarch Regency' }]);
  await db.insert(schema.factionResources).values([{ id: sr, storyId, factionId: supplier, kind: 'grain', name: 'Relief grain', amount: 100 }, { id: rr, storyId, factionId: recipient, kind: 'grain', name: 'Granary stores', amount: 10 }]);
  await db.insert(schema.storyEvents).values([
    { id: authority, storyId, type: 'reveal', title: 'Council mandate', body: 'Council permits temporary toll relief.', metadata: { tollAuthority: { factionId: recipient, maxDays: 20 } } },
    { id: route, storyId, type: 'reveal', title: 'Verified route', body: 'The road is passable.', metadata: { deliveryRoute: { locationId: `${storyId}_granary`, blocked: false } } },
  ]);
  const { initializeNegotiation, advanceNegotiation } = await load('factions/workflow');
  await initializeNegotiation(storyId, { supplierId: supplier, recipientId: recipient, supplierResourceId: sr, recipientResourceId: rr, locationId: `${storyId}_granary`, deliveryDays: 2, maxTollDays: 20, authoritySourceId: authority, routeSourceId: route, blocked: false });
  const adapters = { plan: async ({ actorPacket: packet }) => packet.phase === 'idle'
    ? [{ kind: 'offer', terms: { grain: 40, tollDays: 20 }, sourceIds: [packet.actor.id] }]
    : packet.actor.role === 'recipient' ? [{ kind: 'counteroffer', terms: { grain: 40, tollDays: 10 }, sourceIds: [packet.pendingOffer.id] }]
      : [{ kind: 'accept', sourceIds: [packet.pendingOffer.id] }],
  decide: async input => ({ optionId: input.options.at(-1).id, confidence: .95, sourceIds: input.sourceIds, model: 'synthetic-decision', memoryId: null, usage: null }) };
  const day = async number => db.execute(sql`update stories set current_world_time=${`Day ${number}`},server_version=server_version+1 where id=${storyId}`);
  const offer = await advanceNegotiation(storyId, 'offer', adapters);
  assert.equal(offer.status, 'offer', JSON.stringify(offer));
  await day(1); assert.equal((await advanceNegotiation(storyId, 'counter', adapters)).status, 'counteroffer');
  await day(2); assert.equal((await advanceNegotiation(storyId, 'accept', adapters)).status, 'agreed');
  const inventory = () => db.execute(sql`select id,amount,metadata from faction_resources where id in (${sr},${rr}) order by id`);
  assert.deepEqual((await inventory()).map(row => row.amount), [100, 10], 'Agreement moved grain before delivery');
  assert.equal((await inventory())[0].metadata.reservedGrain, 40);
  await day(3); assert.equal((await advanceNegotiation(storyId, 'transit', adapters)).status, 'agreed');
  await day(4); assert.equal((await advanceNegotiation(storyId, 'delivery', adapters)).status, 'delivered');
  assert.equal((await advanceNegotiation(storyId, 'delivery', adapters)).repeated, true);
  assert.deepEqual((await inventory()).map(row => row.amount), [60, 50], 'Repeated settlement changed inventory');
  const publicEvents = await db.execute(sql`select body from story_events where story_id=${storyId} and visibility='public'`);
  assert.equal(publicEvents.length, 1, 'Delivery did not commit exactly one public consequence');
  assert(!/toll|exemption|mandate/i.test(publicEvents[0].body), 'Public delivery revealed private agreement terms');
  await day(14); assert.equal((await advanceNegotiation(storyId, 'expiry', adapters)).status, 'completed');
  assert.equal((await db.select().from(schema.agreements).where(eq(schema.agreements.storyId, storyId)))[0].status, 'fulfilled');
  console.log('PASS faction-settlement-001: offer/counteroffer/accept, reserved inventory, timed delivery once, private terms and concession expiry');
  return { id: 'faction-settlement-001', passed: true, providerCalls: 0, publicConsequences: publicEvents.length, finalInventory: [60, 50], agreementStatus: 'fulfilled' };
}
