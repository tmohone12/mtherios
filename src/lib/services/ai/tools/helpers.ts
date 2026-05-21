/**
 * Shared helpers for the orchestrator tool executor and background runner.
 * Extracted from GenerationPipeline.ts.
 */

import { uuid } from '$lib/utils/uuid';
import type { Entry, EntryType, TimeTracker } from '$lib/types';

// ── Time helpers ──

// Number words the regex pass understands ahead of unit names.
// 'half' is intentionally absent — let the keyword fallback handle "half an hour"
// vs "an hour and a half" since both phrases share the same tokens.
const TIME_NUMBER_WORDS: Record<string, number> = {
	one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
	eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
	fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
	a: 1, an: 1,
};

const TIME_UNIT_MIN: Record<string, number> = {
	minute: 1,
	hour: 60,
	day: 1440,
	week: 10080,
	month: 43200,
	year: 525600,
};

/**
 * Parse a free-text time delta into minutes.
 *
 * Strategy:
 *   1. Regex pass — sums every "<number-or-word> <unit>(s?)" occurrence
 *      ("3 hours and 15 minutes" → 195, "two days" → 2880, "an hour" → 60).
 *   2. Keyword fallback — for vague prose like "moment", "few minutes",
 *      "several hours", or "half an hour" that has no explicit number.
 *
 * Returns 0 only when both passes find nothing recognizable. Callers that
 * care should log when they get 0 from a non-empty input.
 */
export function parseTimeProgression(s: string): number {
	if (!s) return 0;
	const t = s.toLowerCase();

	// ── Pass 0: "half a/an <unit>" — handled here because the regex below would
	// match "a/an <unit>" (=1*unit) and miss the "half" multiplier in front.
	const halfMatch = t.match(/\bhalf (?:a|an)\s+(minute|hour|day|week|month|year)\b/);
	if (halfMatch) {
		return Math.round(0.5 * TIME_UNIT_MIN[halfMatch[1]]);
	}

	// ── Pass 1: numeric / number-word matches ──
	let total = 0;
	let matched = false;
	const re = /(?:(\d+(?:\.\d+)?)|([a-z]+))\s+(minute|hour|day|week|month|year)s?\b/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(t)) !== null) {
		const numStr = m[1];
		const word = m[2];
		const unit = m[3];
		let count: number | undefined;
		if (numStr != null) {
			count = parseFloat(numStr);
		} else if (word && TIME_NUMBER_WORDS[word] != null) {
			count = TIME_NUMBER_WORDS[word];
		}
		if (count == null || !Number.isFinite(count)) continue;
		total += count * TIME_UNIT_MIN[unit];
		matched = true;
	}
	if (matched) return Math.round(total);

	// ── Pass 2: keyword fallback for vague prose ──
	if (t.includes('moment'))                          return 2;
	if (t.includes('minute') && t.includes('few'))     return 5;
	if (t.includes('minute') && t.includes('several')) return 15;
	if (t.includes('minute'))                          return 5;
	if (t.includes('hour') && t.includes('several'))   return 300;
	if (t.includes('hour') && t.includes('few'))       return 180;
	if (t.includes('hour') && t.includes('half'))      return 30;
	if (t.includes('hour'))                            return 60;
	if (t.includes('day') && t.includes('several'))    return 7200;
	if (t.includes('day') && t.includes('few'))        return 4320;
	if (t.includes('day') && t.includes('half'))       return 720;
	if (t.includes('day'))                             return 1440;
	if (t.includes('week'))                            return 10080;
	if (t.includes('month'))                           return 43200;
	return 0;
}

export function advanceTime(tracker: TimeTracker | null, minutes: number): TimeTracker {
	const t = tracker ?? { years: 0, days: 0, hours: 0, minutes: 0 };
	let totalMinutes = t.minutes + minutes;
	let totalHours = t.hours + Math.floor(totalMinutes / 60);
	totalMinutes = totalMinutes % 60;
	let totalDays = t.days + Math.floor(totalHours / 24);
	totalHours = totalHours % 24;
	const totalYears = t.years + Math.floor(totalDays / 365);
	totalDays = totalDays % 365;
	return { years: totalYears, days: totalDays, hours: totalHours, minutes: totalMinutes };
}

