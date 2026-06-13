/**
 * WorldSimulationService — Mtherios
 *
 * Unified living-world engine: plot injection + faction simulation + plot momentum
 * in ONE service with shared context building.
 *
 * Two entry points:
 *   - simulate()     : periodic full-world tick (faction actions, rumors, plot injection,
 *                      thread lifecycle updates, plot momentum pre-warm)
 *   - generateMomentum(): per-turn plot momentum for injection into the narrator's
 *                      system prompt. Called every turn before narrative generation.
 *
 * Context sources (both methods):
 *   - Strategic: arc summaries (long-term) + uncovered chapter summaries (medium-term)
 *              + thread registry (open/imminent/stalled/closed)
 *   - Tactical: last 40 raw story entries (what just happened)
 *   - Dialogue: last 20 user/assistant message pairs (conversation rhythm)
 *   - Faction dossiers: lorebook entries of type 'faction' with goals/resources/disposition
 *   - Character dossiers: lorebook entries of type 'character' with motives/pressures/ties
 *   - Schemes: active antagonist + player plans
 *
 * Season effects are calculated deterministically in code, not by the LLM.
 */

import { BaseAIService } from '../BaseAIService';
import {
	worldSimulationResultSchema,
	plotMomentumSchema,
	type WorldSimulationResult,
	type PlotMomentum,
} from '../sdk/schemas/worldsim';
import { createLogger } from '../core/config';
import { normalizeRelation } from '../tools/helpers';
import { buildEconomyScaleBlock } from '../context/economyScale';
import { applyPlotMomentumAgencyGuard } from '../context/plotMomentumAgency';
import { selectStoryMemory } from '../context/storyMemorySelector';
import { buildStrategicWorldSimBlock } from '../context/strategicFramePromptCard';
import { buildWarExecutionRulesBlock } from '../context/warDoctrine';
import type {
	Entry, Chapter, Arc, StoryEntry, TimeTracker, EntryRelationship,
	CharacterEntryState, FactionEntryState, FactionActionRecord,
	StoryThread, Agreement, StrategicWorldFrame,
} from '$lib/types';

/** A single inter-faction relation shift, derived from FactionRelation.history. */
export interface RelationChangeEvent {
	source: string;
	target: string;
	event: string;
	delta: number;
	chapter: number;
}

const log = createLogger('WorldSim');

/** WorldSim runs every N chapters */
export const WORLD_SIM_CHAPTER_INTERVAL = 1;

/** Max recent chat entries for tactical context (was 6, now 40) */
const MAX_RECENT_ENTRIES = 40;

/** Max conversation message pairs for dialogue context */
const MAX_CONVERSATION_PAIRS = 20;

/** Max factions per tick to prevent token explosion */
const MAX_FACTIONS_PER_TICK = 12;

/** Max character dossiers per tick to prevent token explosion */
const MAX_CHARACTERS_PER_TICK = 16;

// ── Season calculation (deterministic, no LLM needed) ──

export interface SeasonEffect {
	currentSeason: 'spring' | 'summer' | 'autumn' | 'winter' | 'long_winter';
	militaryModifier: number;
	travelModifier: number;
	foodPressure: 'abundant' | 'normal' | 'scarce' | 'famine';
	narrativeNote: string;
}

const SEASON_TABLE: Record<string, SeasonEffect> = {
	spring: { currentSeason: 'spring', militaryModifier: 1.0, travelModifier: 1.0, foodPressure: 'normal', narrativeNote: 'The thaw has come — mud on the roads, buds on the trees, armies stirring.' },
	summer: { currentSeason: 'summer', militaryModifier: 1.1, travelModifier: 1.1, foodPressure: 'abundant', narrativeNote: 'High summer — long days, full granaries, peak campaign season.' },
	autumn: { currentSeason: 'autumn', militaryModifier: 0.9, travelModifier: 0.9, foodPressure: 'normal', narrativeNote: 'Harvest time — the fields are cut, the air cools, armies make for home.' },
	winter: { currentSeason: 'winter', militaryModifier: 0.6, travelModifier: 0.5, foodPressure: 'scarce', narrativeNote: 'Winter grips the land — roads close, messages slow, the hungry grow desperate.' },
	long_winter: { currentSeason: 'long_winter', militaryModifier: 0.3, travelModifier: 0.3, foodPressure: 'famine', narrativeNote: 'The long winter. The old and the young die first. Movement is suicide. Survival is the only war.' },
};

export function calculateSeason(time: TimeTracker | null): SeasonEffect {
	if (!time) return SEASON_TABLE.summer;
	const totalDays = (time.years * 365) + time.days;
	const dayOfYear = totalDays % 365;
	if (dayOfYear < 90) return SEASON_TABLE.spring;
	if (dayOfYear < 180) return SEASON_TABLE.summer;
	if (dayOfYear < 270) return SEASON_TABLE.autumn;
	return SEASON_TABLE.winter;
}

// ── Shared Context Builder ──

interface SimContext {
	storyMemoryBlock: string;
	arcBlock: string;
	chapterBlock: string;
	historyLedgerBlock: string;
	earnedPayoffBlock: string;
	allThreads: string[];
	characterArcs: Array<string | { name: string; development: string }>;
	tacticalBlock: string;
	conversationBlock: string;
	factionBlock: string;
	characterBlock: string;
	hasFactions: boolean;
	season: SeasonEffect;
	recentFactionActions: FactionActionRecord[];
	relationChangeLog: RelationChangeEvent[];
	threadRegistry: string;
	schemeBlock: string;
	agreementBlock: string;
	worldEventBlock: string;
	locationBlock: string;
	strategicFrameBlock: string;
}

function buildSimContext(
	chapters: Chapter[],
	arcs: Arc[],
	recentEntries: StoryEntry[],
	factionEntries: Entry[],
	characterEntries: Entry[],
	entryRelationships: EntryRelationship[],
	threads: StoryThread[],
	agreements: Agreement[],
	worldEvents: { name: string; description: string }[],
	locationName: string,
	schemes: string,
	timeTracker: TimeTracker | null,
	recentFactionActions: FactionActionRecord[],
	relationChangeLog: RelationChangeEvent[],
	strategicWorldFrame?: StrategicWorldFrame | null,
): SimContext {
	const { arcBlock, chapterBlock, historyLedgerBlock, allThreads, characterArcs } = buildStoryContext(chapters, arcs);

	// Tactical: last 40 entries
	const recent = recentEntries.slice(-MAX_RECENT_ENTRIES);
	const tacticalBlock = recent.length > 0
		? recent.map(e => `[${e.type}]: ${e.content.slice(0, 200)}`).join('\n')
		: '';

	// Conversation: last 20 user/assistant pairs
	const conversationBlock = buildConversationBlock(recentEntries.slice(-MAX_CONVERSATION_PAIRS * 2));
	const storyMemory = selectStoryMemory(chapters, arcs, {
		query: [
			locationName,
			schemes,
			tacticalBlock,
			conversationBlock,
			threads.map(thread => thread.description).join('\n'),
			factionEntries.map(entry => entry.name).join(', '),
			characterEntries.slice(0, 24).map(entry => entry.name).join(', '),
		].join('\n\n'),
		sceneEntityNames: characterEntries.slice(0, 24).map(entry => entry.name),
		currentLocationName: locationName,
		threadHints: threads.map(thread => thread.description),
		tokenBudget: 2600,
		recentCount: 6,
		relevantCount: 8,
		resurfacedCount: 3,
		seed: `${chapters.length}:${arcs.length}:${locationName}`,
	});

	// Season
	const season = calculateSeason(timeTracker);

	// Faction dossiers
	const hasFactions = factionEntries.length > 0;
	let factionBlock = '';
	if (hasFactions) {
		const selectedFactions = selectFactionsForTick(factionEntries, recentFactionActions, schemes);
		const selectedIds = new Set(selectedFactions.map(faction => faction.id));
		const omittedFactions = factionEntries.filter(faction => !selectedIds.has(faction.id));
		const dossiers = selectedFactions
			.map(e => {
				const leaderRel = entryRelationships.find(r =>
					r.targetEntryId === e.id && r.type === 'leader-of'
				);
				const leaderEntry = leaderRel
					? characterEntries.find(c => c.id === leaderRel.sourceEntryId)
					: null;
				return buildFactionDossier(e, leaderEntry ?? null, characterEntries);
			});
		factionBlock = dossiers.join('\n\n');
		if (omittedFactions.length > 0) {
			factionBlock += `\n\nOther known factions not fully simulated this tick: ${omittedFactions.map(f => f.name).sort().join(', ')}.\nOnly bring one of them forward if the current scene, an active scheme, or a recent event directly points at them.`;
		}
	}

	const characterBlock = buildCharacterStateBlock(
		characterEntries,
		factionEntries,
		recentEntries,
		schemes,
		locationName,
	);

	// Thread registry
	const threadRegistry = buildThreadRegistry(threads);

	// Agreements
	const activeAgreements = agreements.filter(a => a.status === 'active');
	const agreementBlock = activeAgreements.length > 0
		? activeAgreements.slice(0, 10).map(a => `- ${a.parties.join(' ↔ ')} (${a.category}): ${a.terms.slice(0, 120)}`).join('\n')
		: '';

	const earnedPayoffBlock = buildEarnedPayoffBlock(
		chapters,
		arcs,
		agreements,
		recentFactionActions,
		relationChangeLog,
	);

	// World events
	const worldEventBlock = worldEvents.length > 0
		? worldEvents.slice(0, 6).map(e => `- ${e.name}${e.description ? ': ' + e.description.slice(0, 100) : ''}`).join('\n')
		: '';

	return {
		storyMemoryBlock: storyMemory.block,
		arcBlock, chapterBlock, historyLedgerBlock, earnedPayoffBlock,
		allThreads, characterArcs,
		tacticalBlock, conversationBlock, factionBlock, characterBlock, hasFactions,
		season, recentFactionActions: recentFactionActions.slice(-5),
		relationChangeLog: relationChangeLog.slice(0, 8),
		threadRegistry, schemeBlock: schemes, agreementBlock,
		worldEventBlock, locationBlock: locationName,
		strategicFrameBlock: buildStrategicWorldSimBlock(strategicWorldFrame),
	};
}

