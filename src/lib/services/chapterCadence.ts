import { isNarrativeCommandInput, isNarrativeControlInput } from './ai/context/controlInput';
import { isParallelPovEntry } from './ai/context/parallelPov';

export const CHAPTER_TURN_COUNT = 20;
export const CHAPTERS_PER_ARC = 10;

/** Arc numbers label saved summaries; actual chapter coverage defines the next window.
 * Reviewed backfills may contain fewer chapters than the normal cadence. */
export function selectArcRollupBatches<T extends { id: string }>(
	chapterRows: T[],
	arcRows: Array<{ chapterIds: string[] }>,
	chaptersPerArc: number = CHAPTERS_PER_ARC,
): T[][] {
	if (!Number.isInteger(chaptersPerArc) || chaptersPerArc < 1) return [];
	const covered = new Set(arcRows.flatMap(arc => arc.chapterIds));
	const uncovered = chapterRows.filter(chapter => !covered.has(chapter.id));
	const batches: T[][] = [];
	for (let index = 0; index + chaptersPerArc <= uncovered.length; index += chaptersPerArc) {
		const batch = uncovered.slice(index, index + chaptersPerArc);
		const numbers = batch.map(chapter => (chapter as T & { number?: unknown }).number);
		if (numbers.every(number => typeof number === 'number') && numbers.some((number, offset) => offset > 0 && Number(number) !== Number(numbers[offset - 1]) + 1)) break;
		batches.push(batch);
	}
	return batches;
}

// Retain the wire keys for older clients; their former entry counts are no longer configurable.
export const FIXED_CHAPTER_SETTINGS = {
	chapterThreshold: CHAPTER_TURN_COUNT,
	postChapterBuffer: 0,
	chaptersPerArc: CHAPTERS_PER_ARC,
} as const;

export type ChapterSourceEntry = {
	id: string;
	type: string;
	content: string;
	position: number;
	parentId?: string | null;
	branchId?: string | null;
	metadata?: unknown;
};

function isNarrativeSource(entry: ChapterSourceEntry): boolean {
	const metadata = entry.metadata && typeof entry.metadata === 'object'
		? entry.metadata as Record<string, unknown> : {};
	if (metadata.nonCanon === true || metadata.actionType === 'ooc' || metadata.narrativeMode === 'ooc') return false;
	if (entry.type === 'narration') return Boolean(entry.content.trim());
	return entry.type === 'user_action' && Boolean(entry.content.trim())
		&& !isNarrativeControlInput(entry.content)
		&& (!isNarrativeCommandInput(entry.content) || isParallelPovEntry(entry));
}

function narrativeSources<T extends ChapterSourceEntry>(entries: T[], branchId: string | null): T[] {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const branch = (value: string | null | undefined) => !value || value === 'main' || value === 'primary' ? null : value;
	return entries.filter(entry => {
		if (branch(entry.branchId) !== branch(branchId) || !isNarrativeSource(entry)) return false;
		const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
		// A GM correction can produce accepted story narration. Its action is not a turn,
		// but the narration remains evidence unless its own metadata marks it non-canon/OOC.
		return !parent || branch(parent.branchId) === branch(branchId);
	}).sort((a, b) => a.position - b.position);
}

/** A turn completes with its saved narration, not with a submitted action or an OOC exchange. */
export function selectCompletedChapterTurns<T extends ChapterSourceEntry>(entries: T[], branchId: string | null = null): Array<{ player: T; narration: T }> {
	const sources = narrativeSources(entries, branchId);
	const byId = new Map(sources.map(entry => [entry.id, entry]));
	const byPlayer = new Map<string, { player: T; narration: T }>();
	for (const narration of sources) {
		if (narration.type !== 'narration' || !narration.parentId) continue;
		const player = byId.get(narration.parentId);
		if (!player || player.type !== 'user_action' || player.position >= narration.position) continue;
		// A second saved response cannot move an already completed turn into a later chapter.
		if (!byPlayer.has(player.id)) byPlayer.set(player.id, { player, narration });
	}
	return [...byPlayer.values()].sort((a, b) => a.narration.position - b.narration.position);
}

/** Pass every source row after the previous chapter; filtering first can sever /pov pairs. */
export function selectNextChapterWindow<T extends ChapterSourceEntry>(entries: T[], branchId: string | null = null) {
	const turns = selectCompletedChapterTurns(entries, branchId).slice(0, CHAPTER_TURN_COUNT);
	if (turns.length < CHAPTER_TURN_COUNT) return null;
	const endPosition = turns[turns.length - 1].narration.position;
	const pairedIds = new Set(turns.flatMap(turn => [turn.player.id, turn.narration.id]));
	// Opening narration and other unpaired narrative evidence remain in the summary's source range.
	// An interleaved action with no completed response belongs to its later turn, never this window.
	const sources = narrativeSources(entries, branchId).filter(entry => entry.position <= endPosition
		&& (entry.type === 'narration' || pairedIds.has(entry.id)));
	return {
		entries: sources,
		turns,
		startPosition: sources[0].position,
		endPosition,
		unmatchedEntryIds: sources.filter(entry => !pairedIds.has(entry.id)).map(entry => entry.id),
	};
}
