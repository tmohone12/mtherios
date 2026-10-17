import { describe, expect, it } from 'vitest';
import { pendingTimeSkip, renderTimeSkipNotice, timeSkipLength, type ClockChangeRow } from './timeSkip';

const change = (overrides: Partial<ClockChangeRow> = {}): ClockChangeRow => ({
	id: 'change_1', status: 'applied', proposer: 'world_chronicle', opKey: 'world-chronicle:job_7', appliedMinutes: 7 * 1440,
	beforeLabel: 'Fifth Moon 24, 305 AC', afterLabel: 'Sixth Moon 1, 305 AC', reason: 'World Chronicle: one week.',
	metadata: { span: 'week', days: 7 }, createdAt: '2026-10-16T20:00:00.000Z', ...overrides,
});
const narration = (createdAt: string, metadata: Record<string, unknown> | null = null) => ({ type: 'narration', metadata, createdAt });

describe('pending time skip', () => {
	it('is pending until an in-character narration follows the clock change', () => {
		const skip = pendingTimeSkip(change(), [narration('2026-10-16T19:00:00.000Z'), { type: 'user_action', metadata: null, createdAt: '2026-10-16T20:30:00.000Z' }]);
		expect(skip).toMatchObject({ changeId: 'change_1', jobId: 'job_7', span: 'week', days: 7, beforeLabel: 'Fifth Moon 24, 305 AC' });
		expect(pendingTimeSkip(change(), [narration('2026-10-16T20:30:00.000Z')])).toBeNull();
		// An OOC answer after the change does not count as playing past it.
		expect(pendingTimeSkip(change(), [narration('2026-10-16T20:30:00.000Z', { narrativeMode: 'ooc' })])).not.toBeNull();
	});

	it('ignores changes that are not an applied chronicle advance', () => {
		expect(pendingTimeSkip(null, [])).toBeNull();
		expect(pendingTimeSkip(change({ proposer: 'gm_header' }), [])).toBeNull();
		expect(pendingTimeSkip(change({ status: 'rejected' }), [])).toBeNull();
		expect(pendingTimeSkip(change({ appliedMinutes: 0 }), [])).toBeNull();
	});

	it('describes the length from the span, else from the minutes', () => {
		expect(timeSkipLength({ span: 'season', days: null, appliedMinutes: 0 })).toBe('one season (90 days)');
		expect(timeSkipLength({ span: null, days: null, appliedMinutes: 3 * 1440 })).toBe('3 days');
		expect(timeSkipLength({ span: null, days: 1, appliedMinutes: 0 })).toBe('one day');
	});

	it('tells the narrator to reopen after the gap and lists only the gap\'s public accepted happenings', () => {
		const skip = pendingTimeSkip(change(), [])!;
		const event = (overrides: Record<string, unknown>) => ({ type: 'world_happening', status: 'committed', visibility: 'public', title: 'Grain riots in Oldtown',
			body: 'Crowds stormed the granaries.', worldTime: 'Fifth Moon 27, 305 AC', metadata: { chronicleJobId: 'job_7' }, ...overrides }) as never;
		const captured: string[] = [];
		const text = renderTimeSkipNotice(skip, [
			event({}),
			event({ title: 'A secret letter', visibility: 'secret' }),
			event({ title: 'Draft riot', status: 'proposed' }),
			event({ title: 'Older news', metadata: { chronicleJobId: 'job_2' } }),
		], (kind, id, value) => { captured.push(`${kind}:${id}`); return value; });
		expect(text).toContain('Time skip: one week (7 days) passed off-screen');
		expect(text).toContain('from Fifth Moon 24, 305 AC to Sixth Moon 1, 305 AC');
		expect(text).toContain('That scene is over.');
		expect(text).toContain('- Grain riots in Oldtown: Crowds stormed the granaries. (Fifth Moon 27, 305 AC)');
		for (const hidden of ['A secret letter', 'Draft riot', 'Older news']) expect(text).not.toContain(hidden);
		expect(captured).toEqual(['requiredScene:timeskip:change_1']);
	});
});
