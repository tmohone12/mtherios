/**
 * Tool Executor — Mtherios Orchestrator
 *
 * Routes GM tool calls to store/database mutations.
 * Replaces GenerationPipeline Phase 1 (classification + state sync).
 * No AI inference happens here — all data comes pre-structured from the LLM.
 */

import { story } from '$lib/stores/story.svelte';
import { CHARACTER_IDENTITY_FIELDS, automaticCharacterUpdate, retainAutomaticCharacterIdentity } from '$lib/contracts/automaticCharacterUpdate';
import {
	briefTerminalWiki,
	contextTerminalWiki,
	type TerminalWikiBriefResponse,
	type TerminalWikiContextPage,
	type TerminalWikiSearchResult,
} from '$lib/services/terminalWiki';
import { uuid } from '$lib/utils/uuid';
import {
	createEntryRelationship, getRelationshipsForEntry, updateEntryRelationship,
	createStoryBeat,
	updateStory, getChapters,
} from '$lib/services/database';
import {
	patchCanonicalLorebookEntry,
	saveCanonicalConversationMemory,
	saveCanonicalLorebookEntry,
	saveCanonicalRumors,
	saveCanonicalWorldEvent,
} from '$lib/services/canonicalWrites';
import {
	parseTimeProgression, advanceTime, clamp,
	makeLoreEntry,
	normalizeRelation,
	findMatchingLoreEntry,
	loreNameKey,
	computeRelationEventTarget,
} from './helpers';
import {
	briefWikiSchema,
	rollCheckToolSchema,
	searchWikiSchema,
	worldStateUpdateSchema,
	type BriefWikiArgs,
	type RollCheckToolArgs,
	type SearchWikiArgs,
	type WorldStateUpdate,
	type WorldStateLorebookEntry,
} from './schemas';
import { encodeDiceMarker, rollCheck } from '$lib/utils/dice';
import { resolveAbilityCheckNotation } from '$lib/utils/playerSheet';
import type {
	Entry, EntryRelationship, WorldEvent, Consequence,
	CharacterEntryState, LocationEntryState, LocationConnection,
	FactionEntryState, RumorRecord,
	EntryType, FactionGoal, FactionResources,
} from '$lib/types';

type FactionGoalInput = Omit<Partial<FactionGoal>, 'deadline'> & {
	description: string;
	deadline?: string | null;
};
type SearchWikiToolResult = {
	query: string;
	source: 'terminal_wiki' | 'local_lorebook';
	count: number;
	fallbackReason?: string;
	semanticError?: string | null;
	context?: {
		citations: string[];
		pages: Array<{
			id: string;
			name: string;
			type?: string;
			description: string;
			path: string;
			layer?: string;
			citationId: number;
			distance: number;
			sourceSeedPaths: string[];
		}>;
		markdown: string;
	};
	results: Array<{
		id: string;
		name: string;
		type?: EntryType | string;
		description: string;
		hidden_info?: string | null;
		aliases: string[];
		keywords: string[];
		path?: string;
		layer?: string;
		score?: number;
		links?: string[];
		backlinks?: string[];
		neighbors?: Array<{ path: string; title: string; distance: number }>;
	}>;
};
type BriefWikiToolResult = {
	task: string;
	source: 'terminal_wiki_brief' | 'search_wiki_fallback';
	mode: string;
	fallbackReason?: string;
	semanticError?: string | null;
	health?: {
		ok: boolean;
		issueCount: number;
		pageCount: number;
		brokenLinks: number;
		orphanPages: number;
		thinPages: number;
	};
	inventory?: {
		pageCount: number;
		layers: Record<string, number>;
		hubs: Array<{ path?: string; title?: string; backlinkCount?: number; linkCount?: number }>;
		rawSourceCount: number;
	};
	context?: SearchWikiToolResult['context'];
	runbook?: string[];
	briefMarkdown?: string;
	fallback?: SearchWikiToolResult;
};

function applyCurrentStoryServerVersion(serverVersion: number | null): void {
	if (!serverVersion || !story.currentStory) return;
	story.currentStory = {
		...story.currentStory,
		serverVersion,
		syncStatus: 'synced',
	};
}

// ── Main router ──

export async function executeToolCall(
	name: string,
	args: Record<string, any>,
): Promise<string> {
	switch (name) {
		case 'search_wiki': {
			const parsed = searchWikiSchema.safeParse(args);
			if (!parsed.success) {
				return JSON.stringify({ error: 'Invalid arguments', details: parsed.error.issues });
			}
			return JSON.stringify(await searchWiki(parsed.data));
		}
		case 'brief_wiki': {
			const parsed = briefWikiSchema.safeParse(args);
			if (!parsed.success) {
				return JSON.stringify({ error: 'Invalid arguments', details: parsed.error.issues });
			}
			return JSON.stringify(await briefWiki(parsed.data));
		}
		case 'roll_check': {
			const parsed = rollCheckToolSchema.safeParse(args);
			if (!parsed.success) {
				return JSON.stringify({ error: 'Invalid arguments', details: parsed.error.issues });
			}
			return JSON.stringify(rollCheckTool(parsed.data));
		}
		case 'update_world_state': {
			const parsed = worldStateUpdateSchema.safeParse(args);
			if (!parsed.success) {
				console.error('[Executor] Invalid update_world_state args:', parsed.error);
				return JSON.stringify({ error: 'Invalid arguments', details: parsed.error.issues });
			}
			await handleWorldStateUpdate(parsed.data);
			return JSON.stringify({ success: true });
		}
		default:
			return JSON.stringify({ error: `Unknown tool: ${name}` });
	}
}

// ══════════════════════════════════════════════════════════════
// update_world_state — replaces ClassifierService + Pipeline Phase 1
// ══════════════════════════════════════════════════════════════

