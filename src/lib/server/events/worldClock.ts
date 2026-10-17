/**
 * Authoritative World Clock. Fictional time is application state: numeric minutes
 * since the clock's anchor day, a calendar for display and rollover, a precision,
 * a branch and a revision. It is separate from the turn sequence (`currentTurn`)
 * and from worker timestamps.
 *
 * Only `applyWorldTimeChange` moves the clock. The GameMaster's narration header and
 * the classifier's `time_delta` are proposals: the clock validates them (no rewinds,
 * bounded jumps), applies each source operation once (stable op key), stops a wait at
 * the first world-time scheduled event, marks reached events `due` (never their
 * outcome) and records an auditable change with before/after values.
 * `stories.current_world_time` is the derived display label; an external change to
 * it (import, checkpoint revert, operator edit) re-anchors the clock on the next
 * change, recorded as such.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { stories, storyEvents, worldClocks, worldTimeChanges } from '$lib/server/db/schema';

export const WORLD_CLOCK_BRANCH = 'primary';
/** A single explicit duration may not exceed a year; a header-derived step may not exceed a week. */
export const WORLD_CLOCK_MAX_ADVANCE_MINUTES = 366 * 24 * 60;
export const WORLD_CLOCK_MAX_HEADER_ADVANCE_MINUTES = 7 * 24 * 60;

export type WorldCalendar = {
	hoursPerDay: number;
	/** Optional named months (with day counts) and weekdays for date rollover. */
	months?: Array<{ name: string; days: number }>;
	weekdays?: string[];
	era?: string | null;
};
export const DEFAULT_WORLD_CALENDAR: WorldCalendar = Object.freeze({ hoursPerDay: 24 }) as WorldCalendar;

export type WorldClockAnchor =
	| { kind: 'day-number'; day: number }
	| { kind: 'named-day'; label: string }
	| { kind: 'calendar-date'; year: number; monthIndex: number; day: number; weekdayIndex: number | null }
	| { kind: 'unanchored'; label: string | null };
/** `day`: only the day is known ("Day 3"); the label keeps that form, which world-day gates read. */
export type WorldClockPrecision = 'minute' | 'approximate' | 'day' | 'unknown';

export interface WorldClockState {
	storyId: string;
	branch: string;
	/** Minutes since 00:00 of the anchor day (for an unanchored clock: elapsed since the label). */
	minutes: number;
	precision: WorldClockPrecision;
	calendar: WorldCalendar;
	anchor: WorldClockAnchor;
	label: string | null;
	revision: number;
	persisted: boolean;
}

export type WorldTimeProposal =
	| { kind: 'advance'; minutes: number; text?: string | null; interruptible?: boolean; precision?: WorldClockPrecision }
	| { kind: 'anchor'; label: string }
	| { kind: 'set'; label: string };

/** `world_chronicle`: an author-requested World Chronicle span (server/jobs/worldChronicle.ts). */
export type WorldTimeProposer = 'gm_header' | 'classifier' | 'operator' | 'external_label' | 'migration' | 'world_chronicle';

export interface WorldTimeChangeResult {
	status: 'applied' | 'duplicate' | 'rejected';
	clock: WorldClockState;
	label: string | null;
	appliedMinutes: number;
	requestedMinutes: number | null;
	interrupted: boolean;
	dueEventIds: string[];
	reason?: string;
	changeId?: string;
}

const NAMED_TIMES: Record<string, number> = {
	midnight: 0, 'small hours': 120, 'pre dawn': 300, predawn: 300, dawn: 360, sunrise: 360, daybreak: 360, morning: 540,
	'late morning': 660, noon: 720, midday: 720, afternoon: 900, 'late afternoon': 1020, sunset: 1110, dusk: 1140,
	evening: 1140, twilight: 1140, nightfall: 1200, night: 1260, 'late night': 1380,
};
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
	eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90, couple: 2 };
const UNIT_MINUTES: Record<string, number> = { minute: 1, min: 1, hour: 60, hr: 60, day: 1440, week: 10080, month: 43200, year: 525600 };

const normalized = (value: string) => value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nowIso = () => new Date().toISOString();

export function minutesPerDay(calendar: WorldCalendar): number {
	return Math.max(1, Math.round(calendar.hoursPerDay || 24)) * 60;
}

