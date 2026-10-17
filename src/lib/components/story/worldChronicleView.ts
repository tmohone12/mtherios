import type { WorldChronicleEvent } from '$lib/contracts/worldChronicle';
import type { BackendWorldChronicleAdvanceResult } from '$lib/services/backendMemory';

/** Display decisions for the World drawer's World Chronicle section (WorldChroniclePanel.svelte). */

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function formatDays(days: number, minutes: number): string {
	if (days > 0) {
		const rounded = Math.round(days * 100) / 100;
		return `${rounded} ${rounded === 1 ? 'day' : 'days'}`;
	}
	return minutes > 0 ? plural(minutes, 'minute') : '0 days';
}

/** One line after "Advance the world": "3 happenings proposed, 2 auto-accepted; the clock moved 7 days". */
export function describeChronicleOutcome(outcome: BackendWorldChronicleAdvanceResult): { tone: 'info' | 'error'; text: string } {
	if (outcome.error) {
		if (outcome.status === 'running') return { tone: 'info', text: 'A batch for this span is already running; it appears here when it finishes.' };
		return { tone: 'error', text: `The world could not advance: ${outcome.error}` };
	}
	if (outcome.alreadyComplete) return { tone: 'info', text: 'This batch was already written.' };
	const parts: string[] = [];
	if (outcome.proposed > 0) parts.push(`${plural(outcome.proposed, 'happening')} proposed`);
	if (outcome.autoAccepted > 0) parts.push(outcome.proposed > 0 ? `${outcome.autoAccepted} auto-accepted` : `${plural(outcome.autoAccepted, 'happening')} auto-accepted`);
	const happened = parts.length ? parts.join(', ') : 'No new happenings';
	const skipped = [
		outcome.skippedDuplicates ? `${outcome.skippedDuplicates} duplicate${outcome.skippedDuplicates === 1 ? '' : 's'} skipped` : '',
		outcome.dropped ? `${outcome.dropped} dropped in review` : '',
	].filter(Boolean).join(', ');
	const clock = outcome.clockAdvancedMinutes > 0
		? `the clock moved ${formatDays(outcome.clockAdvancedDays, outcome.clockAdvancedMinutes)}`
		: `the clock did not move${outcome.clockReason ? ` (${outcome.clockReason.replaceAll('_', ' ')})` : ''}`;
	return { tone: 'info', text: `${happened}${skipped ? ` (${skipped})` : ''}; ${clock}.` };
}

export interface ChronicleEntryView {
	event: WorldChronicleEvent;
	kind: string | null;
	stakes: string | null;
	where: string | null;
	factions: string[];
	reach: string | null;
	seed: string | null;
	visibility: string;
	stakesRaised: boolean;
}

const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

export function chronicleEntryView(event: WorldChronicleEvent): ChronicleEntryView {
	const metadata = event.metadata ?? {};
	const seed = metadata.seed && typeof metadata.seed === 'object' ? metadata.seed as Record<string, unknown> : {};
	const seedType = text(seed.type);
	const seedRef = text(seed.ref);
	return {
		event,
		kind: text(metadata.kind),
		stakes: text(metadata.stakes),
		where: text(metadata.whereName),
		factions: stringList(metadata.factionNames),
		reach: text(metadata.reach),
		seed: seedType ? (seedType === 'new' ? `new${seedRef ? `: ${seedRef}` : ''}` : `${seedType.replace('_', ' ')}${seedRef ? `: ${seedRef}` : ''}`) : null,
		visibility: event.visibility === 'player_known' ? 'regional' : event.visibility,
		stakesRaised: metadata.stakesRaised === true,
	};
}

export interface ChronicleGroup { key: string; label: string; entries: ChronicleEntryView[] }

/** Entries grouped by in-world day (or the date the batch was written), newest first; dismissed ones only on request. */
export function groupChronicleEvents(events: WorldChronicleEvent[], showDismissed: boolean): ChronicleGroup[] {
	const groups: ChronicleGroup[] = [];
	const byKey = new Map<string, ChronicleGroup>();
	for (const event of events) {
		if (event.status === 'cancelled' && !showDismissed) continue;
		const created = event.createdAt ? event.createdAt.slice(0, 10) : '';
		const key = event.worldTime?.trim() || `written:${created}`;
		let group = byKey.get(key);
		if (!group) {
			group = { key, label: event.worldTime?.trim() || (created ? `Written ${created}` : 'Undated'), entries: [] };
			byKey.set(key, group);
			groups.push(group);
		}
		group.entries.push(chronicleEntryView(event));
	}
	return groups;
}

export function dismissedChronicleCount(events: WorldChronicleEvent[]): number {
	return events.filter(event => event.status === 'cancelled').length;
}
