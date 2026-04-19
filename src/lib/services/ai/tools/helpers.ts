/**
 * Shared helpers for the orchestrator tool executor and background runner.
 * Extracted from GenerationPipeline.ts.
 */

import { uuid } from '$lib/utils/uuid';
import type { Entry, EntryType, TimeTracker } from '$lib/types';

// ── Time helpers ──

export function parseTimeProgression(s: string): number {
	const t = s.toLowerCase();
	if (t.includes('moment'))                          return 2;
	if (t.includes('minute') && t.includes('few'))     return 5;
	if (t.includes('minute') && t.includes('several')) return 15;
	if (t.includes('minute'))                           return 5;
	if (t.includes('hour') && t.includes('several')) return 300;
	if (t.includes('hour') && t.includes('few')) return 180;
	if (t.includes('hour') && t.includes('half'))      return 30;
	if (t.includes('hour'))                            return 60;
	if (t.includes('day') && t.includes('several')) return 7200;
	if (t.includes('day') && t.includes('few')) return 4320;
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
export const WORLD_SIM_DAY_INTERVAL = 3;