export function clamp(val: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, val));
}

// Lorebook identity helpers. AI updates often vary titles and articles
// ("Lord Eddard Stark", "Eddard Stark", "the Stark lord"). Exact string
// matching is too weak, but cross-type merging is dangerous, so callers should
// pass the entry type whenever they have it.

const TYPE_PREFIX_RE = /^(?:lore|item|character|house|group|organization|organisation|faction|location|concept|event|general lore|general history)\s*:\s+/i;
const LEADING_TITLE_RE = /^(?:(?:the|a|an|lord|lady|ser|sir|king|queen|prince|princess|duke|duchess|baron|baroness|count|countess|captain|commander|general|maester|archmaester|master|mistress|brother|sister|father|mother|high priest|high priestess|priest|priestess|saint|house|clan|guild|order)\s+)+/i;

export function loreNameKey(name: string): string {
	return name
		.normalize('NFKD')
		.replace(TYPE_PREFIX_RE, '')
		.replace(/[’']/g, '')
		.replace(/[^a-zA-Z0-9]+/g, ' ')
		.trim()
		.toLowerCase()
		.replace(LEADING_TITLE_RE, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function loreKeysFor(name: string): string[] {
	const raw = name
		.normalize('NFKD')
		.replace(TYPE_PREFIX_RE, '')
		.replace(/[’']/g, '')
		.replace(/[^a-zA-Z0-9]+/g, ' ')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
	const canonical = loreNameKey(name);
	return [...new Set([raw, canonical].filter(Boolean))];
}

export function findMatchingLoreEntry(
	entries: Entry[],
	incoming: { name: string; type?: EntryType; aliases?: string[] },
): Entry | undefined {
	const incomingKeys = new Set([
		...loreKeysFor(incoming.name),
		...(incoming.aliases ?? []).flatMap(loreKeysFor),
	]);
	if (incomingKeys.size === 0) return undefined;

	const candidates = incoming.type
		? entries.filter(e => e.type === incoming.type)
		: entries;

	return candidates.find(entry => {
		if ((entry as any).deleted) return false;
		const existingKeys = [
			...loreKeysFor(entry.name),
			...(entry.aliases ?? []).flatMap(loreKeysFor),
		];
		return existingKeys.some(key => incomingKeys.has(key));
	});
}

// ── Inter-faction relation normalization (Phase F4) ──
// Pre-F4 stores `number` (standing-only); post-F4 stores FactionRelation.
// All readers MUST go through this normalizer.

export interface NormalizedRelation {
	standing: number;
	affinity: number;
	history: { event: string; delta: number; chapter: number }[];
}

export function normalizeRelation(v: unknown): NormalizedRelation {
	if (v == null) return { standing: 0, affinity: 0, history: [] };
	if (typeof v === 'number') {
		// Legacy numeric form: derive a conservative affinity floor — assume the
		// affinity tracks recent standing but is bounded so a fresh +90 ally
		// doesn't read as "deeply trusted" until events bear it out.
		return { standing: v, affinity: clamp(v, -50, 50), history: [] };
	}
	if (typeof v === 'object') {
		const o = v as Partial<NormalizedRelation>;
		return {
			standing: typeof o.standing === 'number' ? o.standing : 0,
			affinity: typeof o.affinity === 'number' ? o.affinity : 0,
			history: Array.isArray(o.history) ? o.history.slice(-5) : [],
		};
	}
	return { standing: 0, affinity: 0, history: [] };
}

// ── Lorebook entry factory ──

export function makeDefaultEntryState(type: EntryType): any {
	switch (type) {
		case 'character': return { type, isPresent: false, lastSeenLocation: null, currentDisposition: null, relationship: { level: 0, status: 'neutral', history: [] }, knownFacts: [], revealedSecrets: [], pressures: [] };
		case 'location': return { type, isCurrentLocation: false, visitCount: 0, changes: [], presentCharacters: [], presentItems: [] };
		case 'item': return { type, inInventory: false, currentLocation: null, condition: null, uses: [] };
		case 'faction': return {
			type,
			playerStanding: 0,
			status: 'unknown',
			knownMembers: [],
			goals: [],
			resources: { military: 50, wealth: 50, influence: 50, information: 50, morale: 50 },
			territory: [],
		};
		case 'concept': return { type, revealed: false, comprehensionLevel: 'unknown', relatedEntries: [] };
		case 'event': return { type, occurred: false, occurredAt: null, witnesses: [], consequences: [] };
	}
}

export interface LoreEntryOverrides {
	description?: string;
	hiddenInfo?: string | null;
	aliases?: string[];
	keywords?: string[];
	injectionMode?: 'always' | 'keyword' | 'never';
	priority?: number;
	state?: Record<string, any>;
}

export function makeLoreEntry(
	storyId: string,
	name: string,
	type: EntryType,
	description: string,
	keywords: string[],
	overrides?: LoreEntryOverrides,
): Entry {
	const now = Date.now();
	const baseState = makeDefaultEntryState(type);
	const mergedState = overrides?.state
		? { ...baseState, ...overrides.state }
		: baseState;
	return {
		id: uuid(), storyId, name, type,
		description: overrides?.description ?? description,
		hiddenInfo: overrides?.hiddenInfo ?? null,
		aliases: overrides?.aliases ?? [],
		state: mergedState,
		adventureState: null, creativeState: null,
		injection: {
			mode: overrides?.injectionMode ?? 'keyword',
			keywords: overrides?.keywords ?? keywords,
			priority: overrides?.priority ?? 0,
		},
		firstMentioned: null, lastMentioned: null, mentionCount: 0,
		createdBy: 'ai', createdAt: now, updatedAt: now,
		loreManagementBlacklisted: false, branchId: null,
	};
}

// ── World sim interval (in-world days between ticks) ──
// Weekly cadence — picked to match natural narrative pacing (factions move,
// rumors spread, plot seeds resolve) without over-firing.
export const WORLD_SIM_DAY_INTERVAL = 7;

// ── Faction standing event math ──

export type RelationEventType =
	| 'alliance_formed'
	| 'alliance_broken'
	| 'betrayal'
	| 'standing_shift';

/**
 * Compute the new faction standing after an inter-faction event.
 * Pure function so it's directly testable without store/DB mocks.
 *
 * Floor/ceiling semantics — the LLM-provided delta is honored as a drift, but
 * the event's narrative meaning is enforced as a hard bound: a faction whose
 * alliance just FORMED cannot land below +50, and a faction whose alliance
 * just BROKE cannot land above -50, regardless of what delta was emitted.
 *   - alliance_formed: cur+delta, floored at +50.
 *   - alliance_broken: cur+delta, ceilinged at -50.
 *   - betrayal:        cur+delta, ceilinged at -70.
 *   - standing_shift:  pure ±delta, no floor/ceiling — for routine drift.
 * Output is clamped to [-100, 100].
 */
export function computeRelationEventTarget(
	cur: number,
	eventType: RelationEventType,
	delta: number,
): number {
	// Defensive: a non-finite delta (NaN/Infinity) would propagate through clamp
	// + Math.max/min and corrupt persisted state. Treat as zero.
	const safeDelta = Number.isFinite(delta) ? delta : 0;
	const rawDelta = clamp(safeDelta, -50, 50);
	let target: number;
	switch (eventType) {
		case 'alliance_formed':
			target = Math.max(cur + rawDelta, 50);
			break;
		case 'alliance_broken':
			target = Math.min(cur + rawDelta, -50);
			break;
		case 'betrayal':
			target = Math.min(cur + rawDelta, -70);
			break;
		case 'standing_shift':
			target = cur + rawDelta;
			break;
	}
	return clamp(target, -100, 100);
}

// ── Entropy drift constants (deterministic regression-to-the-mean) ──

/** |standing| threshold above which entropy drift fires each worldsim tick. */
export const ENTROPY_DRIFT_THRESHOLD = 30;
/** Per-tick drift magnitude toward zero. Small enough to not overwhelm narrative deltas. */
export const ENTROPY_DRIFT_STEP = 5;
