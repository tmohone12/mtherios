import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_CALENDAR, formatWorldTime, headerTimeProposal, normalizeWorldCalendar, parseTimeOfDay, parseWorldDuration, parseWorldTimeLabel,
	worldClockDayText, type WorldClockState } from './worldClock';

const harvest = normalizeWorldCalendar({ hoursPerDay: 24, era: 'AC',
	months: [{ name: 'Silver Moon', days: 30 }, { name: 'Ember Moon', days: 30 }, { name: 'Frost Moon', days: 28 }],
	weekdays: ['Sunday', 'Moonday', 'Fireday'] });

function clock(label: string | null, minutesAfter = 0, calendar = DEFAULT_WORLD_CALENDAR): WorldClockState {
	const parsed = parseWorldTimeLabel(label, calendar);
	return { storyId: 's', branch: 'primary', minutes: parsed.minutes + minutesAfter, precision: parsed.precision, calendar, anchor: parsed.anchor, label, revision: 1, persisted: true };
}

describe('world clock labels', () => {
	it('parses narrated labels conservatively and keeps unknown text as an unanchored label', () => {
		expect(parseWorldTimeLabel('Day 3 | 06:15')).toMatchObject({ anchor: { kind: 'day-number', day: 3 }, minutes: 375, precision: 'minute' });
		expect(parseWorldTimeLabel('Day 1 | Noon')).toMatchObject({ anchor: { kind: 'day-number', day: 1 }, minutes: 720, precision: 'approximate' });
		expect(parseWorldTimeLabel('Day Sunday, Silver Moon 12, 299 AC | 15:05')).toMatchObject({ anchor: { kind: 'named-day', label: 'Sunday, Silver Moon 12, 299 AC' }, minutes: 905 });
		expect(parseWorldTimeLabel('Day Sunday, Silver Moon 12, 299 AC | 3:05 pm', harvest)).toMatchObject({
			anchor: { kind: 'calendar-date', year: 299, monthIndex: 0, day: 12, weekdayIndex: 0 }, minutes: 905 });
		expect(parseWorldTimeLabel('Twilight of Ashes')).toMatchObject({ anchor: { kind: 'unanchored', label: 'Twilight of Ashes' }, precision: 'unknown' });
		expect(parseWorldTimeLabel(null)).toMatchObject({ anchor: { kind: 'unanchored', label: null }, precision: 'unknown' });
		// A day-only label keeps its form (world-day gates read it) and rolls by whole days.
		expect(parseWorldTimeLabel('Day 3')).toMatchObject({ anchor: { kind: 'day-number', day: 3 }, minutes: 0, precision: 'day' });
		expect(formatWorldTime(clock('Day 3', 90))).toBe('Day 3');
		expect(formatWorldTime(clock('Day 3', 25 * 60))).toBe('Day 4');
		expect(headerTimeProposal(clock('Day 3'), 'Day 3 | 06:15')).toMatchObject({ kind: 'advance', minutes: 375, precision: 'minute' });
		expect(parseTimeOfDay('24:00')).toBeNull();
		expect(parseTimeOfDay('12:30 am')).toEqual({ minutes: 30, precision: 'minute' });
	});

	it('rolls minutes into days on the standard day and into months, years and weekdays on a defined calendar', () => {
		expect(formatWorldTime(clock('Day 3 | 23:50', 20))).toBe('Day 4 | 00:10');
		expect(formatWorldTime(clock('Day 3 | 23:50', 2 * 1440))).toBe('Day 5 | 23:50');
		expect(formatWorldTime(clock('Day Fireday, Ember Moon 30, 299 AC | 23:30', 45, harvest))).toBe('Day Sunday, Frost Moon 1, 299 AC | 00:15');
		expect(formatWorldTime(clock('Day Moonday, Frost Moon 28, 299 AC | 12:00', 1440, harvest))).toBe('Day Fireday, Silver Moon 1, 300 AC | 12:00');
		expect(formatWorldTime(clock('Day Sunday, Silver Moon 1, 299 AC | 00:00', 88 * 1440, harvest))).toBe('Day Moonday, Silver Moon 1, 300 AC | 00:00');
		expect(formatWorldTime(clock('Day Sunday, Silver Moon 12, 299 AC | 15:05', 10 * 60))).toBe('Day Sunday, Silver Moon 12, 299 AC +1d | 01:05');
		expect(formatWorldTime(clock('Twilight of Ashes', 90))).toBe('Twilight of Ashes (+1h 30m)');
		const longDay = normalizeWorldCalendar({ hoursPerDay: 30 });
		expect(formatWorldTime(clock('Day 1 | 29:30', 60, longDay))).toBe('Day 2 | 00:30');
	});
});

describe('world clock proposals', () => {
	it('parses stated durations and marks estimates as inexact', () => {
		expect(parseWorldDuration('ten minutes')).toEqual({ minutes: 10, exact: true });
		expect(parseWorldDuration('3 hours and 15 minutes')).toEqual({ minutes: 195, exact: true });
		expect(parseWorldDuration('half an hour')).toEqual({ minutes: 30, exact: true });
		expect(parseWorldDuration('about two days')).toEqual({ minutes: 2880, exact: false });
		expect(parseWorldDuration('a few hours')).toEqual({ minutes: 180, exact: false });
		expect(parseWorldDuration('Dawn after the fire')).toBeNull();
		expect(parseWorldDuration('no time')).toEqual({ minutes: 0, exact: true });
	});

	it('turns a narration header into a forward duration, never a rewind or an unbounded jump', () => {
		expect(headerTimeProposal(clock('Day 3 | 06:15'), 'Day 3 | 06:45')).toMatchObject({ kind: 'advance', minutes: 30 });
		expect(headerTimeProposal(clock('Day 3 | 06:15'), 'Day 4 | 06:00')).toMatchObject({ kind: 'advance', minutes: 1425 });
		expect(headerTimeProposal(clock('Day 3 | 06:15'), 'Day 3 | 05:00')).toEqual({ rejected: 'header_time_earlier_than_clock' });
		expect(headerTimeProposal(clock('Day 3 | 06:15'), 'Day 30 | 06:15')).toEqual({ rejected: 'header_jump_exceeds_limit' });
		expect(headerTimeProposal(clock('Day 3 | 06:15'), 'Day 3 | 06:15')).toBeNull();
		expect(headerTimeProposal(clock('Day 3 | 06:15'), 'Day unknown | dusk-ish')).toBeNull();
		// A differently named day without a calendar is the next day, never more.
		expect(headerTimeProposal(clock('Day Sunday, Silver Moon 12, 299 AC | 22:00'), 'Day Monday, Silver Moon 13, 299 AC | 07:00')).toMatchObject({ kind: 'advance', minutes: 540 });
		expect(headerTimeProposal(clock('Day Fireday, Ember Moon 30, 299 AC | 23:30', 0, harvest), 'Day Moonday, Frost Moon 2, 299 AC | 01:00'))
			.toMatchObject({ kind: 'advance', minutes: 1530 });
		// An unanchored clock takes the first usable narrated time as its anchor.
		expect(headerTimeProposal(clock('Twilight of Ashes'), 'Day 1 | Noon')).toEqual({ kind: 'anchor', label: 'Day 1 | Noon' });
		const advanced = clock('Day 3 | 06:15', 20);
		expect(worldClockDayText(advanced)).toBe('3');
	});
});
