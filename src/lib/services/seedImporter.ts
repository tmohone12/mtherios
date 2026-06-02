/**
 * Seed Importer — Mtherios
 *
 * Imports pre-built faction/lorebook seed files (JSON) into a story's lorebook.
 * Used for scenario packs like ASOIAF, Middle-earth, etc.
 *
 * Seed files live in src/lib/data/seeds/ and follow the FactionSeedFile schema.
 * Each faction becomes a full Entry with type-specific state, injection rules,
 * and optional extended faction state (goals, resources, disposition).
 */

import { uuid } from '$lib/utils/uuid';
import { getLorebookEntries } from '$lib/services/database';
import { saveCanonicalLorebookEntry } from '$lib/services/canonicalWrites';
import type {
	Entry,
	EntryType,
	EntryState,
	FactionEntryState,
	FactionGoal,
	FactionResources,
	EntryInjectionMode,
} from '$lib/types';

// ── Seed File Schema ──

export interface FactionSeed {
	name: string;
	type: EntryType;
	description: string;
	hiddenInfo?: string | null;
	aliases?: string[];
	keywords?: string[];
	state: FactionEntryState;
	adventureState?: { discovered: boolean; interactedWith: boolean; notes: string[] } | null;
	creativeState?: Record<string, unknown> | null;
}

export interface FactionSeedFile {
	meta: {
		name: string;
		description: string;
		version: number;
		setting: string;
		periodHint?: string;
	};
	factions: FactionSeed[];
}

// ── Lorebook Seed Schema (mixed entry types) ──

export interface LorebookSeedEntry {
	name: string;
	type: EntryType;
	description: string;
	hiddenInfo?: string | null;
	aliases?: string[];
	keywords?: string[];
	injectionMode?: EntryInjectionMode;
	priority?: number;
}

export interface LorebookSeedFile {
	meta: {
		name: string;
		description: string;
		version: number;
		setting: string;
		periodHint?: string;
		sources?: string[];
	};
	entries: LorebookSeedEntry[];
}

export interface SeedImportResult {
	imported: number;
	skipped: number;
	skippedNames: string[];
	errors: string[];
}

/**
 * Import factions from a seed file into a story's lorebook.
 *
 * @param storyId    Target story ID
 * @param seedData   Parsed seed file (FactionSeedFile)
 * @param options    Import options
 * @returns          Import result with counts and any errors
 */
export async function importFactionSeed(
	storyId: string,
	seedData: FactionSeedFile,
	options: {
		/** Skip factions that already exist in the lorebook (by name, case-insensitive) */
		skipDuplicates?: boolean;
		/** Override injection mode for all imported entries */
		injectionMode?: EntryInjectionMode;
		/** Override injection priority */
		priority?: number;
		/** Mark as discovered by player (adventure mode) */
		markDiscovered?: boolean;
	} = {},
): Promise<SeedImportResult> {
	const {
		skipDuplicates = true,
		injectionMode = 'keyword',
		priority = 100,
		markDiscovered,
	} = options;

	const result: SeedImportResult = {
		imported: 0,
		skipped: 0,
		skippedNames: [],
		errors: [],
	};

	// Get existing entries for duplicate detection
	let existingNames = new Set<string>();
	if (skipDuplicates) {
		const existing = await getLorebookEntries(storyId);
		existingNames = new Set(existing.map(e => e.name.toLowerCase()));
	}

	const now = Date.now();

	for (const faction of seedData.factions) {
		try {
			// Duplicate check
			if (skipDuplicates && existingNames.has(faction.name.toLowerCase())) {
				result.skipped++;
				result.skippedNames.push(faction.name);
				continue;
			}

			// Build the full Entry object
			const entry: Entry = {
				id: uuid(),
				storyId,
				branchId: null,
				name: faction.name,
				type: faction.type || 'faction',
				description: faction.description,
				hiddenInfo: faction.hiddenInfo ?? null,
				aliases: faction.aliases ?? [],

				// State — pass through the full faction state including extended fields
				state: sanitizeFactionState(faction.state),

				// Adventure/creative state
				adventureState: faction.adventureState
					? {
						discovered: markDiscovered !== undefined ? markDiscovered : faction.adventureState.discovered,
						interactedWith: faction.adventureState.interactedWith,
						notes: faction.adventureState.notes,
					}
					: null,
				creativeState: (faction.creativeState as Entry['creativeState']) ?? null,

				// Injection rules
				injection: {
					mode: injectionMode,
					keywords: faction.keywords ?? [faction.name.toLowerCase()],
					priority,
				},

				// Metadata
				firstMentioned: null,
				lastMentioned: null,
				mentionCount: 0,
				createdBy: 'import',
				createdAt: now,
				updatedAt: now,
				loreManagementBlacklisted: false,
			};

			await saveCanonicalLorebookEntry(entry, 'create');
			result.imported++;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			result.errors.push(`${faction.name}: ${msg}`);
		}
	}

	return result;
}

/**
 * Ensure faction state has all required base fields and valid types.
 */
function sanitizeFactionState(state: FactionEntryState): FactionEntryState {
	return {
		type: 'faction',
		playerStanding: state.playerStanding ?? 0,
		status: state.status ?? 'unknown',
		knownMembers: state.knownMembers ?? [],
		// Extended fields (pass through if present)
		goals: state.goals,
		resources: state.resources,
		disposition: state.disposition,
		interFactionRelations: state.interFactionRelations,
		territory: state.territory,
		lastActionChapter: state.lastActionChapter,
	};
}

