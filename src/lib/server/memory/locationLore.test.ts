import { describe, expect, it } from 'vitest';
import { locationLoreSchema } from '$lib/contracts/locationLore';
import { countTokens } from '$lib/utils/tokens';
import { loadLocationLore, renderLocationLore, resolveLocationLore } from './locationLore';
import { entities, facts, relationships } from '$lib/server/db/schema';

type Input = Parameters<typeof resolveLocationLore>[0];
const place = (id: string, state: Record<string, unknown> = {}): Input['places'][number] => ({
	id, storyId: 'story', type: 'location', name: id, description: `${id} has a distinct civic identity.`,
	status: 'active', visibility: 'player_known', state, metadata: {}, sourceEntryIds: [`source_${id}`],
});
const edge = (child: string, parent: string, metadata: Record<string, unknown> = {}): Input['relationships'][number] => ({
	id: `${child}_in_${parent}`, storyId: 'story', sourceEntityId: child, targetEntityId: parent, type: 'part-of', bidirectional: false, metadata,
});
const fact = (id: string, owner = 'Volantis', overrides: Partial<Input['facts'][number]> = {}): Input['facts'][number] => ({
	id, storyId: 'story', subjectEntityId: owner, type: 'identity', title: id, statement: `${id}: admission requires sponsorship except on public market days.`,
	status: 'active', visibility: 'player_known', sourceEntryIds: [`source_${id}`], sourceEventIds: [], sourcePatchIds: [],
	metadata: { locationLore: { version: 1, category: 'access', scope: 'descendants', origin: 'foundation', salience: 'core' } }, ...overrides,
});
const fixture = (overrides: Partial<Input> = {}): Input => ({ storyId: 'story', locationId: 'Chambers', atTurn: 20,
	places: [place('Volantis', { locationKind: 'city', politicalForm: 'Archonate', hiddenInfo: 'Never expose this.' }), place('Manse'), place('Chambers'), place('Harbor')],
	relationships: [edge('Chambers', 'Manse'), edge('Manse', 'Volantis'), edge('Harbor', 'Volantis')],
	facts: [fact('sponsorship'), fact('private_hours', 'Chambers'), fact('harbor_fee', 'Harbor')], ...overrides,
});