export function normalizeWorldCalendar(value: unknown): WorldCalendar {
	const raw = asRecord(value);
	const hours = Number(raw.hoursPerDay);
	const months = Array.isArray(raw.months) ? raw.months.map(asRecord)
		.filter(month => typeof month.name === 'string' && month.name.trim() && Number.isInteger(month.days) && Number(month.days) > 0)
		.map(month => ({ name: String(month.name).trim(), days: Number(month.days) })) : [];
	const weekdays = Array.isArray(raw.weekdays) ? raw.weekdays.filter((day): day is string => typeof day === 'string' && Boolean(day.trim())).map(day => day.trim()) : [];
	return { hoursPerDay: Number.isInteger(hours) && hours > 0 && hours <= 100 ? hours : 24,
		...(months.length ? { months } : {}), ...(weekdays.length ? { weekdays } : {}),
		...(typeof raw.era === 'string' && raw.era.trim() ? { era: raw.era.trim() } : {}) };
}

/** Time of day: "06:15", "6:15 pm", "15:05", or a named part of the day (approximate). */
export function parseTimeOfDay(text: string, calendar: WorldCalendar = DEFAULT_WORLD_CALENDAR): { minutes: number; precision: WorldClockPrecision } | null {
	const value = text.trim().toLowerCase();
	const clock = value.match(/^(\d{1,3}):(\d{2})(?:\s*([ap])\.?\s*m\.?)?$/);
	if (clock) {
		let hours = Number(clock[1]);
		const minutes = Number(clock[2]);
		if (clock[3]) { if (hours < 1 || hours > 12) return null; hours = (hours % 12) + (clock[3] === 'p' ? 12 : 0); }
		if (hours >= calendar.hoursPerDay || minutes >= 60) return null;
		return { minutes: hours * 60 + minutes, precision: 'minute' };
	}
	const named = NAMED_TIMES[normalized(value)];
	return named === undefined || calendar.hoursPerDay !== 24 ? null : { minutes: named, precision: 'approximate' };
}

function monthsOf(calendar: WorldCalendar) {
	return calendar.months?.length ? calendar.months : null;
}

function parseCalendarDate(text: string, calendar: WorldCalendar): Extract<WorldClockAnchor, { kind: 'calendar-date' }> | null {
	const months = monthsOf(calendar);
	if (!months) return null;
	let rest = text.trim();
	let weekdayIndex: number | null = null;
	const weekdays = calendar.weekdays ?? [];
	const weekday = weekdays.findIndex(day => rest.toLowerCase().startsWith(day.toLowerCase()));
	if (weekday >= 0) { weekdayIndex = weekday; rest = rest.slice(weekdays[weekday].length).replace(/^\s*,?\s*/, ''); }
	const monthIndex = months.findIndex(month => rest.toLowerCase().startsWith(month.name.toLowerCase()));
	if (monthIndex < 0) return null;
	const date = rest.slice(months[monthIndex].name.length).match(/^\s*(\d{1,3})\s*,\s*(-?\d{1,6})\b/);
	if (!date) return null;
	const day = Number(date[1]);
	if (day < 1 || day > months[monthIndex].days) return null;
	return { kind: 'calendar-date', year: Number(date[2]), monthIndex, day, weekdayIndex };
}

/** Parse a stored or narrated label ("Day 3 | 06:15", "Day Sunday, Silver Moon 12, 299 AC | 15:05"). */
export function parseWorldTimeLabel(label: string | null | undefined, calendar: WorldCalendar = DEFAULT_WORLD_CALENDAR): {
	anchor: WorldClockAnchor; minutes: number; precision: WorldClockPrecision; dayText: string | null;
} {
	const text = (label ?? '').trim();
	const unknown = { anchor: { kind: 'unanchored' as const, label: text || null }, minutes: 0, precision: 'unknown' as const, dayText: null };
	const dayOnly = text.match(/^Day\s+(\d{1,6})$/i);
	if (dayOnly) return { anchor: { kind: 'day-number', day: Number(dayOnly[1]) }, minutes: 0, precision: 'day', dayText: dayOnly[1] };
	const match = text.match(/^Day\s+(.+?)\s*\|\s*(.+)$/i);
	if (!match) return unknown;
	const time = parseTimeOfDay(match[2], calendar);
	if (!time) return unknown;
	const dayText = match[1].trim();
	if (/^\d{1,6}$/.test(dayText)) return { anchor: { kind: 'day-number', day: Number(dayText) }, minutes: time.minutes, precision: time.precision, dayText };
	const date = parseCalendarDate(dayText, calendar);
	if (date) return { anchor: date, minutes: time.minutes, precision: time.precision, dayText };
	return { anchor: { kind: 'named-day', label: dayText }, minutes: time.minutes, precision: time.precision, dayText };
}

