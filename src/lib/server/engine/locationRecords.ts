import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { entities, facts, relationships, sourceRefs, statePatches, stories } from '$lib/server/db/schema';
import { locationSaveArgsSchema, locationWorkspaceArgsSchema } from '$lib/contracts/locationLore';
import { isEffectiveContainment, loadLocationLore } from '$lib/server/memory/locationLore';
import { enqueueBackendJob, enqueueStoryVaultSyncJob } from '$lib/server/jobs/outbox';
import type { z } from 'zod';

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function sourceIds(...values: string[][]): string[] { return [...new Set(values.flat())]; }
type Edge = Parameters<typeof isEffectiveContainment>[0];
type Place = Pick<typeof entities.$inferSelect, 'id' | 'storyId' | 'type' | 'status'>;

/** Call while holding the story lock, including from other canonical relationship writers. */
export function validateLocationParent(input: { storyId: string; childId: string; parentId: string | null; turn: number; places: Place[]; relationships: Edge[] }): void {
	const places = new Map(input.places.filter(place => place.storyId === input.storyId && place.type === 'location' && place.status === 'active').map(place => [place.id, place]));
	if (!places.has(input.childId)) throw new Error('The child must be an active location in this story.');
	if (input.parentId === null) return;
	if (!places.has(input.parentId)) throw new Error('The parent must be an active location in this story.');
	const seen = new Set([input.childId]);
	let current: string | null = input.parentId;
	while (current) {
		if (seen.has(current)) throw new Error('This parent would create a location cycle.');
		seen.add(current);
		const parents = input.relationships.filter(edge => edge.storyId === input.storyId && edge.sourceEntityId === current && isEffectiveContainment(edge, input.turn));
		if (parents.length > 1) throw new Error('The proposed parent has an ambiguous ancestry; reconcile it first.');
		current = parents[0]?.targetEntityId ?? null;
		if (current && !places.has(current)) throw new Error('The proposed ancestry contains a missing or invalid location.');
	}
}

export async function getLocationWorkspace(storyId: string, rawArgs: z.input<typeof locationWorkspaceArgsSchema>) {
	const args = locationWorkspaceArgsSchema.parse(rawArgs);
	const db = getDb();
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error('Story not found.');
	const [location] = await db.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, args.locationId), eq(entities.type, 'location'))).limit(1);
	if (!location) throw new Error('Location not found.');
	const atTurn = args.atTurn ?? story.currentTurn;
	const context = await loadLocationLore({ storyId, locationId: location.id, atTurn, db });
	// Entity prose/state are current snapshots, not historical evidence. Dated rules and
	// containment remain available without projecting today's government into the past.
	if (atTurn !== story.currentTurn) context.chain = context.chain.map(place => ({ ...place, description: null, state: {} }));
	const offset = Math.max(0, Number.parseInt(args.cursor ?? '0', 10) || 0);
	// Filter visibility before pagination so names and counts do not expose hidden children.
	const childRows = await db.select({ location: entities, relationship: relationships }).from(relationships)
		.innerJoin(entities, and(eq(entities.id, relationships.sourceEntityId), eq(entities.storyId, storyId)))
		.where(and(eq(relationships.storyId, storyId), eq(relationships.targetEntityId, location.id), eq(relationships.type, 'part-of'), eq(entities.type, 'location'), eq(entities.status, 'active'), inArray(entities.visibility, ['public', 'player_known'])))
		.orderBy(asc(entities.name), asc(entities.id));
	const children = childRows.filter(row => isEffectiveContainment(row.relationship, atTurn) && record(row.relationship.metadata).visibility !== 'secret'
		&& record(row.location.metadata).visibility !== 'secret' && !record(row.location.metadata).mergedInto)
		.map(row => ({ id: row.location.id, name: row.location.name, kind: record(row.location.state).locationKind ?? null }));
	const ownFacts = await db.select().from(facts).where(and(eq(facts.storyId, storyId), eq(facts.subjectEntityId, location.id), inArray(facts.visibility, ['public', 'player_known'])))
		.orderBy(asc(facts.id));
	return { location, storyVersion: story.serverVersion, currentTurn: story.currentTurn, context,
		children: children.slice(offset, offset + 50), nextCursor: children.length > offset + 50 ? String(offset + 50) : null,
		ownFacts: ownFacts.filter(fact => record(fact.metadata).visibility !== 'secret' && record(fact.metadata).nonCanon !== true),
	};
}

