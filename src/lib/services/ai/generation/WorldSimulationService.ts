/**
 * WorldSimulationService — Mtherios
 *
 * Unified living-world engine: plot injection + faction simulation in ONE call.
 * Runs every WORLD_SIM_CHAPTER_INTERVAL chapters.
 *
 * When factions exist in the lorebook, the prompt expands to include faction
 * reasoning (goals, resources, disposition → actions → rumors). When no factions
 * exist, it collapses to the original lightweight WorldSim behavior.
 *
 * Context sources:
 *   - Strategic: arc summaries (long-term) + uncovered chapter summaries (medium-term)
 *   - Tactical: last N raw story entries (what just happened)
 *   - Faction dossiers: lorebook entries of type 'faction' with goals/resources/disposition
 *
 * Season effects are calculated deterministically in code, not by the LLM.
 */

import { BaseAIService } from '../BaseAIService';
import { worldSimulationResultSchema, type WorldSimulationResult } from '../sdk/schemas/worldsim';
import { createLogger } from '../core/config';
import type { Entry, Chapter, Arc, StoryEntry, TimeTracker, EntryRelationship, CharacterEntryState, FactionEntryState } from '$lib/types';

const log = createLogger('WorldSim');

/** WorldSim runs every N chapters */
export const WORLD_SIM_CHAPTER_INTERVAL = 1;

/** Max recent chat entries for tactical context */
const MAX_RECENT_ENTRIES = 6;

/** Max factions per tick to prevent token explosion */
const MAX_FACTIONS_PER_TICK = 12;

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
	winter: { currentSeason: 'winter', militaryModifier: 0.6, travelModifier: 0.5, foodPressure: 'scarce', narrativeNote: 'Winter grips the land — snow chokes the passes, ravens fly slow, the hungry grow desperate.' },
	long_winter: { currentSeason: 'long_winter', militaryModifier: 0.3, travelModifier: 0.3, foodPressure: 'famine', narrativeNote: 'The long winter. The old and the young die first. Movement is suicide. Survival is the only war.' },
};

export function calculateSeason(time: TimeTracker | null): SeasonEffect {
	if (!time) return SEASON_TABLE.summer; // default if no tracking
	const totalDays = (time.years * 365) + time.days;
	const dayOfYear = totalDays % 365;
	if (dayOfYear < 90) return SEASON_TABLE.spring;
	if (dayOfYear < 180) return SEASON_TABLE.summer;
	if (dayOfYear < 270) return SEASON_TABLE.autumn;
	return SEASON_TABLE.winter;
}

export class WorldSimulationService extends BaseAIService {
	constructor() {
		super('worldSimulation');
	}

	/**
	 * Unified world simulation: plot injection + faction movements.
	 * One LLM call. Faction section is omitted when no factions exist.
	 */
	async simulate(
		chapters: Chapter[],
		arcs: Arc[],
		recentEntries: StoryEntry[],
		factionEntries: Entry[],
		characterEntries: Entry[],
		entryRelationships: EntryRelationship[],
		timeTracker: TimeTracker | null,
		mode = 'adventure',
		pov = 'second',
		tense = 'present',
	): Promise<WorldSimulationResult & { seasonEffect: SeasonEffect }> {
		const hasFactions = factionEntries.length > 0;

		log('simulate', {
			chapters: chapters.length,
			arcs: arcs.length,
			factions: factionEntries.length,
			mode: hasFactions ? 'faction+world' : 'world-only',
		});

		// ── Shared context (built once) ──
		const { arcBlock, chapterBlock, allThreads, characterArcs } = buildStoryContext(chapters, arcs);

		// ── Tactical context ──
		const recent = recentEntries.slice(-MAX_RECENT_ENTRIES);
		const tacticalBlock = recent.length > 0
			? recent.map(e => `[${e.type}]: ${e.content.slice(0, 200)}`).join('\n')
			: '';

		// ── Season (deterministic) ──
		const season = calculateSeason(timeTracker);

		// ── Faction dossiers (only when factions exist) ──
		let factionBlock = '';
		if (hasFactions) {
			const dossiers = factionEntries
				.slice(0, MAX_FACTIONS_PER_TICK)
				.map(e => {
					// Find leader via relationships (source=character, type=leader-of, target=faction)
					const leaderRel = entryRelationships.find(r =>
						r.targetEntryId === e.id && r.type === 'leader-of'
					);
					const leaderEntry = leaderRel
						? characterEntries.find(c => c.id === leaderRel.sourceEntryId)
						: null;
					return buildFactionDossier(e, leaderEntry ?? null);
				});
			factionBlock = dossiers.join('\n\n');
		}

		// ── Build system prompt ──
		const system = buildSystemPrompt({
			mode, pov, tense,
			arcBlock, chapterBlock, allThreads, characterArcs,
			tacticalBlock, factionBlock, hasFactions, season,
		});

		const prompt = hasFactions
			? `Story: ${chapters.length} chapters, ${arcs.length} arcs, ${factionEntries.length} factions. Season: ${season.currentSeason}. Simulate the world.`
			: `Story: ${chapters.length} chapters, ${arcs.length} arcs. Review trajectory and decide if the world should act.`;

		const result = await this.generateStructured(worldSimulationResultSchema, system, prompt);

		return { ...result, seasonEffect: season };
	}
}

