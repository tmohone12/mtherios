import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorldChronicleEvent } from '$lib/contracts/worldChronicle';
import type { BackendWorldChronicleAdvanceResult } from '$lib/services/backendMemory';
import { chronicleEntryView, describeChronicleOutcome, dismissedChronicleCount, groupChronicleEvents } from './worldChronicleView';

const outcome = (overrides: Partial<BackendWorldChronicleAdvanceResult> = {}): BackendWorldChronicleAdvanceResult => ({
	jobId: 'job_1', status: 'complete', created: 5, proposed: 3, autoAccepted: 2, skippedDuplicates: 0, dropped: 0,
	clockAdvancedMinutes: 10080, clockAdvancedDays: 7, clockLabel: 'Day 11', clockReason: null, alreadyComplete: false, error: null, ...overrides,
});

const event = (id: string, overrides: Partial<WorldChronicleEvent> = {}): WorldChronicleEvent => ({
	id, status: 'proposed', type: 'world_happening', title: `Happening ${id}`, body: 'Something happened.', visibility: 'player_known',
	worldTime: 'Day 9', createdAt: '2026-10-16 12:00:00+00', metadata: {}, ...overrides,
});

describe('World Chronicle drawer view', () => {
	it('summarizes an advance in one line', () => {
		expect(describeChronicleOutcome(outcome())).toEqual({ tone: 'info', text: '3 happenings proposed, 2 auto-accepted; the clock moved 7 days.' });
		expect(describeChronicleOutcome(outcome({ proposed: 0, autoAccepted: 1, clockAdvancedMinutes: 1440, clockAdvancedDays: 1 })).text)
			.toBe('1 happening auto-accepted; the clock moved 1 day.');
		expect(describeChronicleOutcome(outcome({ proposed: 0, autoAccepted: 0, skippedDuplicates: 2, dropped: 1 })).text)
			.toBe('No new happenings (2 duplicates skipped, 1 dropped in review); the clock moved 7 days.');
		expect(describeChronicleOutcome(outcome({ clockAdvancedMinutes: 0, clockAdvancedDays: 0, clockReason: 'duration_exceeds_limit' })).text)
			.toBe('3 happenings proposed, 2 auto-accepted; the clock did not move (duration exceeds limit).');
		expect(describeChronicleOutcome(outcome({ status: 'failed', error: 'Model configuration needed: World planning has no model profile.' })))
			.toEqual({ tone: 'error', text: 'The world could not advance: Model configuration needed: World planning has no model profile.' });
		expect(describeChronicleOutcome(outcome({ status: 'running', error: 'already running' })).tone).toBe('info');
		expect(describeChronicleOutcome(outcome({ alreadyComplete: true })).text).toBe('This batch was already written.');
	});

	it('groups by in-world day, newest first, and hides dismissed happenings unless asked', () => {
		const events = [event('a', { worldTime: 'Day 11' }), event('b', { worldTime: 'Day 11', status: 'committed' }), event('c', { worldTime: 'Day 9', status: 'cancelled' }),
			event('d', { worldTime: null })];
		expect(groupChronicleEvents(events, false).map(group => [group.label, group.entries.map(entry => entry.event.id)]))
			.toEqual([['Day 11', ['a', 'b']], ['Written 2026-10-16', ['d']]]);
		expect(groupChronicleEvents(events, true).map(group => group.label)).toEqual(['Day 11', 'Day 9', 'Written 2026-10-16']);
		expect(dismissedChronicleCount(events)).toBe(1);
	});

	it('reads the chip, place, reach and seed from the happening metadata', () => {
		expect(chronicleEntryView(event('a', { metadata: { kind: 'economic', stakes: 'medium', whereName: 'Varn', factionNames: ['Salt Guild'],
			reach: 'Merchants talk.', seed: { type: 'faction_goal', ref: 'goal_tolls' }, stakesRaised: true } }))).toMatchObject({
			kind: 'economic', stakes: 'medium', where: 'Varn', factions: ['Salt Guild'], reach: 'Merchants talk.', seed: 'faction goal: goal_tolls', visibility: 'regional', stakesRaised: true });
		expect(chronicleEntryView(event('b', { visibility: 'secret', metadata: { seed: { type: 'new', ref: null } } }))).toMatchObject({ seed: 'new', visibility: 'secret', where: null });
	});

	it('is a World drawer section that uses the shared engine command helpers', () => {
		const drawer = readFileSync(resolve('src/lib/components/story/WorldDrawer.svelte'), 'utf8');
		const panel = readFileSync(resolve('src/lib/components/story/WorldChroniclePanel.svelte'), 'utf8');
		expect(drawer).toContain('<WorldChroniclePanel {open} />');
		expect(drawer.indexOf('<WorldChroniclePanel')).toBeLessThan(drawer.indexOf('Living World</span>'));
		expect(panel).toContain('runBackendWorldChronicle');
		expect(panel).toContain('reviewBackendWorldChronicle');
		expect(panel).toContain('story.refreshCampaignProjection()');
		expect(panel).toContain('disabled={!serverStoryId || advancing}');
		expect(panel).not.toContain('fetch(');
	});
});
