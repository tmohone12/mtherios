import { z } from 'zod';

export const worldSeedVisibilitySchema = z.enum(['public', 'player_known', 'secret']);
export const worldSeedEntityTypeSchema = z.enum(['character', 'location', 'item', 'faction', 'concept', 'event']);
export const worldSeedStoryModeSchema = z.enum(['adventure', 'creative-writing']);
export const worldSeedTimelineModeSchema = z.enum(['overlay', 'shared', 'fork']);

export const worldSeedEntitySchema = z.object({
	id: z.string().trim().min(1).optional(),
	type: worldSeedEntityTypeSchema,
	name: z.string().trim().min(1),
	aliases: z.array(z.string().trim().min(1)).default([]),
	visibility: worldSeedVisibilitySchema.default('player_known'),
	description: z.string().default(''),
	secrets: z.array(z.string().trim().min(1)).default([]),
	tags: z.array(z.string().trim().min(1)).default([]),
	state: z.record(z.string(), z.unknown()).default({}),
});

export const worldSeedRelationshipSchema = z.object({
	source: z.string().trim().min(1),
	target: z.string().trim().min(1),
	type: z.string().trim().min(1).default('related-to'),
	label: z.string().optional(),
	strength: z.number().min(0).max(1).default(0.5),
	visibility: worldSeedVisibilitySchema.default('player_known'),
});

export const worldSeedThreadSchema = z.object({
	description: z.string().trim().min(1),
	significance: z.enum(['minor', 'moderate', 'major']).default('moderate'),
});

export const worldSeedRawSourceSchema = z.object({
	id: z.string().trim().min(1),
	title: z.string().trim().min(1),
	sourceType: z.string().trim().min(1),
	content: z.string(),
});

export const worldSeedSchema = z.object({
	version: z.literal(1),
	shelf: z.object({
		name: z.string().trim().min(1),
		description: z.string().optional(),
		genre: z.string().optional(),
		tags: z.array(z.string().trim().min(1)).default([]),
	}),
	story: z.object({
		title: z.string().trim().min(1),
		genre: z.string().optional(),
		mode: worldSeedStoryModeSchema.default('adventure'),
		description: z.string().optional(),
		openingScene: z.string().optional(),
		timelineMode: worldSeedTimelineModeSchema.default('overlay'),
	}).optional(),
	protagonist: worldSeedEntitySchema.optional(),
	entities: z.array(worldSeedEntitySchema).default([]),
	relationships: z.array(worldSeedRelationshipSchema).default([]),
	threads: z.array(worldSeedThreadSchema).default([]),
	rawSources: z.array(worldSeedRawSourceSchema).default([]),
});

export const seedPreviewRequestSchema = z.object({
	sourceType: z.enum(['sillytavern_lorebook', 'character_card', 'markdown_seed', 'mtherios_seed_json', 'pasted_notes']),
	content: z.string(),
	fileName: z.string().optional(),
	options: z.record(z.string(), z.unknown()).optional(),
});

export const seedImportRequestSchema = z.object({
	seed: worldSeedSchema.optional(),
	source: seedPreviewRequestSchema.optional(),
	options: z.object({
		preserveIds: z.boolean().default(true),
		replaceExisting: z.boolean().default(false),
		syncWiki: z.boolean().default(true),
	}).default({ preserveIds: true, replaceExisting: false, syncWiki: true }),
}).refine((value) => value.seed || value.source, {
	message: 'Seed import requires either a seed object or an import source.',
	path: ['seed'],
});

export type WorldSeed = z.infer<typeof worldSeedSchema>;
export type WorldSeedEntity = z.infer<typeof worldSeedEntitySchema>;
export type WorldSeedPreviewRequest = z.infer<typeof seedPreviewRequestSchema>;
export type WorldSeedImportRequest = z.infer<typeof seedImportRequestSchema>;

export interface WorldSeedBundle {
	schemaVersion: 1;
	exportedAt: string;
	source: 'mtherios-world-seed';
	shelf: Record<string, unknown>;
	story: Record<string, unknown> | null;
	worldDatabase: Record<string, unknown> & {
		story: Record<string, unknown> | null;
		storyEntries: Record<string, unknown>[];
		entities: Record<string, unknown>[];
		entityAliases: Record<string, unknown>[];
		relationships: Record<string, unknown>[];
		factions: Record<string, unknown>[];
		storyThreads: Record<string, unknown>[];
		facts: Record<string, unknown>[];
		memoryNodes: Record<string, unknown>[];
		sourceRefs: Record<string, unknown>[];
	};
}

