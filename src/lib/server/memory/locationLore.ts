import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { entities, facts, relationships } from '$lib/server/db/schema';
import { locationKindSchema, locationLoreSchema, type LocationLoreContext, type LocationContextFact } from '$lib/contracts/locationLore';
import { countTokens } from '$lib/utils/tokens';

type Place = Pick<typeof entities.$inferSelect, 'id' | 'storyId' | 'type' | 'name' | 'description' | 'status' | 'visibility' | 'state' | 'metadata' | 'sourceEntryIds'>;
type Edge = Pick<typeof relationships.$inferSelect, 'id' | 'storyId' | 'sourceEntityId' | 'targetEntityId' | 'type' | 'bidirectional' | 'metadata'>;
type Fact = Pick<typeof facts.$inferSelect, 'id' | 'storyId' | 'subjectEntityId' | 'type' | 'title' | 'statement' | 'status' | 'visibility' | 'metadata' | 'sourceEntryIds' | 'sourceEventIds' | 'sourcePatchIds'>;
type Reader = Pick<ReturnType<typeof getDb>, 'select'>;
const MAX_ANCESTORS = 8;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function ids(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function publicRecord(visibility: string, metadata: unknown): boolean {
	const meta = record(metadata);
	return ['public', 'player_known'].includes(visibility) && meta.visibility !== 'secret' && meta.nonCanon !== true;
}
function atTurn(metadata: unknown, turn: number): boolean {
	const meta = record(metadata);
	return (meta.validFromTurn == null || (Number.isInteger(meta.validFromTurn) && Number(meta.validFromTurn) <= turn))
		&& (meta.validToTurn == null || (Number.isInteger(meta.validToTurn) && Number(meta.validToTurn) > turn));
}
export function isEffectiveContainment(edge: Edge, turn: number): boolean {
	const meta = record(edge.metadata);
	return edge.type === 'part-of' && !edge.bidirectional && atTurn(meta, turn)
		&& (meta.status == null || meta.status === 'active') && meta.nonCanon !== true;
}
function usablePlace(place: Place, storyId: string): boolean {
	return place.storyId === storyId && place.type === 'location' && place.status === 'active'
		&& !record(place.metadata).mergedInto && publicRecord(place.visibility, place.metadata);
}

/** The same deterministic resolver serves live preparation, previews and scene checks. */
export function resolveLocationLore(input: {
	storyId: string; locationId: string | null; atTurn: number;
	places: Place[]; relationships: Edge[]; facts: Fact[];
}): LocationLoreContext {
	const result: LocationLoreContext = { locationId: null, atTurn: input.atTurn, chain: [], facts: [], relationshipIds: [], supersededFactIds: [], exceptedFactIds: [], warnings: [], incomplete: false };
	if (!input.locationId) return result;
	const places = new Map(input.places.filter(place => usablePlace(place, input.storyId)).map(place => [place.id, place]));
	let place = places.get(input.locationId);
	if (!place) return result;
	result.locationId = place.id;
	const seen = new Set<string>();
	while (place) {
		seen.add(place.id);
		const rawState = record(place.state);
		const state = Object.fromEntries(['locationKind', 'region', 'terrain', 'politicalForm', 'politicalOrder', 'government', 'socialRules', 'economy', 'customs']
			.filter(key => typeof rawState[key] === 'string').map(key => [key, rawState[key]]));
		result.chain.unshift({ id: place.id, name: place.name, kind: locationKindSchema.safeParse(state.locationKind).data ?? null,
			description: place.description, state, sourceEntryIds: place.sourceEntryIds });
		const edges = input.relationships.filter(edge => edge.storyId === input.storyId && edge.sourceEntityId === place!.id && isEffectiveContainment(edge, input.atTurn));
		if (!edges.length) break;
		if (edges.length > 1) { result.warnings.push('The location hierarchy has multiple active parents and needs review.'); result.incomplete = true; break; }
		const edge = edges[0];
		if (record(edge.metadata).visibility === 'secret') break;
		if (seen.has(edge.targetEntityId)) { result.warnings.push('The location hierarchy contains a cycle and needs review.'); result.incomplete = true; break; }
		if (result.chain.length > MAX_ANCESTORS) { result.warnings.push('The location hierarchy exceeds the supported context depth.'); result.incomplete = true; break; }
		if (!places.has(edge.targetEntityId)) break;
		result.relationshipIds.unshift(edge.id);
		place = places.get(edge.targetEntityId);
	}
	const depth = new Map(result.chain.map((item, index) => [item.id, index]));
	const eligible: Array<{ row: Fact; value: LocationContextFact }> = [];
	for (const row of input.facts) {
		if (row.storyId !== input.storyId || !row.subjectEntityId || !depth.has(row.subjectEntityId)
			|| !publicRecord(row.visibility, row.metadata) || ['belief', 'proposal'].includes(row.type)) continue;
		const lore = locationLoreSchema.safeParse(record(row.metadata).locationLore);
		if (!lore.success) continue; // Untagged legacy lore stays readable at its owner; scope is never guessed.
		const inherited = row.subjectEntityId !== input.locationId;
		if (inherited && lore.data.scope !== 'descendants') continue;
		const meta = record(row.metadata);
		// A superseded record is valid in a dated historical interval, never as an undated current rule.
		if (!(row.status === 'active' || (row.status === 'superseded' && Number.isInteger(meta.validToTurn))) || !atTurn(meta, input.atTurn)) continue;
		eligible.push({ row, value: { id: row.id, ownerId: row.subjectEntityId, title: row.title, statement: row.statement,
			lore: lore.data, inherited, sourceEntryIds: row.sourceEntryIds, sourceEventIds: row.sourceEventIds, sourcePatchIds: row.sourcePatchIds } });
	}
	const superseded = new Set<string>();
	const excepted = new Set<string>();
	for (const { row, value } of eligible) {
		const meta = record(row.metadata);
		for (const replacedId of [...ids(meta.supersedesIds), ...(typeof meta.supersedesId === 'string' ? [meta.supersedesId] : [])]) {
			const replaced = eligible.find(item => item.row.id === replacedId)?.value;
			if (replaced && replaced.id !== value.id && replaced.ownerId === value.ownerId
				&& replaced.lore.scope === value.lore.scope && replaced.lore.category === value.lore.category
				&& !(value.lore.origin === 'foundation' && replaced.lore.origin === 'campaign')) superseded.add(replacedId);
		}
	}
	for (const { value } of eligible.filter(item => !superseded.has(item.row.id))) {
		for (const targetId of value.lore.exceptionToFactIds) {
			const target = eligible.find(item => item.row.id === targetId)?.value;
			if (target && target.id !== value.id && depth.get(target.ownerId)! < depth.get(value.ownerId)!) excepted.add(targetId);
		}
	}
	result.supersededFactIds = [...superseded];
	result.exceptedFactIds = [...excepted];
	// Keep the complete base rule alongside a conditional exception. The exception is not a repeal.
	result.facts = eligible.filter(item => !superseded.has(item.row.id)).map(item => item.value);
	return result;
}

/** Bounded direct reads do not depend on a bootstrap page, search index or the wording of an action. */
export async function loadLocationLore(input: { storyId: string; locationId: string | null; atTurn: number; db?: Reader }): Promise<LocationLoreContext> {
	const db = input.db ?? getDb();
	const places: Place[] = [];
	const edges: Edge[] = [];
	let parentOverflow = false;
	let currentId = input.locationId;
	for (let depth = 0; currentId && depth <= MAX_ANCESTORS; depth++) {
		const rows = await db.select().from(entities).where(and(eq(entities.storyId, input.storyId), eq(entities.id, currentId), eq(entities.type, 'location'))).limit(1);
		const place = rows.find(row => row.id === currentId);
		if (!place || !usablePlace(place, input.storyId)) break;
		places.push(place);
		const parents = await db.select().from(relationships).where(and(eq(relationships.storyId, input.storyId), eq(relationships.sourceEntityId, currentId), eq(relationships.type, 'part-of'))).orderBy(asc(relationships.id)).limit(101);
		if (parents.length > 100) { parentOverflow = true; break; }
		edges.push(...parents);
		const active = parents.filter(edge => isEffectiveContainment(edge, input.atTurn));
		if (active.length !== 1 || record(active[0].metadata).visibility === 'secret' || places.some(item => item.id === active[0].targetEntityId)) break;
		currentId = active[0].targetEntityId;
	}
	const factRows = places.length ? await db.select().from(facts).where(and(eq(facts.storyId, input.storyId), inArray(facts.subjectEntityId, places.map(place => place.id)), inArray(facts.visibility, ['public', 'player_known'])))
		.orderBy(asc(facts.id)).limit(401) : [];
	const result = resolveLocationLore({ ...input, places, relationships: edges, facts: factRows.slice(0, 400) });
	if (parentOverflow) { result.incomplete = true; result.warnings.push('Location ancestry exceeds the bounded read; review its parent history before relying on inherited rules.'); }
	if (factRows.length > 400) { result.incomplete = true; result.warnings.push('Location lore exceeds the bounded read; review the omitted rules before resolving a lore-dependent action.'); }
	return result;
}

/** Whole claims and paragraphs only: truncating a qualifier can reverse a rule. */
export function renderLocationLore(context: LocationLoreContext | null | undefined, query = '', tokenBudget = 1200) {
	const records: Array<{ kind: string; id: string; text: string }> = [];
	const omittedFactIds: string[] = [];
	if (!context?.chain.length) return { text: '', records, omittedFactIds, incomplete: false };
	const parts = ['Location and inherited lore:', `Scene containment: ${context.chain.map(place => place.name).join(' > ')}.`,
		'These places contain the scene; containment does not imply co-presence or travel time. Apply rules with their stated conditions and sources. Customs describe expectations, not guaranteed individual behavior.'];
	const add = (kind: string, id: string, text: string) => {
		if (countTokens([...parts, text].join('\n')) > tokenBudget - 45) return false;
		parts.push(text); records.push({ kind, id, text }); return true;
	};
	const city = context.chain.findLast(place => place.kind === 'city') ?? context.chain[0];
	// Current authority fields are concise established canon, independent of a longer article's history.
	const authority = ['politicalForm', 'politicalOrder', 'government', 'socialRules', 'economy', 'customs']
		.flatMap(key => typeof city.state[key] === 'string' ? [`${key}: ${city.state[key]}`] : []);
	for (const item of authority) add('locationPlaces', city.id, `Current ${city.name} canon: ${item}`);
	const tokens = new Set(query.toLowerCase().match(/[a-z]{4,}/g) ?? []);
	const score = (fact: LocationContextFact) => (fact.lore.salience === 'core' ? 100 : 0)
		+ (fact.lore.origin === 'campaign' ? 30 : 0) + (['governance', 'law', 'access'].includes(fact.lore.category) ? 20 : 0)
		+ [...tokens].filter(token => `${fact.title} ${fact.statement}`.toLowerCase().includes(token)).length;
	const sorted = [...context.facts].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
	for (const fact of sorted) {
		const owner = context.chain.find(place => place.id === fact.ownerId)!;
		const links = fact.lore.exceptionToFactIds.filter(id => context.exceptedFactIds.includes(id));
		const sources = [...fact.sourceEntryIds, ...fact.sourceEventIds, ...fact.sourcePatchIds].slice(0, 3);
		const line = `- ${fact.inherited ? `Inherited from ${owner.name}` : `Local to ${owner.name}`} [fact:${fact.id}; ${fact.lore.category}; ${fact.lore.origin}${links.length ? `; conditional exception to ${links.join(', ')}` : ''}]: ${fact.statement}${sources.length ? ` [sources:${sources.join(', ')}]` : ''}`;
		if (!add('locationLore', fact.id, line)) omittedFactIds.push(fact.id);
	}
	for (const place of [city, ...context.chain.filter(place => place.id !== city.id)]) {
		for (const paragraph of (place.description ?? '').split(/\n\s*\n/).map(text => text.trim()).filter(Boolean)) {
			add('locationPlaces', place.id, `${place.name} background (current scoped facts govern conflicts): ${paragraph}`);
		}
	}
	const incomplete = context.incomplete || omittedFactIds.length > 0;
	if (incomplete) parts.push('Location context is incomplete. Some applicable rules were omitted; use canonical location lookup before a decision depending on them.');
	return { text: parts.join('\n'), records, omittedFactIds, incomplete };
}
