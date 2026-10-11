import { headerTimeProposal, parseWorldTimeLabel, type WorldClockState } from '$lib/server/events/worldClock';
import { parseNarrationSceneAnchor } from './patchValidator';

/**
 * A turn's first line carries its time and place ("[ 🕰️ Time 09:42 | 🗓️ Day … | 📍 … ]").
 * The world clock and the scene location are proposed from it. When the narrator leaves it
 * out, the server asks the Classifier role for that one line; the clock still validates it.
 */

const MAX_HEADER_CHARS = 400;
const MAX_NARRATION_CHARS = 6000;

/** The header's time as the clock would read it, or null when there is no usable time. */
function headerTime(text: string): string | null {
	const time = parseNarrationSceneAnchor(text)?.currentWorldTime ?? null;
	return time && parseWorldTimeLabel(time).precision !== 'unknown' ? time : null;
}

export function narrationHasSceneHeader(narration: string): boolean {
	return headerTime(narration) !== null;
}

/** The newest narrated header in the transcript, verbatim. */
export function latestSceneHeader(entries: ReadonlyArray<{ type: string; content: string }>): string | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== 'narration' || !narrationHasSceneHeader(entry.content)) continue;
		return entry.content.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
	}
	return null;
}

export function buildSceneHeaderRequest(input: {
	previousHeader: string | null;
	clockLabel: string | null;
	location: string | null;
	playerText: string;
	narration: string;
}): { system: string; prompt: string } {
	const narration = input.narration.length > MAX_NARRATION_CHARS
		? `${input.narration.slice(0, MAX_NARRATION_CHARS / 2)}\n[…]\n${input.narration.slice(-MAX_NARRATION_CHARS / 2)}`
		: input.narration;
	return {
		system: [
			'You write the scene header for one turn of an interactive story. Reply with exactly one line and nothing else.',
			'Use the format of the previous header when there is one; otherwise use: [ 🕰️ Time HH:MM | 🗓️ <day> | 📍 <location> | [Weather] <weather> ].',
			'The time is when this passage ends. It never goes backwards: a short exchange takes a few minutes; travel, sleep or waiting take as long as the passage shows.',
			'Keep the day text and the location unless the passage moves to a new day or place. Write a new day in the same style as the previous one.',
		].join('\n'),
		prompt: [
			`Previous header: ${input.previousHeader ?? '(none)'}`,
			`Current story time: ${input.clockLabel ?? 'unknown'}`,
			`Current location: ${input.location ?? 'unknown'}`,
			'',
			`Player action:\n${input.playerText.trim()}`,
			'',
			`Passage:\n${narration.trim()}`,
		].join('\n'),
	};
}

export interface SceneHeaderService {
	profile: unknown | null;
	setting?: { enabled?: boolean } | null;
	missingReason?: string | null;
}

export interface SceneHeaderOutcome {
	narration: string;
	receipt: { source: 'server_extracted'; model: string | null } | null;
	warning: string | null;
}

/**
 * Make sure a saved turn carries a usable time header. Only time-tracked stories (the clock has a
 * label) on primary-scene, in-world turns qualify; the header is added only after the clock
 * would accept it. Failures leave the narration unchanged with a warning; cancellation rethrows.
 */
export async function ensureSceneHeader<Service extends SceneHeaderService>(input: {
	narration: string;
	eligible: boolean;
	storyLabel: string | null;
	previousEntries: ReadonlyArray<{ type: string; content: string }>;
	location: string | null;
	playerText: string;
	signal?: AbortSignal;
}, deps: {
	resolve: () => Promise<Service>;
	generate: (request: { system: string; prompt: string }, service: Service) => Promise<{ text: string; model?: string | null }>;
	loadClock: () => Promise<WorldClockState>;
}): Promise<SceneHeaderOutcome> {
	const unchanged = (warning: string | null = null): SceneHeaderOutcome => ({ narration: input.narration, receipt: null, warning });
	if (!input.eligible || !input.storyLabel || !input.narration.trim() || narrationHasSceneHeader(input.narration)) return unchanged();
	const service = await deps.resolve();
	if (service.setting?.enabled === false) return unchanged();
	if (!service.profile) return unchanged(`The narration had no time header and none could be written: ${service.missingReason ?? 'no model profile'}`);
	try {
		const result = await deps.generate(buildSceneHeaderRequest({ previousHeader: latestSceneHeader(input.previousEntries),
			clockLabel: input.storyLabel, location: input.location, playerText: input.playerText, narration: input.narration }), service);
		const accepted = acceptSceneHeader(result.text, await deps.loadClock());
		if ('rejected' in accepted) return unchanged(`The narration had no time header and the written one was not used (${accepted.rejected}).`);
		return { narration: `${accepted.header}\n${input.narration}`, receipt: { source: 'server_extracted', model: result.model ?? null }, warning: null };
	} catch (error) {
		if (input.signal?.aborted) throw error;
		return unchanged(`The narration had no time header and none could be written: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Accept a model-written header only when it parses and the clock would not reject it. */
export function acceptSceneHeader(output: string, clock: WorldClockState): { header: string } | { rejected: string } {
	const header = output.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.replace(/^`+|`+$/g, '').trim() ?? '';
	if (!header.startsWith('[') || !header.endsWith(']') || header.length > MAX_HEADER_CHARS) return { rejected: 'not_a_header_line' };
	const time = headerTime(header);
	if (!time) return { rejected: 'no_time_in_header' };
	const proposal = headerTimeProposal(clock, time);
	if (proposal && 'rejected' in proposal) return { rejected: proposal.rejected };
	return { header };
}