function rollCheckTool(args: RollCheckToolArgs): Record<string, unknown> {
	try {
		const playerSheet = story.protagonist?.metadata?.playerSheet;
		const notation = playerSheet && typeof playerSheet === 'object'
			? resolveAbilityCheckNotation(args.notation, args.ability, playerSheet)
			: args.notation;
		const result = rollCheck(notation, args.dc, args.ability, args.description);
		return {
			ok: true,
			result,
			diceMarker: encodeDiceMarker(result),
			outcome: result.success ? 'success' : 'failure',
			critical: result.critical,
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function searchWiki(args: SearchWikiArgs): Promise<SearchWikiToolResult> {
	const query = args.query.trim();
	const limit = Math.max(1, Math.min(args.limit ?? 5, 10));
	const followDepth = Math.max(0, Math.min(args.follow_depth ?? 1, 3));
	try {
		const terminal = await contextTerminalWiki({
			query,
			storyId: story.currentStory?.serverStoryId ?? null,
			limit,
			followDepth,
			pageLimit: Math.max(limit, limit * Math.max(1, followDepth + 1)),
			pageChars: 1200,
			maxChars: 9000,
			exact: args.exact,
		});
		const pagesByPath = new Map((terminal.pages ?? []).map((page) => [page.path, page]));
		const results = filterTerminalWikiResults(terminal.seeds ?? [], args.types ?? [])
			.slice(0, limit)
			.map((row) => ({
				id: row.path,
				name: row.title,
				type: row.layer,
				description: truncateForTool(pagesByPath.get(row.path)?.text ?? row.text ?? '', 1200),
				hidden_info: undefined,
				aliases: [],
				keywords: wikiResultKeywords(row),
				path: row.path,
				layer: row.layer,
				score: row.score,
				links: (row.links ?? []).slice(0, 12),
				backlinks: (row.backlinks ?? []).slice(0, 12),
				neighbors: (row.neighbors ?? []).slice(0, 12),
			}));
		if (results.length === 0 && story.lorebookEntries.length > 0) {
			return localSearchWiki(args, terminal.semanticError
				? `Terminal wiki returned no matches; semantic search note: ${terminal.semanticError}`
				: 'Terminal wiki returned no matches.');
		}
		return {
			query,
			source: 'terminal_wiki',
			count: results.length,
			semanticError: terminal.semanticError ?? null,
			context: {
				citations: (terminal.citations ?? []).slice(0, 24),
				pages: filterTerminalWikiContextPages(terminal.pages ?? [], args.types ?? [])
					.slice(0, 24)
					.map((page) => ({
						id: page.path,
						name: page.title,
						type: page.layer,
						description: truncateForTool(page.text ?? '', 900),
						path: page.path,
						layer: page.layer,
						citationId: page.citationId,
						distance: page.distance,
						sourceSeedPaths: page.sourceSeedPaths,
					})),
				markdown: truncateForTool(terminal.contextMarkdown ?? '', 6000),
			},
			results,
		};
	} catch (error) {
		return localSearchWiki(args, error instanceof Error ? error.message : String(error));
	}
}

async function briefWiki(args: BriefWikiArgs): Promise<BriefWikiToolResult> {
	const task = args.task.trim();
	const limit = Math.max(1, Math.min(args.limit ?? 5, 8));
	const followDepth = Math.max(0, Math.min(args.follow_depth ?? 2, 3));
	const pageLimit = Math.max(1, Math.min(args.page_limit ?? 12, 24));
	const mode = args.mode ?? 'answer';

	try {
		const brief = await briefTerminalWiki({
			query: task,
			storyId: story.currentStory?.serverStoryId ?? null,
			mode,
			limit,
			followDepth,
			pageLimit,
			pageChars: 1200,
			maxChars: 12000,
			inventoryLimit: 8,
			exact: args.exact,
		});
		const summary = brief.lint?.summary ?? {};
		return {
			task,
			source: 'terminal_wiki_brief',
			mode: brief.mode ?? mode,
			semanticError: brief.search?.semanticError ?? null,
			health: {
				ok: Boolean(brief.lint?.ok),
				issueCount: summary.issueCount ?? 0,
				pageCount: summary.pageCount ?? brief.inventory?.pageCount ?? 0,
				brokenLinks: summary.brokenLinks ?? 0,
				orphanPages: summary.orphanPages ?? 0,
				thinPages: summary.thinPages ?? 0,
			},
			inventory: {
				pageCount: brief.inventory?.pageCount ?? 0,
				layers: brief.inventory?.layers ?? {},
				hubs: mapBriefHubs(brief.inventory?.hubs ?? []),
				rawSourceCount: brief.inventory?.rawSources?.length ?? 0,
			},
			context: {
				citations: (brief.context?.citations ?? []).slice(0, 24),
				pages: filterTerminalWikiContextPages(brief.context?.pages ?? [], [])
					.slice(0, 24)
					.map((page) => ({
						id: page.path,
						name: page.title,
						type: page.layer,
						description: truncateForTool(page.text ?? '', 900),
						path: page.path,
						layer: page.layer,
						citationId: page.citationId,
						distance: page.distance,
						sourceSeedPaths: page.sourceSeedPaths,
					})),
				markdown: truncateForTool(brief.context?.contextMarkdown ?? '', 6500),
			},
			runbook: (brief.runbook ?? []).slice(0, 10),
			briefMarkdown: truncateForTool(brief.briefMarkdown ?? '', 9000),
		};
	} catch (error) {
		return {
			task,
			source: 'search_wiki_fallback',
			mode,
			fallbackReason: error instanceof Error ? error.message : String(error),
			fallback: await searchWiki({
				query: task,
				types: [],
				limit,
				follow_depth: followDepth,
				include_hidden: true,
				exact: args.exact ?? false,
			}),
		};
	}
}

function localSearchWiki(args: SearchWikiArgs, fallbackReason?: string): SearchWikiToolResult {
	const query = args.query.trim();
	const terms = tokenize(query);
	const typeFilter = new Set(args.types ?? []);
	const limit = Math.max(1, Math.min(args.limit ?? 5, 10));

	const scored = story.lorebookEntries
		.filter(e => !(e as any).deleted)
		.filter(e => typeFilter.size === 0 || typeFilter.has(e.type))
		.map(entry => ({ entry, score: scoreWikiEntry(entry, query, terms) }))
		.filter(r => r.score > 0)
		.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
		.slice(0, limit);

	return {
		query,
		source: 'local_lorebook',
		count: scored.length,
		fallbackReason,
		results: scored.map(({ entry }) => ({
			id: entry.id,
			name: entry.name,
			type: entry.type,
			description: truncateForTool(entry.description ?? '', 900),
			hidden_info: args.include_hidden ? truncateForTool(entry.hiddenInfo ?? '', 700) || null : undefined,
			aliases: entry.aliases ?? [],
			keywords: entry.injection?.keywords ?? [],
		})),
	};
}

function mapBriefHubs(hubs: TerminalWikiBriefResponse['inventory']['hubs']): NonNullable<BriefWikiToolResult['inventory']>['hubs'] {
	return hubs.slice(0, 8).map((row) => ({
		path: typeof row.path === 'string' ? row.path : undefined,
		title: typeof row.title === 'string' ? row.title : undefined,
		backlinkCount: typeof row.backlinkCount === 'number' ? row.backlinkCount : undefined,
		linkCount: typeof row.linkCount === 'number' ? row.linkCount : undefined,
	}));
}

function filterTerminalWikiContextPages(pages: TerminalWikiContextPage[], types: SearchWikiArgs['types']): TerminalWikiContextPage[] {
	if (!types || types.length === 0) return pages;
	const folders = new Set(types.map((type) => `wiki/${type}s/`));
	return pages.filter((row) => {
		const path = row.path.toLowerCase();
		if (folders.has(path.split('/').slice(0, 2).join('/') + '/')) return true;
		return types.some((type) => path.includes(`/${type}`) || row.title.toLowerCase().includes(type));
	});
}

function filterTerminalWikiResults(results: TerminalWikiSearchResult[], types: SearchWikiArgs['types']): TerminalWikiSearchResult[] {
	if (!types || types.length === 0) return results;
	const folders = new Set(types.map((type) => `wiki/${type}s/`));
	return results.filter((row) => {
		const path = row.path.toLowerCase();
		if (folders.has(path.split('/').slice(0, 2).join('/') + '/')) return true;
		return types.some((type) => path.includes(`/${type}`) || row.title.toLowerCase().includes(type));
	});
}

function wikiResultKeywords(row: TerminalWikiSearchResult): string[] {
	return [
		row.layer,
		...(row.links ?? []).slice(0, 4),
		...(row.backlinks ?? []).slice(0, 4),
	]
		.filter((value): value is string => Boolean(value))
		.slice(0, 12);
}

function tokenize(text: string): string[] {
	return [...new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9'_-]+/i)
			.map(t => t.trim())
			.filter(t => t.length > 1),
	)];
}

function scoreWikiEntry(entry: Entry, rawQuery: string, terms: string[]): number {
	const query = rawQuery.toLowerCase();
	const name = entry.name.toLowerCase();
	let score = 0;

	if (name === query) score += 120;
	else if (name.includes(query) || query.includes(name)) score += 55;

	for (const alias of entry.aliases ?? []) {
		const a = alias.toLowerCase();
		if (a === query) score += 90;
		else if (a.includes(query) || query.includes(a)) score += 40;
	}

	const keywords = entry.injection?.keywords ?? [];
	for (const keyword of keywords) {
		const k = keyword.toLowerCase();
		if (k === query) score += 45;
		else if (k.includes(query) || query.includes(k)) score += 25;
	}

	const searchable = [
		entry.name,
		...(entry.aliases ?? []),
		...keywords,
		entry.description ?? '',
		entry.hiddenInfo ?? '',
	].join(' ').toLowerCase();
	for (const term of terms) {
		if (name.includes(term)) score += 20;
		else if (keywords.some(k => k.toLowerCase().includes(term))) score += 14;
		else if (searchable.includes(term)) score += 4;
	}
	return score;
}

function truncateForTool(text: string, maxChars: number): string {
	const clean = text.trim();
	if (clean.length <= maxChars) return clean;
	return clean.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...';
}

function recordValue(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function cleanStrings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
		: [];
}

function cleanText(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mergedCharacterContinuityState(
	previous: Record<string, any>,
	character: WorldStateUpdate['characters'][number],
	evidenceEntry: { id?: string } | undefined,
	isProtagonist: boolean,
): Record<string, any> {
	const next = { ...previous };
	const disposition = cleanText(character.relationship);
	const currentLocation = cleanText(character.currentLocation ?? character.current_location);
	const currentAction = cleanText(character.currentAction ?? character.current_action);
	const emotionalState = cleanText(character.emotionalState ?? character.emotional_state);
	const appearance = cleanText(character.appearance);
	const background = cleanText(character.background);
	const speechStyle = cleanText(character.speechStyle ?? character.speech_style);
	const aliases = cleanStrings(character.aliases);
	const traits = cleanStrings(character.traits);
	const pressures = cleanStrings(character.pressures);
	const factionTags = cleanStrings(character.faction_tags);
	const goals = cleanStrings(character.goals);

	if (aliases.length) next.aliases = mergeStrings(cleanStrings(previous.aliases), aliases);
	if (character.status) next.status = character.status;
	if (disposition) next.currentDisposition = disposition;
	if (traits.length) next.traits = traits;
	if (typeof character.present === 'boolean') {
		next.present = character.present;
		next.isPresent = character.present;
	}
	if (pressures.length) next.pressures = pressures;
	if (factionTags.length) next.factionTags = factionTags;
	if (typeof character.party_member === 'boolean') next.partyMember = character.party_member;
	if (character.party_member === false) next.partyRole = null;
	else if (cleanText(character.party_role)) next.partyRole = cleanText(character.party_role);
	if (currentLocation) next.currentLocation = currentLocation;
	if (currentAction) next.currentAction = currentAction;
	if (emotionalState) next.emotionalState = emotionalState;
	if (appearance) next.appearance = appearance;
	if (background) {
		next.bio = background;
		next.background = background;
	}
	if (goals.length) {
		next.goals = goals;
		next.motivations = goals;
	}
	if (speechStyle) next.speechStyle = speechStyle;

	const relationship = recordValue(previous.relationship);
	const playerSelf = isProtagonist
		|| previous.isProtagonist === true
		|| relationship.status === 'self'
		|| relationship.status === 'player_character';
	const affinityDelta = typeof character.affinity_delta === 'number' && Number.isFinite(character.affinity_delta)
		? Math.max(-20, Math.min(20, Math.trunc(character.affinity_delta)))
		: 0;
	if (disposition || (affinityDelta !== 0 && !playerSelf)) {
		const history = Array.isArray(relationship.history) ? relationship.history : [];
		const alreadyApplied = Boolean(evidenceEntry?.id)
			&& history.some((item) => recordValue(item).entryId === evidenceEntry?.id);
		const applyDelta = affinityDelta !== 0 && !playerSelf && !alreadyApplied;
		const level = typeof relationship.level === 'number' && Number.isFinite(relationship.level) ? relationship.level : 0;
		next.relationship = {
			...relationship,
			...(applyDelta ? { level: Math.max(-100, Math.min(100, level + affinityDelta)) } : {}),
			status: disposition ?? relationship.status ?? 'neutral',
			history: applyDelta ? [...history, {
				description: `[${affinityDelta > 0 ? '+' : ''}${affinityDelta}] ${cleanText(character.affinity_reason) ?? 'Narrated relationship shift.'}`,
				delta: affinityDelta,
				...(evidenceEntry?.id ? { entryId: evidenceEntry.id } : {}),
			}].slice(-12) : history,
		};
	}

	if (character.eventMemory) {
		const oldMemory = recordValue(previous.eventMemory ?? previous.npcEventMemory);
		next.eventMemory = Object.fromEntries(['did', 'saw', 'knew', 'knows'].map((key) => [
			key,
			mergeStrings(cleanStrings(oldMemory[key]), cleanStrings(character.eventMemory?.[key as keyof typeof character.eventMemory])).slice(-12),
		]));
	}
	return next;
}

async function handleWorldStateUpdate(args: WorldStateUpdate): Promise<void> {
	if (!story.currentStory) return;

	const protagonistName = story.protagonist?.name?.toLowerCase();
	const knownCharacterNames = new Set(story.characters.filter(character => story.characters.filter(other => other.name.toLowerCase() === character.name.toLowerCase()).length === 1).map(character => character.name.toLowerCase()));

	// ── Characters ──
	for (const char of args.characters) {
		if (!char.name) continue;
		const needle = char.name.toLowerCase();
		const targets = story.lorebookEntries.filter(e => e.type === 'character' && (
			e.name?.toLowerCase() === needle || (e.aliases ?? []).some(a => a?.toLowerCase() === needle)
		));
		if (targets.length > 1) continue;

		if (story.characters.filter(c => c.name.toLowerCase() === needle).length === 1) {
			await story.updateCharacterFromClassification(char.name, {
				relationship: char.relationship,
				status: char.status,
				partyMember: char.party_member,
				partyRole: char.party_role,
			});
		}

		// Classification may have just committed a narrow delta and refreshed the projection.
		const target = targets.length === 1 ? story.lorebookEntries.find(entry => entry.id === targets[0].id) : undefined;
		if (target) {
			const previousState = recordValue(target.state);
			const newState = mergedCharacterContinuityState(
				previousState,
				char,
				story.entries.at(-1),
				char.name.toLowerCase() === protagonistName,
			);
			const aliases = target.aliases ?? [];
			const automatic = automaticCharacterUpdate({ ...previousState, description: target.description }, { ...newState, ...(char.description ? { description: char.description } : {}) }, story.entries.at(-1)?.id ? [story.entries.at(-1)!.id] : []);
			const retained = retainAutomaticCharacterIdentity(previousState, newState);
			const identityRequest = JSON.stringify([automatic.sourceEntryIds, Object.fromEntries(Object.entries(recordValue(automatic.patch)).filter(([key]) => CHARACTER_IDENTITY_FIELDS.has(key)))]);
			const repeatedIdentityOnly = Object.keys(recordValue(automatic.patch)).every(key => CHARACTER_IDENTITY_FIELDS.has(key)) && target.metadata?.lastAutomaticIdentityRequest === identityRequest;
			if (Object.keys(recordValue(automatic.patch)).length && !repeatedIdentityOnly) {
				const result = await patchCanonicalLorebookEntry(target.id, { state: retained as any, aliases, metadata: { ...target.metadata, automaticCharacterUpdate: automatic }, updatedAt: Date.now() });
				applyCurrentStoryServerVersion(result.serverVersion);
				const projected = result.entry ?? { ...target, state: retained as any, aliases };
				projected.metadata = { ...projected.metadata, lastAutomaticIdentityRequest: identityRequest };
				story.lorebookEntries = story.lorebookEntries.map(e => e.id === target.id ? projected : e);
			}
		}
	}

	// Presence clears — anyone alive-but-off-screen, departed, dead, or
	// explicitly marked not-present. The schema's `present` flag was
	// previously declared but never read.
	const offstageNames = args.characters
		.filter(c => c.name && (
			c.status === 'departed' ||
			c.status === 'deceased' ||
			c.status === 'inactive' ||
			c.present === false
		))
		.map(c => c.name);
	if (offstageNames.length > 0) await story.clearPresenceForCharacters(offstageNames);

	// ── Locations ──
	// Enforce single current location
	const currentLocations = args.locations.filter(l => l.current);
	if (currentLocations.length > 1) {
		for (const loc of args.locations) {
			if (loc.current && loc !== currentLocations[currentLocations.length - 1]) {
				loc.current = false;
			}
		}
	}

	for (const loc of args.locations) {
		if (!loc.name) continue;
		await story.addOrUpdateLocation(loc.name, loc.description, loc.current);

		// Location connections
		if (loc.connections?.length) {
			await syncLocationConnections(loc.name, loc.connections);
		}
	}

	// Update presence. We previously skipped this whenever the classifier didn't
	// re-emit a `current: true` location — so a turn like "the merchant enters"
	// that didn't restate the room left presence stale. Fall back to the live
	// store's current location so presence still tracks.
	const currentLocFromArgs = args.locations.find(l => l.current);
	const currentLocName = currentLocFromArgs?.name
		?? story.locations.find(l => l.current)?.name
		?? null;
	if (currentLocName) {
		const presentNames = args.characters
			.filter(c =>
				c.name
				&& knownCharacterNames.has(c.name.toLowerCase())
				&& c.present !== false
				&& c.status !== 'deceased'
				&& c.status !== 'departed'
				&& c.status !== 'inactive',
			)
			.map(c => c.name);
		if (presentNames.length > 0) await story.updatePresence(presentNames, currentLocName);
	}

	// ── Items ──
	for (const item of args.items) {
		if (!item.name) continue;
		await story.addOrUpdateItem(item.name, item.description, item.quantity, item.equipped, item.location ?? undefined);
	}

	// ── Explicit lorebook entry creation ──
	if (args.lorebook_entries.length > 0) {
		await handleLorebookCreations(args.lorebook_entries);
	}

	// ── Time progression ──
	if (args.time_delta) {
		await applyTimeProgression(args.time_delta);
	}

	// ── Conversations ──
	if (args.conversations.length > 0) {
		const lastEntry = story.entries[story.entries.length - 1];
		if (lastEntry) {
			await syncConversationMemory(args.conversations, lastEntry);
		}
	}

	// ── Relationships ──
	if (args.relationships.length > 0) {
		await syncRelationships(args.relationships);
	}

	// ── Story beats ──
	for (const beat of args.story_beats) {
		if (!beat.title) continue;
		const type = beat.significance === 'critical' ? 'plot_point'
			: beat.significance === 'major' ? 'revelation'
			: beat.significance === 'moderate' ? 'milestone'
			: 'event' as const;
		await createStoryBeat({
			id: uuid(), storyId: story.currentStory.id,
			title: beat.title, description: beat.description,
			type, significance: beat.significance ?? null, status: 'active',
			triggeredAt: Date.now(), resolvedAt: null,
			metadata: { mood: args.mood ?? null },
			branchId: story.currentStory.currentBranchId ?? null,
		});
	}

	// ── Meter changes ──
	if (args.meter_changes.length > 0) {
		await story.applyMeterChanges(args.meter_changes);
	}

	if (args.player_reputation !== undefined) {
		await story.updatePlayerReputation(args.player_reputation);
	}

	// ── Agreement changes (treaties, oaths, bonds, bargains...) ──
	if (args.agreements.length > 0) {
		// Resolve current chapter number from the latest chapter, if any,
		// so created/broken agreements are threaded into the timeline.
		let currentChapterNumber: number | null = null;
		try {
			const { getChapters } = await import('$lib/services/database');
			const chapters = await getChapters(story.currentStory.id);
			if (chapters.length > 0) {
				currentChapterNumber = Math.max(...chapters.map((c) => c.number));
			}
		} catch { /* non-fatal */ }
		await story.applyAgreementChanges(args.agreements, currentChapterNumber);
	}

	// ── Consequences (death → faction hostility) ──
	await evaluateConsequences(args.characters);

	// ── Pre-embed lorebook (background) ──
	story.preEmbedLorebook().catch(e => console.warn('[Executor] preEmbedLorebook failed:', e));
}

// ── Explicit lorebook entry creation ──

async function handleLorebookCreations(
	entries: WorldStateLorebookEntry[],
): Promise<void> {
	if (!story.currentStory) return;
	const newEntries: Entry[] = [];
	const updatedEntries = new Map<string, Entry>();

	for (const incoming of entries) {
		if (!incoming.name) continue;
		const existing = findExistingLoreEntry(incoming);
		if (incoming.type === 'character' && !existing) {
			continue;
		}
		if (existing) {
			const updated = mergeLorebookEntry(existing, incoming);
			applyCurrentStoryServerVersion((await patchCanonicalLorebookEntry(existing.id, updated)).serverVersion);
			updatedEntries.set(existing.id, { ...existing, ...updated });
			console.log(`[Executor] Lorebook entry "${incoming.name}" already exists — skipping creation`);
			continue;
		}

		const entry = makeLoreEntry(
			story.currentStory.id,
			incoming.name,
			incoming.type,
			incoming.description,
			incoming.keywords.length > 0 ? incoming.keywords : [loreNameKey(incoming.name)],
			{
				hiddenInfo: incoming.hidden_info,
				aliases: incoming.aliases,
				keywords: incoming.keywords.length > 0 ? incoming.keywords : [loreNameKey(incoming.name)],
				injectionMode: incoming.injection_mode,
				priority: incoming.priority,
				state: buildIncomingLoreState(incoming),
			},
		);

		applyCurrentStoryServerVersion(await saveCanonicalLorebookEntry(entry, 'create'));
		newEntries.push(entry);
	}

	if (updatedEntries.size > 0) {
		story.lorebookEntries = story.lorebookEntries.map(e => updatedEntries.get(e.id) ?? e);
		console.log(`[Executor] Updated ${updatedEntries.size} lorebook entries: ${[...updatedEntries.values()].map(e => e.name).join(', ')}`);
	}
	if (newEntries.length > 0) {
		story.lorebookEntries = [...story.lorebookEntries, ...newEntries];
		console.log(`[Executor] Created ${newEntries.length} lorebook entries: ${newEntries.map(e => e.name).join(', ')}`);
	}
}

// ── Location connections ──

function findExistingLoreEntry(incoming: WorldStateLorebookEntry): Entry | undefined {
	return findMatchingLoreEntry(story.lorebookEntries, {
		name: incoming.name,
		type: incoming.type,
		aliases: incoming.aliases,
	});
}

function mergeLorebookEntry(existing: Entry, incoming: WorldStateLorebookEntry): Partial<Entry> {
	const mergedAliases = mergeStrings(existing.aliases ?? [], incoming.aliases ?? []);
	const mergedKeywords = mergeStrings(existing.injection?.keywords ?? [], incoming.keywords ?? []);
	const incomingState = buildIncomingLoreState(incoming) ?? {};

	return {
		description: mergeLoreText(existing.description ?? '', incoming.description, 'Recent development'),
		hiddenInfo: mergeLoreText(existing.hiddenInfo ?? '', incoming.hidden_info ?? '', 'Hidden development') || null,
		aliases: mergedAliases,
		state: mergeEntryState(existing, incomingState),
		injection: {
			mode: strongestInjectionMode(existing.injection?.mode ?? 'keyword', incoming.injection_mode),
			keywords: mergedKeywords.length > 0 ? mergedKeywords : [loreNameKey(existing.name)],
			priority: Math.max(existing.injection?.priority ?? 0, incoming.priority ?? 0),
		},
		updatedAt: Date.now(),
	};
}

function buildIncomingLoreState(incoming: WorldStateLorebookEntry): Record<string, any> | undefined {
	const state: Record<string, any> = { ...(incoming.state_overrides ?? {}) };
	if (incoming.type === 'faction') {
		if (incoming.faction_goals?.length) state.goals = normalizeFactionGoals(incoming.faction_goals);
		if (incoming.faction_resources) state.resources = normalizeFactionResources(incoming.faction_resources);
		if (incoming.faction_disposition) state.disposition = incoming.faction_disposition;
		if (incoming.territory?.length) state.territory = incoming.territory.map(t => t.trim()).filter(Boolean);
		if (incoming.known_members?.length) {
			const members = resolveFactionKnownMembers(incoming.known_members);
			if (members.knownMemberIds.length > 0) state.knownMembers = members.knownMemberIds;
			if (members.unresolvedMemberNames.length > 0) state.unresolvedKnownMembers = members.unresolvedMemberNames;
		}
	}
	return Object.keys(state).length > 0 ? state : undefined;
}

function mergeEntryState(existing: Entry, incomingState: Record<string, any>): any {
	if (existing.type !== 'faction') {
		return { ...(existing.state as Record<string, any>), ...incomingState };
	}
	const prev = existing.state as FactionEntryState;
	const next: FactionEntryState = { ...prev, ...(incomingState as Partial<FactionEntryState>) };
	if (incomingState.knownMembers) {
		next.knownMembers = mergeStrings(prev.knownMembers ?? [], incomingState.knownMembers);
	}
	if (incomingState.unresolvedKnownMembers) {
		next.unresolvedKnownMembers = mergeStrings(prev.unresolvedKnownMembers ?? [], incomingState.unresolvedKnownMembers);
	}
	if (incomingState.goals) {
		next.goals = mergeFactionGoals(prev.goals ?? [], incomingState.goals as FactionGoal[]);
	}
	if (incomingState.resources) {
		next.resources = mergeFactionResources(prev.resources, incomingState.resources as FactionResources);
	}
	if (incomingState.territory) {
		next.territory = mergeStrings(prev.territory ?? [], incomingState.territory);
	}
	return next;
}

function normalizeFactionGoals(goals: FactionGoalInput[]): FactionGoal[] {
	return goals
		.filter(g => g.description?.trim())
		.slice(0, 8)
		.map(g => ({
			description: g.description.trim(),
			priority: clamp(typeof g.priority === 'number' && Number.isFinite(g.priority) ? g.priority : 5, 1, 10),
			progress: clamp(typeof g.progress === 'number' && Number.isFinite(g.progress) ? g.progress : 0, 0, 100),
			type: g.type ?? 'diplomatic',
			deadline: g.deadline?.trim() || undefined,
		}));
}

function normalizeFactionResources(resources: Partial<FactionResources>): FactionResources {
	return {
		military: clamp(Math.round(resources.military ?? 50), 0, 100),
		wealth: clamp(Math.round(resources.wealth ?? 50), 0, 100),
		influence: clamp(Math.round(resources.influence ?? 50), 0, 100),
		information: clamp(Math.round(resources.information ?? 50), 0, 100),
		morale: clamp(Math.round(resources.morale ?? 50), 0, 100),
	};
}

function mergeFactionGoals(existing: FactionGoal[], incoming: FactionGoal[]): FactionGoal[] {
	const byKey = new Map<string, FactionGoal>();
	for (const goal of [...existing, ...incoming]) {
		const key = loreNameKey(goal.description);
		const prev = byKey.get(key);
		if (!prev) {
			byKey.set(key, goal);
			continue;
		}
		byKey.set(key, {
			...prev,
			...goal,
			priority: Math.max(prev.priority ?? 1, goal.priority ?? 1),
			progress: Math.max(prev.progress ?? 0, goal.progress ?? 0),
		});
	}
	return [...byKey.values()]
		.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
		.slice(0, 8);
}

function mergeFactionResources(existing: FactionResources | undefined, incoming: FactionResources): FactionResources {
	if (!existing) return incoming;
	return {
		military: incoming.military ?? existing.military,
		wealth: incoming.wealth ?? existing.wealth,
		influence: incoming.influence ?? existing.influence,
		information: incoming.information ?? existing.information,
		morale: incoming.morale ?? existing.morale,
	};
}

function memberNameToEntryId(name: string): string | null {
	const entry = findMatchingLoreEntry(story.lorebookEntries, {
		name,
		type: 'character',
		aliases: [],
	});
	return entry?.id ?? null;
}

function resolveFactionKnownMembers(names: string[]): { knownMemberIds: string[]; unresolvedMemberNames: string[] } {
	const knownMemberIds: string[] = [];
	const unresolvedMemberNames: string[] = [];
	for (const name of names) {
		const clean = name.trim();
		if (!clean) continue;
		const entryId = memberNameToEntryId(clean);
		if (entryId) {
			knownMemberIds.push(entryId);
		} else {
			unresolvedMemberNames.push(clean);
		}
	}
	return {
		knownMemberIds: mergeStrings([], knownMemberIds),
		unresolvedMemberNames: mergeStrings([], unresolvedMemberNames),
	};
}

function mergeStrings(existing: string[], incoming: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of [...existing, ...incoming]) {
		const clean = value.trim();
		if (!clean) continue;
		const key = clean.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(clean);
	}
	return out;
}

function mergeLoreText(existing: string, incoming: string, label: string): string {
	const base = existing.trim();
	const addition = incoming.trim();
	if (!addition) return base;
	if (!base) return addition;
	if (base.toLowerCase().includes(addition.toLowerCase().slice(0, 120))) return base;
	const merged = `${base}\n\n${label}: ${addition}`;
	return merged.length > 6000 ? merged.slice(0, 5997).trimEnd() + '...' : merged;
}

function strongestInjectionMode(
	existing: 'always' | 'keyword' | 'never',
	incoming: 'always' | 'keyword' | 'never',
): 'always' | 'keyword' | 'never' {
	if (existing === 'always' || incoming === 'always') return 'always';
	if (existing === 'keyword' || incoming === 'keyword') return 'keyword';
	return 'never';
}

async function syncLocationConnections(
	sourceName: string,
	connections: Array<{ targetName: string; direction?: string | null; travelTimeMinutes?: number }>,
): Promise<void> {
	if (!story.currentStory) return;

	const locationsByName = new Map<string, Entry>();
	for (const e of story.lorebookEntries) {
		if (e.type === 'location') locationsByName.set(e.name.toLowerCase(), e);
	}

	const sourceEntry = locationsByName.get(sourceName.toLowerCase());
	if (!sourceEntry) return;

	const state = { ...(sourceEntry.state as LocationEntryState) };
	const conns: LocationConnection[] = state.connections ? [...state.connections] : [];
	let changed = false;

	for (const conn of connections) {
		const targetEntry = locationsByName.get(conn.targetName.toLowerCase());
		if (!targetEntry) continue;
		if (conns.some(c => c.targetLocationId === targetEntry.id)) continue;
		conns.push({
			targetLocationId: targetEntry.id, targetLocationName: targetEntry.name,
			direction: conn.direction ?? null, travelTime: conn.travelTimeMinutes ?? 0,
			description: null, blocked: false, blockedReason: null,
		});
		changed = true;
	}

	if (changed) {
		state.connections = conns;
		applyCurrentStoryServerVersion((await patchCanonicalLorebookEntry(sourceEntry.id, { state: state as any, updatedAt: Date.now() })).serverVersion);
		story.lorebookEntries = story.lorebookEntries.map(e =>
			e.id === sourceEntry.id ? { ...e, state: state as any } : e
		);
	}
}

// ── Conversation memory ──

async function syncConversationMemory(
	conversations: WorldStateUpdate['conversations'],
	narrativeEntry: { id: string; position: number },
): Promise<void> {
	if (!story.currentStory) return;
	const updatedEntries = new Map<string, Entry>();

	for (const conv of conversations) {
		const npcEntry = story.lorebookEntries.find(
			e => e.type === 'character' && e.name.toLowerCase() === conv.npcName.toLowerCase()
		);
		if (!npcEntry) continue;

		await saveCanonicalConversationMemory({
			id: uuid(), storyId: story.currentStory.id,
			npcEntryId: npcEntry.id, npcName: conv.npcName,
			storyEntryId: narrativeEntry.id, storyPosition: narrativeEntry.position,
			topic: conv.topicSummary, playerSaid: conv.playerRevealed.join('; '),
			npcLearned: conv.npcLearned, emotionalImpact: conv.emotionalShift,
			importance: 'minor', createdAt: Date.now(),
		});

		const cState = { ...(npcEntry.state as CharacterEntryState) };
		cState.knownFacts = [...new Set([...(cState.knownFacts ?? []), ...conv.npcLearned])];
		cState.conversationTopics = [...new Set([...(cState.conversationTopics ?? []), conv.topicSummary])];
		cState.lastConversationAt = narrativeEntry.position;
		if (conv.emotionalShift) cState.personalOpinion = conv.emotionalShift;
		applyCurrentStoryServerVersion((await patchCanonicalLorebookEntry(npcEntry.id, { state: cState as any, updatedAt: Date.now() })).serverVersion);
		updatedEntries.set(npcEntry.id, { ...npcEntry, state: cState as any });
	}

	if (updatedEntries.size > 0) {
		story.lorebookEntries = story.lorebookEntries.map(e => updatedEntries.get(e.id) ?? e);
	}
}

// ── Relationships ──

async function syncRelationships(
	relationships: WorldStateUpdate['relationships'],
): Promise<void> {
	if (!story.currentStory) return;
	const entries = story.lorebookEntries;

	const entryByName = new Map<string, Entry>();
	for (const e of entries) entryByName.set(e.name.toLowerCase(), e);

	// Batch-load existing relationships
	const sourceIds = new Set<string>();
	for (const rel of relationships) {
		const source = entryByName.get(rel.sourceName.toLowerCase())
			?? findMatchingLoreEntry(entries, { name: rel.sourceName });
		if (source) sourceIds.add(source.id);
	}
	const allRels = new Map<string, EntryRelationship[]>();
	await Promise.all([...sourceIds].map(async (id) => {
		const rels = await getRelationshipsForEntry(story.currentStory!.id, id);
		allRels.set(id, rels);
	}));

	const newRels: EntryRelationship[] = [];
	for (const rel of relationships) {
		const source = entryByName.get(rel.sourceName.toLowerCase())
			?? findMatchingLoreEntry(entries, { name: rel.sourceName });
		const target = entryByName.get(rel.targetName.toLowerCase())
			?? findMatchingLoreEntry(entries, { name: rel.targetName });
		if (!source || !target) continue;

		const existing = allRels.get(source.id) ?? [];
		const dupe = existing.find(r => r.targetEntryId === target.id && r.type === rel.type);
		if (dupe) {
			await updateEntryRelationship(dupe.id, { strength: rel.strength, updatedAt: Date.now() });
			await syncFactionMembership(source, target, rel.type);
			continue;
		}

		const newRel: EntryRelationship = {
			id: uuid(), storyId: story.currentStory!.id,
			sourceEntryId: source.id, targetEntryId: target.id,
			type: rel.type, label: rel.label ?? null, strength: rel.strength ?? 50,
			bidirectional: rel.bidirectional ?? false, metadata: null,
			createdAt: Date.now(), updatedAt: Date.now(),
		};
		await createEntryRelationship(newRel);
		await syncFactionMembership(source, target, rel.type);
		newRels.push(newRel);
	}

	if (newRels.length > 0) {
		story.entryRelationships = [...story.entryRelationships, ...newRels];
	}
}

async function syncFactionMembership(source: Entry, target: Entry, type: string): Promise<void> {
	if (!['member-of', 'serves', 'leader-of'].includes(type)) return;
	if (source.type !== 'character' || target.type !== 'faction') return;
	const state = target.state as FactionEntryState;
	const knownMembers = mergeStrings(state.knownMembers ?? [], [source.id]);
	if (knownMembers.length === (state.knownMembers ?? []).length) return;
	const next: FactionEntryState = { ...state, knownMembers };
	applyCurrentStoryServerVersion((await patchCanonicalLorebookEntry(target.id, { state: next as any, updatedAt: Date.now() })).serverVersion);
	story.lorebookEntries = story.lorebookEntries.map(e =>
		e.id === target.id ? { ...e, state: next as any, updatedAt: Date.now() } : e
	);
}

// ── Time progression ──

/**
 * Advance the in-world clock by a parsed time delta and age local rumors.
 * Backend jobs own automatic faction and antagonist movement.
 */
async function applyTimeProgression(progression: string): Promise<void> {
	if (!story.currentStory) return;
	const deltaMinutes = parseTimeProgression(progression);
	if (deltaMinutes === 0) {
		console.warn(`[Executor] time_delta="${progression}" parsed to 0 minutes — no time advanced.`);
		return;
	}

	// Capture the story id at entry — `updateStory` is async, and if the user
	// switches stories during the write we must not stamp the new story's
	// `currentStory` with the old story's tracker.
	const storyId = story.currentStory.id;
	const newTracker = advanceTime(story.currentStory.timeTracker ?? null, deltaMinutes);
	await updateStory(storyId, { timeTracker: newTracker } as any);
	if (story.currentStory && story.currentStory.id === storyId) {
		story.currentStory = { ...story.currentStory, timeTracker: newTracker };
	}

	await ageRumors();
}

/**
 * Advance rumor lifecycle based on chapter delta vs each rumor's
 * `staleAfterChapters` lifetime.
 *
 * spreading → mature  at 50% of lifetime
 * mature    → stale   at 100% of lifetime
 *
 * Rumors with no `chapterNumber` (created before any chapter existed)
 * are left in their initial state.
 */
async function ageRumors(): Promise<void> {
	if (!story.currentStory || story.rumors.length === 0) return;
	const chapters = await getChapters(story.currentStory.id);
	const currentChapter = chapters.length > 0 ? Math.max(...chapters.map((c) => c.number)) : 0;

	type Update = { id: string; status: RumorRecord['status'] };
	const updates: Update[] = [];
	for (const rumor of story.rumors) {
		if (rumor.status === 'stale' || rumor.status === 'debunked') continue;
		if (rumor.chapterNumber == null) continue;
		const lifetime = rumor.staleAfterChapters > 0 ? rumor.staleAfterChapters : 5;
		const age = currentChapter - rumor.chapterNumber;
		if (age >= lifetime) {
			updates.push({ id: rumor.id, status: 'stale' });
		} else if (age >= lifetime / 2 && rumor.status === 'spreading') {
			updates.push({ id: rumor.id, status: 'mature' });
		}
	}

	if (updates.length === 0) return;
	const byId = new Map(updates.map((u) => [u.id, u.status]));
	const updatedRumors = story.rumors
		.filter((r) => byId.has(r.id))
		.map((r) => ({ ...r, status: byId.get(r.id)! }));
	try {
		applyCurrentStoryServerVersion(await saveCanonicalRumors(updatedRumors));
	} catch (e) {
		console.warn('[Executor] ageRumors update failed:', e);
	}
	story.rumors = story.rumors.map((r) =>
		byId.has(r.id) ? { ...r, status: byId.get(r.id)! } : r,
	);
}

// ── Consequences (death → faction hostility) ──

async function evaluateConsequences(
	characters: WorldStateUpdate['characters'],
): Promise<void> {
	if (!story.currentStory) return;
	const lastEntry = story.entries[story.entries.length - 1];
	if (!lastEntry) return;

	const newEvents: WorldEvent[] = [];

	for (const c of characters) {
		if (c.status !== 'deceased') continue;
		const charEntry = story.lorebookEntries.find(
			e => e.type === 'character' && e.name.toLowerCase() === c.name.toLowerCase()
		);
		if (!charEntry) continue;

		const rels = await getRelationshipsForEntry(story.currentStory.id, charEntry.id);
		const factionRels = rels.filter(r => r.type === 'member-of' || r.type === 'serves' || r.type === 'leader-of');

		const consequences: Consequence[] = [];
		for (const rel of factionRels) {
			const factionEntry = story.lorebookEntries.find(e => e.id === rel.targetEntryId && e.type === 'faction');
			if (!factionEntry) continue;
			const impact = rel.type === 'leader-of' ? -40 : -20;
			consequences.push({
				id: uuid(),
				description: `${factionEntry.name} turns hostile after ${c.name}'s death`,
				status: 'pending',
				targetEntityId: factionEntry.id,
				targetEntityName: factionEntry.name,
				effectType: 'faction_status_change',
				effectPayload: { playerStandingDelta: impact },
				delay: 0,
				appliedAt: null,
			});
		}

		if (consequences.length > 0) {
			const event: WorldEvent = {
				id: uuid(), storyId: story.currentStory.id,
				name: `${c.name} killed`,
				description: `${c.name} has been killed, triggering faction consequences.`,
				triggerEntryId: lastEntry.id, triggerPosition: lastEntry.position,
				sourceEntityId: charEntry.id, type: 'death', severity: 'major',
				consequences, appliedAt: null, createdAt: Date.now(),
			};
			applyCurrentStoryServerVersion(await saveCanonicalWorldEvent(event));
			newEvents.push(event);

			// Apply immediate consequences
			for (const cons of consequences) {
				if (cons.delay === 0) await applyConsequence(cons, event.id);
			}

			// Persist applied consequence statuses
			applyCurrentStoryServerVersion(await saveCanonicalWorldEvent(event));
		}
	}

	if (newEvents.length > 0) {
		story.worldEvents = [...story.worldEvents, ...newEvents];
	}
}

async function applyConsequence(consequence: Consequence, eventId: string): Promise<void> {
	if (!story.currentStory) return;
	consequence.status = 'applied';
	consequence.appliedAt = Date.now();

	if (consequence.effectType === 'faction_status_change' && consequence.targetEntityId) {
		const entry = story.lorebookEntries.find(e => e.id === consequence.targetEntityId);
		if (!entry || entry.type !== 'faction') return;
		const state = { ...(entry.state as FactionEntryState) };
		const payload = consequence.effectPayload as { playerStandingDelta?: number };
		if (payload.playerStandingDelta) {
			state.playerStanding = clamp(state.playerStanding + payload.playerStandingDelta, -100, 100);
			// Cascade through allies BEFORE writing back so we capture the original
			// faction's pre-mutation rels reference for traversal. Single-hop only.
			await cascadePlayerStandingThroughAllies(entry.id, payload.playerStandingDelta);
		}
		if (state.playerStanding <= -50) state.status = 'hostile';
		else if (state.playerStanding >= 50) state.status = 'allied';
		applyCurrentStoryServerVersion((await patchCanonicalLorebookEntry(entry.id, { state: state as any, updatedAt: Date.now() })).serverVersion);
		story.lorebookEntries = story.lorebookEntries.map(e =>
			e.id === entry.id ? { ...e, state: state as any } : e
		);
		return;
	}

	// Structured inter-faction relationship events. Wired here (not in
	// faction_status_change) so the existing player-rep flow stays untouched.
	if (consequence.effectType === 'relationship_change' && consequence.targetEntityId) {
		const payload = consequence.effectPayload as {
			sourceFactionId?: string;
			eventType?: 'alliance_formed' | 'alliance_broken' | 'betrayal' | 'standing_shift';
			delta?: number;
		};
		if (!payload.sourceFactionId || !payload.eventType) return;
		const a = story.lorebookEntries.find(e => e.id === payload.sourceFactionId && e.type === 'faction');
		const b = story.lorebookEntries.find(e => e.id === consequence.targetEntityId && e.type === 'faction');
		if (!a || !b) return;
		// Guard non-finite deltas so a malformed payload can't propagate NaN
		// through clamp → mutateRelation → persisted state.
		const rawDelta = typeof payload.delta === 'number' && Number.isFinite(payload.delta)
			? payload.delta
			: 0;

		if (payload.eventType === 'standing_shift') {
			// Pure ±delta drift via mutateRelation — preserves affinity tracking + per-side history.
			const d = clamp(rawDelta, -50, 50);
			await mutateRelation(a.id, b.name, d, payload.eventType);
			await mutateRelation(b.id, a.name, d, payload.eventType);
		} else {
			// Snap-to-target events (alliance/betrayal) — clean affinity reset via mutateRelationDirect.
			// Math lives in computeRelationEventTarget so it's testable in isolation.
			for (const [src, dst] of [[a, b], [b, a]] as const) {
				const sState = src.state as FactionEntryState;
				const cur = normalizeRelation((sState.interFactionRelations ?? {})[dst.name]).standing;
				const next = computeRelationEventTarget(cur, payload.eventType, rawDelta);
				await mutateRelationDirect(src.id, dst.name, next);
			}
		}
		return;
	}
}

// ── Inter-faction relation mutation helpers (Phase F3) ──

/**
 * Patch one side of a relation: shift standing by delta, shift affinity by a
 * fraction (slower for positive deltas, faster for negative — betrayal hurts
 * trust as much as standing). Appends an entry to history (capped at 5) unless
 * `silent` is true — entropy drift sets silent so it doesn't displace narrative
 * history entries.
 */
async function mutateRelation(
	factionEntryId: string,
	otherName: string,
	delta: number,
	reason?: string,
	silent: boolean = false,
): Promise<void> {
	const entry = story.lorebookEntries.find(e => e.id === factionEntryId);
	if (!entry || entry.type !== 'faction') return;
	const state = entry.state as FactionEntryState;
	const prev = state.interFactionRelations ?? {};
	const norm = normalizeRelation(prev[otherName]);
	const nextStanding = clamp(norm.standing + delta, -100, 100);
	const affinityRate = delta < 0 ? 0.5 : 0.33;
	const nextAffinity = clamp(norm.affinity + delta * affinityRate, -100, 100);
	const chapterNumber = currentChapterNumber();
	const newHistory = silent
		? norm.history
		: [
				...norm.history,
				{ event: reason ?? 'relation shift', delta, chapter: chapterNumber },
			].slice(-5);
	await writeRelation(factionEntryId, otherName, {
		standing: nextStanding,
		affinity: nextAffinity,
		history: newHistory,
	});
}

/**
 * SET the relation to an absolute value (used by alliance_formed/_broken/betrayal).
 * Snaps affinity to the same value for a clean reset; appends a history entry.
 */
async function mutateRelationDirect(factionEntryId: string, otherName: string, value: number): Promise<void> {
	const entry = story.lorebookEntries.find(e => e.id === factionEntryId);
	if (!entry || entry.type !== 'faction') return;
	const state = entry.state as FactionEntryState;
	const prev = state.interFactionRelations ?? {};
	const norm = normalizeRelation(prev[otherName]);
	const standing = clamp(value, -100, 100);
	const newHistory = [
		...norm.history,
		{ event: 'alliance event', delta: standing - norm.standing, chapter: currentChapterNumber() },
	].slice(-5);
	await writeRelation(factionEntryId, otherName, {
		standing,
		affinity: standing,
		history: newHistory,
	});
}

/** Low-level: persist a single relation entry. Both helpers above funnel through this. */
async function writeRelation(
	factionEntryId: string,
	otherName: string,
	relation: { standing: number; affinity: number; history: { event: string; delta: number; chapter: number }[] },
): Promise<void> {
	const entry = story.lorebookEntries.find(e => e.id === factionEntryId);
	if (!entry || entry.type !== 'faction') return;
	const state = entry.state as FactionEntryState;
	const prev = state.interFactionRelations ?? {};
	const newRels = { ...prev, [otherName]: relation };
	const newState = { ...state, interFactionRelations: newRels };
	applyCurrentStoryServerVersion((await patchCanonicalLorebookEntry(factionEntryId, { state: newState as any, updatedAt: Date.now() })).serverVersion);
	story.lorebookEntries = story.lorebookEntries.map(e =>
		e.id === factionEntryId ? { ...e, state: newState as any } : e,
	);
}

function currentChapterNumber(): number {
	// Best-effort: use the highest known chapter number for history attribution.
	// We don't fetch from DB to avoid making mutateRelation async-heavy.
	let max = 0;
	for (const fa of story.factionActions) {
		if (typeof fa.chapterNumber === 'number' && fa.chapterNumber > max) max = fa.chapterNumber;
	}
	return max;
}

/**
 * When a faction's playerStanding shifts via consequence, propagate a fraction
 * of that delta to its allies (interFactionRelations[ally] >= 30). Single-hop:
 * we never re-cascade through cascaded factions to avoid runaway changes.
 *
 * Asymmetric on purpose: enemies of enemies do NOT inherit the inverse — your
 * enemies' enemies don't automatically like you, that's a separate dynamic.
 */
async function cascadePlayerStandingThroughAllies(
	sourceFactionId: string,
	delta: number,
): Promise<void> {
	if (!story.currentStory) return;
	if (!Number.isFinite(delta) || delta === 0) return;
	const source = story.lorebookEntries.find(e => e.id === sourceFactionId);
	if (!source || source.type !== 'faction') return;
	const rels = (source.state as FactionEntryState).interFactionRelations ?? {};
	for (const [allyName, raw] of Object.entries(rels)) {
		const standing = normalizeRelation(raw).standing;
		if (standing < 30) continue;
		const ally = story.lorebookEntries.find(
			e => e.type === 'faction' && e.name === allyName && e.id !== sourceFactionId,
		);
		if (!ally) continue;
		const ratio = standing >= 60 ? 0.5 : standing >= 45 ? 0.4 : 0.3;
		const allyState = ally.state as FactionEntryState;
		const newStanding = clamp(allyState.playerStanding + delta * ratio, -100, 100);
		const newAllyState: FactionEntryState = {
			...allyState,
			playerStanding: newStanding,
			status: newStanding <= -50 ? 'hostile' : newStanding >= 50 ? 'allied' : allyState.status ?? 'unknown',
		};
		applyCurrentStoryServerVersion((await patchCanonicalLorebookEntry(ally.id, { state: newAllyState as any, updatedAt: Date.now() })).serverVersion);
		story.lorebookEntries = story.lorebookEntries.map(e =>
			e.id === ally.id ? { ...e, state: newAllyState as any } : e,
		);
	}
}