/**
 * Import a lorebook seed file (mixed entry types) into a story's lorebook.
 */
export async function importLorebookSeed(
	storyId: string,
	seedData: LorebookSeedFile,
	options: {
		skipDuplicates?: boolean;
		injectionMode?: EntryInjectionMode;
		priority?: number;
		markDiscovered?: boolean;
	} = {},
): Promise<SeedImportResult> {
	const {
		skipDuplicates = true,
		injectionMode,
		priority,
		markDiscovered = true,
	} = options;

	const result: SeedImportResult = { imported: 0, skipped: 0, skippedNames: [], errors: [] };

	let existingNames = new Set<string>();
	if (skipDuplicates) {
		const existing = await getLorebookEntries(storyId);
		existingNames = new Set(existing.map(e => e.name.toLowerCase()));
	}

	const now = Date.now();

	for (const seed of seedData.entries) {
		try {
			if (skipDuplicates && existingNames.has(seed.name.toLowerCase())) {
				result.skipped++;
				result.skippedNames.push(seed.name);
				continue;
			}

			const entryType = seed.type || 'concept';
			const entry: Entry = {
				id: uuid(),
				storyId,
				branchId: null,
				name: seed.name,
				type: entryType,
				description: seed.description || '',
				hiddenInfo: seed.hiddenInfo ?? null,
				aliases: seed.aliases ?? [],
				state: buildDefaultStateForType(entryType),
				adventureState: { discovered: markDiscovered, interactedWith: false, notes: [] },
				creativeState: null,
				injection: {
					mode: injectionMode ?? seed.injectionMode ?? 'keyword',
					keywords: seed.keywords ?? [seed.name.toLowerCase()],
					priority: priority ?? seed.priority ?? 100,
				},
				firstMentioned: null,
				lastMentioned: null,
				mentionCount: 0,
				createdBy: 'import',
				createdAt: now,
				updatedAt: now,
				loreManagementBlacklisted: false,
			};

			await saveCanonicalLorebookEntry(entry, 'create');
			result.imported++;
		} catch (e) {
			result.errors.push(`${seed.name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return result;
}

/**
 * Build a default state object for a given entry type.
 */
function buildDefaultStateForType(type: EntryType): Entry['state'] {
	switch (type) {
		case 'character': return { type: 'character', isPresent: false, lastSeenLocation: null, currentDisposition: null, relationship: { level: 0, status: 'unknown', history: [] }, knownFacts: [], revealedSecrets: [] };
		case 'location': return { type: 'location', isCurrentLocation: false, visitCount: 0, changes: [], presentCharacters: [], presentItems: [] };
		case 'item': return { type: 'item', inInventory: false, currentLocation: null, condition: null, uses: [] };
		case 'faction': return { type: 'faction', playerStanding: 0, status: 'unknown', knownMembers: [] };
		case 'event': return { type: 'event', occurred: false, occurredAt: null, witnesses: [], consequences: [] };
		default: return { type: 'concept', revealed: false, comprehensionLevel: 'unknown', relatedEntries: [] };
	}
}

/**
 * Load a built-in seed file by name.
 */
export async function loadBuiltinSeed(seedName: string): Promise<FactionSeedFile | LorebookSeedFile> {
	const seedModules: Record<string, () => Promise<unknown>> = {
		'asoiaf-factions': () => import('$lib/data/seeds/asoiaf-factions.json'),
		'asoiaf-lorebook': () => import('$lib/data/seeds/asoiaf-lorebook.json'),
	};

	const loader = seedModules[seedName];
	if (!loader) {
		throw new Error(`Unknown seed: ${seedName}. Available: ${Object.keys(seedModules).join(', ')}`);
	}

	const module = await loader() as { default: FactionSeedFile | LorebookSeedFile };
	return module.default;
}

/**
 * List available built-in seeds with metadata.
 */
export function listBuiltinSeeds(): { id: string; name: string; description: string }[] {
	return [
		{
			id: 'asoiaf-factions',
			name: 'ASOIAF — Faction Simulation Pack',
			description: '13 factions with goals, resources, dispositions, and inter-faction relations. Powers the faction simulation engine.',
		},
		{
			id: 'asoiaf-lorebook',
			name: 'ASOIAF — Complete Lorebook',
			description: '190 entries: 37 characters, 50 factions, 52 locations, 42 concepts, 9 items. Merged from Westeros + Valyrian sources. Spoiler-free to 298 AC.',
		},
	];
}

/**
 * Import a built-in seed by name into a story.
 * Auto-detects format (faction pack vs lorebook) and calls the right importer.
 */
export async function importBuiltinSeed(
	storyId: string,
	seedName: string,
	options?: Parameters<typeof importFactionSeed>[2],
): Promise<SeedImportResult> {
	const seedData = await loadBuiltinSeed(seedName);

	// Detect format: faction seeds have `factions`, lorebook seeds have `entries`
	if ('factions' in seedData) {
		return importFactionSeed(storyId, seedData as FactionSeedFile, options);
	} else if ('entries' in seedData) {
		return importLorebookSeed(storyId, seedData as LorebookSeedFile, options);
	}

	throw new Error(`Unknown seed format for ${seedName}`);
}