const sectionTypes: Record<string, WorldSeedEntity['type'] | 'thread'> = {
	characters: 'character',
	cast: 'character',
	people: 'character',
	places: 'location',
	locations: 'location',
	factions: 'faction',
	items: 'item',
	concepts: 'concept',
	events: 'event',
	threads: 'thread',
};

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 80);
	return slug || 'item';
}

function stableId(prefix: string, value: string): string {
	return `${prefix}_${slugify(value)}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function inferLorebookType(name: string, content: string): WorldSeedEntity['type'] {
	const haystack = `${name}\n${content}`.toLowerCase();
	if (/\b(house|guild|order|clan|court|union|empire|kingdom|faction|company|council)\b/.test(haystack)) return 'faction';
	if (/\b(city|village|bridge|district|keep|castle|road|forest|market|temple|tavern|place|location)\b/.test(haystack)) return 'location';
	if (/\b(sword|ring|book|artifact|relic|item|weapon|armor|key)\b/.test(haystack)) return 'item';
	if (/\b(battle|war|riot|death|coronation|festival|event)\b/.test(haystack)) return 'event';
	if (/\b(he|she|they|lord|lady|captain|prince|queen|king|courier|clerk|mage)\b/.test(haystack)) return 'character';
	return 'concept';
}

function parseFrontmatter(markdown: string): { attrs: Record<string, string>; body: string } {
	const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
	if (!match) return { attrs: {}, body: markdown };
	const attrs: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(':');
		if (separator <= 0) continue;
		attrs[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
	}
	return { attrs, body: markdown.slice(match[0].length) };
}

function readField(block: string[], key: string): string | null {
	const prefix = `${key.toLowerCase()}:`;
	const line = block.find((candidate) => candidate.trim().toLowerCase().startsWith(prefix));
	return line ? line.slice(line.indexOf(':') + 1).trim() : null;
}

function stripFieldLines(block: string[]): string[] {
	return block.filter((line) => !/^(aliases|visibility|resources|goal|secret goal|present at start):/i.test(line.trim()));
}

function extractSecrets(block: string[]): string[] {
	const secrets: string[] = [];
	for (let index = 0; index < block.length; index += 1) {
		const line = block[index].trim();
		if (/^secret:/i.test(line)) {
			const inline = line.slice(line.indexOf(':') + 1).trim();
			if (inline) secrets.push(inline);
			else if (block[index + 1]?.trim()) secrets.push(block[index + 1].trim());
		}
		if (/^secret goal:/i.test(line)) {
			const inline = line.slice(line.indexOf(':') + 1).trim();
			if (inline) secrets.push(inline);
		}
	}
	return unique(secrets);
}

export function parseMarkdownWorldSeed(markdown: string): WorldSeed {
	const { attrs, body } = parseFrontmatter(markdown);
	const shelfName = attrs.shelf || attrs.title || attrs.name || 'Imported Shelf';
	const storyTitle = attrs.title && attrs.title !== shelfName ? attrs.title : undefined;
	const lines = body.split(/\r?\n/);
	let currentSection: string | null = null;
	let active: { name: string; type: WorldSeedEntity['type']; block: string[] } | null = null;
	const entities: WorldSeedEntity[] = [];
	const threads: Array<z.infer<typeof worldSeedThreadSchema>> = [];

	const flush = () => {
		if (!active) return;
		const aliases = unique((readField(active.block, 'Aliases') ?? '').split(','));
		const visibilityRaw = readField(active.block, 'Visibility') ?? 'player_known';
		const visibility = worldSeedVisibilitySchema.safeParse(visibilityRaw).success ? visibilityRaw as WorldSeedEntity['visibility'] : 'player_known';
		const secrets = extractSecrets(active.block);
		const description = stripFieldLines(active.block)
			.filter((line) => line.trim() && !/^secret:/i.test(line.trim()))
			.join('\n')
			.trim();
		entities.push({
			id: stableId(active.type === 'faction' ? 'faction' : active.type === 'character' ? 'char' : active.type, active.name),
			type: active.type,
			name: active.name,
			aliases,
			visibility,
			description,
			secrets,
			tags: [],
			state: {},
		});
		active = null;
	};

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		const h1 = line.match(/^#\s+(.+)$/);
		if (h1) {
			flush();
			currentSection = h1[1].trim().toLowerCase();
			continue;
		}
		const h2 = line.match(/^##\s+(.+?)(?:\s+\[([^\]]+)\])?\s*$/);
		if (h2) {
			flush();
			const sectionType = currentSection ? sectionTypes[currentSection] : 'concept';
			const explicitType = h2[2] ? worldSeedEntityTypeSchema.safeParse(h2[2].trim()).data : null;
			const type = explicitType ?? (sectionType && sectionType !== 'thread' ? sectionType : 'concept');
			active = { name: h2[1].trim(), type, block: [] };
			continue;
		}
		if (!active && currentSection && sectionTypes[currentSection] === 'thread') {
			const bullet = line.match(/^[-*]\s+(.+)$/);
			if (bullet) threads.push({ description: bullet[1].trim(), significance: 'moderate' });
			continue;
		}
		if (active) active.block.push(line);
	}
	flush();

	return worldSeedSchema.parse({
		version: 1,
		shelf: {
			name: shelfName,
			description: attrs.description,
			genre: attrs.genre,
			tags: attrs.tags ? unique(attrs.tags.split(',')) : [],
		},
		story: storyTitle ? {
			title: storyTitle,
			genre: attrs.genre,
			mode: worldSeedStoryModeSchema.safeParse(attrs.mode).success ? attrs.mode : 'adventure',
			openingScene: attrs.openingScene,
			timelineMode: 'overlay',
		} : undefined,
		entities,
		threads,
		rawSources: [{
			id: stableId('source', attrs.title || shelfName || 'markdown_seed'),
			title: attrs.title || `${shelfName} Markdown Seed`,
			sourceType: 'markdown_seed',
			content: markdown,
		}],
	});
}

function parseSillyTavernLorebook(content: string, fileName = 'SillyTavern lorebook'): WorldSeed {
	const parsed = JSON.parse(content) as Record<string, unknown>;
	const rawEntries = parsed.entries && typeof parsed.entries === 'object'
		? Object.values(parsed.entries as Record<string, unknown>)
		: Array.isArray(parsed) ? parsed : [];
	const entities = rawEntries
		.map((entry, index): WorldSeedEntity | null => {
			if (!entry || typeof entry !== 'object') return null;
			const row = entry as Record<string, unknown>;
			if (row.disable === true) return null;
			const name = typeof row.comment === 'string' && row.comment.trim()
				? row.comment.trim()
				: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : `Lorebook Entry ${index + 1}`;
			const description = typeof row.content === 'string' ? row.content : '';
			const aliases = unique([
				...(Array.isArray(row.key) ? row.key.filter((value): value is string => typeof value === 'string') : []),
				...(Array.isArray(row.keysecondary) ? row.keysecondary.filter((value): value is string => typeof value === 'string') : []),
			]);
			const type = inferLorebookType(name, description);
			return {
				id: stableId(type === 'faction' ? 'faction' : type === 'character' ? 'char' : type, name),
				type,
				name,
				aliases,
				visibility: 'player_known',
				description,
				secrets: [],
				tags: [],
				state: {
					...(row.constant === true ? { importImportance: 'always' } : {}),
					order: typeof row.order === 'number' ? row.order : null,
				},
			};
		})
		.filter((entity): entity is WorldSeedEntity => Boolean(entity));
	return worldSeedSchema.parse({
		version: 1,
		shelf: { name: fileName.replace(/\.[^.]+$/, '') || 'Imported Shelf' },
		entities,
		rawSources: [{ id: stableId('source', fileName), title: fileName, sourceType: 'sillytavern_lorebook', content }],
	});
}

function parsePastedNotes(content: string, fileName = 'Pasted Notes'): WorldSeed {
	return worldSeedSchema.parse({
		version: 1,
		shelf: { name: fileName.replace(/\.[^.]+$/, '') || 'Imported Shelf' },
		rawSources: [{ id: stableId('source', fileName), title: fileName, sourceType: 'pasted_notes', content }],
	});
}

export function previewWorldSeedSource(input: WorldSeedPreviewRequest) {
	const request = seedPreviewRequestSchema.parse(input);
	let seedDraft: WorldSeed;
	const warnings: Array<{ code: string; message: string; severity: 'info' | 'warning' | 'error'; sourceId?: string }> = [];
	if (request.sourceType === 'markdown_seed') seedDraft = parseMarkdownWorldSeed(request.content);
	else if (request.sourceType === 'mtherios_seed_json') seedDraft = worldSeedSchema.parse(JSON.parse(request.content));
	else if (request.sourceType === 'sillytavern_lorebook' || request.sourceType === 'character_card') seedDraft = parseSillyTavernLorebook(request.content, request.fileName);
	else seedDraft = parsePastedNotes(request.content, request.fileName);

	const summary = summarizeSeed(seedDraft);
	if (summary.entities === 0 && request.sourceType !== 'pasted_notes') {
		warnings.push({ code: 'no_entities_detected', message: 'No canon entities were detected automatically. Review the source before importing.', severity: 'warning' });
	}
	return { ok: true as const, seedDraft, summary, warnings };
}

function summarizeSeed(seed: WorldSeed) {
	return {
		entities: seed.entities.length + (seed.protagonist ? 1 : 0),
		characters: seed.entities.filter((entity) => entity.type === 'character').length + (seed.protagonist ? 1 : 0),
		locations: seed.entities.filter((entity) => entity.type === 'location').length,
		factions: seed.entities.filter((entity) => entity.type === 'faction').length,
		relationships: seed.relationships.length,
		threads: seed.threads.length,
		sources: seed.rawSources.length,
	};
}

export function compileWorldSeedToBundle(rawSeed: WorldSeed): WorldSeedBundle {
	const seed = worldSeedSchema.parse(rawSeed);
	const exportedAt = nowIso();
	const shelfId = stableId('shelf', seed.shelf.name);
	const storyId = seed.story ? stableId('story', `${seed.shelf.name}:${seed.story.title}`) : null;
	const allEntities = seed.protagonist ? [seed.protagonist, ...seed.entities] : seed.entities;
	const entityIds = new Map<string, string>();
	for (const entity of allEntities) {
		const entityId = seedEntityId(entity);
		entityIds.set(entityId, entityId);
		entityIds.set(entity.name, entityId);
	}
	const sourceEntryIds = seed.rawSources.length > 0
		? seed.rawSources.map((source) => stableId('entry_source', source.id))
		: [stableId('entry_source', seed.shelf.name)];
	const storyEntries = seed.rawSources.length > 0
		? seed.rawSources.map((source, index) => ({
			id: sourceEntryIds[index],
			storyId,
			shelfId,
			type: 'source_import',
			content: source.content,
			position: index,
			metadata: { title: source.title, sourceType: source.sourceType, sourceOnly: true },
			serverVersion: 1,
			createdAt: exportedAt,
			updatedAt: exportedAt,
		}))
		: [{
			id: sourceEntryIds[0],
			storyId,
			shelfId,
			type: 'source_import',
			content: seed.shelf.description ?? `Seed source for ${seed.shelf.name}`,
			position: 0,
			metadata: { title: `${seed.shelf.name} Seed`, sourceType: 'world_seed', sourceOnly: true },
			serverVersion: 1,
			createdAt: exportedAt,
			updatedAt: exportedAt,
		}];
	const entities = allEntities.map((entity) => {
		const entityId = seedEntityId(entity);
		return {
			id: entityId,
			storyId,
			shelfId,
			type: entity.type,
			name: entity.name,
			description: entity.description || null,
			status: 'active',
			visibility: entity.visibility,
			state: entity.state,
			metadata: {
				source: 'mtherios-world-seed',
				scope: 'shared',
				tags: entity.tags,
				secrets: entity.secrets,
			},
			sourceEntryIds,
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion: 1,
			createdAt: exportedAt,
			updatedAt: exportedAt,
		};
	});
	const entityAliases = allEntities.flatMap((entity) => {
		const entityId = seedEntityId(entity);
		return entity.aliases.map((alias) => ({
			id: stableId('alias', `${entityId}:${alias}`),
			storyId,
			shelfId,
			entityId,
			alias,
			normalizedAlias: slugify(alias).replace(/_/g, ' '),
			sourceEntryIds,
			serverVersion: 1,
			createdAt: exportedAt,
			updatedAt: exportedAt,
		}));
	});
	const factions = entities
		.filter((entity) => entity.type === 'faction')
		.map((entity) => ({
			id: stableId('faction_record', String(entity.id)),
			storyId,
			shelfId,
			entityId: entity.id,
			name: entity.name,
			goals: [],
			resources: {},
			memberEntityIds: [],
			territoryIds: [],
			allies: [],
			enemies: [],
			pressure: 0,
			metadata: { scope: 'shared', source: 'mtherios-world-seed' },
			sourceEntryIds,
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion: 1,
			createdAt: exportedAt,
			updatedAt: exportedAt,
		}));
	const storyThreads = seed.threads.map((thread, index) => ({
		id: stableId('thread', `${shelfId}:${thread.description}:${index}`),
		storyId,
		shelfId,
		description: thread.description,
		status: 'open',
		significance: thread.significance,
		relatedFactionIds: [],
		relatedEntityIds: [],
		sourceEntryIds,
		sourceEventIds: [],
		sourcePatchIds: [],
		metadata: { scope: 'shared', source: 'mtherios-world-seed' },
		serverVersion: 1,
		createdAt: exportedAt,
		updatedAt: exportedAt,
	}));
	const sourceRefs = entities.flatMap((entity) => sourceEntryIds.map((sourceEntryId) => ({
		id: stableId('sourceref', `${sourceEntryId}:${entity.id}`),
		storyId,
		shelfId,
		sourceType: 'story_entry',
		sourceId: sourceEntryId,
		targetTable: 'entities',
		targetRecordId: String(entity.id),
		targetRecordField: 'description',
		sourceField: 'content',
		confidence: 0.75,
		rationale: 'Generated from reviewed world seed source material.',
		notes: null,
		serverVersion: 1,
		createdAt: exportedAt,
		updatedAt: exportedAt,
	})));

	return {
		schemaVersion: 1,
		exportedAt,
		source: 'mtherios-world-seed',
		shelf: {
			id: shelfId,
			name: seed.shelf.name,
			slug: slugify(seed.shelf.name),
			description: seed.shelf.description ?? null,
			genre: seed.shelf.genre ?? null,
			coverImageUrl: null,
			settings: {},
			metadata: { tags: seed.shelf.tags, createdFromSeed: true },
			serverVersion: 1,
			createdAt: exportedAt,
			updatedAt: exportedAt,
		},
		story: storyId && seed.story ? {
			id: storyId,
			shelfId,
			clientStoryId: null,
			title: seed.story.title,
			description: seed.story.description ?? null,
			genre: seed.story.genre ?? seed.shelf.genre ?? null,
			mode: seed.story.mode,
			role: 'playable',
			timelineMode: seed.story.timelineMode,
			settings: {},
			headerPrompt: null,
			currentLocationId: null,
			currentTurn: 0,
			currentWorldTime: null,
			metadata: {
				openingScene: seed.story.openingScene ?? null,
				startWorkflow: {
					sourceMode: 'world_seed',
					sourceCount: seed.rawSources.length,
					requiresCanonReview: false,
					startingSceneReady: Boolean(seed.story.openingScene),
				},
			},
			serverVersion: 1,
			createdAt: exportedAt,
			updatedAt: exportedAt,
		} : null,
		worldDatabase: {
			story: storyId && seed.story ? {
				id: storyId,
				shelfId,
				title: seed.story.title,
				description: seed.story.description ?? null,
				genre: seed.story.genre ?? seed.shelf.genre ?? null,
				mode: seed.story.mode,
				role: 'playable',
				timelineMode: seed.story.timelineMode,
				metadata: { openingScene: seed.story.openingScene ?? null },
				serverVersion: 1,
				createdAt: exportedAt,
				updatedAt: exportedAt,
			} : null,
			storyEntries,
			entities,
			entityAliases,
			relationships: buildRelationships(seed, shelfId, storyId, sourceEntryIds, exportedAt, entityIds),
			factions,
			storyThreads,
			facts: [],
			memoryNodes: [],
			sourceRefs,
		},
	};
}

function seedEntityId(entity: WorldSeedEntity): string {
	return entity.id ?? stableId(entity.type === 'faction' ? 'faction' : entity.type === 'character' ? 'char' : entity.type, entity.name);
}

function resolveRelationshipEndpoint(endpoint: string, role: 'source' | 'target', entityIds: Map<string, string>): string {
	const entityId = entityIds.get(endpoint);
	if (!entityId) throw new Error(`Unknown relationship ${role} "${endpoint}". Add a matching seed entity name or id.`);
	return entityId;
}

function buildRelationships(
	seed: WorldSeed,
	shelfId: string,
	storyId: string | null,
	sourceEntryIds: string[],
	createdAt: string,
	entityIds: Map<string, string>,
): Record<string, unknown>[] {
	return seed.relationships.map((relationship, index) => {
		const sourceEntityId = resolveRelationshipEndpoint(relationship.source, 'source', entityIds);
		const targetEntityId = resolveRelationshipEndpoint(relationship.target, 'target', entityIds);
		return {
			id: stableId('rel', `${relationship.source}:${relationship.target}:${relationship.type}:${index}`),
			storyId,
			shelfId,
			sourceEntityId,
			targetEntityId,
			type: relationship.type,
			label: relationship.label ?? null,
			strength: relationship.strength,
			bidirectional: false,
			metadata: { scope: 'shared', source: 'mtherios-world-seed' },
			sourceEntryIds,
			sourceEventIds: [],
			sourcePatchIds: [],
			serverVersion: 1,
			createdAt,
			updatedAt: createdAt,
		};
	});
}