function addCalendarDays(anchor: Extract<WorldClockAnchor, { kind: 'calendar-date' }>, days: number, calendar: WorldCalendar) {
	const months = monthsOf(calendar)!;
	const yearDays = months.reduce((total, month) => total + month.days, 0);
	let year = anchor.year + Math.floor(days / yearDays);
	let remaining = days % yearDays;
	let monthIndex = anchor.monthIndex;
	let day = anchor.day;
	while (remaining > 0) {
		const left = months[monthIndex].days - day;
		if (remaining <= left) { day += remaining; remaining = 0; break; }
		remaining -= left + 1;
		day = 1;
		monthIndex += 1;
		if (monthIndex >= months.length) { monthIndex = 0; year += 1; }
	}
	const weekdays = calendar.weekdays ?? [];
	const weekdayIndex = anchor.weekdayIndex === null || !weekdays.length ? null : (anchor.weekdayIndex + days) % weekdays.length;
	return { year, monthIndex, day, weekdayIndex };
}

function calendarOrdinal(date: { year: number; monthIndex: number; day: number }, calendar: WorldCalendar): number {
	const months = monthsOf(calendar)!;
	const yearDays = months.reduce((total, month) => total + month.days, 0);
	return date.year * yearDays + months.slice(0, date.monthIndex).reduce((total, month) => total + month.days, 0) + date.day - 1;
}

/** The day portion of the clock's label (what a matching narration header names). */
export function worldClockDayText(state: Pick<WorldClockState, 'anchor' | 'minutes' | 'calendar' | 'precision'>): string | null {
	const dayIndex = Math.floor(state.minutes / minutesPerDay(state.calendar));
	switch (state.anchor.kind) {
		case 'day-number': return String(state.anchor.day + dayIndex);
		case 'named-day': return dayIndex === 0 ? state.anchor.label : `${state.anchor.label} +${dayIndex}d`;
		case 'calendar-date': {
			const date = addCalendarDays(state.anchor, dayIndex, state.calendar);
			const weekday = date.weekdayIndex === null ? '' : `${state.calendar.weekdays![date.weekdayIndex]}, `;
			return `${weekday}${monthsOf(state.calendar)![date.monthIndex].name} ${date.day}, ${date.year}${state.calendar.era ? ` ${state.calendar.era}` : ''}`;
		}
		default: return null;
	}
}

function formatDuration(minutes: number): string {
	const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
	return [days ? `${days}d` : '', hours ? `${hours}h` : '', rest || (!days && !hours) ? `${rest}m` : ''].filter(Boolean).join(' ');
}

/** Display label: the calendar rolls minutes into days, months and years. */
export function formatWorldTime(state: Pick<WorldClockState, 'anchor' | 'minutes' | 'calendar' | 'precision'>): string | null {
	if (state.anchor.kind === 'unanchored') {
		const base = state.anchor.label ?? null;
		return state.minutes > 0 ? `${base ?? 'Unanchored time'} (+${formatDuration(state.minutes)})` : base;
	}
	if (state.precision === 'day') return `Day ${worldClockDayText(state)}`;
	const day = minutesPerDay(state.calendar);
	const timeOfDay = ((state.minutes % day) + day) % day;
	const hh = String(Math.floor(timeOfDay / 60)).padStart(2, '0');
	const mm = String(timeOfDay % 60).padStart(2, '0');
	return `Day ${worldClockDayText(state)} | ${hh}:${mm}`;
}