const PAYOFF_KEYWORDS = [
	'loyal', 'favor', 'favour', 'debt', 'promise', 'oath', 'reward', 'gift',
	'helped', 'saved', 'rescued', 'protected', 'alliance', 'ally', 'gratitude',
	'trust', 'standing', 'honor', 'honour', 'mercy', 'vouched', 'invitation',
	'shelter', 'safe passage', 'patron', 'sponsor', 'commended', 'praised',
];

function truncateText(value: string | null | undefined, max: number): string {
	if (!value) return '';
	return value.length > max ? value.slice(0, max - 1) + '...' : value;
}

function compactText(value: string | null | undefined): string {
	return (value ?? '').replace(/\s+/g, ' ').trim();
}

function recordFrom(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArrayFrom(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function normalizeForMatch(value: string): string {
	return compactText(value).toLowerCase();
}

function containsName(text: string, name: string): boolean {
	const normalized = normalizeForMatch(name);
	if (normalized.length < 3) return false;
	return normalizeForMatch(text).includes(normalized);
}

function factionMatchTerms(faction: Entry): string[] {
	const state = recordFrom(faction.state);
	const injection = recordFrom(faction.injection);
	return [...new Set([
		faction.name,
		...faction.aliases,
		...stringArrayFrom(injection.keywords),
		...stringArrayFrom(state.aliases),
	].map(compactText).filter((item) => item.length >= 3))];
}

function selectChapterRelevantFactions(input: {
	latestChapter: Chapter;
	recentEntries: StoryEntry[];
	factionEntries: Entry[];
	involvedFactionNames: string[];
}): Entry[] {
	const explicit = input.involvedFactionNames.map(normalizeForMatch).filter(Boolean);
	const evidenceText = [
		input.latestChapter.title ?? '',
		input.latestChapter.summary,
		...(input.latestChapter.keywords ?? []),
		...(input.latestChapter.characters ?? []),
		...(input.latestChapter.locations ?? []),
		...(input.latestChapter.plotThreads ?? []),
		...input.recentEntries.slice(-12).map((entry) => entry.content),
	].join('\n');
	return input.factionEntries
		.filter((faction) => {
			const terms = factionMatchTerms(faction);
			if (explicit.length > 0 && terms.some((term) => explicit.includes(normalizeForMatch(term)))) return true;
			return terms.some((term) => containsName(evidenceText, term));
		})
		.slice(0, 6);
}

function factionPromptLine(faction: Entry): string {
	const state = recordFrom(faction.state);
	const goals = stringArrayFrom(state.goals).slice(0, 2);
	const resources = recordFrom(state.resources);
	const resourceKeys = Object.entries(resources)
		.filter(([, value]) => value !== null && value !== undefined && value !== '')
		.slice(0, 4)
		.map(([key, value]) => `${key}: ${String(value)}`);
	const details = [
		goals.length > 0 ? `goals: ${goals.join('; ')}` : null,
		resourceKeys.length > 0 ? `resources: ${resourceKeys.join(', ')}` : null,
	].filter((item): item is string => Boolean(item));
	return `- ${faction.name}${details.length > 0 ? ` (${details.join(' | ')})` : ''}`;
}

export interface ChapterWorldSimulationPrompt {
	system: string;
	user: string;
	relevantFactions: Entry[];
}

export function buildChapterWorldSimulationPrompt(input: {
	latestChapter: Chapter;
	recentEntries: StoryEntry[];
	factionEntries?: Entry[];
	involvedFactions?: string[];
	mode?: string;
	pov?: string;
	tense?: string;
}): ChapterWorldSimulationPrompt {
	const {
		latestChapter,
		recentEntries,
		factionEntries = [],
		involvedFactions = [],
		mode = 'adventure',
		pov = 'second',
		tense = 'present',
	} = input;
	const recent = recentEntries.slice(-12);
	const relevantFactions = selectChapterRelevantFactions({
		latestChapter,
		recentEntries: recent,
		factionEntries,
		involvedFactionNames: involvedFactions,
	});
	const recentBlock = recent.length > 0
		? recent.map((entry) => `[${entry.type}] ${truncateText(entry.content, 280)}`).join('\n')
		: 'No recent transcript entries supplied.';
	const factionBlock = relevantFactions.length > 0
		? relevantFactions.map(factionPromptLine).join('\n')
		: 'No faction dossiers were directly relevant to this chapter.';
	const chapterBlock = [
		`Chapter ${latestChapter.number}: ${latestChapter.title ?? 'Untitled'}`,
		truncateText(latestChapter.summary, 1600),
		latestChapter.characters?.length ? `Characters: ${latestChapter.characters.join(', ')}` : null,
		latestChapter.locations?.length ? `Locations: ${latestChapter.locations.join(', ')}` : null,
		latestChapter.plotThreads?.length ? `Open threads: ${latestChapter.plotThreads.join('; ')}` : null,
		latestChapter.emotionalTone ? `Tone: ${latestChapter.emotionalTone}` : null,
	].filter((line): line is string => Boolean(line)).join('\n');

	const system = `You are the Mtherios living-world engine for a ${mode} story (${pov} person, ${tense} tense).

React ONLY the newly closed chapter and the recent transcript excerpt. Do not read ahead, recap old arcs, or make sweeping off-screen changes.

Keep the update slow-burn:
- 0-2 faction actions, only from factions shown below
- 0-2 rumors, tied to chapter evidence
- small world-state changes that memory can carry forward
- no sudden personality rewrites or major faction reversals without evidence

Return JSON matching the world simulation schema. Use worldNarrative for the compact world-state delta.`;

	const user = `Latest chapter:
${chapterBlock}

Recent transcript excerpt:
${recentBlock}

Relevant factions:
${factionBlock}

Generate the per-chapter world update now.`;

	return { system, user, relevantFactions };
}

function hasPayoffCue(value: string | null | undefined): boolean {
	if (!value) return false;
	const lower = value.toLowerCase();
	return PAYOFF_KEYWORDS.some(keyword => lower.includes(keyword));
}

function buildStoryContext(chapters: Chapter[], arcs: Arc[]) {
	const coveredIds = new Set(arcs.flatMap(a => a.chapterIds));
	const uncovered = chapters
		.filter(c => !coveredIds.has(c.id))
		.sort((a, b) => a.number - b.number);
	const recentChapters = chapters
		.slice()
		.sort((a, b) => a.number - b.number)
		.slice(-8);
	const recentArcs = arcs
		.slice()
		.sort((a, b) => a.arcNumber - b.arcNumber)
		.slice(-4);

	const arcBlock = arcs.length > 0
		? arcs.map(a =>
			`Arc ${a.arcNumber}: "${a.title}" (Ch.${a.chapterRange})\n${truncateText(a.summary, 350)}`
		).join('\n\n')
		: '';

	const chapterBlock = uncovered
		.map(ch => {
			const chars = ch.characters?.length ? ` | Characters: ${ch.characters.join(', ')}` : '';
			const locs = ch.locations?.length ? ` | Locations: ${ch.locations.join(', ')}` : '';
			return `Ch.${ch.number}: ${ch.title ?? 'Untitled'}${chars}${locs}\n${truncateText(ch.summary, 250)}`;
		})
		.join('\n\n');

	const historyLedgerLines: string[] = [];
	for (const arc of recentArcs) {
		const threads = arc.unresolvedThreads?.length
			? ` Threads still live: ${arc.unresolvedThreads.slice(0, 3).join('; ')}.`
			: '';
		const characterMovement = arc.characterArcs?.length
			? ` Character movement: ${arc.characterArcs.slice(0, 3).map(ca => `${ca.name}: ${ca.development}`).join('; ')}.`
			: '';
		historyLedgerLines.push(
			`- [Arc ${arc.arcNumber}, Ch.${arc.chapterRange}] ${truncateText(arc.summary, 260)}${threads}${characterMovement}`,
		);
	}
	for (const ch of recentChapters) {
		const threads = ch.plotThreads?.length ? ` Threads: ${ch.plotThreads.slice(0, 3).join('; ')}.` : '';
		historyLedgerLines.push(
			`- [Ch.${ch.number}${ch.title ? ` "${ch.title}"` : ''}] ${truncateText(ch.summary, 220)}${threads}`,
		);
	}
	const historyLedgerBlock = historyLedgerLines.join('\n');

	const allThreads = arcs.flatMap(a => a.unresolvedThreads).filter(Boolean);

	const characterArcs = arcs
		.flatMap(a => a.characterArcs ?? [])
		.filter(Boolean);

	return { arcBlock, chapterBlock, historyLedgerBlock, allThreads, characterArcs };
}

function buildEarnedPayoffBlock(
	chapters: Chapter[],
	arcs: Arc[],
	agreements: Agreement[],
	recentFactionActions: FactionActionRecord[],
	relationChangeLog: RelationChangeEvent[],
): string {
	const lines: string[] = [];

	for (const agreement of agreements
		.filter(a => a.status === 'active' || a.status === 'fulfilled')
		.slice(-10)) {
		const chapter = agreement.createdChapterNumber != null ? `Ch.${agreement.createdChapterNumber}` : 'prior history';
		const status = agreement.status === 'fulfilled' ? 'fulfilled' : 'owed';
		lines.push(
			`- [${chapter} ${agreement.category} ${status}] ${agreement.parties.join(' / ')}: ${truncateText(agreement.terms, 170)}`,
		);
		for (const consequence of agreement.consequences.slice(0, 2)) {
			if (hasPayoffCue(consequence)) lines.push(`  payoff cue: ${truncateText(consequence, 150)}`);
		}
	}

	for (const shift of relationChangeLog.filter(e => e.delta > 0).slice(0, 8)) {
		lines.push(
			`- [Ch.${shift.chapter} relation +${shift.delta}] ${shift.source} and ${shift.target}: ${truncateText(shift.event, 150)}. This can mature as trust, loyalty, access, aid, or a warning.`,
		);
	}

	for (const action of recentFactionActions.slice(-8)) {
		const positiveConsequences = action.consequences.filter(hasPayoffCue);
		if (!hasPayoffCue(action.action) && positiveConsequences.length === 0) continue;
		const target = action.target ? ` -> ${action.target}` : '';
		lines.push(`- [Faction action ${action.factionName}${target}] ${truncateText(action.action, 170)}`);
		for (const consequence of positiveConsequences.slice(0, 2)) {
			lines.push(`  payoff cue: ${truncateText(consequence, 150)}`);
		}
	}

	for (const arc of arcs.slice(-4)) {
		for (const ca of (arc.characterArcs ?? []).filter(ca => hasPayoffCue(ca.development)).slice(0, 3)) {
			lines.push(`- [Arc ${arc.arcNumber} character arc] ${ca.name}: ${truncateText(ca.development, 170)}`);
		}
	}

	for (const chapter of chapters.slice(-8)) {
		const chapterCues = [
			...(chapter.plotThreads ?? []).filter(hasPayoffCue),
			chapter.summary,
		].filter(hasPayoffCue);
		for (const cue of chapterCues.slice(0, 2)) {
			lines.push(`- [Ch.${chapter.number} reward seed] ${truncateText(cue, 170)}`);
		}
	}

	return lines.slice(0, 18).join('\n');
}

function buildConversationBlock(entries: StoryEntry[]): string {
	const pairs: string[] = [];
	let lastUser = '';
	for (const e of entries) {
		if (e.type === 'user_action') {
			lastUser = e.content.slice(0, 300);
		} else if (e.type === 'narration' && lastUser) {
			pairs.push(`USER: ${lastUser}\nGM:  ${e.content.slice(0, 300)}`);
			lastUser = '';
		}
	}
	return pairs.join('\n\n---\n\n');
}

function factionResourceAverage(state: FactionEntryState): number {
	const r = state.resources;
	if (!r) return 0;
	return Math.round((r.military + r.wealth + r.influence + r.information + r.morale) / 5);
}

function factionGoalPressure(state: FactionEntryState): number {
	const goals = (state.goals ?? []).filter(goal => (goal.progress ?? 0) < 100);
	if (goals.length === 0) return 0;
	return Math.max(...goals.map(goal => (goal.priority ?? 0) * 10 + Math.max(0, 100 - (goal.progress ?? 0)) / 5));
}

function scoreFactionForTick(
	faction: Entry,
	recentFactionActions: FactionActionRecord[],
	schemes: string,
): number {
	const state = faction.state as FactionEntryState;
	const name = faction.name.toLowerCase();
	let score = Math.abs(state.playerStanding ?? 0);
	if (state.status === 'hostile' || state.status === 'allied') score += 30;
	if (state.disposition === 'aggressive' || state.disposition === 'desperate') score += 25;
	else if (state.disposition === 'scheming') score += 20;
	score += factionGoalPressure(state);
	score += factionResourceAverage(state) / 4;
	score += recentFactionActions.filter(action => action.factionName.toLowerCase() === name).length * 35;
	if (schemes.toLowerCase().includes(name)) score += 35;
	if ((state.territory ?? []).length > 0) score += 5;
	return score;
}

function selectFactionsForTick(
	factionEntries: Entry[],
	recentFactionActions: FactionActionRecord[],
	schemes: string,
): Entry[] {
	return factionEntries
		.map((entry, index) => ({ entry, index, score: scoreFactionForTick(entry, recentFactionActions, schemes) }))
		.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name) || a.index - b.index)
		.slice(0, MAX_FACTIONS_PER_TICK)
		.map(item => item.entry);
}

