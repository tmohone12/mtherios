import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { entities, factionGoals, factionMemberships, factionResources, factions } from '$lib/server/db/schema';
import { MutationError } from '$lib/server/engine/mutationSafety';
import { patchWorldRecord } from '$lib/server/engine/worldRecords';

const resourceKinds = ['military', 'wealth', 'influence', 'information', 'morale'] as const;
const factionIdSchema = z.object({ factionId: z.string().min(1).max(200) }).strict();
const addDetailSchema = z.discriminatedUnion('kind', [
	 z.object({ kind: z.literal('member'), factionId: z.string().min(1).max(200), expectedVersion: z.number().int().positive(), characterId: z.string().min(1).max(200) }).strict(),
	 z.object({ kind: z.literal('goal'), factionId: z.string().min(1).max(200), expectedVersion: z.number().int().positive(), goal: z.string().trim().min(1).max(500) }).strict(),
	 z.object({ kind: z.literal('resource'), factionId: z.string().min(1).max(200), expectedVersion: z.number().int().positive(), resource: z.enum(resourceKinds), amount: z.number().finite().min(0).max(100) }).strict(),
]);
const saveMembersSchema = z.object({
	factionId: z.string().min(1).max(200),
	expectedVersion: z.number().int().positive(),
	characterIds: z.array(z.string().min(1).max(200)).max(2000),
}).strict();

type DbOrTx = ReturnType<typeof getDb> | Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function rows(db: DbOrTx, storyId: string, factionId: string) {
	const [faction] = await db.select().from(factions).where(and(eq(factions.storyId, storyId), eq(factions.id, factionId))).limit(1);
	if (!faction) throw new MutationError('INVALID_REFERENCE', 'Faction not found in this game.');
	const [memberships, goals, resources] = await Promise.all([
		db.select().from(factionMemberships).where(and(eq(factionMemberships.storyId, storyId), eq(factionMemberships.factionId, factionId))),
		db.select().from(factionGoals).where(and(eq(factionGoals.storyId, storyId), eq(factionGoals.factionId, factionId))),
		db.select().from(factionResources).where(and(eq(factionResources.storyId, storyId), eq(factionResources.factionId, factionId))),
	]);
	return { faction, memberships, goals, resources };
}

export async function readFactionProfile(storyId: string, input: unknown) {
	const { factionId } = factionIdSchema.parse(input);
	const { faction, memberships, goals, resources } = await rows(getDb(), storyId, factionId);
	const memberIds = memberships.length
		? memberships.filter(row => row.status === 'active').flatMap(row => row.entityId ? [row.entityId] : [])
		: (Array.isArray(faction.memberEntityIds) ? faction.memberEntityIds : []);
	const uniqueMemberIds = [...new Set(memberIds)];
	const characters = uniqueMemberIds.length
		? await getDb().select({ id: entities.id, name: entities.name }).from(entities)
			.where(and(eq(entities.storyId, storyId), eq(entities.type, 'character'), inArray(entities.id, uniqueMemberIds)))
		: [];
	const names = new Map(characters.map(row => [row.id, row.name]));
	const activeGoals = goals.length
		? goals.filter(row => ['active', 'in_progress'].includes(row.status)).map(row => row.goal)
		: (Array.isArray(faction.goals) ? faction.goals : []);
	const scores: Record<string, number> = {};
	for (const kind of resourceKinds) {
		const normalized = resources.filter(row => row.kind === kind);
		const value = normalized.length === 1 ? normalized[0].amount : (faction.resources as Record<string, unknown>)[kind];
		if (typeof value === 'number' && Number.isFinite(value)) scores[kind] = value;
	}
	return {
		factionId, version: Math.max(faction.serverVersion, ...memberships.map(row => row.serverVersion), ...goals.map(row => row.serverVersion), ...resources.map(row => row.serverVersion)),
		members: uniqueMemberIds.map(id => ({ id, name: names.get(id) ?? id })),
		goals: [...new Set(activeGoals)], resources: scores,
	};
}