/** A free-text duration ("ten minutes", "3 hours and 15 minutes", "a few hours"). Null when none is stated. */
export function parseWorldDuration(text: string | null | undefined): { minutes: number; exact: boolean } | null {
	const value = normalized(text ?? '');
	if (!value) return null;
	if (/^(no time|none|nothing|instant(ly)?|0( minutes?)?)$/.test(value)) return { minutes: 0, exact: true };
	let total = 0;
	let matched = false;
	const half = value.match(/\bhalf (?:a|an) (minute|hour|day|week|month|year)\b/);
	if (half) { total += UNIT_MINUTES[half[1]] / 2; matched = true; }
	const pattern = /\b(\d+(?:\.\d+)?|forty five|[a-z]+)\s+(minute|min|hour|hr|day|week|month|year)s?\b/g;
	for (const match of value.replace(/\bhalf (?:a|an) (?:minute|hour|day|week|month|year)\b/g, ' ').matchAll(pattern)) {
		const count = /^\d/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1]];
		if (count === undefined || !Number.isFinite(count)) continue;
		total += count * UNIT_MINUTES[match[2]];
		matched = true;
	}
	if (matched) return { minutes: Math.round(total), exact: !/\b(few|several|some|about|around|roughly|nearly|almost)\b/.test(value) };
	const vague: Array<[RegExp, number]> = [[/\bmoments?\b/, 2], [/\bfew minutes\b/, 5], [/\bseveral minutes\b/, 15], [/\bfew hours\b/, 180],
		[/\bseveral hours\b/, 300], [/\bfew days\b/, 4320], [/\bseveral days\b/, 7200]];
	for (const [pattern, minutes] of vague) if (pattern.test(value)) return { minutes, exact: false };
	return null;
}

/** What a narrator header proposes relative to the clock. Never a rewind. */
export function headerTimeProposal(state: WorldClockState, header: string | null | undefined): WorldTimeProposal | { rejected: string } | null {
	if (!header) return null;
	const parsed = parseWorldTimeLabel(header, state.calendar);
	if (parsed.precision === 'unknown') return null;
	// An unanchored clock takes its first usable narrated time as its anchor.
	if (state.anchor.kind === 'unanchored') return { kind: 'anchor', label: header };
	const day = minutesPerDay(state.calendar);
	const currentTimeOfDay = ((state.minutes % day) + day) % day;
	const currentDay = worldClockDayText(state);
	// The current label may be the narrator's own wording of the same day.
	const labelDay = state.label ? parseWorldTimeLabel(state.label, state.calendar).dayText : null;
	const sameDay = Boolean(parsed.dayText) && [currentDay, labelDay].some(text => text && normalized(text) === normalized(parsed.dayText!));
	let delta: number;
	if (sameDay) {
		delta = parsed.minutes - currentTimeOfDay;
	} else if (state.anchor.kind === 'day-number' && parsed.anchor.kind === 'day-number') {
		delta = (parsed.anchor.day - (state.anchor.day + Math.floor(state.minutes / day))) * day + parsed.minutes - currentTimeOfDay;
	} else if (state.anchor.kind === 'calendar-date' && parsed.anchor.kind === 'calendar-date') {
		const current = addCalendarDays(state.anchor, Math.floor(state.minutes / day), state.calendar);
		delta = (calendarOrdinal(parsed.anchor, state.calendar) - calendarOrdinal(current, state.calendar)) * day + parsed.minutes - currentTimeOfDay;
	} else {
		// A differently named day without a calendar: the next day, never more.
		delta = day - currentTimeOfDay + parsed.minutes;
	}
	if (delta < 0) return { rejected: 'header_time_earlier_than_clock' };
	if (delta === 0) return null;
	if (delta > WORLD_CLOCK_MAX_HEADER_ADVANCE_MINUTES) return { rejected: 'header_jump_exceeds_limit' };
	return { kind: 'advance', minutes: delta, text: header, precision: parsed.precision };
}

function stateFromRow(storyId: string, row: typeof worldClocks.$inferSelect): WorldClockState {
	return { storyId, branch: row.branch, minutes: row.minutes, precision: row.precision as WorldClockPrecision, calendar: normalizeWorldCalendar(row.calendar),
		anchor: row.anchor as WorldClockAnchor, label: row.label, revision: row.revision, persisted: true };
}

function stateFromLabel(storyId: string, label: string | null, calendar: WorldCalendar = DEFAULT_WORLD_CALENDAR, revision = 0): WorldClockState {
	const parsed = parseWorldTimeLabel(label, calendar);
	return { storyId, branch: WORLD_CLOCK_BRANCH, minutes: parsed.minutes, precision: parsed.precision, calendar, anchor: parsed.anchor,
		label: label ?? null, revision, persisted: false };
}

type ClockDb = ReturnType<typeof getDb>;
type ClockTx = Parameters<Parameters<ClockDb['transaction']>[0]>[0];
export type WorldClockDb = Pick<ClockDb | ClockTx, 'insert' | 'select' | 'update'>;

