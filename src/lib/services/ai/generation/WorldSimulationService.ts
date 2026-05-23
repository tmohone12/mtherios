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
import type {
	Entry, Chapter, Arc, StoryEntry, TimeTracker, EntryRelationship,
	CharacterEntryState, FactionEntryState, FactionActionRecord,
	StoryThread, Agreement,
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
	arcBlock: string;
	chapterBlock: string;
	allThreads: string[];
	characterArcs: Array<string | { name: string; development: string }>;
	tacticalBlock: string;
	conversationBlock: string;
	factionBlock: string;
	hasFactions: boolean;
	season: SeasonEffect;
	recentFactionActions: FactionActionRecord[];
	relationChangeLog: RelationChangeEvent[];
	threadRegistry: string;
	schemeBlock: string;
	agreementBlock: string;
	worldEventBlock: string;
	locationBlock: string;
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
): SimContext {
	const { arcBlock, chapterBlock, allThreads, characterArcs } = buildStoryContext(chapters, arcs);

	// Tactical: last 40 entries
	const recent = recentEntries.slice(-MAX_RECENT_ENTRIES);
	const tacticalBlock = recent.length > 0
		? recent.map(e => `[${e.type}]: ${e.content.slice(0, 200)}`).join('\n')
		: '';

	// Conversation: last 20 user/assistant pairs
	const conversationBlock = buildConversationBlock(recentEntries.slice(-MAX_CONVERSATION_PAIRS * 2));

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

	// Thread registry
	const threadRegistry = buildThreadRegistry(threads);

	// Agreements
	const activeAgreements = agreements.filter(a => a.status === 'active');
	const agreementBlock = activeAgreements.length > 0
		? activeAgreements.slice(0, 10).map(a => `- ${a.parties.join(' ↔ ')} (${a.category}): ${a.terms.slice(0, 120)}`).join('\n')
		: '';

	// World events
	const worldEventBlock = worldEvents.length > 0
		? worldEvents.slice(0, 6).map(e => `- ${e.name}${e.description ? ': ' + e.description.slice(0, 100) : ''}`).join('\n')
		: '';

	return {
		arcBlock, chapterBlock, allThreads, characterArcs,
		tacticalBlock, conversationBlock, factionBlock, hasFactions,
		season, recentFactionActions: recentFactionActions.slice(-5),
		relationChangeLog: relationChangeLog.slice(0, 8),
		threadRegistry, schemeBlock: schemes, agreementBlock,
		worldEventBlock, locationBlock: locationName,
	};
}

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

The story's own memory is canon. Use chapter summaries, arcs, faction dossiers, relationships, active agreements, schemes, and recent events. Do not steer toward outside canon, genre tropes, or assumed source-material outcomes unless the current story explicitly establishes them. The point is to simulate what happens here.`;

	if (p.arcBlock) sys += `\n\n═══ STORY ARCS ═══\n${p.arcBlock}`;
	if (p.chapterBlock) sys += `\n\n═══ RECENT CHAPTERS ═══\n${p.chapterBlock}`;
	if (p.allThreads.length > 0) sys += `\n\n═══ OPEN THREADS ═══\n${p.allThreads.map(t => `- ${t}`).join('\n')}`;
	if (p.characterArcs.length > 0) sys += `\n\n═══ CHARACTER ARCS ═══\n${p.characterArcs.map(ca => `- ${typeof ca === 'string' ? ca : `${ca.name}: ${ca.development}`}`).join('\n')}`;

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

   PUSH BACK ON THE PROTAGONIST (important):
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

Your job: read the current world state, recent history, faction dossiers, active schemes, thread registry, and open threads — then plot the NEXT narrative beat's momentum.

Think like a patient showrunner planning the next scene. You are NOT writing prose. You are writing a concise strategic brief that the GM will read before generating. The goal is slow-burn escalation, not a twist machine.

SLOW-BURN DIRECTIVE:
- Most next beats should preserve the current scene's pressure, deepen a relationship, clarify a cost, or let a consequence breathe.
- Do not raise dramatic temperature every turn. Plateaus are useful when they make the next rise feel earned.
- Twists are dormant seeds until the story has paid for them with setup, evidence, suspicion, and player-facing cost.
- Prefer path_a or path_b unless a thread is already imminent. Path_d should almost never be recommended.

═══ OUTPUT FORMAT ═══