describe('scoped location lore', () => {
	it('inherits city rules at a room without including sibling places or private state', () => {
		const resolved = resolveLocationLore(fixture());
		expect(resolved.chain.map(place => place.id)).toEqual(['Volantis', 'Manse', 'Chambers']);
		expect(resolved.facts.map(fact => [fact.id, fact.inherited])).toEqual([['sponsorship', true], ['private_hours', false]]);
		const rendered = renderLocationLore(resolved, 'I ask the servant for an audience.');
		expect(rendered.text).toContain('Archonate');
		expect(rendered.text).toContain('Inherited from Volantis');
		expect(rendered.text).not.toContain('harbor_fee');
		expect(JSON.stringify(resolved)).not.toContain('Never expose this.');
	});

	it('keeps self-only, untagged legacy lore, beliefs, rejected claims and foreign canon out of inheritance', () => {
		const base = fact('legacy');
		const resolved = resolveLocationLore(fixture({ facts: [
			{ ...base, metadata: {}, type: 'awoiaf_lore' },
			fact('self', 'Volantis', { metadata: { locationLore: { ...base.metadata.locationLore as object, scope: 'self' } } }),
			fact('rumor', 'Volantis', { type: 'belief' }), fact('rejected', 'Volantis', { status: 'rejected' }),
			fact('foreign', 'Volantis', { storyId: 'other_story' }),
		] }));
		expect(resolved.facts).toHaveLength(0);
	});

	it('keeps a local conditional exception beside its base rule and leaves unrelated city rules intact', () => {
		const exception = fact('invited_access', 'Chambers');
		exception.metadata = { locationLore: { ...exception.metadata.locationLore as object, origin: 'campaign', exceptionToFactIds: ['sponsorship'] } };
		const resolved = resolveLocationLore(fixture({ facts: [fact('sponsorship'), fact('taxes'), exception] }));
		expect(resolved.exceptedFactIds).toEqual(['sponsorship']);
		expect(resolved.facts.map(fact => fact.id)).toEqual(['sponsorship', 'taxes', 'invited_access']);
		expect(renderLocationLore(resolved).text).toContain('conditional exception to sponsorship');
		const harbor = resolveLocationLore({ ...fixture({ facts: [fact('sponsorship'), exception] }), locationId: 'Harbor' });
		expect(harbor.exceptedFactIds).toEqual([]);
	});

	it('applies explicit campaign reform at its effective turn and retains the earlier historical interval', () => {
		const old = fact('old_government', 'Volantis', { status: 'superseded' });
		old.metadata = { ...old.metadata, validFromTurn: 0, validToTurn: 10 };
		const reform = fact('reformed_government');
		reform.metadata = { locationLore: { ...reform.metadata.locationLore as object, origin: 'campaign' }, validFromTurn: 10, supersedesId: old.id };
		const rows = [old, reform];
		expect(resolveLocationLore(fixture({ facts: rows, atTurn: 9 })).facts.map(fact => fact.id)).toEqual(['old_government']);
		expect(resolveLocationLore(fixture({ facts: rows, atTurn: 10 })).facts.map(fact => fact.id)).toEqual(['reformed_government']);
	});

	it('does not let a later foundation claim or rumor supersede a campaign reform', () => {
		const reform = fact('reform');
		reform.metadata = { locationLore: { ...reform.metadata.locationLore as object, origin: 'campaign' } };
		const foundation = fact('foundation'); foundation.metadata = { ...foundation.metadata, supersedesId: 'reform' };
		const rumor = fact('rumor', 'Volantis', { type: 'belief', metadata: { ...foundation.metadata, supersedesId: 'reform' } });
		expect(resolveLocationLore(fixture({ facts: [reform, foundation, rumor] })).facts.map(fact => fact.id)).toEqual(['reform', 'foundation']);
	});

	it('does not reveal a secret parent name, secret rule or hidden relationship through context', () => {
		const data = fixture({ places: [place('Chambers'), { ...place('Secret estate'), visibility: 'secret' }], relationships: [edge('Chambers', 'Secret estate')], facts: [fact('secret_rule', 'Chambers', { visibility: 'secret' })] });
		const resolved = resolveLocationLore(data);
		expect(resolved.chain.map(place => place.id)).toEqual(['Chambers']);
		expect(JSON.stringify(resolved)).not.toMatch(/Secret estate|secret_rule/);
		expect(resolved.relationshipIds).toEqual([]);
	});

	it.each([
		{ relationships: [edge('Chambers', 'Manse'), edge('Chambers', 'Volantis')] },
		{ relationships: [edge('Chambers', 'Manse'), edge('Manse', 'Chambers')] },
	])('stops safely at an ambiguous or cyclic graph', ({ relationships }) => {
		const resolved = resolveLocationLore(fixture({ relationships }));
		expect(resolved.incomplete).toBe(true);
		expect(resolved.warnings).toHaveLength(1);
		expect(resolved.facts.some(fact => fact.ownerId === 'Volantis')).toBe(false);
	});

	it('ignores authority and travel links and respects dated containment', () => {
		const resolved = resolveLocationLore(fixture({ relationships: [
			{ ...edge('Chambers', 'Volantis'), type: 'rules' }, edge('Chambers', 'Manse', { validFromTurn: 21 }),
		] }));
		expect(resolved.chain.map(place => place.id)).toEqual(['Chambers']);
	});

	it('uses whole rules under the token limit and explicitly reports omitted context', () => {
		const huge = fact('huge', 'Volantis', { statement: 'A long but indivisible rule. '.repeat(1000) });
		const rendered = renderLocationLore(resolveLocationLore(fixture({ facts: [huge, fact('small')] })), '', 400);
		expect(rendered.omittedFactIds).toContain('huge');
		expect(rendered.text).not.toContain('A long but indivisible');
		expect(rendered.text).toContain('except on public market days');
		expect(rendered.incomplete).toBe(true);
		expect(countTokens(rendered.text)).toBeLessThanOrEqual(400);
	});

	it('rejects unsupported lore metadata rather than silently expanding its scope', () => {
		expect(locationLoreSchema.safeParse({ version: 1, category: 'law', scope: 'everywhere', origin: 'campaign', salience: 'core' }).success).toBe(false);
		expect(locationLoreSchema.safeParse({ version: 1, category: 'law', scope: 'self', origin: 'campaign', salience: 'core', forceNpcResponse: true }).success).toBe(false);
	});

	it('loads the exact ancestry independently of a broad entity page', async () => {
		const data = fixture();
		const queued: unknown[][] = [
			[data.places[2]], [data.relationships[0]], [data.places[1]], [data.relationships[1]], [data.places[0]], [], data.facts,
		];
		const tables: unknown[] = [];
		const db = { select: () => {
			const chain = { from: (table: unknown) => { tables.push(table); return chain; }, where: () => chain, orderBy: () => chain, limit: async () => queued.shift() ?? [] };
			return chain;
		} } as unknown as NonNullable<Parameters<typeof loadLocationLore>[0]['db']>;
		const resolved = await loadLocationLore({ storyId: 'story', locationId: 'Chambers', atTurn: 20, db });
		expect(resolved.chain.map(place => place.id)).toEqual(['Volantis', 'Manse', 'Chambers']);
		expect(tables).toEqual([entities, relationships, entities, relationships, entities, relationships, facts]);
	});
});