// ── Shared context builder (eliminates duplication) ──

function buildStoryContext(chapters: Chapter[], arcs: Arc[]) {
	const coveredIds = new Set(arcs.flatMap(a => a.chapterIds));
	const uncovered = chapters
		.filter(c => !coveredIds.has(c.id))
		.sort((a, b) => a.number - b.number);

	const arcBlock = arcs.length > 0
		? arcs.map(a =>
			`Arc ${a.arcNumber}: "${a.title}" (Ch.${a.chapterRange})\n${a.summary.slice(0, 350)}`
		).join('\n\n')
		: '';

	const chapterBlock = uncovered
		.map(ch => {
			const chars = ch.characters?.length ? ` | Characters: ${ch.characters.join(', ')}` : '';
			const locs = ch.locations?.length ? ` | Locations: ${ch.locations.join(', ')}` : '';
			return `Ch.${ch.number}: ${ch.title ?? 'Untitled'}${chars}${locs}\n${ch.summary.slice(0, 250)}`;
		})
		.join('\n\n');

	const allThreads = arcs.flatMap(a => a.unresolvedThreads).filter(Boolean);

	const characterArcs = arcs
		.flatMap(a => a.characterArcs ?? [])
		.filter(Boolean);

	return { arcBlock, chapterBlock, allThreads, characterArcs };
}

// ── Faction dossier builder (reads from state.goals, not metadata) ──

function buildFactionDossier(faction: Entry, leaderEntry: Entry | null): string {
	const state = faction.state as FactionEntryState;
	let d = `── ${faction.name} ──\n`;
	d += `${faction.description.slice(0, 250)}\n`;

	if (faction.hiddenInfo) {
		d += `[Hidden]: ${faction.hiddenInfo.slice(0, 150)}\n`;
	}

	d += `Standing: ${state.playerStanding} | Status: ${state.status}`;
	if (state.disposition) d += ` | Disposition: ${state.disposition}`;
	d += '\n';

	// Goals — read from extended state (where seed imports put them)
	if (state.goals && state.goals.length > 0) {
		d += `Goals:\n`;
		for (const g of state.goals.slice(0, 4)) {
			d += `  - [${g.type}, P${g.priority}] ${g.description} (${g.progress}% done${g.deadline ? ', deadline: ' + g.deadline : ''})\n`;
		}
	}

	// Resources — compact single line
	if (state.resources) {
		const r = state.resources;
		d += `Resources: mil=${r.military} wealth=${r.wealth} influence=${r.influence} intel=${r.information} morale=${r.morale}\n`;
	}

	// Inter-faction relations — only show non-neutral
	if (state.interFactionRelations) {
		const notable = Object.entries(state.interFactionRelations)
			.filter(([_, v]) => Math.abs(v) >= 30)
			.sort(([_, a], [__, b]) => Math.abs(b) - Math.abs(a))
			.slice(0, 6)
			.map(([name, val]) => `${name}: ${val > 0 ? '+' : ''}${val}`)
			.join(', ');
		if (notable) d += `Relations: ${notable}\n`;
	}

	// Territory
	if (state.territory && state.territory.length > 0) {
		d += `Territory: ${state.territory.slice(0, 5).join(', ')}\n`;
	}

	// Leader personality (from character enrichment)
	if (leaderEntry) {
		const lState = leaderEntry.state as CharacterEntryState;
		d += `Leader: ${leaderEntry.name}\n`;
		if (lState?.motivations?.length) d += `  Drives: ${lState.motivations.join('; ')}\n`;
		if (lState?.personality) d += `  Temperament: ${lState.personality}\n`;
	}

	// Fallback: if no goals on state, faction was created manually without extended fields
	if (!state.goals && !state.resources) {
		d += `(No goals or resources defined — faction will mostly idle)\n`;
	}

	return d;
}

// ── System prompt builder ──

interface PromptParams {
	mode: string; pov: string; tense: string;
	arcBlock: string; chapterBlock: string;
	allThreads: string[]; characterArcs: Array<string | { name: string; development: string }>;
	tacticalBlock: string; factionBlock: string;
	hasFactions: boolean; season: SeasonEffect;
}