function buildThreadRegistry(threads: StoryThread[]): string {
	if (threads.length === 0) return '(No tracked threads yet.)';
	const byStatus: Record<string, StoryThread[]> = {
		open: [], imminent: [], stalled: [], closed: [], abandoned: [],
	};
	for (const t of threads) {
		(byStatus[t.status] ?? byStatus.open).push(t);
	}
	const lines: string[] = [];
	for (const [status, list] of Object.entries(byStatus)) {
		if (list.length === 0) continue;
		lines.push(`[${status.toUpperCase()}]`);
		for (const t of list) {
			lines.push(`  [${t.significance}] ${t.description}`);
		}
	}
	return lines.join('\n');
}

function factionNamesForCharacter(character: Entry, factionEntries: Entry[]): string[] {
	const directTags = ((character.state as CharacterEntryState | undefined)?.factionTags ?? [])
		.map(tag => tag.trim())
		.filter(Boolean);
	const memberships = factionEntries
		.filter(faction => {
			const state = faction.state as FactionEntryState | undefined;
			return (state?.knownMembers ?? []).some(member =>
				member === character.id ||
				member.toLowerCase() === character.name.toLowerCase() ||
				(character.aliases ?? []).some(alias => member.toLowerCase() === alias.toLowerCase())
			);
		})
		.map(faction => faction.name);
	return [...new Set([...directTags, ...memberships])];
}

