import { describe, expect, it } from 'vitest';
import { buildActionContent, decodeActionDraft, encodeActionDraft, failedDraftRestoreTarget, startServerTurn, turnActionTypeForInput } from './actionInput';

describe('action input helpers', () => {
	it('round-trips private draft mode and reads legacy text drafts', () => {
		expect(decodeActionDraft(encodeActionDraft({ text: 'keep this private', actionType: 'think' })))
			.toEqual({ text: 'keep this private', actionType: 'think' });
		expect(decodeActionDraft('legacy draft')).toEqual({ text: 'legacy draft', actionType: 'do' });
	});

	it('routes prefixed GM controls to OOC without matching in-world mentions', () => {
		expect(turnActionTypeForInput('GM: reset to the emperor\'s offer.', 'do')).toBe('ooc');
		expect(turnActionTypeForInput('> Game Master: keep Leng separate from Yi Ti.', 'say')).toBe('ooc');
		expect(turnActionTypeForInput('Narrator: correct the location.', 'story')).toBe('ooc');
		expect(turnActionTypeForInput('/pov Bu Gai | considers the offer.', 'pov')).toBe('pov');
		expect(turnActionTypeForInput('I tell the GM of the merchant guild that the levy is late.', 'do')).toBe('do');
	});

	it('does not duplicate punctuation or dialogue quotes', () => {
		expect(buildActionContent('attack him!', 'do', { thirdPerson: false, protagonistName: 'Aurion' }))
			.toBe('> I attack him!');
		expect(buildActionContent('"Who are you?"', 'say', { thirdPerson: false, protagonistName: 'Aurion' }))
			.toBe('> I ask, "Who are you?"');
	});

	it('renders third-person commands with usable grammar and pronouns', () => {
		expect(buildActionContent('open my bag', 'do', { thirdPerson: true, protagonistName: 'Aurion' }))
			.toBe('> Aurion opens their bag.');
		expect(buildActionContent('i', 'do', { thirdPerson: true, protagonistName: 'Aurion' }))
			.toBe('> Aurion checks their inventory.');
	});
});

describe('failed draft restoration', () => {
	const base = { submittedStoryId: 'story_a', submittedRevision: 4, currentStoryId: 'story_a', currentRevision: 4, storedDraftForSubmittedStory: null };

	it('returns an untouched draft to the composer that sent it', () => {
		expect(failedDraftRestoreTarget(base)).toBe('composer');
	});

	it('never overwrites a newer draft typed after the send', () => {
		expect(failedDraftRestoreTarget({ ...base, currentRevision: 5 })).toBe('none');
	});

	it('returns the draft to its own story after a story switch unless that slot has a newer draft', () => {
		expect(failedDraftRestoreTarget({ ...base, currentStoryId: 'story_b' })).toBe('storage');
		expect(failedDraftRestoreTarget({ ...base, currentStoryId: 'story_b',
			storedDraftForSubmittedStory: encodeActionDraft({ text: 'newer plan', actionType: 'say' }) })).toBe('none');
	});
});

describe('server turn start', () => {
	type Run = { id: string; gameId: string; clientTurnId: string; status: string };
	const run = (status: string, clientTurnId = 'turn_1'): Run => ({ id: 'run_1', gameId: 'game_a', clientTurnId, status });

	function harness(overrides: Partial<Parameters<typeof startServerTurn<Run>>[0]> = {}) {
		let selected = true;
		const calls = { start: [] as unknown[], current: [] as string[] };
		const input: Parameters<typeof startServerTurn<Run>>[0] = {
			serverStoryId: 'game_a',
			clientTurnId: 'turn_1',
			stillSelected: () => selected,
			prepare: async () => ({ serverStoryId: 'game_a', serverVersion: 12 }),
			start: async request => { calls.start.push(request); return run('running'); },
			current: async storyId => { calls.current.push(storyId); return null; },
			...overrides,
		};
		return { input, calls, deselect: () => { selected = false; } };
	}

	it('starts one run against the prepared server version', async () => {
		const { input, calls } = harness();
		await expect(startServerTurn(input)).resolves.toEqual({ kind: 'run', run: run('running'), restoreDraft: false, storyChanged: false });
		expect(calls.start).toEqual([{ storyId: 'game_a', localVersion: 12, clientTurnId: 'turn_1' }]);
	});

	it('restores the draft when the server rejects the run immediately', async () => {
		const { input } = harness({ start: async () => run('failed') });
		await expect(startServerTurn(input)).resolves.toMatchObject({ kind: 'run', restoreDraft: true });
	});

	it('reports a story switch so the run is not shown in another story', async () => {
		const h = harness();
		h.input.start = async () => { h.deselect(); return run('running'); };
		await expect(startServerTurn(h.input)).resolves.toMatchObject({ kind: 'run', storyChanged: true, restoreDraft: false });
	});

	it('recovers an accepted run by client turn ID instead of sending the move again', async () => {
		const h = harness({
			start: async request => { h.calls.start.push(request); throw new Error('connection reset'); },
			current: async () => run('running'),
		});
		await expect(startServerTurn(h.input)).resolves.toMatchObject({ kind: 'run', run: { clientTurnId: 'turn_1' }, restoreDraft: false });
		expect(h.calls.start).toHaveLength(1);
	});

	it('fails without adopting another turn that happens to be active', async () => {
		const error = new Error('connection reset');
		const { input } = harness({ start: async () => { throw error; }, current: async () => run('running', 'other_turn') });
		await expect(startServerTurn(input)).resolves.toEqual({ kind: 'failed', error, storyChanged: false });
	});

	it('does not start a run when pending edits cannot be synced first', async () => {
		const error = new Error('Resolve backend sync conflicts before submitting another backend turn.');
		const { input, calls } = harness({ prepare: async () => { throw error; } });
		await expect(startServerTurn(input)).resolves.toEqual({ kind: 'failed', error, storyChanged: false });
		expect(calls.start).toEqual([]);
	});

	it('keeps the original failure when the recovery lookup also fails', async () => {
		const error = new Error('Terminal request failed: 503');
		const { input } = harness({ start: async () => { throw error; }, current: async () => { throw new Error('offline'); } });
		await expect(startServerTurn(input)).resolves.toEqual({ kind: 'failed', error, storyChanged: false });
	});
});
