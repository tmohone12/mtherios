import { describe, expect, it } from 'vitest';
import { entities, entityAliases } from '$lib/server/db/schema';
import {
	chooseEntityResolution,
	isCharacterTitleOnlyName,
	normalizeEntityName,
	resolveEntityIdentity,
	scoreEntityNameSimilarity,
	type EntityResolutionCandidate,
} from './entityResolver';

function candidate(overrides: Partial<EntityResolutionCandidate>): EntityResolutionCandidate {
	return {
		entityId: 'entity_1',
		type: 'character',
		name: 'Mira Vey',
		aliases: ['Mira'],
		score: 0.9,
		signals: ['fuzzy:name', 'same:type'],
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
		...overrides,
	};
}

describe('entity resolver identity scoring', () => {
	it('does not use a proposed character alias to overwrite a different established person', async () => {
		const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () =>
			table === entities ? [{ id: 'aurion', name: 'Aurion Belaerys', type: 'character', status: 'active' }]
				: table === entityAliases ? [{ entityId: 'aurion', alias: 'Aurion' }] : [],
		}) }) }) } as unknown as NonNullable<Parameters<typeof resolveEntityIdentity>[0]['db']>;
		const newPerson = await resolveEntityIdentity({ storyId: 'veil', db, includeSemantic: false,
			candidate: { type: 'character', name: 'Nairah', aliases: ['Aurion'] } });
		expect(newPerson.decision).toBe('create');
		expect(newPerson.entityId).toBeNull();
		const knownAlias = await resolveEntityIdentity({ storyId: 'veil', db, includeSemantic: false,
			candidate: { type: 'character', name: 'Aurion' } });
		expect(knownAlias.entityId).toBe('aurion');
	});
	it('normalizes names for stable lookup across casing, punctuation, and articles', () => {
		expect(normalizeEntityName('The Glass-Market Smuggler')).toBe('glass market smuggler');
		expect(normalizeEntityName('Mira Vey')).toBe('mira vey');
	});

	it('treats a short alias as a strong possible match for a canonical name', () => {
		expect(scoreEntityNameSimilarity('Mira', 'Mira Vey')).toBeGreaterThanOrEqual(0.82);
	});

	it('recognizes title-only character names that should not create canon records', () => {
		expect(isCharacterTitleOnlyName('Consort')).toBe(true);
		expect(isCharacterTitleOnlyName('Golden Dragon')).toBe(true);
		expect(isCharacterTitleOnlyName('Aurion Balaerys')).toBe(false);
	});

	it('updates strong matches instead of creating duplicate entities', () => {
		const resolution = chooseEntityResolution({
			candidates: [
				candidate({ entityId: 'char_mira', score: 0.9 }),
			],
		});

		expect(resolution.decision).toBe('update');
		expect(resolution.entityId).toBe('char_mira');
	});

	it('asks instead of auto-merging when candidates are too close', () => {
		const resolution = chooseEntityResolution({
			candidates: [
				candidate({ entityId: 'char_mira_vey', name: 'Mira Vey', score: 0.79 }),
				candidate({ entityId: 'char_mira_ves', name: 'Mira Ves', score: 0.75 }),
			],
		});

		expect(resolution.decision).toBe('ask');
		expect(resolution.candidates.map((item) => item.entityId)).toEqual(['char_mira_vey', 'char_mira_ves']);
	});

	it('marks requested-id drift as a merge when an existing entity is a strong match', () => {
		const resolution = chooseEntityResolution({
			requestedId: 'char_new_mira',
			candidates: [
				candidate({ entityId: 'char_mira', score: 0.94, signals: ['exact:alias', 'same:type'] }),
			],
		});

		expect(resolution.decision).toBe('merge');
		expect(resolution.entityId).toBe('char_mira');
	});
});

describe('location identity resolution', () => {
	const roomName = "Volantis — Belaerys Manse, Aurion's Chambers";
	const parentName = 'Volantis — Belaerys Manse';

	async function resolveLocation(
		rows: Array<{ id: string; name: string; type?: string; sourceEntryIds?: string[] }>,
		input: { id?: string; aliases?: string[] } = {},
	) {
		const db = {
			select: () => ({
				from: (table: unknown) => ({
					where: () => ({
						limit: async () => table === entities
							? rows.map((row) => ({ type: 'location', status: 'active', ...row }))
							: table === entityAliases
								? [{ entityId: 'parent', alias: roomName }]
								: [],
					}),
				}),
			}),
		} as unknown as NonNullable<Parameters<typeof resolveEntityIdentity>[0]['db']>;
		return resolveEntityIdentity({
			storyId: 'story_veil',
			candidate: { type: 'location', name: roomName, sourceEntryIds: ['entry_1'], ...input },
			db,
			includeSemantic: false,
		});
	}

	it('requires review when duplicate rooms share a canonical name', async () => {
		const resolution = await resolveLocation([
			{ id: 'parent', name: parentName, sourceEntryIds: ['entry_1'] },
			{ id: 'room_1', name: roomName },
			{ id: 'room_2', name: roomName },
		]);
		expect(resolution).toMatchObject({ decision: 'ask', entityId: null });
	});

	it('reuses the unique room when a parent alias ties its score', async () => {
		const resolution = await resolveLocation([
			{ id: 'parent', name: parentName, sourceEntryIds: ['entry_1'] },
			{ id: 'room_1', name: roomName },
		]);
		expect(resolution).toMatchObject({ decision: 'update', entityId: 'room_1' });
	});

	it('honors an explicit room id when another room has the same canonical name', async () => {
		const resolution = await resolveLocation([
			{ id: 'room_1', name: roomName },
			{ id: 'room_2', name: roomName },
		], { id: 'room_2' });
		expect(resolution).toMatchObject({ decision: 'update', entityId: 'room_2' });
	});

	it('does not reuse a parent place through either side of an alias match', async () => {
		const resolution = await resolveLocation([
			{ id: 'parent', name: parentName },
		], { aliases: [parentName] });
		expect(resolution).toMatchObject({ decision: 'create', entityId: null });
	});

	it('does not reuse an entity of another type with the same canonical name', async () => {
		const resolution = await resolveLocation([
			{ id: 'item_1', name: roomName, type: 'item' },
		]);
		expect(resolution).toMatchObject({ decision: 'create', entityId: null });
	});
});