function scoreCharacterForTick(
	character: Entry,
	factionEntries: Entry[],
	recentEntries: StoryEntry[],
	schemes: string,
	locationName: string,
): number {
	const state = character.state as CharacterEntryState | undefined;
	const recentText = recentEntries.slice(-MAX_RECENT_ENTRIES)
		.map(entry => entry.content)
		.join('\n')
		.toLowerCase();
	const name = character.name.toLowerCase();
	const aliases = (character.aliases ?? []).map(alias => alias.toLowerCase());
	let score = 0;
	if (recentText.includes(name) || aliases.some(alias => recentText.includes(alias))) score += 50;
	if (schemes.toLowerCase().includes(name) || aliases.some(alias => schemes.toLowerCase().includes(alias))) score += 35;
	if (state?.isPresent) score += 45;
	if (state?.lastSeenLocation && locationName && state.lastSeenLocation.toLowerCase().includes(locationName.toLowerCase())) score += 30;
	if (state?.pressures?.length) score += 25;
	if (state?.motivations?.length) score += 20;
	if (state?.personalOpinion) score += 15;
	if (character.hiddenInfo) score += 10;
	const relLevel = state?.relationship?.level ?? 0;
	if (Math.abs(relLevel) >= 25) score += Math.abs(relLevel) / 2;
	score += factionNamesForCharacter(character, factionEntries).length * 12;
	return score;
}

function selectCharactersForTick(
	characterEntries: Entry[],
	factionEntries: Entry[],
	recentEntries: StoryEntry[],
	schemes: string,
	locationName: string,
): Entry[] {
	return characterEntries
		.filter(entry => !entry.deleted)
		.map((entry, index) => ({
			entry,
			index,
			score: scoreCharacterForTick(entry, factionEntries, recentEntries, schemes, locationName),
		}))
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name) || a.index - b.index)
		.slice(0, MAX_CHARACTERS_PER_TICK)
		.map(item => item.entry);
}

function buildCharacterDossier(character: Entry, factionEntries: Entry[]): string {
	const state = character.state as CharacterEntryState | undefined;
	const factions = factionNamesForCharacter(character, factionEntries);
	let d = `-- ${character.name} --\n`;
	const description = truncateText(state?.bio || character.description, 260);
	if (description) d += `${description}\n`;
	if (character.hiddenInfo) d += `[Hidden]: ${truncateText(character.hiddenInfo, 180)}\n`;
	if (state?.personality) d += `Personality: ${truncateText(state.personality, 180)}\n`;
	if (state?.currentDisposition) d += `Current disposition: ${state.currentDisposition}\n`;
	if (state?.personalOpinion) d += `Opinion of player: ${truncateText(state.personalOpinion, 180)}\n`;
	if (state?.relationship) d += `Relationship: ${state.relationship.status}, level ${state.relationship.level}\n`;
	if (state?.motivations?.length) d += `Motivations: ${state.motivations.slice(0, 5).join('; ')}\n`;
	if (state?.pressures?.length) d += `Pressures: ${state.pressures.slice(0, 5).join('; ')}\n`;
	if (state?.knownFacts?.length) d += `Known facts: ${state.knownFacts.slice(-5).join('; ')}\n`;
	if (state?.revealedSecrets?.length) d += `Revealed secrets: ${state.revealedSecrets.slice(-4).join('; ')}\n`;
	if (factions.length > 0) d += `Faction ties: ${factions.slice(0, 5).join(', ')}\n`;
	if (!description && !state?.motivations?.length && !state?.pressures?.length && !state?.personalOpinion) {
		d += '(No operational character state defined yet.)\n';
	}
	return d;
}

function buildCharacterStateBlock(
	characterEntries: Entry[],
	factionEntries: Entry[],
	recentEntries: StoryEntry[],
	schemes: string,
	locationName: string,
): string {
	const selected = selectCharactersForTick(characterEntries, factionEntries, recentEntries, schemes, locationName);
	if (selected.length === 0) return '';
	return selected.map(character => buildCharacterDossier(character, factionEntries)).join('\n');
}

function buildFactionDossier(faction: Entry, leaderEntry: Entry | null, characterEntries: Entry[]): string {
	const state = faction.state as FactionEntryState;
	let d = `── ${faction.name} ──\n`;
	d += `${faction.description.slice(0, 250)}\n`;

	if (faction.hiddenInfo) {
		d += `[Hidden]: ${faction.hiddenInfo.slice(0, 150)}\n`;
	}

	d += `Standing: ${state.playerStanding} | Status: ${state.status}`;
	if (state.disposition) d += ` | Disposition: ${state.disposition}`;
	d += '\n';

	if (state.goals && state.goals.length > 0) {
		d += `Goals:\n`;
		for (const g of state.goals.slice(0, 4)) {
			d += `  - [${g.type}, P${g.priority}] ${g.description} (${g.progress}% done${g.deadline ? ', deadline: ' + g.deadline : ''})\n`;
		}
	}

	if (state.resources) {
		const r = state.resources;
		d += `Resources: mil=${r.military} wealth=${r.wealth} influence=${r.influence} intel=${r.information} morale=${r.morale}\n`;
	}

	if (state.interFactionRelations) {
		const notable = Object.entries(state.interFactionRelations)
			.map(([name, raw]) => ({ name, ...normalizeRelation(raw) }))
			.filter((r) => Math.abs(r.standing) >= 30 || Math.abs(r.affinity) >= 30)
			.sort((a, b) => Math.abs(b.standing) - Math.abs(a.standing))
			.slice(0, 6)
			.map((r) => {
				const s = `${r.standing > 0 ? '+' : ''}${r.standing}`;
				const a = `${r.affinity > 0 ? '+' : ''}${r.affinity}`;
				return `${r.name} (st:${s} af:${a})`;
			})
			.join(', ');
		if (notable) d += `Relations: ${notable}\n`;
	}

	if (state.territory && state.territory.length > 0) {
		d += `Territory: ${state.territory.slice(0, 5).join(', ')}\n`;
	}

	if (state.knownMembers && state.knownMembers.length > 0) {
		const memberNames = state.knownMembers
			.map(id => characterEntries.find(c => c.id === id)?.name ?? id)
			.filter(Boolean)
			.slice(0, 8);
		if (memberNames.length > 0) d += `Members: ${memberNames.join(', ')}\n`;
	}

	if (leaderEntry) {
		const lState = leaderEntry.state as CharacterEntryState;
		d += `Leader: ${leaderEntry.name}\n`;
		if (lState?.motivations?.length) d += `  Drives: ${lState.motivations.join('; ')}\n`;
		if (lState?.personality) d += `  Temperament: ${lState.personality}\n`;
	}

	if (!state.goals && !state.resources) {
		d += `(No goals or resources defined — faction will mostly idle)\n`;
	}

	return d;
}

// ── System prompt builders ──