export async function addFactionDetail(storyId: string, input: unknown) {
	const request = addDetailSchema.parse(input);
	await getDb().transaction(async tx => {
		const { faction, memberships, goals, resources } = await rows(tx, storyId, request.factionId);
		const version = Math.max(faction.serverVersion, ...memberships.map(row => row.serverVersion), ...goals.map(row => row.serverVersion), ...resources.map(row => row.serverVersion));
		if (version !== request.expectedVersion) throw new MutationError('REVISION_CONFLICT', 'This faction changed. Reload it before adding a detail.');
		const reason = 'Manual faction detail edit.';
		if (request.kind === 'member') {
			const [character] = await tx.select({ id: entities.id }).from(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, request.characterId), eq(entities.type, 'character'))).limit(1);
			if (!character) throw new MutationError('INVALID_REFERENCE', 'Choose a character from this game.');
			const existing = memberships.find(row => row.entityId === request.characterId);
			if (existing?.status === 'active' || (!memberships.length && faction.memberEntityIds.includes(request.characterId))) return;
			if (existing) await patchWorldRecord(storyId, 'factionMemberships', existing.id, { expectedVersion: existing.serverVersion, updates: { status: 'active' }, reason }, undefined, tx);
			else if (memberships.length) {
				const id = `faction_member_${randomUUID()}`;
				await tx.insert(factionMemberships).values({ id, storyId, factionId: faction.id, entityId: request.characterId, status: 'draft' });
				await patchWorldRecord(storyId, 'factionMemberships', id, { expectedVersion: 1, updates: { status: 'active' }, reason }, undefined, tx);
			} else await patchWorldRecord(storyId, 'factions', faction.id, { expectedVersion: faction.serverVersion, updates: { memberEntityIds: [...new Set([...faction.memberEntityIds, request.characterId])] }, jsonMode: 'replace', reason }, undefined, tx);
		} else if (request.kind === 'goal') {
			if (goals.some(row => row.goal === request.goal && ['active', 'in_progress'].includes(row.status)) || (!goals.length && faction.goals.includes(request.goal))) return;
			if (goals.length) {
				const id = `faction_goal_${randomUUID()}`;
				await tx.insert(factionGoals).values({ id, storyId, factionId: faction.id, goal: request.goal, status: 'draft' });
				await patchWorldRecord(storyId, 'factionGoals', id, { expectedVersion: 1, updates: { status: 'active' }, reason }, undefined, tx);
			} else await patchWorldRecord(storyId, 'factions', faction.id, { expectedVersion: faction.serverVersion, updates: { goals: [...new Set([...faction.goals, request.goal])] }, jsonMode: 'replace', reason }, undefined, tx);
		} else {
			const matches = resources.filter(row => row.kind === request.resource);
			if (matches.length > 1) throw new MutationError('INVALID_FIELD', 'Several recorded resources use this kind. Edit those records individually in World Explorer.');
			if (matches[0]?.amount === request.amount && matches[0].status === 'available') return;
			if (matches[0]) await patchWorldRecord(storyId, 'factionResources', matches[0].id, { expectedVersion: matches[0].serverVersion, updates: { amount: request.amount, status: 'available' }, reason }, undefined, tx);
			else {
				const id = `faction_resource_${randomUUID()}`;
				await tx.insert(factionResources).values({ id, storyId, factionId: faction.id, kind: request.resource, name: `${request.resource[0].toUpperCase()}${request.resource.slice(1)} capacity`, status: 'draft' });
				await patchWorldRecord(storyId, 'factionResources', id, { expectedVersion: 1, updates: { amount: request.amount, status: 'available' }, reason }, undefined, tx);
			}
		}
	});
	return readFactionProfile(storyId, { factionId: request.factionId });
}

export async function saveFactionMembers(storyId: string, input: unknown) {
	const request = saveMembersSchema.parse(input);
	const desiredIds = [...new Set(request.characterIds)];
	if (desiredIds.length !== request.characterIds.length) throw new MutationError('INVALID_FIELD', 'Choose each character only once.');
	await getDb().transaction(async tx => {
		const { faction, memberships, goals, resources } = await rows(tx, storyId, request.factionId);
		const version = Math.max(faction.serverVersion, ...memberships.map(row => row.serverVersion), ...goals.map(row => row.serverVersion), ...resources.map(row => row.serverVersion));
		if (version !== request.expectedVersion) throw new MutationError('REVISION_CONFLICT', 'This faction changed. Reload it before saving members.');
		if (desiredIds.length) {
			const found = await tx.select({ id: entities.id }).from(entities)
				.where(and(eq(entities.storyId, storyId), eq(entities.type, 'character'), inArray(entities.id, desiredIds)));
			if (found.length !== desiredIds.length) throw new MutationError('INVALID_REFERENCE', 'Choose characters from this game.');
		}
		const reason = 'Manual faction members edit.';
		if (!memberships.length) {
			if (desiredIds.length === faction.memberEntityIds.length && desiredIds.every(id => faction.memberEntityIds.includes(id))) return;
			await patchWorldRecord(storyId, 'factions', faction.id, { expectedVersion: faction.serverVersion, updates: { memberEntityIds: desiredIds }, jsonMode: 'replace', reason }, undefined, tx);
			return;
		}
		const desired = new Set(desiredIds);
		const active = new Set(memberships.filter(row => row.status === 'active').map(row => row.entityId));
		for (const row of memberships) {
			if (row.status === 'active' && row.entityId && !desired.has(row.entityId))
				await patchWorldRecord(storyId, 'factionMemberships', row.id, { expectedVersion: row.serverVersion, updates: { status: 'inactive' }, reason }, undefined, tx);
		}
		for (const id of desiredIds) {
			if (active.has(id)) continue;
			const existing = memberships.find(row => row.entityId === id && row.status !== 'active');
			if (existing) await patchWorldRecord(storyId, 'factionMemberships', existing.id, { expectedVersion: existing.serverVersion, updates: { status: 'active' }, reason }, undefined, tx);
			else {
				const membershipId = `faction_member_${randomUUID()}`;
				await tx.insert(factionMemberships).values({ id: membershipId, storyId, factionId: faction.id, entityId: id, status: 'draft' });
				await patchWorldRecord(storyId, 'factionMemberships', membershipId, { expectedVersion: 1, updates: { status: 'active' }, reason }, undefined, tx);
			}
		}
	});
	return readFactionProfile(storyId, { factionId: request.factionId });
}
