// Provider-free integration qualification against a disposable imported campaign.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base = process.env.LOCATION_LORE_BASE_URL ?? 'http://127.0.0.1:5174';
const created = [];
const checks = [];
const command = async (storyId, command, args = {}, expectSuccess = true) => {
  const res = await fetch(`${base}/api/engine/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storyId, command, args }) });
  const body = await res.json();
  if (expectSuccess) assert.equal(body.status, 'succeeded', JSON.stringify(body.error));
  return expectSuccess ? body.result : body;
};
const lore = (scope, origin = 'foundation') => ({ version: 1, category: 'access', scope, origin, salience: 'core', exceptionToFactIds: [] });
const fixture = { worldDatabase: {
  story: { id: 'location_qualification', title: 'Location lore qualification — disposable', currentTurn: 20, currentLocationId: 'old-room' },
  entries: [{ id: 'source', type: 'narration', position: 0, content: '[Time 08:00 | Location: Port Alder, harbor office]\nThe posted rule requires a stamped pass.' }],
  entities: [
    { id: 'city', name: 'Port Alder', type: 'location', state: { locationKind: 'city', government: 'The current harbor marshal administers the port.' } },
    { id: 'room', name: 'Harbor office', type: 'location', state: { locationKind: 'room' }, sourceEntryIds: ['source'] },
    { id: 'old-room', name: 'Harbor office duplicate', type: 'location', state: { current: true }, sourceEntryIds: ['source'] },
    { id: 'visitor', name: 'Courier', type: 'character', state: { currentLocationId: 'old-room', currentLocation: 'Harbor office' } },
    { id: 'gate', name: 'Harbor gate', type: 'location', state: { connections: [{ targetLocationId: 'old-room', targetName: 'Harbor office', travelTimeMinutes: 2 }] } },
    { id: 'secret', name: 'Concealed cellar', type: 'location', visibility: 'secret' },
  ],
  relationships: [
    { id: 'inside', type: 'part-of', sourceEntityId: 'room', targetEntityId: 'city', metadata: { validFromTurn: 0 } },
    { id: 'secret-edge', type: 'part-of', sourceEntityId: 'secret', targetEntityId: 'city' },
  ],
  facts: [
    { id: 'old-rule', subjectEntityId: 'city', title: 'Old pass rule', statement: 'A stamped pass is required.', status: 'superseded', metadata: { validFromTurn: 0, validToTurn: 10, locationLore: lore('descendants') }, sourceEntryIds: ['source'] },
    { id: 'rule', subjectEntityId: 'city', title: 'Harbor access', statement: 'A stamped pass is required except for registered couriers.', metadata: { validFromTurn: 10, supersedesFactIds: ['old-rule'], locationLore: lore('descendants', 'campaign') }, sourceEntryIds: ['source'] },
    { id: 'exception', subjectEntityId: 'room', title: 'Office access', statement: 'Visitors collecting a pass may enter the public counter during office hours.', metadata: { validFromTurn: 10, locationLore: { ...lore('self', 'campaign'), exceptionToFactIds: ['rule'] } }, sourceEntryIds: ['source'] },
    { id: 'secret-rule', subjectEntityId: 'city', title: 'Secret', statement: 'A concealed tunnel.', visibility: 'secret', metadata: { locationLore: lore('descendants') } },
  ],
  events: [{ id: 'event', title: 'Pass collected', body: 'The courier collected a pass.', locationId: 'old-room', locationIds: ['old-room'], sourceEntryIds: ['source'] }],
  memoryNodes: [{ id: 'memory', title: 'Office visit', type: 'event', content: 'The courier collected a pass.', locationId: 'old-room', sourceEntryIds: ['source'] }],
  factions: [{ id: 'faction', name: 'Harbor authority', territoryIds: ['old-room'] }],
  factionResources: [{ id: 'resource', factionId: 'faction', kind: 'supplies', name: 'Pass stock', locationId: 'old-room' }],
} };
try {
  const imported = await command('__app__', 'database.importWorldBundle', { bundle: fixture, options: { preserveIds: false, syncWiki: false, sourceProjectId: 'shelf_default', destinationProjectId: 'shelf_default' } });
  created.push(imported.storyId);
  const storyId = imported.storyId;
  let exported = await command(storyId, 'story.export');
  let tables = exported.worldDatabase;
  assert.ok(tables, 'Canonical worldDatabase must be exported');
  const byName = name => tables.entities.find(row => row.name === name).id;
  const room = byName('Harbor office'), oldRoom = byName('Harbor office duplicate'), city = byName('Port Alder');
  const current = await command(storyId, 'world.location.get', { locationId: room });
  assert.equal(current.context.chain.length, 2);
  assert.equal(current.context.facts.length, 2);
  assert.ok(current.context.facts.some(fact => fact.title === 'Harbor access' && fact.inherited));
  assert.equal((await command(storyId, 'world.location.get', { locationId: city })).children.some(child => child.name === 'Concealed cellar'), false);
  const historical = await command(storyId, 'world.location.get', { locationId: room, atTurn: 5 });
  assert.equal(historical.context.facts[0].title, 'Old pass rule');
  assert.ok(historical.context.chain.every(place => place.description === null && Object.keys(place.state).length === 0));
  checks.push('Current and historical scoped lore, conditional exception and secret filtering survive import with new IDs.');
  const rejected = await command(storyId, 'world.location.save', { locationId: city, expectedVersion: current.storyVersion, parentLocationId: room, reason: 'Qualification cycle rejection' }, false);
  assert.equal(rejected.status, 'failed');
  const wrongMerge = await command(storyId, 'entity.merge', { keepEntityId: room, mergeEntityId: city }, false);
  assert.equal(wrongMerge.status, 'failed');
  await command(storyId, 'entity.merge', { keepEntityId: room, mergeEntityId: oldRoom, expectedVersion: current.storyVersion, reason: 'Qualification duplicate with typed location references' });
  exported = await command(storyId, 'story.export'); tables = exported.worldDatabase;
  assert.equal(tables.story.currentLocationId, room);
  assert.equal(tables.entities.find(row => row.name === 'Courier').state.currentLocationId, room);
  assert.equal(tables.entities.find(row => row.name === 'Harbor gate').state.connections[0].targetLocationId, room);
  assert.equal(tables.entities.find(row => row.id === oldRoom).metadata.mergedInto, room);
  assert.equal(tables.entities.find(row => row.id === oldRoom).status, 'inactive');
  assert.equal((tables.events ?? tables.storyEvents)[0].locationId, room);
  assert.deepEqual((tables.events ?? tables.storyEvents)[0].locationIds, [room]);
  assert.equal(tables.memoryNodes[0].locationId, room);
  assert.equal(tables.factionResources[0].locationId, room);
  assert.deepEqual(tables.factions[0].territoryIds, [room]);
  checks.push('Location merge preserves source records and remaps scene, actor, route, event, memory, territory and resource pointers; cyclic merge is rejected.');
  const beforeVersion = tables.story.serverVersion;
  await command(storyId, 'entity.merge', { keepEntityId: room, mergeEntityId: oldRoom });
  assert.equal((await command(storyId, 'world.location.get', { locationId: room })).storyVersion, beforeVersion);
  const copy = await command('__app__', 'database.importWorldBundle', { bundle: exported, options: { preserveIds: false, syncWiki: false, sourceProjectId: exported.shelf.id, destinationProjectId: 'shelf_default' } });
  created.push(copy.storyId);
  const copied = (await command(copy.storyId, 'story.export')).worldDatabase;
  const copiedRoom = copied.entities.find(row => row.name === 'Harbor office').id;
  const roundTrip = await command(copy.storyId, 'world.location.get', { locationId: copiedRoom });
  assert.equal(roundTrip.context.chain.length, 2);
  assert.equal(roundTrip.context.facts.length, 2);
  assert.equal(copied.story.currentLocationId, copiedRoom);
	assert.equal(copied.entities.find(row => row.name === 'Harbor office duplicate').metadata.mergedInto, copiedRoom);
  const rule = copied.facts.find(fact => fact.title === 'Harbor access');
  assert.ok(copied.entries.some(entry => rule.sourceEntryIds.includes(entry.id)));
  assert.ok(copied.facts.find(fact => fact.title === 'Office access').metadata.locationLore.exceptionToFactIds.includes(rule.id));
  checks.push('Actual export and second remapped import retain owner, ancestry, scene, exception, supersession, transcript sources and historical views. Repeated merge is idempotent.');
  fs.writeFileSync('docs/evidence/location-lore-roundtrip-qualification-2026-09-07.json', JSON.stringify({ completedAt: new Date().toISOString(), checks, disposableStoryIds: created }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  for (const storyId of created) await command(storyId, 'story.delete', { mode: 'purge' });
}