function buildWorldSimSystemPrompt(p: SimContext & { mode: string; pov: string; tense: string }): string {
	let sys = `You are a living-world engine for a ${p.mode} story (${p.pov} person, ${p.tense} tense).

You read the story's memory — chapter and arc summaries — to decide what the world does in the background.

TONE: Think like a living-world referee. Power is negotiated, spent, lost, and stolen. Alliances strain, resources run down, leaders make flawed choices, and unattended problems worsen. Let the world feel active and consequential, not conveniently arranged for the protagonist.

═══ CONTINUITY RULE ═══

The story's own memory is canon. Use chapter summaries, arcs, faction dossiers, character dossiers, relationships, active agreements, schemes, and recent events. Do not steer toward outside canon, genre tropes, or assumed source-material outcomes unless the current story explicitly establishes them. The point is to simulate what happens here.`;

	sys += `\n\nFaction goals define why a faction fights; schemes define how they try to win; story threads define how the war becomes player-facing plot; world events record what actually happened.`;
	sys += `\n\n${buildWarExecutionRulesBlock()}`;

	if (p.strategicFrameBlock) {
		sys += `\n\n=== STRATEGIC WORLD FRAME ===\n${p.strategicFrameBlock}\n\nUse the strategic frame as the arc-level weather system. This tick should choose 1-3 immediate visible movements inside that frame: rumors, prices, patrols, shortages, letters, troop motion, diplomatic tension, or NPC behavior. If forward faction operations are listed, prefer due or urgent operations and translate them into factionActions, rumor seeds, resource pressure, or visible NPC behavior. Do not resolve strategic clocks instantly unless completion conditions are already met.`;
	}

	if (p.storyMemoryBlock) {
		sys += `\n\n${p.storyMemoryBlock}`;
	} else {
		if (p.arcBlock) sys += `\n\n═══ STORY ARCS ═══\n${p.arcBlock}`;
		if (p.chapterBlock) sys += `\n\n═══ RECENT CHAPTERS ═══\n${p.chapterBlock}`;
	}
	if (p.historyLedgerBlock) sys += `\n\n=== CAUSAL HISTORY LEDGER ===\nEvery new move should trace back to one of these sources unless the immediate scene creates a stronger cause.\n${p.historyLedgerBlock}`;
	if (p.earnedPayoffBlock) sys += `\n\n=== EARNED PAYOFFS / REWARD SEEDS ===\nThese are not guaranteed wins, but they are permissions for future loyalty, favors, access, protection, reputation gains, invitations, warnings, safe passage, resources, or standing.\n${p.earnedPayoffBlock}`;
	if (p.allThreads.length > 0) sys += `\n\n═══ OPEN THREADS ═══\n${p.allThreads.map(t => `- ${t}`).join('\n')}`;
	if (p.characterArcs.length > 0) sys += `\n\n═══ CHARACTER ARCS ═══\n${p.characterArcs.map(ca => `- ${typeof ca === 'string' ? ca : `${ca.name}: ${ca.development}`}`).join('\n')}`;
	if (p.characterBlock) sys += `\n\n=== CHARACTER STATE DOSSIERS ===\nUse these NPC states for continuity, motives, loyalties, faction ties, and off-screen pressure. Do not invent contradictory motives when a dossier gives a clearer one.\n${p.characterBlock}`;

	if (p.tacticalBlock) {
		sys += `\n\n═══ RECENT EVENTS ═══\n${p.tacticalBlock}`;
	}

	if (p.relationChangeLog.length > 0) {
		const lines = p.relationChangeLog.map(e => {
			const sign = e.delta > 0 ? `+${e.delta}` : `${e.delta}`;
			return `- Ch.${e.chapter}: ${e.source} ↔ ${e.target}, ${sign}  (${e.event})`;
		});
		sys += `\n\n═══ RECENT INTER-FACTION SHIFTS ═══\n${lines.join('\n')}`;
	}

	if (p.recentFactionActions.length > 0) {
		const lines = p.recentFactionActions.map(fa => {
			const target = fa.target ? ` → ${fa.target}` : '';
			const motivation = fa.motivation ? ` (motivation: ${fa.motivation})` : '';
			const action = fa.action.length > 100 ? fa.action.slice(0, 97) + '…' : fa.action;
			return `- ${fa.factionName}${target}: ${action}${motivation}`;
		});
		sys += `\n\n═══ LAST TICK'S FACTION MOVES ═══\n${lines.join('\n')}`;
	}

	sys += `\n\nSEASON: ${p.season.currentSeason} (military ×${p.season.militaryModifier}, travel ×${p.season.travelModifier}, food: ${p.season.foodPressure})`;

	if (p.hasFactions) {
		sys += `\n\n═══ FACTIONS ═══\n${p.factionBlock}`;
		sys += `

═══ ALLIANCE AWARENESS ═══

Each faction's "Relations:" line shows current standings as \`st:/af:\` pairs:
  - **st** (standing): current temperature, fast-moving (-100..100)
  - **af** (affinity): deeper trust, slow-moving (-100..100)

Reading the pair:
  - High standing + low affinity = brittle alliance, may shatter at the first slight.
  - Low standing + high affinity = wounded friendship, ripe for reconciliation.
  - High both = dependable ally. Low both = entrenched foe. Use the gap to gauge sincerity.

Bayesian motive prior:
  - Start from the faction's known culture, goals, resources, standing, affinity, leader temperament,
    and recent evidence. Then update toward alliance, betrayal, caution, or sincere cooperation.
  - Betrayal needs a strong posterior: high upside, low detection risk, old grievance, desperation,
    coercion, ideology, fear, or a better patron. Do not make betrayal the default hidden layer.
  - Sincere alliance, loyalty, marriage, trade, or service is probable when expected value is good:
    survival improves, status rises, kin are protected, debts are honored, or public cost of betrayal
    is too high.
  - If standing and affinity are high, prefer trust unless evidence says otherwise. If standing is
    neutral but the offer is profitable, prefer cautious bargain over secret treachery.

Before targeting another faction:
  1. If standing >= +30 (ally), do NOT attack unless motivation is overwhelming
     (existential threat, succession crisis, betrayal). Note the cost in your \`consequences\`.
  2. If standing >= +50 (close ally), prefer COORDINATED actions on shared goals —
     marriage pacts, joint expeditions, intelligence sharing. Mention the ally explicitly in \`action\`.
  3. If standing <= -30 (foe), conflict is cheap and expected.
  4. Allies of allies: hitting a faction with high standing toward your ally reads as hitting your ally.

For every action that meaningfully changes a relationship, emit a \`relationDeltas\` entry:
  { targetFaction: "House Stark", delta: -25, reason: "Lannister forces sacked Sherrer" }

Use ±5 for small slights, ±15 for visible hostility, ±30 for major break, ±50 for full-scale war
or alliance formation. Be sparing — most actions emit zero deltas. Cap at 4 per action.`;
		sys += `

═══ YOUR JOB ═══

THREE TASKS in one response:

1. WORLD NARRATIVE + PLOT INJECTION (always):
   - worldNarrative: 1-2 sentences on the world's current mood/atmosphere.
   - plotInjection: null MOST of the time. Only inject when an open thread is ripe
     or the story arc demands a shift. If injecting: 1-2 sentences of in-world prose
     (${p.pov} person, ${p.tense} tense), urgency almost always "simmer" or "emerging."

═══ FACTION MOVE PALETTE ═══

Factions do not simply "attack" or "trade." They maneuver through the tools this setting makes available: status, money, force, secrets, belief, logistics, law, favors, family, technology, magic, or whatever the lorebook establishes. When deciding faction actions, draw from this palette:

DEFAULT PRESET:
- Treat the political world as A Song of Ice and Fire-style Known World political fantasy unless the lorebook explicitly overrides it.
- Westeros machinery: houses, bloodlines, bannermen, wards, hostages, bastards, marriages, dowries, inheritance, guest right, oaths, ravens, maesters, septons, tourneys, trials by combat, spies, sellswords, brothels, lenders, and smallfolk unrest.
- Essos machinery: free cities, merchant princes, magisters, triarchs, guilds, banks, sellsail fleets, mercenary companies, slave economies, red priests, courtesans, old Valyrian ruins, city-state rivalries, and trade wars. Braavos, Volantis, Pentos, Myr, Tyrosh, Lys, Norvos, Qohor, Lorath, Slaver's Bay, the Dothraki Sea, and the Summer Isles can shape pressure when the story points there.
- Do not force a specific canon city, ruler, or book event. Use the ruleset and social pressures, not a fixed timeline or one-region monoculture.
- Sexual scandal is political leverage: affairs, secret lovers, coerced marriages, paternity doubts, bastardy, incest rumors, fertility pressure, brothel gossip, and accusations of sexual deviancy can drive blackmail, religious pressure, succession crises, and faction moves. Keep it non-graphic and consequence-focused.

${buildEconomyScaleBlock('ECONOMY SCALE')}

DYNASTIC:
- Marriage pacts and betrothals: offer a daughter to seal peace, break an engagement to insult a rival, rush a wedding before a war starts
- Succession crises: a leader dies without a clear successor, an outsider is legitimized, a deputy challenges the heir, a claimant is passed over for a rival
- Births and deaths: a new heir, a public funeral, a suspicious accident, a medical failure, a succession shock
- Wards and hostages: send a child to foster loyalty, demand a hostage after a rebellion, quietly murder a ward to prevent a claim

INTRIGUE:
- Poisonings and "accidents": the cup of wine, the saddle strap, the fall from the tower, the boar on the hunt
- Blackmail and secrets: hidden debts, forbidden relationships, illegal bargains, broken vows, concealed crimes
- Spies and informants: the servant who listens at doors, the paid informant, the intercepted message, the report that never arrived
- False flags: attack in another house's colors, forge a letter, spread a lie that becomes truth through repetition

ECONOMIC:
- Trade embargoes and tolls: close a port, tax a river crossing, burn a rival's granary
- Loans and debts: borrow from a powerful lender, call in a debt to force obedience, default to provoke collapse
- Resource seizures: commandeer harvests, press-gang sailors, requisition horses

MILITARY:
- Raids and reavings: hit fast, burn crops, take captives, disappear before response
- Sieges and blockades: starve a castle, poison a well, build siege towers
- Mercenary contracts: hire sellsword companies, betray the employer, switch sides mid-campaign

IDEOLOGICAL:
- Septons, priests, cults, parties, guilds, movements, or institutions denounce an enemy, elevate a champion, split into factions, or demand public proof
- Conversions and purges: force a leader to recant, exile dissenters, criminalize a rival belief, or stage a public ritual
- Prophecy and omen: dreams, signs, statistics, intelligence, machine forecasts, or portents shift a leader's mind

DIPLOMATIC:
- Guest right, hospitality, and safe-conduct: host rivals under truce, then strain or break the bond
- Oaths and vows: swear loyalty, then reconsider when circumstances shift
- Public events: host games, festivals, councils, ceremonies, salons, trials, or summits to show strength, spy, recruit, or trap rivals

2. FACTION ACTIONS (for each faction):
   Think step by step for each faction:
   a) Do their goals + current events call for action? (Usually NO.)
   b) Do they have the resources? Does the season allow it?
   c) Does their disposition support this move?
   d) If acting: what do they do, and what would observers notice?
   e) If a faction has a named leader with known drives/temperament, factor
      those into the faction's decision. A cautious leader sends a message first.
      A hot-tempered one demands trial by combat. A cruel one takes hostages.
      An ambitious one pushes for binding pacts. A zealous one listens to priests, ideologues, or doctrine.
   f) Which allies/foes are affected? Will this strain or strengthen those bonds?
      Emit \`relationDeltas\` for each meaningful shift (see ALLIANCE AWARENESS).
   g) React to last tick's moves (see RECENT INTER-FACTION SHIFTS / LAST TICK'S FACTION MOVES).
      Escalate, retaliate, or capitalize. Don't simply repeat your previous action.

   RESTRAINT:
   - 70-85% of factions should do "none" or quiet preparation. The world breathes, it doesn't explode.
   - Prefer preparation, bargaining, debt, rumor, logistics, spying, and small commitments over public shocks.
   - "emerging" urgency = 0-1 per tick max. "critical" = only when a thread was already imminent.

   SETTING RESTRAINT:
   - Most faction moves are invisible to the player at first: a message sent, a promise made, a bribe paid, a debt called in, a resource quietly diverted.
   - Open warfare or public collapse is rare and catastrophic. Factions that escalate often end weaker even in victory.
   - Ordinary people pay the price for every elite decision. Mention collateral harm in consequences.

   FLAVOR:
   - Factions act through self-interest, not alignment. "Good" factions do ruthless things for good reasons.
   - Intelligence and subterfuge are cheaper than armies. Spies, marriages, hostages, and trade embargoes
     are the weapons of choice. Open war is a last resort born of desperation or miscalculation.
   - Rumors should sound like local gossip, ravens, maester letters, septon warnings, intercepted chatter, street talk, brothel gossip, or court whispers — not clinical reports.
     "They say the maester's raven flew at dawn" not "Faction B deployed an agent."

   STORY DIVERGENCE:
   - Whatever seems genre-obvious or source-obvious is not fate. Let plans fail, heirs survive, institutions split, and alliances form along different axes.
   - If an expected death, betrayal, or battle is approaching, ask whether this timeline needs it. Maybe it fails. Maybe someone else pays the cost.
   - Factions that seemed opposed may find common cause. Factions that seemed allied may uncover old grievances.

   EARNED PAYOFFS AND LOYALTY (important):
   - Not every thread maturation is a punishment, twist, or new cost. If the player has earned trust,
     saved someone, honored a debt, kept an oath, improved standing, or helped an ally, let that history
     return as visible story value.
   - Payoffs should fit the setting: a vassal vouches for them, a house sends a warning, a gate opens,
     a debt is forgiven, a guard looks away, a patron offers introductions, smallfolk spread praise, a
     merchant gives better terms, an ally commits men, or an NPC shows loyalty under pressure.
   - Use the EARNED PAYOFFS / REWARD SEEDS block as evidence. A reward with no prior cause is as bad as
     a random twist. A reward with history behind it makes the world feel alive.
   - Rewards can still create later obligations, but do not hide every reward behind a trap. Sometimes
     the honest consequence of a good choice is that somebody helps.

   PUSH BACK AND PAY OFF THE PROTAGONIST (important):
   - Read the OPEN THREADS list above. Most of those threads are the protagonist's plans, betrothals, alliances,
     or pending business. They are TARGETS, not promises. The world does not exist to deliver them.
   - Occasionally choose ONE open thread tied to the protagonist and let a faction complicate it.
      Most complications should be delays, doubts, new prices, quiet rival offers, or partial
      information, not instant reversals. A betrothal partner's house reconsiders. A retained
      mercenary company is courted by a rival. A confidante is tempted by a competing offer. A
      rumor reaches the wrong ear. A debt is noticed before it comes due.
   - Frame this through faction self-interest, not malice. A faction does not need to hate the player;
     it simply has its own incentives, and those incentives sometimes cross the player's path.
   - Sometimes the protagonist should walk away EMPTY-HANDED from a plan they invested in, but
      most setbacks should build over several beats: warning, pressure, cost, consequence.
   - Cap: at most ONE direct anti-protagonist move per tick. Don't dogpile. Friction, not persecution.

3. RUMORS (0-2 per active faction):
   - How information reaches the player. No rumor = invisible action.
   - truthfulness: 0.7-1.0 for real events, 0.3-0.6 for gossip, 0.0-0.3 for disinfo.
   - spreadRadius: "local" = one city, "regional" = neighboring areas, "continental" = everyone.
   - sourceType must be one of: raven, traveler, spy, public_decree, whisper, septon, maester. Use "whisper" for brothel gossip, court gossip, and other informal scandal.

4. THREAD UPDATES: Evaluate the THREAD REGISTRY below. Open new threads when significant plot
   lines emerge. Advance threads to "imminent" when they're about to pay off. Stall threads that
   hit obstacles. Close threads that resolve. Never close a critical or major thread without
   narrative payoff.

5. worldTension (0-10) and plotSeeds (0-1 one-sentence hooks from faction actions).

6. plotMomentum: Generate the NEXT narrative beat's strategic brief as a \`next_beat\` object:
   - critical_path: four rich path objects (path_a..path_d) with type, description, and flags.
   - next_turn_strategy: recommended_path + rationale.
   - revelation_budget: major_reveals_stewing array + notes.
   - faction_advisory: object keyed by faction slug.
   - thread_awareness: existing_threads, imminent_threads, branch_alignment.`;
	} else {
		sys += `

═══ YOUR JOB ═══

Based on the story's arc and trajectory, decide if the world should plant a subtle seed.

RESTRAINT: Default to doing NOTHING. Return null plotInjection and a brief worldNarrative.
Only inject when an open thread is clearly ripe, or the story arc calls for a shift.
The world should feel like it's breathing, not exploding.

TONE: The world breathes with quiet menace. Seasons change, debts come due, old grudges simmer.
When you do inject, make it feel like a distant rumble — something the protagonist half-notices
but can't yet name.

BALANCE: The world should also remember earned goodwill. If recent history contains loyalty,
kept promises, rescued allies, repaid debts, or improved standing, a future beat can be a quiet
reward: help offered, a door opened, reputation improved, safe passage granted, or a warning sent.
Trace every reward to a prior chapter, arc, agreement, relationship shift, or thread.

- worldNarrative: 1-2 sentences summarizing the world's current state/mood.
- plotInjection: null most of the time. When warranted: 1-2 sentences of in-world prose
  (${p.pov} person, ${p.tense} tense). urgency: almost always "simmer" or "emerging."
- factionActions, rumors, plotSeeds: return empty arrays.
- worldTension: 0 (no factions tracked).
- threadUpdates: evaluate existing threads; open new ones if warranted.
- plotMomentum: generate strategic brief for next beat.`;
	}

	if (p.threadRegistry) {
		sys += `\n\n═══ THREAD REGISTRY ═══\n${p.threadRegistry}`;
	}

	sys += `\n\nRespond with JSON matching the schema. Be concise.`;
	return sys;
}