/** Read-only: the persisted clock, or the clock a label would produce. Never writes.
 * With `storyLabel`, a label changed outside the clock is what the next change re-anchors to. */
export async function loadWorldClock(storyId: string, db: WorldClockDb = getDb(), storyLabel?: string | null): Promise<WorldClockState> {
	const [row] = await db.select().from(worldClocks).where(and(eq(worldClocks.storyId, storyId), eq(worldClocks.branch, WORLD_CLOCK_BRANCH))).limit(1);
	if (row && (storyLabel === undefined || (storyLabel ?? null) === (row.label ?? null))) return stateFromRow(storyId, row);
	if (row) return { ...stateFromLabel(storyId, storyLabel ?? null, normalizeWorldCalendar(row.calendar), row.revision), persisted: true };
	if (storyLabel !== undefined) return stateFromLabel(storyId, storyLabel);
	const [story] = await db.select({ currentWorldTime: stories.currentWorldTime }).from(stories).where(eq(stories.id, storyId)).limit(1);
	return stateFromLabel(storyId, story?.currentWorldTime ?? null);
}

const changeId = (storyId: string, opKey: string) => `world_time_${createHash('sha256').update(`${storyId}\0${WORLD_CLOCK_BRANCH}\0${opKey}`).digest('hex').slice(0, 40)}`;

async function recordChange(tx: WorldClockDb, row: Omit<typeof worldTimeChanges.$inferInsert, 'id' | 'branch' | 'createdAt'>): Promise<string> {
	const id = changeId(row.storyId, row.opKey);
	await tx.insert(worldTimeChanges).values({ ...row, id, branch: WORLD_CLOCK_BRANCH, createdAt: nowIso() }).onConflictDoNothing();
	return id;
}

async function saveClock(tx: WorldClockDb, state: WorldClockState, label: string | null, now: string, writeStoryLabel: boolean): Promise<WorldClockState> {
	const next = { ...state, label, revision: state.revision + 1, persisted: true };
	const values = { minutes: next.minutes, precision: next.precision, calendar: next.calendar, anchor: next.anchor as Record<string, unknown>,
		label, revision: next.revision, updatedAt: now };
	if (state.persisted) {
		await tx.update(worldClocks).set(values).where(and(eq(worldClocks.storyId, state.storyId), eq(worldClocks.branch, state.branch)));
	} else {
		await tx.insert(worldClocks).values({ storyId: state.storyId, branch: state.branch, createdAt: now, ...values })
			.onConflictDoUpdate({ target: [worldClocks.storyId, worldClocks.branch], set: values });
	}
	if (writeStoryLabel) await tx.update(stories).set({ currentWorldTime: label, updatedAt: now }).where(eq(stories.id, state.storyId));
	return next;
}

export interface ApplyWorldTimeChangeInput {
	storyId: string;
	/** Stable per source operation: a repeat (retry, delayed extraction, duplicate job) changes nothing. */
	opKey: string;
	proposal: WorldTimeProposal;
	proposer: WorldTimeProposer;
	reason: string;
	sourceEntryId?: string | null;
	sourceTurn?: number | null;
	/** Story label as read under the caller's story lock; detects an external label change. */
	storyLabel?: string | null;
	/** The turn path writes the label in its own story update. */
	writeStoryLabel?: boolean;
	serverVersion?: number;
	/** Stored on the change row, e.g. the World Chronicle's span and day count. */
	metadata?: Record<string, unknown>;
}

/**
 * The only writer of world time. Call inside the transaction that commits the
 * source (turn result, extraction, operator command), with the story row locked.
 */
