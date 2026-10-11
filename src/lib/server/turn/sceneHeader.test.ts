import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_CALENDAR, parseWorldTimeLabel, type WorldClockState } from '$lib/server/events/worldClock';
import { parseNarrationSceneAnchor } from './patchValidator';
import { acceptSceneHeader, buildSceneHeaderRequest, ensureSceneHeader, latestSceneHeader, narrationHasSceneHeader } from './sceneHeader';

function clock(label: string | null): WorldClockState {
	const parsed = parseWorldTimeLabel(label);
	return { storyId: 'story_1', branch: 'primary', minutes: parsed.minutes, precision: parsed.precision, calendar: DEFAULT_WORLD_CALENDAR,
		anchor: parsed.anchor, label, revision: 3, persisted: true };
}

const veilHeader = "[ 🕰️ 09:50 | 🗓️ Day Eighth Moon 11, 301 AC | 📍 The Crownlands — King's Landing, the Outer Yard | [Weather] Grey overcast ]";

describe('scene headers', () => {
	it('reads unlabelled headers by content instead of field position', () => {
		expect(parseNarrationSceneAnchor('[Day 3 | 09:42 | Harbor]\nThe ferry docks.')).toEqual({ currentWorldTime: 'Day 3 | 09:42', location: 'Harbor' });
		expect(parseNarrationSceneAnchor(`${veilHeader}\nThe yard is busy.`)).toEqual({
			currentWorldTime: 'Day Eighth Moon 11, 301 AC | 09:50', location: "The Crownlands — King's Landing, the Outer Yard" });
	});

	it('detects a missing header and finds the newest narrated one', () => {
		expect(narrationHasSceneHeader('"Come, little dove. Step closer with me."')).toBe(false);
		expect(narrationHasSceneHeader(`${veilHeader}\nPassage.`)).toBe(true);
		expect(latestSceneHeader([
			{ type: 'narration', content: '[ 🕰️ 08:40 | 🗓️ Day Eighth Moon 11, 301 AC | 📍 The Solar ]\nOlder.' },
			{ type: 'narration', content: `${veilHeader}\nNewer.` },
			{ type: 'user_action', content: '[not a header | at all | here]' },
			{ type: 'narration', content: 'A passage without a header.' },
		])).toBe(veilHeader);
		expect(latestSceneHeader([{ type: 'narration', content: 'No header.' }])).toBeNull();
	});

	it('asks for one line continuing the previous header and bounds long passages', () => {
		const request = buildSceneHeaderRequest({ previousHeader: veilHeader, clockLabel: 'Day Eighth Moon 11, 301 AC | 09:50',
			location: 'Outer Yard', playerText: 'I fly us to Dragonstone.', narration: 'Wind. '.repeat(3000) });
		expect(request.system).toContain('exactly one line');
		expect(request.system).toContain('never goes backwards');
		expect(request.prompt).toContain(`Previous header: ${veilHeader}`);
		expect(request.prompt).toContain('I fly us to Dragonstone.');
		expect(request.prompt.length).toBeLessThan(7000);
	});

	describe('at turn save', () => {
		const later = "[ 🕰️ 13:15 | 🗓️ Day Eighth Moon 11, 301 AC | 📍 Dragonstone — the Dragonmont | [Weather] Wind ]";
		const base = { narration: '"Come, little dove. Step closer with me."', eligible: true, storyLabel: 'Day Eighth Moon 11, 301 AC | 09:50',
			previousEntries: [{ type: 'narration', content: `${veilHeader}\nThe yard.` }], location: 'Outer Yard', playerText: 'I fly us to Dragonstone.' };
		const deps = (text: string | Error, profile: unknown = { providerType: 'openrouter' }, enabled = true) => {
			const calls: Array<{ system: string; prompt: string }> = [];
			return {
				calls,
				deps: {
					resolve: async () => ({ profile, setting: { enabled }, missingReason: 'Model configuration needed: Classifier has no model profile.' }),
					generate: async (request: { system: string; prompt: string }) => { calls.push(request); if (text instanceof Error) throw text; return { text, model: 'cheap-classifier' }; },
					loadClock: async () => clock(base.storyLabel),
				},
			};
		};

		it('prepends an accepted header written from the passage', async () => {
			const { calls, deps: injected } = deps(later);
			await expect(ensureSceneHeader(base, injected)).resolves.toEqual({
				narration: `${later}\n${base.narration}`, receipt: { source: 'server_extracted', model: 'cheap-classifier' }, warning: null });
			expect(calls).toHaveLength(1);
			expect(calls[0].prompt).toContain(veilHeader);
		});

		it('makes no request when the turn already has a header, is not eligible, or the story keeps no time', async () => {
			for (const input of [{ ...base, narration: `${later}\nPassage.` }, { ...base, eligible: false }, { ...base, storyLabel: null }]) {
				const { calls, deps: injected } = deps(later);
				await expect(ensureSceneHeader(input, injected)).resolves.toMatchObject({ narration: input.narration, receipt: null, warning: null });
				expect(calls).toHaveLength(0);
			}
		});

		it('keeps the narration unchanged, with a reason, when the header cannot be used', async () => {
			const rewind = deps(later.replace('13:15', '08:00'));
			await expect(ensureSceneHeader(base, rewind.deps)).resolves.toMatchObject({ narration: base.narration, receipt: null,
				warning: expect.stringContaining('header_time_earlier_than_clock') });
			const failed = deps(new Error('Server LLM request timed out'));
			await expect(ensureSceneHeader(base, failed.deps)).resolves.toMatchObject({ narration: base.narration, warning: expect.stringContaining('timed out') });
			const unconfigured = deps(later, null);
			await expect(ensureSceneHeader(base, unconfigured.deps)).resolves.toMatchObject({ narration: base.narration, warning: expect.stringContaining('Model configuration needed') });
			expect(unconfigured.calls).toHaveLength(0);
			const disabled = deps(later, { providerType: 'openrouter' }, false);
			await expect(ensureSceneHeader(base, disabled.deps)).resolves.toEqual({ narration: base.narration, receipt: null, warning: null });
		});

		it('rethrows when the turn was cancelled', async () => {
			const controller = new AbortController();
			controller.abort();
			const cancelled = deps(new Error('aborted'));
			await expect(ensureSceneHeader({ ...base, signal: controller.signal }, cancelled.deps)).rejects.toThrow('aborted');
		});
	});

	it('accepts a header only when the clock would apply it', () => {
		const current = clock('Day Eighth Moon 11, 301 AC | 09:50');
		const later = "[ 🕰️ 13:15 | 🗓️ Day Eighth Moon 11, 301 AC | 📍 Dragonstone — the Dragonmont | [Weather] Wind ]";
		expect(acceptSceneHeader(`\`${later}\`\n`, current)).toEqual({ header: later });
		expect(acceptSceneHeader(later.replace('13:15', '09:10'), current)).toEqual({ rejected: 'header_time_earlier_than_clock' });
		expect(acceptSceneHeader('The time is now 13:15.', current)).toEqual({ rejected: 'not_a_header_line' });
		expect(acceptSceneHeader('[ Dragonstone | the Dragonmont | Wind ]', current)).toEqual({ rejected: 'no_time_in_header' });
		// An unchanged time is still a valid header; it just moves nothing.
		expect(acceptSceneHeader(veilHeader, current)).toEqual({ header: veilHeader });
	});
});