function buildMomentumSystemPrompt(p: SimContext & { mode: string; pov: string; tense: string }): string {
	let sys = `You are a story strategist for an interactive fiction GM.

Your job: read the current world state, recent history, faction dossiers, character dossiers, active schemes, thread registry, and open threads — then plot the NEXT narrative beat's momentum.

Think like a patient showrunner planning the next scene. You are NOT writing prose. You are writing a concise strategic brief that the GM will read before generating. The goal is slow-burn escalation, not a twist machine.

Faction goals define why a faction fights; schemes define how they try to win; story threads define how the war becomes player-facing plot; world events record what actually happened.

${buildWarExecutionRulesBlock('WAR MOMENTUM RULES')}

SLOW-BURN DIRECTIVE:
- Most next beats should preserve the current scene's pressure, deepen a relationship, clarify a cost, or let a consequence or reward breathe.
- Do not raise dramatic temperature every turn. Plateaus are useful when they make the next rise feel earned.
- Twists are dormant seeds until the story has paid for them with setup, evidence, suspicion, and player-facing cost.
- If the history ledger shows earned goodwill, at least one path should be a quiet payoff, loyalty response, or opportunity unless the current scene is in immediate crisis.
- Prefer path_a or path_b unless a thread is already imminent. Path_d should almost never be recommended.

═══ OUTPUT FORMAT ═══

Respond with JSON matching the schema. The top-level key is \`next_beat\`.

Inside \`next_beat\`:

1. **critical_path** — four path objects:
   - \`path_a\`: the obvious next NPC move or earned opening (political overture, summons, trade proposal, loyalty payoff).
   - \`path_b\`: friction — resistance, counter-demand, refusal, social slight.
   - \`path_c\`: action — NPC/environment physical movement, escalation, arrival/departure, sound from elsewhere.
   - \`path_d\`: dormant twist seed — drawn from stewing secrets ONLY. Usually this is NOT for the next turn; it marks what to withhold or foreshadow.

   Each path object:
   {
     "type": "political_overture|social_slight|action_small_scale|twist_from_secret|environmental_shift|discovery|negotiation|confrontation|earned_reward|loyalty_payoff|opportunity|none",
     "description": "1-2 sentences describing NPC action, environmental pressure, off-screen movement, or a conditional opportunity. Never command or assume player movement/action.",
     "friction": true|false,
     "action": true|false,
     "twist_from_existing_secret": true|false,
     "downgraded_to_friction": true|false
   }

2. **next_turn_strategy**:
   {
     "recommended_path": "path_a|path_b|path_c|path_d",
      "rationale": "one line on why this serves slow-burn pacing and current pressure"
   }

3. **revelation_budget**:
   {
     "major_reveals_stewing": ["list of major reveals currently building"],
      "notes": "guidance on what is held back and what evidence, cost, or time should accumulate first"
   }

4. **faction_advisory** — an object keyed by faction slug:
   {
     "faction_slug": { "disposition": "...", "likely_next_move": "...", "notes": "..." },
     "house_lannister": { ... }
   }

5. **thread_awareness**:
   {
     "existing_threads": ["thread descriptions"],
     "imminent_threads": ["threads about to pay off"],
     "branch_alignment": "how the chosen branch aligns with active threads"
   }

═══ RULES ═══

1. CRITICAL PATH RULE — you only control NPCs and the environment. NEVER predict, assume, or dictate what the player will do. All paths describe NPC actions, environmental shifts, off-screen events, or conditional opportunities ONLY.

1a. PLOT MOMENTUM IS NOT A COMMAND QUEUE. It may offer pressure, openings, summons, messengers, sounds, objects, documents, delays, rumors, NPC questions, or off-screen NPC movement. It may not move Aurion. If a beat depends on Aurion choosing movement, summoning someone, writing, opening, entering, leaving, or otherwise acting, write it conditionally: "If Aurion chooses to return to the Eastern Wing or summons Vessia..." If he remains elsewhere, foreshadow only through a messenger, distant sound, waiting ledger, household servant question, or similar pressure.

2. DEFAULT TO CONTINUITY, FRICTION, AND PAYOFF. NPCs have their own agendas, but resistance can be quiet: delay, uncertainty, price, silence, logistics, or a small refusal. Earned goodwill can also be quiet: a warning, better terms, public credit, access, cover, shelter, or a loyal NPC choosing the player under pressure.

3. PLOT BRANCHES must be drawn from existing open threads, faction goals, scheme seeds, causal history ledger items, or earned payoff seeds. NEVER invent new lore. If a twist (Path D) has no stewing secret with prior setup to draw from, set Path D to "none" or downgrade it to friction.

4. NEXT TURN STRATEGY — select the slowest path that keeps pressure alive. Default to path_a or path_b. Do not pick path_c or path_d just because the player has had an easy stretch. Pick path_d only when an existing imminent thread, visible evidence, and player action make the reveal unavoidable.

5. REVELATION BUDGET — list major reveals currently stewing and what evidence still needs to accumulate before payoff. Major reveals are currency, not confetti. At most one per arc, and most arcs should spend many turns foreshadowing before they pay.

6. FACTION ADVISORY — for each relevant faction, note their current disposition toward the player and their most likely next move. Factor in recent world events, relation shifts, resources, goals, and seasonal pressures. Use lowercase faction slugs as keys.

7. THREAD AWARENESS — read the THREAD REGISTRY. Factor imminent threads into your branch planning, but a branch may point toward a payoff without landing it.

8. BAYESIAN SOCIAL PRIOR — do not overfit to betrayal. For each major NPC/faction choice,
   weigh prior relationship, standing, affinity, visible upside, downside risk, detection risk,
   public reputation cost, and alternatives. If marriage, alliance, loyalty, or service improves
   the NPC's prospects, it can be sincere. Hidden motives require evidence, not genre habit.

═══ STRATEGY ═══

Momentum is built on shifting pressure:
- A binding pact is worth more than a show of force until it is broken.
- A death, exposure, shortage, scandal, or succession crisis can reshape the board more than any battle.
- Debt, dependency, logistics, belief, and public legitimacy are leashes.
- Hospitality, contracts, sacred promises, laws, and customs are weapons and targets.
- Seasons, distance, shortages, and communications matter. A faction that ignores its supply line pays for it.
- Heirs, wards, deputies, informants, clients, rivals, and overlooked relatives are loose threads powerful factions ignore at their peril.
- Rewards are also momentum: loyalty gained, an ally acting first, a debt repaid, an invitation extended, or standing improving can move the plot without another twist.

${buildEconomyScaleBlock('ECONOMY SCALE')}

When plotting branches:
- Path A (obvious) should usually be an overture or earned opportunity: an offer, summons, alliance proposal, trade, deal, invitation, repaid favor, or ally opening a door.
- Path B (friction) should often be a social, legal, or logistical obstacle: a refusal, insult, broken promise, blocked route, recalled debt, or missing resource.
- Path C (action) should be occasional and small-scale: a messenger arriving, a patrol sighted, a door barred, a theft discovered, a distant fire, a public challenge, or a limited confrontation. Avoid constant raids, abductions, assassinations, and sudden attacks.
- Path D (twist) should usually be dormant. Use it to name a secret pressure that remains off-page unless the current action directly forces it. If it is not earned, set type "none" or downgrade to friction.
- Any path that depends on Aurion moving, writing, opening, entering, leaving, summoning, deciding, remembering, realizing, or knowing something must be phrased as a conditional opportunity only.
- Earned payoff paths that require Aurion to go somewhere or summon someone must be framed as optional openings, not transitions.`;

	if (p.strategicFrameBlock) {
		sys += `\n\n=== STRATEGIC WORLD FRAME ===\n${p.strategicFrameBlock}\n\nUse this as arc-level pressure for next-beat planning. If forward faction operations are listed, pick the operation most likely to touch the current scene through evidence, rumor, envoy, cost, weather, shortage, or NPC behavior. The recommended next beat may foreshadow or localize the pressure, but must not expose hidden strategy without scene evidence.`;
	}

	if (p.storyMemoryBlock) {
		sys += `\n\n${p.storyMemoryBlock}`;
	} else {
		if (p.arcBlock) sys += `\n\n═══ STORY ARCS ═══\n${p.arcBlock}`;
		if (p.chapterBlock) sys += `\n\n═══ RECENT CHAPTERS ═══\n${p.chapterBlock}`;
	}
	if (p.historyLedgerBlock) sys += `\n\n=== CAUSAL HISTORY LEDGER ===\nUse this as the source list for future consequences, rewards, and twists.\n${p.historyLedgerBlock}`;
	if (p.earnedPayoffBlock) sys += `\n\n=== EARNED PAYOFFS / REWARD SEEDS ===\nUse these to create earned_reward, loyalty_payoff, or opportunity paths when the next beat can honor prior choices. If a payoff needs Aurion to move, summon, write, open, enter, leave, or decide, describe only the conditional opening or the NPC/environment pressure that invites that choice.\n${p.earnedPayoffBlock}`;
	if (p.characterArcs.length > 0) sys += `\n\n═══ CHARACTER ARCS ═══\n${p.characterArcs.map(ca => `- ${typeof ca === 'string' ? ca : `${ca.name}: ${ca.development}`}`).join('\n')}`;
	if (p.characterBlock) sys += `\n\n=== CHARACTER STATE DOSSIERS ===\nUse these NPC states for continuity, motives, loyalties, faction ties, and off-screen pressure. The next beat should respect what each NPC wants, knows, fears, and owes.\n${p.characterBlock}`;

	if (p.tacticalBlock) {
		sys += `\n\n═══ RECENT EVENTS (last ${MAX_RECENT_ENTRIES} entries) ═══\n${p.tacticalBlock}`;
	}

	if (p.conversationBlock) {
		sys += `\n\n═══ DIALOGUE RHYTHM ═══\n${p.conversationBlock}`;
	}

	if (p.factionBlock) {
		sys += `\n\n═══ FACTIONS ═══\n${p.factionBlock}`;
	}

	if (p.schemeBlock) {
		sys += `\n\n═══ ACTIVE SCHEMES ═══\n${p.schemeBlock}`;
	}

	if (p.agreementBlock) {
		sys += `\n\n═══ ACTIVE AGREEMENTS ═══\n${p.agreementBlock}`;
	}

	if (p.worldEventBlock) {
		sys += `\n\n═══ RECENT WORLD EVENTS ═══\n${p.worldEventBlock}`;
	}

	sys += `\n\nSEASON: ${p.season.currentSeason} (military ×${p.season.militaryModifier}, travel ×${p.season.travelModifier}, food: ${p.season.foodPressure})`;

	if (p.threadRegistry) {
		sys += `\n\n═══ THREAD REGISTRY ═══\n${p.threadRegistry}`;
	}

	sys += `\n\nNow generate the plot momentum JSON.`;
	return sys;
}

