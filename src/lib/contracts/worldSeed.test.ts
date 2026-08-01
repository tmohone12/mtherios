import { describe, expect, it } from 'vitest';
import {
	compileWorldSeedToBundle,
	parseMarkdownWorldSeed,
	previewWorldSeedSource,
	worldSeedSchema,
} from './worldSeed';

describe('world seed contract and compiler', () => {
	it('validates friendly .mtherios.seed.json with defaults', () => {
		const seed = worldSeedSchema.parse({
			version: 1,
			shelf: { name: 'Glassmarket' },
			entities: [{ type: 'character', name: 'Vaeron Ash' }],
		});

		expect(seed.shelf.tags).toEqual([]);
		expect(seed.entities[0]).toMatchObject({
			type: 'character',
			name: 'Vaeron Ash',
			aliases: [],
			visibility: 'player_known',
		});
	});

	it('rejects a seed without a shelf name', () => {
		expect(() => worldSeedSchema.parse({ version: 1, shelf: { name: '' } })).toThrow();
	});

	it('parses markdown seed sections into entities, secrets, and threads', () => {
		const seed = parseMarkdownWorldSeed(`---
mtheriosSeed: 1
shelf: Glassmarket
title: Vaeron's Debt
genre: political fantasy
mode: adventure
openingScene: The protagonist arrives at the Ledger Bridge.
---

# Characters

## Vaeron Ash [character]
Aliases: Vaeron, the debt courier
Visibility: player_known

A disgraced courier carrying a debt marker.

Secret:
The debt marker is keyed to his blood.

# Factions

## House Sythar [faction]
Aliases: Sythar, the Silver House
Goal: Control the Ledger Bridge.
Secret Goal: Buy the Dockside Union from within.

# Threads

- Who owns Vaeron's debt marker?
- Why did the toll records vanish?
`);

		expect(seed.shelf.name).toBe('Glassmarket');
		expect(seed.story?.title).toBe("Vaeron's Debt");
		expect(seed.entities.map((entity) => entity.name)).toEqual(['Vaeron Ash', 'House Sythar']);
		expect(seed.entities[0].aliases).toContain('the debt courier');
		expect(seed.entities[0].secrets).toContain('The debt marker is keyed to his blood.');
		expect(seed.entities[1].secrets).toContain('Buy the Dockside Union from within.');
		expect(seed.threads).toHaveLength(2);
	});

	it('compiles a seed into a shelf, first story, shared canon records, and source evidence', () => {
		const bundle = compileWorldSeedToBundle({
			version: 1,
			shelf: { name: 'Glassmarket', genre: 'political fantasy', tags: ['contracts'] },
			story: {
				title: "Vaeron's Debt",
				mode: 'adventure',
				openingScene: 'The protagonist arrives at the Ledger Bridge.',
				timelineMode: 'overlay',
			},
			entities: [
				{
					id: 'char_vaeron_ash',
					type: 'character',
					name: 'Vaeron Ash',
					aliases: ['Vaeron'],
					description: 'A former courier.',
					visibility: 'player_known',
					secrets: ['The marker is keyed to his blood.'],
					tags: [],
					state: {},
				},
			],
			relationships: [],
			threads: [{ description: 'Who owns the debt marker?', significance: 'major' }],
			rawSources: [{ id: 'source_1', title: 'notes.md', sourceType: 'markdown_seed', content: 'Vaeron notes' }],
		});

		expect(bundle.shelf.name).toBe('Glassmarket');
		expect(bundle.story).toMatchObject({ shelfId: bundle.shelf.id, title: "Vaeron's Debt", timelineMode: 'overlay' });
		expect(bundle.worldDatabase.story).toMatchObject({ id: bundle.story?.id, shelfId: bundle.shelf.id });
		expect(bundle.worldDatabase.storyEntries).toHaveLength(1);
		expect(bundle.worldDatabase.entities[0]).toMatchObject({
			id: 'char_vaeron_ash',
			storyId: bundle.story?.id,
			shelfId: bundle.shelf.id,
			type: 'character',
			name: 'Vaeron Ash',
		});
		expect(bundle.worldDatabase.entities[0].metadata).toMatchObject({ scope: 'shared', secrets: ['The marker is keyed to his blood.'] });
		expect(bundle.worldDatabase.entityAliases[0]).toMatchObject({ alias: 'Vaeron', entityId: 'char_vaeron_ash' });
		expect(bundle.worldDatabase.storyThreads[0]).toMatchObject({ description: 'Who owns the debt marker?' });
		expect(bundle.worldDatabase.sourceRefs.length).toBeGreaterThan(0);
	});

	it('resolves relationship endpoints from seed entity names', () => {
		const bundle = compileWorldSeedToBundle(worldSeedSchema.parse({
			version: 1,
			shelf: { name: 'Glassmarket' },
			story: { title: 'Debt Ledger' },
			entities: [
				{ type: 'character', name: 'Vaeron Ash' },
				{ type: 'faction', name: 'House Sythar' },
			],
			relationships: [{ source: 'Vaeron Ash', target: 'House Sythar', type: 'owes-debt-to' }],
		}));

		expect(bundle.worldDatabase.relationships[0]).toMatchObject({
			sourceEntityId: 'char_vaeron_ash',
			targetEntityId: 'faction_house_sythar',
			type: 'owes-debt-to',
		});
	});

	it('keeps explicit relationship endpoint ids', () => {
		const bundle = compileWorldSeedToBundle(worldSeedSchema.parse({
			version: 1,
			shelf: { name: 'Glassmarket' },
			story: { title: 'Debt Ledger' },
			entities: [
				{ id: 'entity_vaeron', type: 'character', name: 'Vaeron Ash' },
				{ id: 'entity_sythar', type: 'faction', name: 'House Sythar' },
			],
			relationships: [{ source: 'entity_vaeron', target: 'entity_sythar', type: 'owes-debt-to' }],
		}));

		expect(bundle.worldDatabase.relationships[0]).toMatchObject({
			sourceEntityId: 'entity_vaeron',
			targetEntityId: 'entity_sythar',
		});
	});

	it('rejects relationship endpoints that do not match a seed entity', () => {
		expect(() => compileWorldSeedToBundle(worldSeedSchema.parse({
			version: 1,
			shelf: { name: 'Glassmarket' },
			story: { title: 'Debt Ledger' },
			entities: [{ type: 'character', name: 'Vaeron Ash' }],
			relationships: [{ source: 'Vaeron Ash', target: 'Missing House', type: 'owes-debt-to' }],
		}))).toThrow('Unknown relationship target "Missing House"');
	});

	it('previews SillyTavern lorebook entries without writing canon', () => {
		const preview = previewWorldSeedSource({
			sourceType: 'sillytavern_lorebook',
			fileName: 'glassmarket_lorebook.json',
			content: JSON.stringify({
				entries: {
					'0': {
						comment: 'House Sythar',
						content: 'A creditor house controlling bridge tolls.',
						key: ['Sythar'],
						keysecondary: ['Silver House'],
						constant: true,
					},
				},
			}),
		});

		expect(preview.ok).toBe(true);
		expect(preview.summary.sources).toBe(1);
		expect(preview.summary.entities).toBe(1);
		expect(preview.summary.factions).toBe(1);
		expect(preview.seedDraft.entities[0]).toMatchObject({
			type: 'faction',
			name: 'House Sythar',
			aliases: ['Sythar', 'Silver House'],
		});
	});
});