export async function applyWorldTimeChange(tx: WorldClockDb, input: ApplyWorldTimeChangeInput): Promise<WorldTimeChangeResult> {
	const now = nowIso();
	const writeStoryLabel = input.writeStoryLabel !== false;
	const [row] = await tx.select().from(worldClocks)
		.where(and(eq(worldClocks.storyId, input.storyId), eq(worldClocks.branch, WORLD_CLOCK_BRANCH))).for('update').limit(1);
	let storyLabel = input.storyLabel;
	if (storyLabel === undefined) {
		const [story] = await tx.select({ currentWorldTime: stories.currentWorldTime }).from(stories).where(eq(stories.id, input.storyId)).for('update').limit(1);
		storyLabel = story?.currentWorldTime ?? null;
	}
	let state = row ? stateFromRow(input.storyId, row) : stateFromLabel(input.storyId, storyLabel ?? null);
	const result = (status: WorldTimeChangeResult['status'], extra: Partial<WorldTimeChangeResult> = {}): WorldTimeChangeResult =>
		({ status, clock: state, label: state.label, appliedMinutes: 0, requestedMinutes: null, interrupted: false, dueEventIds: [], ...extra });

	const [existing] = await tx.select({ id: worldTimeChanges.id }).from(worldTimeChanges)
		.where(and(eq(worldTimeChanges.storyId, input.storyId), eq(worldTimeChanges.branch, WORLD_CLOCK_BRANCH), eq(worldTimeChanges.opKey, input.opKey))).limit(1);
	if (existing) return result('duplicate', { changeId: existing.id });

	const base = { storyId: input.storyId, proposer: input.proposer, sourceEntryId: input.sourceEntryId ?? null, sourceTurn: input.sourceTurn ?? null, metadata: input.metadata ?? {} };
	// A label changed outside the clock (import, checkpoint revert, operator edit) re-anchors it, on the record.
	if (row && (storyLabel ?? null) !== (row.label ?? null)) {
		const before = state;
		state = { ...stateFromLabel(input.storyId, storyLabel ?? null, before.calendar, before.revision), persisted: true };
		state = await saveClock(tx, state, storyLabel ?? null, now, false);
		await recordChange(tx, { ...base, opKey: `external-label:${before.revision}:${createHash('sha256').update(storyLabel ?? '').digest('hex').slice(0, 16)}`,
			status: 'applied', kind: 'set', proposer: 'external_label', reason: 'The story time label was changed outside the clock.',
			beforeMinutes: before.minutes, afterMinutes: state.minutes, beforeLabel: before.label, afterLabel: state.label, clockRevision: state.revision });
	}

	const proposal = input.proposal;
	const reject = async (reason: string, requestedMinutes: number | null = null) => {
		const id = await recordChange(tx, { ...base, opKey: `${input.opKey}#rejected:${reason}`, status: 'rejected', kind: proposal.kind, reason: `${input.reason} Rejected: ${reason}.`,
			requestedMinutes, appliedMinutes: 0, beforeMinutes: state.minutes, afterMinutes: state.minutes, beforeLabel: state.label, afterLabel: state.label,
			clockRevision: state.revision, metadata: { text: 'text' in proposal ? proposal.text ?? null : null } });
		return result('rejected', { reason, requestedMinutes, changeId: id });
	};

	if (proposal.kind === 'anchor' || proposal.kind === 'set') {
		if (proposal.kind === 'anchor' && state.anchor.kind !== 'unanchored') return reject('clock_already_anchored');
		const parsed = parseWorldTimeLabel(proposal.label, state.calendar);
		if (proposal.kind === 'anchor' && parsed.precision === 'unknown') return reject('label_not_parseable');
		const before = state;
		state = { ...state, anchor: parsed.anchor, minutes: parsed.minutes, precision: parsed.precision };
		state = await saveClock(tx, state, proposal.label, now, writeStoryLabel);
		const id = await recordChange(tx, { ...base, opKey: input.opKey, status: 'applied', kind: proposal.kind, reason: input.reason,
			beforeMinutes: before.minutes, afterMinutes: state.minutes, beforeLabel: before.label, afterLabel: state.label, clockRevision: state.revision,
			metadata: { anchor: state.anchor, precision: state.precision } });
		return result('applied', { changeId: id });
	}

	const requested = Math.round(proposal.minutes);
	if (!Number.isFinite(requested) || requested < 0) return reject('negative_or_invalid_duration', Number.isFinite(requested) ? requested : null);
	if (requested > WORLD_CLOCK_MAX_ADVANCE_MINUTES) return reject('duration_exceeds_limit', requested);
	if (requested === 0) return result('applied', { requestedMinutes: 0 });
	// A wait stops at the first world-time scheduled event it reaches; the event becomes due, not resolved.
	const scheduled = await tx.select({ id: storyEvents.id, metadata: storyEvents.metadata }).from(storyEvents)
		.where(and(eq(storyEvents.storyId, input.storyId), eq(storyEvents.status, 'scheduled'), sql`${storyEvents.metadata} ? 'dueWorldMinutes'`)).limit(500);
	const dueAt = (metadata: unknown) => Number(asRecord(metadata).dueWorldMinutes);
	const target = state.minutes + requested;
	const reached = scheduled.filter(event => Number.isFinite(dueAt(event.metadata)) && dueAt(event.metadata) <= target);
	const interruption = proposal.interruptible === false ? null
		: reached.map(event => dueAt(event.metadata)).filter(due => due > state.minutes).sort((left, right) => left - right)[0] ?? null;
	const after = interruption ?? target;
	const dueEventIds = reached.filter(event => dueAt(event.metadata) <= after).map(event => event.id);
	const before = state;
	// A narrated time of day refines a day-only or approximate clock.
	state = { ...state, minutes: after, precision: proposal.precision && proposal.precision !== 'unknown' && (state.precision === 'approximate' || state.precision === 'day') ? proposal.precision : state.precision };
	// A header step that landed where the narrator said keeps the narrator's wording.
	const label = input.proposer === 'gm_header' && interruption === null && proposal.text ? proposal.text : formatWorldTime(state);
	state = await saveClock(tx, state, label, now, writeStoryLabel);
	if (dueEventIds.length) {
		await tx.update(storyEvents).set({ status: 'due', updatedAt: now, ...(input.serverVersion ? { serverVersion: input.serverVersion } : {}),
			metadata: sql`${storyEvents.metadata} || ${JSON.stringify({ dueReachedAtWorldMinutes: after, dueReachedAtLabel: state.label })}::jsonb` })
			.where(and(eq(storyEvents.storyId, input.storyId), inArray(storyEvents.id, dueEventIds), eq(storyEvents.status, 'scheduled')));
	}
	const id = await recordChange(tx, { ...base, opKey: input.opKey, status: 'applied', kind: 'advance', reason: input.reason,
		requestedMinutes: requested, appliedMinutes: after - before.minutes, beforeMinutes: before.minutes, afterMinutes: after,
		beforeLabel: before.label, afterLabel: state.label, clockRevision: state.revision, interruptedBy: interruption === null ? [] : dueEventIds,
		metadata: { text: proposal.text ?? null } });
	return result('applied', { requestedMinutes: requested, appliedMinutes: after - before.minutes, interrupted: interruption !== null, dueEventIds, changeId: id });
}