// ── Service ──

type PlotPathKey = PlotMomentum['next_beat']['next_turn_strategy']['recommended_path'];

const REWARD_PATH_TYPES = new Set(['earned_reward', 'loyalty_payoff', 'opportunity']);

function firstRewardPathKey(
	criticalPath: PlotMomentum['next_beat']['critical_path'],
): PlotPathKey | null {
	for (const key of ['path_a', 'path_b', 'path_c', 'path_d'] as PlotPathKey[]) {
		if (REWARD_PATH_TYPES.has(criticalPath[key].type)) return key;
	}
	return null;
}

function applySlowBurnGuard(momentum: PlotMomentum): PlotMomentum {
	const nb = momentum.next_beat;
	const pathD = nb.critical_path.path_d;
	const hasStewingReveal = nb.revelation_budget.major_reveals_stewing.length > 0;
	const hasImminentThread = nb.thread_awareness.imminent_threads.length > 0;
	const twistIsEarned = Boolean(
		pathD.twist_from_existing_secret &&
		hasStewingReveal &&
		hasImminentThread &&
		!pathD.downgraded_to_friction,
	);

	let criticalPath = nb.critical_path;
	if (!twistIsEarned && pathD.type === 'twist_from_secret') {
		criticalPath = {
			...criticalPath,
			path_d: {
				...pathD,
				downgraded_to_friction: true,
			},
		};
	}

	let nextTurnStrategy = nb.next_turn_strategy;
	if (nextTurnStrategy.recommended_path === 'path_d' && !twistIsEarned) {
		const fallback: PlotPathKey = firstRewardPathKey(criticalPath)
			?? (criticalPath.path_b.type !== 'none' ? 'path_b' : 'path_a');
		nextTurnStrategy = {
			...nextTurnStrategy,
			recommended_path: fallback,
			rationale: `Slow-burn guard: ${nextTurnStrategy.rationale}`,
		};
	}

	return {
		...momentum,
		next_beat: {
			...nb,
			critical_path: criticalPath,
			next_turn_strategy: nextTurnStrategy,
		},
	};
}

