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

// ── Lorebook entry factory ──

export function makeDefaultEntryState(type: EntryType): any {
	switch (type) {
		case 'character': return { type, isPresent: false, lastSeenLocation: null, currentDisposition: null, relationship: { level: 0, status: 'neutral', history: [] }, knownFacts: [], revealedSecrets: [] };
		case 'location': return { type, isCurrentLocation: false, visitCount: 0, changes: [], presentCharacters: [], presentItems: [] };
		case 'item': return { type, inInventory: false, currentLocation: null, condition: null, uses: [] };
		case 'faction': return { type, playerStanding: 0, status: 'unknown', knownMembers: [] };
		case 'concept': return { type, revealed: false, comprehensionLevel: 'unknown', relatedEntries: [] };
		case 'event': return { type, occurred: false, occurredAt: null, witnesses: [], consequences: [] };
	}
}

export function makeLoreEntry(storyId: string, name: string, type: EntryType, description: string, keywords: string[]): Entry {
	const now = Date.now();
	return {
		id: uuid(), storyId, name, type, description,
		hiddenInfo: null, aliases: [],
		state: makeDefaultEntryState(type),
		adventureState: null, creativeState: null,
		injection: { mode: 'keyword', keywords, priority: 0 },
		firstMentioned: null, lastMentioned: null, mentionCount: 0,
		createdBy: 'ai', createdAt: now, updatedAt: now,
		loreManagementBlacklisted: false, branchId: null,
	};
}

// ── World sim interval (in-world days between ticks) ──
// Weekly cadence — picked to match natural narrative pacing (factions move,
// rumors spread, plot seeds resolve) without over-firing.
export const WORLD_SIM_DAY_INTERVAL = 7;
