/**
 * A time skip the narrator has not yet played past. When the World Chronicle advances the clock,
 * the previous scene ended at the old time; until a narration is written after the change, every
 * turn tells the narrator how much time passed and that the scene must reopen after the gap.
 */
export interface PendingTimeSkip {
	changeId: string;
	/** The chronicle job that advanced the clock, for the happenings written in the gap. */
	jobId: string | null;
	span: string | null;
	days: number | null;
	appliedMinutes: number;
	beforeLabel: string | null;
	afterLabel: string | null;
	reason: string;
	createdAt: string;
}

export interface ClockChangeRow {
	id: string;
	status: string;
	proposer: string;
	opKey: string;
	appliedMinutes: number | null;
	beforeLabel: string | null;
	afterLabel: string | null;
	reason: string;
	metadata: Record<string, unknown> | null;
	createdAt: string;
}

interface EntryRow { type: string; metadata?: Record<string, unknown> | null; createdAt: string }
interface EventRow { type: string; status: string; visibility: string; title: string; body: string; worldTime: string | null; metadata: Record<string, unknown> | null }

const CHRONICLE_OP_PREFIX = 'world-chronicle:';
const MINUTES_PER_DAY = 24 * 60;
const HAPPENING_LIMIT = 6;

function isInCharacterNarration(entry: EntryRow): boolean {
	if (entry.type !== 'narration') return false;
	const metadata = entry.metadata ?? {};
	return metadata.nonCanon !== true && metadata.actionType !== 'ooc' && metadata.narrativeMode !== 'ooc';
}

/** The latest chronicle clock change, unless an in-character narration has been written since it. */
export function pendingTimeSkip(change: ClockChangeRow | null | undefined, entries: EntryRow[]): PendingTimeSkip | null {
	if (!change || change.status !== 'applied' || change.proposer !== 'world_chronicle' || !((change.appliedMinutes ?? 0) > 0)) return null;
	const changedAt = Date.parse(change.createdAt);
	if (!Number.isFinite(changedAt)) return null;
	if (entries.some(entry => isInCharacterNarration(entry) && Date.parse(entry.createdAt) >= changedAt)) return null;
	const metadata = change.metadata ?? {};
	return {
		changeId: change.id,
		jobId: change.opKey.startsWith(CHRONICLE_OP_PREFIX) ? change.opKey.slice(CHRONICLE_OP_PREFIX.length) : null,
		span: typeof metadata.span === 'string' ? metadata.span : null,
		days: typeof metadata.days === 'number' && Number.isFinite(metadata.days) ? metadata.days : null,
		appliedMinutes: change.appliedMinutes ?? 0,
		beforeLabel: change.beforeLabel,
		afterLabel: change.afterLabel,
		reason: change.reason,
		createdAt: change.createdAt,
	};
}

/** "one week (7 days)", or the day count when the span was not recorded. */
export function timeSkipLength(skip: Pick<PendingTimeSkip, 'span' | 'days' | 'appliedMinutes'>): string {
	if (skip.span === 'day') return 'one day';
	if (skip.span === 'week') return 'one week (7 days)';
	if (skip.span === 'season') return 'one season (90 days)';
	const days = skip.days ?? Math.round(skip.appliedMinutes / MINUTES_PER_DAY);
	return days === 1 ? 'one day' : `${days} days`;
}

/**
 * The narrator's time-skip notice: how long passed, the clock labels, how to reopen the scene,
 * and the gap's accepted public happenings as news the character may have heard.
 */
export function renderTimeSkipNotice(skip: PendingTimeSkip, events: EventRow[], capture?: (kind: string, id: string, text: string) => string): string {
	const news = events.filter(event => event.type === 'world_happening' && event.status === 'committed' && event.visibility === 'public'
		&& skip.jobId !== null && (event.metadata ?? {}).chronicleJobId === skip.jobId).slice(0, HAPPENING_LIMIT);
	const text = [
		`Time skip: ${timeSkipLength(skip)} passed off-screen since the last narrated scene${skip.beforeLabel || skip.afterLabel ? ` (the clock moved from ${skip.beforeLabel ?? 'the previous time'} to ${skip.afterLabel ?? 'now'})` : ''}.`,
		'That scene is over. Do not resume its last moment or answer as if no time had passed. Open this turn after the gap: in a sentence or two, establish the new time, where the player character now is, and what changed for them in the interval (journeys completed, wounds healed or not, waits ended), then let the player action happen in that new moment. Keep everyone\'s plans, injuries and whereabouts consistent with the time elapsed. What happened during the gap stays unnarrated except as consequence or news.',
		news.length ? `Public happenings of the gap that may have reached the character as news (report or consequence, never witnessed):\n${news.map(event =>
			`- ${event.title}: ${event.body}${event.worldTime ? ` (${event.worldTime})` : ''}`).join('\n')}` : '',
	].filter(Boolean).join('\n');
	return capture?.('requiredScene', `timeskip:${skip.changeId}`, text) ?? text;
}