export class WorldSimulationService extends BaseAIService {
	constructor() {
		super('worldSimulation');
	}

	/**
	 * Lightweight world simulation triggered once per new chapter.
	 * Focuses on the most recent chapter + recent conversation history
	 * and only the factions directly relevant to recent events.
	 * This prevents characters from changing too quickly.
	 */
	async simulateForNewChapter(params: {
		storyId: string;
		latestChapter: Chapter;
		recentEntries: StoryEntry[];
		factionEntries?: Entry[];
		involvedFactions?: string[];
		mode?: string;
		pov?: string;
		tense?: string;
	}): Promise<WorldSimulationResult> {
		const { latestChapter, recentEntries, factionEntries = [], involvedFactions = [], mode = 'adventure', pov = 'second', tense = 'present' } = params;

		log('simulateForNewChapter', {
			chapter: latestChapter.number,
			entries: recentEntries.length,
			factions: factionEntries.length,
		});

		// Build lightweight context (last chapter + recent conversation only)
		const prompt = buildChapterWorldSimulationPrompt({
			latestChapter,
			recentEntries,
			factionEntries,
			involvedFactions,
			mode,
			pov,
			tense,
		});

		const result = await this.generateStructured(worldSimulationResultSchema, prompt.system, prompt.user);
		return result.plotMomentum
			? { ...result, plotMomentum: applySlowBurnGuard(result.plotMomentum) }
			: result;

	}

	/**
	 * Unified world simulation: plot injection + faction movements + thread updates + plot momentum.
	 * One LLM call. Faction section is omitted when no factions exist.
	 * Triggered periodically by maybeRunWorldSim() in the executor.
	 */
	async simulate(
		chapters: Chapter[],
		arcs: Arc[],
		recentEntries: StoryEntry[],
		factionEntries: Entry[],
		characterEntries: Entry[],
		entryRelationships: EntryRelationship[],
		threads: StoryThread[],
		agreements: Agreement[],
		worldEvents: { name: string; description: string }[],
		locationName: string,
		schemes: string,
		timeTracker: TimeTracker | null,
		mode = 'adventure',
		pov = 'second',
		tense = 'present',
		recentFactionActions: FactionActionRecord[] = [],
		relationChangeLog: RelationChangeEvent[] = [],
		strategicWorldFrame: StrategicWorldFrame | null = null,
	): Promise<WorldSimulationResult & { seasonEffect: SeasonEffect }> {
		const hasFactions = factionEntries.length > 0;

		log('simulate', {
			chapters: chapters.length,
			arcs: arcs.length,
			factions: factionEntries.length,
			threads: threads.length,
			mode: hasFactions ? 'faction+world+momentum' : 'world-only+momentum',
		});

		const ctx = buildSimContext(
			chapters, arcs, recentEntries, factionEntries, characterEntries,
			entryRelationships, threads, agreements, worldEvents, locationName,
			schemes, timeTracker, recentFactionActions, relationChangeLog,
			strategicWorldFrame,
		);

		const system = buildWorldSimSystemPrompt({ ...ctx, mode, pov, tense });

		const prompt = hasFactions
			? `Story: ${chapters.length} chapters, ${arcs.length} arcs, ${factionEntries.length} factions, ${threads.length} threads. Season: ${ctx.season.currentSeason}. Simulate the world.`
			: `Story: ${chapters.length} chapters, ${arcs.length} arcs, ${threads.length} threads. Review trajectory and decide if the world should act.`;

		const result = await this.generateStructured(worldSimulationResultSchema, system, prompt);
		const guarded = result.plotMomentum
			? { ...result, plotMomentum: applyPlotMomentumAgencyGuard(applySlowBurnGuard(result.plotMomentum)) }
			: result;

		return { ...guarded, seasonEffect: ctx.season };
	}

	/**
	 * Generate plot momentum for the next narrative beat.
	 * Called every turn before narrative generation.
	 * Uses the same rich context as simulate() but with a showrunner-focused prompt.
	 */
	async generateMomentum(
		chapters: Chapter[],
		arcs: Arc[],
		recentEntries: StoryEntry[],
		factionEntries: Entry[],
		characterEntries: Entry[],
		entryRelationships: EntryRelationship[],
		threads: StoryThread[],
		agreements: Agreement[],
		worldEvents: { name: string; description: string }[],
		locationName: string,
		schemes: string,
		timeTracker: TimeTracker | null,
		mode = 'adventure',
		pov = 'second',
		tense = 'present',
		recentFactionActions: FactionActionRecord[] = [],
		relationChangeLog: RelationChangeEvent[] = [],
		strategicWorldFrame: StrategicWorldFrame | null = null,
	): Promise<PlotMomentum> {
		log('generateMomentum', {
			entries: recentEntries.length,
			factions: factionEntries.length,
			threads: threads.length,
		});

		const ctx = buildSimContext(
			chapters, arcs, recentEntries, factionEntries, characterEntries,
			entryRelationships, threads, agreements, worldEvents, locationName,
			schemes, timeTracker, recentFactionActions, relationChangeLog,
			strategicWorldFrame,
		);

		const system = buildMomentumSystemPrompt({ ...ctx, mode, pov, tense });

		const prompt = `You are plotting the NEXT beat of an interactive fiction story.

Current location: ${locationName || 'Unknown'}
Season: ${ctx.season.currentSeason}
Recent context: ${recentEntries.length} entries, ${factionEntries.length} factions, ${threads.length} threads.

Generate the plot momentum JSON.`;

		const result = await this.generateStructured(plotMomentumSchema, system, prompt);
		return applyPlotMomentumAgencyGuard(applySlowBurnGuard(result));
	}
}