export async function saveLocationWorkspace(storyId: string, rawArgs: z.input<typeof locationSaveArgsSchema>) {
	const args = locationSaveArgsSchema.parse(rawArgs);
	const result = await getDb().transaction(async tx => {
		// All hierarchy and lore mutations share one lock and revision boundary.
		const [story] = await tx.select().from(stories).where(eq(stories.id, storyId)).for('update').limit(1);
		if (!story) throw new Error('Story not found.');
		if (story.serverVersion !== args.expectedVersion) throw new Error('The story changed since this location was opened. Reload the location before saving.');
		const [location] = await tx.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, args.locationId), eq(entities.type, 'location'))).limit(1);
		if (!location || location.status !== 'active') throw new Error('Active location not found.');
		const timestamp = new Date().toISOString();
		const version = story.serverVersion + 1;
		const patchId = `location_patch_${crypto.randomUUID()}`;
		const operations: Array<Record<string, unknown>> = [];
		const changed: Array<{ table: string; id: string; field: string }> = [];
		if (args.parentLocationId !== undefined) {
			const [places, edges] = await Promise.all([
				tx.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.type, 'location'))),
				tx.select().from(relationships).where(and(eq(relationships.storyId, storyId), eq(relationships.type, 'part-of'))),
			]);
			validateLocationParent({ storyId, childId: location.id, parentId: args.parentLocationId, turn: story.currentTurn, places, relationships: edges });
			const previous = edges.filter(edge => edge.sourceEntityId === location.id && isEffectiveContainment(edge, story.currentTurn));
			if (!(previous.length === 1 && previous[0].targetEntityId === args.parentLocationId)) {
				for (const edge of previous) {
					await tx.update(relationships).set({ metadata: { ...record(edge.metadata), validToTurn: story.currentTurn }, sourcePatchIds: sourceIds(edge.sourcePatchIds, [patchId]), serverVersion: version, updatedAt: timestamp }).where(eq(relationships.id, edge.id));
					changed.push({ table: 'relationships', id: edge.id, field: 'metadata' });
				}
				if (args.parentLocationId) {
					const id = `location_parent_${crypto.randomUUID()}`;
					await tx.insert(relationships).values({ id, storyId, sourceEntityId: location.id, targetEntityId: args.parentLocationId, type: 'part-of', bidirectional: false,
						metadata: { validFromTurn: story.currentTurn }, sourcePatchIds: [patchId], serverVersion: version, createdAt: timestamp, updatedAt: timestamp });
					changed.push({ table: 'relationships', id, field: 'targetEntityId' });
				}
				operations.push({ op: 'replace', path: `/locations/${location.id}/parent`, before: previous.map(edge => edge.targetEntityId), value: args.parentLocationId });
			}
		}
		if (args.locationKind !== undefined) {
			const state = { ...record(location.state), locationKind: args.locationKind };
			await tx.update(entities).set({ state, sourcePatchIds: sourceIds(location.sourcePatchIds, [patchId]), serverVersion: version, updatedAt: timestamp }).where(eq(entities.id, location.id));
			operations.push({ op: 'replace', path: `/entities/${location.id}/state/locationKind`, before: record(location.state).locationKind ?? null, value: args.locationKind });
			changed.push({ table: 'entities', id: location.id, field: 'state.locationKind' });
		}
		if (args.lore) {
			const draft = args.lore;
			const validFromTurn = draft.validFromTurn ?? story.currentTurn;
			if (draft.validToTurn != null && draft.validToTurn <= validFromTurn) throw new Error('A lore rule must end after its effective start turn.');
			const [previous] = draft.id ? await tx.select().from(facts).where(and(eq(facts.storyId, storyId), eq(facts.id, draft.id), eq(facts.subjectEntityId, location.id))).limit(1) : [];
			if (draft.id && (!previous || previous.status !== 'active')) throw new Error('The lore rule must be an active fact owned by this location.');
			if (previous && typeof record(previous.metadata).validFromTurn === 'number' && validFromTurn < Number(record(previous.metadata).validFromTurn)) throw new Error('A revision cannot start before the rule it revises.');
			const ancestry = await loadLocationLore({ storyId, locationId: location.id, atTurn: validFromTurn, db: tx });
			const ancestors = new Set(ancestry.chain.filter(place => place.id !== location.id).map(place => place.id));
			if (draft.locationLore.exceptionToFactIds.length) {
				const targets = await tx.select().from(facts).where(and(eq(facts.storyId, storyId), inArray(facts.id, draft.locationLore.exceptionToFactIds)));
				if (targets.length !== new Set(draft.locationLore.exceptionToFactIds).size || targets.some(fact => !fact.subjectEntityId || !ancestors.has(fact.subjectEntityId)
					|| !ancestry.facts.some(applicable => applicable.id === fact.id))) throw new Error('Local exceptions must reference applicable accepted rules belonging to an established containing place.');
			}
			const id = `location_fact_${crypto.randomUUID()}`;
			if (previous) {
				await tx.update(facts).set({ status: 'superseded', metadata: { ...record(previous.metadata), validToTurn: validFromTurn }, sourcePatchIds: sourceIds(previous.sourcePatchIds, [patchId]), serverVersion: version, updatedAt: timestamp }).where(eq(facts.id, previous.id));
				changed.push({ table: 'facts', id: previous.id, field: 'metadata' });
			}
			const metadata = { ...record(previous?.metadata), locationLore: draft.locationLore, validFromTurn, validToTurn: draft.validToTurn ?? null,
				...(previous ? { supersedesId: previous.id } : {}) };
			await tx.insert(facts).values({ id, storyId, subjectEntityId: location.id, type: previous?.type ?? 'identity', title: draft.title, statement: draft.statement,
				status: 'active', visibility: previous?.visibility ?? 'player_known', confidence: 1, metadata,
				sourceEntryIds: previous?.sourceEntryIds ?? [], sourceEventIds: previous?.sourceEventIds ?? [], sourcePatchIds: sourceIds(previous?.sourcePatchIds ?? [], [patchId]), serverVersion: version, createdAt: timestamp, updatedAt: timestamp });
			operations.push({ op: 'add', path: `/facts/${id}`, before: previous ?? null, value: { title: draft.title, statement: draft.statement, metadata, subjectEntityId: location.id } });
			changed.push({ table: 'facts', id, field: 'statement' });
		}
		await tx.insert(statePatches).values({ id: patchId, storyId, operations, reason: args.reason, status: 'applied', serverVersion: version, createdAt: timestamp, updatedAt: timestamp });
		for (const target of changed) await tx.insert(sourceRefs).values({ id: `location_source_${crypto.randomUUID()}`, storyId,
			sourceType: 'state_patch', sourceId: patchId, targetTable: target.table, targetRecordId: target.id, targetRecordField: target.field,
			sourceField: 'manual_location_edit', rationale: args.reason, confidence: 1, serverVersion: version, createdAt: timestamp, updatedAt: timestamp });
		await tx.update(stories).set({ serverVersion: version, updatedAt: timestamp }).where(eq(stories.id, storyId));
		await enqueueStoryVaultSyncJob({ storyId, serverVersion: version, reason: 'location-lore-edit' }, tx);
		await enqueueBackendJob({ storyId, type: 'index_canonical_records', dedupeKey: `location-lore-index-${storyId}-${version}`,
			payload: { recordTypes: ['entities', 'relationships', 'facts'], reason: 'location_lore_edit' }, maxAttempts: 3 }, tx);
		return { storyId, locationId: location.id, serverVersion: version, patchId };
	});
	return result;
}