function buildSystemPrompt(p: PromptParams): string {
	let sys = `You are a living-world engine for a ${p.mode} story (${p.pov} person, ${p.tense} tense).

You read the story's memory — chapter and arc summaries — to decide what the world does in the background.

TONE: Think like a scheming maester writing history as it happens. Power is never given, only taken or lost. Every alliance hides a dagger. Smallfolk suffer when lords play their games. Loyalty is a currency that depreciates. Weather, famine, and distance kill more than swords. Let the world feel lived-in, grimy, and politically treacherous — not heroic or clean.`;

	// ── Story context ──
	if (p.arcBlock) sys += `\n\n═══ STORY ARCS ═══\n${p.arcBlock}`;
	if (p.chapterBlock) sys += `\n\n═══ RECENT CHAPTERS ═══\n${p.chapterBlock}`;
	if (p.allThreads.length > 0) sys += `\n\n═══ OPEN THREADS ═══\n${p.allThreads.map(t => `- ${t}`).join('\n')}`;
	if (p.characterArcs.length > 0) sys += `\n\n═══ CHARACTER ARCS ═══\n${p.characterArcs.map(ca => `- ${typeof ca === 'string' ? ca : `${ca.name}: ${ca.development}`}`).join('\n')}`;

	// ── Tactical context ──
	if (p.tacticalBlock) {
		sys += `\n\n═══ RECENT EVENTS ═══\n${p.tacticalBlock}`;
	}

	// ── Season ──
	sys += `\n\nSEASON: ${p.season.currentSeason} (military ×${p.season.militaryModifier}, travel ×${p.season.travelModifier}, food: ${p.season.foodPressure})`;

	// ── Faction block (conditional) ──
	if (p.hasFactions) {
		sys += `\n\n═══ FACTIONS ═══\n${p.factionBlock}`;
		sys += `

═══ YOUR JOB ═══

TWO TASKS in one response:

1. WORLD NARRATIVE + PLOT INJECTION (always):
   - worldNarrative: 1-2 sentences on the world's current mood/atmosphere.
   - plotInjection: null MOST of the time. Only inject when an open thread is ripe
     or the story arc demands a shift. If injecting: 1-2 sentences of in-world prose
     (${p.pov} person, ${p.tense} tense), urgency almost always "simmer" or "emerging."

2. FACTION ACTIONS (for each faction):
   Think step by step for each faction:
   a) Do their goals + current events call for action? (Usually NO.)
   b) Do they have the resources? Does the season allow it?
   c) Does their disposition support this move?
   d) If acting: what do they do, and what would observers notice?
   e) If a faction has a named leader with known drives/temperament, factor
      those into the faction's decision. A cautious leader won't launch reckless
      attacks. An ambitious leader pushes for expansion.

   RESTRAINT:
   - 60-70% of factions should do "none" — the world breathes, it doesn't explode.
   - Prefer diplomatic/intelligence over military. Battles are rare and earned.
   - "emerging" urgency = 1-2 per tick max. "critical" = nearly never.

   FLAVOR:
   - Factions act through self-interest, not alignment. "Good" factions do ruthless things for good reasons.
   - Intelligence and subterfuge are cheaper than armies. Spies, marriages, hostages, and trade embargoes
     are the weapons of choice. Open war is a last resort born of desperation or miscalculation.
   - Rumors should sound like tavern gossip or raven dispatches — not clinical reports.
     "They say the Warden's second son was seen riding hard for the coast" not "Faction B deployed an agent."

3. RUMORS (0-2 per active faction):
   - How information reaches the player. No rumor = invisible action.
   - truthfulness: 0.7-1.0 for real events, 0.3-0.6 for gossip, 0.0-0.3 for disinfo.
   - spreadRadius: "local" = one city, "regional" = neighboring areas, "continental" = everyone.
   - sourceType: raven (fast/accurate), traveler (slow/wide), spy (targeted), public_decree, whisper.

4. worldTension (0-10) and plotSeeds (0-2 one-sentence hooks from faction actions).`;
	} else {
		// No factions — original lightweight WorldSim behavior
		sys += `

═══ YOUR JOB ═══

Based on the story's arc and trajectory, decide if the world should plant a subtle seed.

RESTRAINT: Default to doing NOTHING. Return null plotInjection and a brief worldNarrative.
Only inject when an open thread is clearly ripe, or the story arc calls for a shift.
The world should feel like it's breathing, not exploding.

TONE: The world breathes with quiet menace. Seasons change, debts come due, old grudges simmer.
When you do inject, make it feel like a distant rumble — something the protagonist half-notices
but can't yet name.

- worldNarrative: 1-2 sentences summarizing the world's current state/mood.
- plotInjection: null most of the time. When warranted: 1-2 sentences of in-world prose
  (${p.pov} person, ${p.tense} tense). urgency: almost always "simmer" or "emerging."
- factionActions, rumors, plotSeeds: return empty arrays.
- worldTension: 0 (no factions tracked).`;
	}

	sys += `\n\nRespond with JSON matching the schema. Be concise.`;
	return sys;
}
