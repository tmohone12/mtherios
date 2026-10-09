import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { addFactionDetail, readFactionProfile, saveFactionMembers } from './authoring';

const integration = process.env.MYTHENGINE_FACTION_AUTHORING_INTEGRATION === '1' ? test : test.skip;

integration('adds faction details through the effective base and normalized paths', async () => {
	const db = getDb();
	const suffix = randomUUID();
	const shelfId = `shelf_faction_test_${suffix}`;
	const storyId = `story_faction_test_${suffix}`;
	const factionId = `faction_base_${suffix}`;
	const normalizedId = `faction_normalized_${suffix}`;
	const characterId = `character_one_${suffix}`;
	const secondCharacterId = `character_two_${suffix}`;
	try {
		await db.execute(sql`insert into shelves(id,name,slug) values(${shelfId},'Faction authoring test',${shelfId})`);
		await db.execute(sql`insert into stories(id,shelf_id,title) values(${storyId},${shelfId},'Faction authoring test')`);
		await db.execute(sql`insert into entities(id,story_id,type,name) values
			(${characterId},${storyId},'character','First envoy'),(${secondCharacterId},${storyId},'character','Second envoy')`);
		await db.execute(sql`insert into factions(id,story_id,name) values(${factionId},${storyId},'Base guild')`);
		await db.execute(sql`insert into factions(id,story_id,name,member_entity_ids,goals,resources) values
			(${normalizedId},${storyId},'Detailed guild',${JSON.stringify([characterId])}::jsonb,${JSON.stringify(['Historical objective'])}::jsonb,${JSON.stringify({ wealth: 50 })}::jsonb)`);
		await db.execute(sql`insert into faction_memberships(id,story_id,faction_id,entity_id) values(${`member_${suffix}`},${storyId},${normalizedId},${characterId})`);
		await db.execute(sql`insert into faction_goals(id,story_id,faction_id,goal) values(${`goal_${suffix}`},${storyId},${normalizedId},'Current objective')`);
		await db.execute(sql`insert into faction_resources(id,story_id,faction_id,kind,name,amount,visibility) values(${`resource_${suffix}`},${storyId},${normalizedId},'wealth','Private treasury',22,'secret')`);

		let base = await readFactionProfile(storyId, { factionId });
		const staleVersion = base.version;
		base = await addFactionDetail(storyId, { kind: 'member', factionId, expectedVersion: base.version, characterId });
		await expect(addFactionDetail(storyId, { kind: 'goal', factionId, expectedVersion: staleVersion, goal: 'Stale goal' })).rejects.toThrow('changed');
		base = await addFactionDetail(storyId, { kind: 'goal', factionId, expectedVersion: base.version, goal: 'Open the eastern road' });
		base = await addFactionDetail(storyId, { kind: 'resource', factionId, expectedVersion: base.version, resource: 'military', amount: 70 });
		expect(base).toMatchObject({ members: [{ id: characterId, name: 'First envoy' }], goals: ['Open the eastern road'], resources: { military: 70 } });

		let detailed = await readFactionProfile(storyId, { factionId: normalizedId });
		detailed = await addFactionDetail(storyId, { kind: 'member', factionId: normalizedId, expectedVersion: detailed.version, characterId: secondCharacterId });
		detailed = await addFactionDetail(storyId, { kind: 'goal', factionId: normalizedId, expectedVersion: detailed.version, goal: 'Secure the pass' });
		detailed = await addFactionDetail(storyId, { kind: 'resource', factionId: normalizedId, expectedVersion: detailed.version, resource: 'wealth', amount: 65 });
		expect(detailed.members.map(member => member.id)).toEqual([characterId, secondCharacterId]);
		expect(detailed.goals).toEqual(['Current objective', 'Secure the pass']);
		expect(detailed.resources.wealth).toBe(65);
		const [stored] = await db.execute(sql`select member_entity_ids,goals,resources from factions where id=${normalizedId}`);
		expect(stored.member_entity_ids).toEqual([characterId]);
		expect(stored.goals).toEqual(['Historical objective']);
		expect(stored.resources).toEqual({ wealth: 50 });
		const [resource] = await db.execute(sql`select amount,visibility from faction_resources where faction_id=${normalizedId}`);
		expect(resource).toMatchObject({ amount: 65, visibility: 'secret' });
		base = await saveFactionMembers(storyId, { factionId, expectedVersion: base.version, characterIds: [] });
		expect(base.members).toEqual([]);
		detailed = await saveFactionMembers(storyId, { factionId: normalizedId, expectedVersion: detailed.version, characterIds: [secondCharacterId] });
		expect(detailed.members.map(member => member.id)).toEqual([secondCharacterId]);
		const [removed] = await db.execute(sql`select status from faction_memberships where faction_id=${normalizedId} and entity_id=${characterId}`);
		expect(removed.status).toBe('inactive');
		detailed = await saveFactionMembers(storyId, { factionId: normalizedId, expectedVersion: detailed.version, characterIds: [] });
		expect(detailed.members).toEqual([]);
		await expect(saveFactionMembers(storyId, { factionId: normalizedId, expectedVersion: detailed.version, characterIds: [characterId, characterId] })).rejects.toThrow('only once');
		await expect(saveFactionMembers(storyId, { factionId: normalizedId, expectedVersion: detailed.version, characterIds: ['character_elsewhere'] })).rejects.toThrow('this game');
		detailed = await saveFactionMembers(storyId, { factionId: normalizedId, expectedVersion: detailed.version, characterIds: [characterId] });
		expect(detailed.members.map(member => member.id)).toEqual([characterId]);
	} finally {
		await db.execute(sql`delete from shelves where id=${shelfId}`);
	}
});

afterAll(async () => { if (process.env.MYTHENGINE_FACTION_AUTHORING_INTEGRATION === '1') await closeDb(); });