/** Operator configuration: calendar and (optionally) an explicit current time. Recorded. */
export async function configureWorldClock(input: { storyId: string; calendar?: unknown; label?: string | null; reviewedBy: string; reason?: string }, db: ClockDb = getDb()) {
	if (!input.reviewedBy.trim()) throw new Error('World clock configuration requires a reviewer.');
	return db.transaction(async tx => {
		const [story] = await tx.select({ currentWorldTime: stories.currentWorldTime }).from(stories).where(eq(stories.id, input.storyId)).for('update').limit(1);
		if (!story) throw new Error(`Story not found: ${input.storyId}`);
		const now = nowIso();
		let state = await loadWorldClock(input.storyId, tx);
		const before = state;
		const calendar = input.calendar === undefined ? state.calendar : normalizeWorldCalendar(input.calendar);
		const label = input.label === undefined ? (state.label ?? story.currentWorldTime ?? null) : input.label;
		const parsed = parseWorldTimeLabel(label, calendar);
		state = { ...state, calendar, anchor: parsed.anchor, minutes: parsed.minutes, precision: parsed.precision };
		state = await saveClock(tx, state, label, now, true);
		await recordChange(tx, { storyId: input.storyId, opKey: `operator:${now}:${state.revision}`, status: 'applied', kind: 'set', proposer: 'operator',
			reason: input.reason?.trim() || `Configured by ${input.reviewedBy.trim()}.`, beforeMinutes: before.minutes, afterMinutes: state.minutes,
			beforeLabel: before.label, afterLabel: state.label, clockRevision: state.revision, metadata: { reviewedBy: input.reviewedBy.trim(), calendar } });
		return state;
	});
}

/** Recent clock history for the UI, CLI and MCP. Read-only. */
export async function worldClockStatus(storyId: string, db: WorldClockDb = getDb()) {
	const clock = await loadWorldClock(storyId, db);
	const changes = await db.select().from(worldTimeChanges).where(eq(worldTimeChanges.storyId, storyId))
		.orderBy(sql`${worldTimeChanges.createdAt} desc`).limit(20);
	return { clock: { ...clock, display: formatWorldTime(clock), dayText: worldClockDayText(clock) }, changes };
}