Respond with JSON matching the schema. The top-level key is \`next_beat\`.

Inside \`next_beat\`:

1. **critical_path** — four path objects:
   - \`path_a\`: the obvious next NPC move (political overture, summons, trade proposal).
   - \`path_b\`: friction — resistance, counter-demand, refusal, social slight.
   - \`path_c\`: action — physical movement, escalation, arrival/departure, sound from elsewhere.
   - \`path_d\`: dormant twist seed — drawn from stewing secrets ONLY. Usually this is NOT for the next turn; it marks what to withhold or foreshadow.

   Each path object:
   {
     "type": "political_overture|social_slight|action_small_scale|twist_from_secret|environmental_shift|discovery|negotiation|confrontation|none",
     "description": "1-2 sentences describing the NPC action or environmental shift",
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

1. CRITICAL PATH RULE — you only control NPCs and the environment. NEVER predict, assume, or dictate what the player will do. All paths describe NPC actions, environmental shifts, or off-screen events ONLY.

2. DEFAULT TO CONTINUITY AND FRICTION. NPCs have their own agendas, but resistance can be quiet: delay, uncertainty, price, silence, logistics, or a small refusal.

3. PLOT BRANCHES must be drawn from existing open threads, faction goals, and scheme seeds. NEVER invent new lore. If a twist (Path D) has no stewing secret with prior setup to draw from, set Path D to "none" or downgrade it to friction.

4. NEXT TURN STRATEGY — select the slowest path that keeps pressure alive. Default to path_a or path_b. Do not pick path_c or path_d just because the player has had an easy stretch. Pick path_d only when an existing imminent thread, visible evidence, and player action make the reveal unavoidable.

5. REVELATION BUDGET — list major reveals currently stewing and what evidence still needs to accumulate before payoff. Major reveals are currency, not confetti. At most one per arc, and most arcs should spend many turns foreshadowing before they pay.

6. FACTION ADVISORY — for each relevant faction, note their current disposition toward the player and their most likely next move. Factor in recent world events, relation shifts, resources, goals, and seasonal pressures. Use lowercase faction slugs as keys.

7. THREAD AWARENESS — read the THREAD REGISTRY. Factor imminent threads into your branch planning, but a branch may point toward a payoff without landing it.

═══ STRATEGY ═══

Momentum is built on shifting pressure:
- A binding pact is worth more than a show of force until it is broken.
- A death, exposure, shortage, scandal, or succession crisis can reshape the board more than any battle.
- Debt, dependency, logistics, belief, and public legitimacy are leashes.
- Hospitality, contracts, sacred promises, laws, and customs are weapons and targets.
- Seasons, distance, shortages, and communications matter. A faction that ignores its supply line pays for it.
- Heirs, wards, deputies, informants, clients, rivals, and overlooked relatives are loose threads powerful factions ignore at their peril.

When plotting branches:
- Path A (obvious) should usually be an overture: an offer, summons, alliance proposal, trade, deal, or invitation.
- Path B (friction) should often be a social, legal, or logistical obstacle: a refusal, insult, broken promise, blocked route, recalled debt, or missing resource.
- Path C (action) should be occasional and small-scale: a messenger arriving, a patrol sighted, a door barred, a theft discovered, a distant fire, a public challenge, or a limited confrontation. Avoid constant raids, abductions, assassinations, and sudden attacks.
- Path D (twist) should usually be dormant. Use it to name a secret pressure that remains off-page unless the current action directly forces it. If it is not earned, set type "none" or downgrade to friction.`;

	if (p.arcBlock) sys += `\n\n═══ STORY ARCS ═══\n${p.arcBlock}`;
	if (p.chapterBlock) sys += `\n\n═══ RECENT CHAPTERS ═══\n${p.chapterBlock}`;
	if (p.characterArcs.length > 0) sys += `\n\n═══ CHARACTER ARCS ═══\n${p.characterArcs.map(ca => `- ${typeof ca === 'string' ? ca : `${ca.name}: ${ca.development}`}`).join('\n')}`;

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
		const fallback: PlotPathKey = criticalPath.path_b.type !== 'none' ? 'path_b' : 'path_a';
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
		);

		const system = buildWorldSimSystemPrompt({ ...ctx, mode, pov, tense });

		const prompt = hasFactions
			? `Story: ${chapters.length} chapters, ${arcs.length} arcs, ${factionEntries.length} factions, ${threads.length} threads. Season: ${ctx.season.currentSeason}. Simulate the world.`
			: `Story: ${chapters.length} chapters, ${arcs.length} arcs, ${threads.length} threads. Review trajectory and decide if the world should act.`;

		const result = await this.generateStructured(worldSimulationResultSchema, system, prompt);
		const guarded = result.plotMomentum
			? { ...result, plotMomentum: applySlowBurnGuard(result.plotMomentum) }
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
		);

		const system = buildMomentumSystemPrompt({ ...ctx, mode, pov, tense });

		const prompt = `You are plotting the NEXT beat of an interactive fiction story.

Current location: ${locationName || 'Unknown'}
Season: ${ctx.season.currentSeason}
Recent context: ${recentEntries.length} entries, ${factionEntries.length} factions, ${threads.length} threads.

Generate the plot momentum JSON.`;

		const result = await this.generateStructured(plotMomentumSchema, system, prompt);
		return applySlowBurnGuard(result);
	}
}
