import type { StrategicWorldFrame } from '$lib/types';
import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import { isPlotBrainFrameFresh } from './plotBrainFreshness';

export function appliedStrategicFrameForStory(
	storyIdValue: unknown,
	currentTurn: unknown,
	metadataValue: unknown,
): StrategicWorldFrame | null {
	if (typeof currentTurn !== 'number' || !Number.isFinite(currentTurn)) return null;
	if (!metadataValue || typeof metadataValue !== 'object' || Array.isArray(metadataValue)) return null;
	const plotBrain = (metadataValue as { plotBrain?: unknown }).plotBrain;
	if (!plotBrain || typeof plotBrain !== 'object' || Array.isArray(plotBrain) || !isPlotBrainFrameFresh(plotBrain, currentTurn)) return null;
	return storedStrategicFrameForStory(storyIdValue, metadataValue);
}

/** Stored history for the Director UI; narration must use the freshness-gated helper. */
export function storedStrategicFrameForStory(storyIdValue: unknown, metadataValue: unknown): StrategicWorldFrame | null {
	if (typeof storyIdValue !== 'string' || !storyIdValue.trim()) return null;
	if (!metadataValue || typeof metadataValue !== 'object' || Array.isArray(metadataValue)) return null;
	const plotBrain = (metadataValue as { plotBrain?: unknown }).plotBrain;
	if (!plotBrain || typeof plotBrain !== 'object' || Array.isArray(plotBrain)) return null;
	const parsed = strategicWorldFrameSchema.safeParse((plotBrain as { lastFrame?: unknown }).lastFrame);
	if (!parsed.success) return null;
	const lastFrameId = (plotBrain as { lastFrameId?: unknown }).lastFrameId;
	return lastFrameId === parsed.data.id && parsed.data.storyId === storyIdValue.trim()
		? filterClosedStrategicCards(parsed.data as unknown as StrategicWorldFrame, metadataValue)
		: null;
}

export function filterClosedStrategicCards(frame: StrategicWorldFrame, metadataValue: unknown): StrategicWorldFrame {
	const metadata = metadataValue && typeof metadataValue === 'object' && !Array.isArray(metadataValue)
		? metadataValue as { plotBrain?: { closedThreadIds?: unknown }; deletedCommitments?: Record<string, unknown> }
		: {};
	const plotBrain = metadata.plotBrain;
	const closedIds = plotBrain?.closedThreadIds;
	const closed = new Set(Array.isArray(closedIds) ? closedIds : []);
	const deleted = metadata.deletedCommitments ?? {};
	return normalizeStrategicFrameActivations({ ...frame, plotCards: frame.plotCards.filter(card => !closed.has(card.storyThreadId)
		&& !card.sourceRefs.some(ref => (ref.sourceType === 'thread' && closed.has(ref.sourceId)) || Object.hasOwn(deleted, `${ref.sourceType}:${ref.sourceId}`))) });
}

export function appliedStrategicFrameFromProjection(projection: unknown): StrategicWorldFrame | null {
	if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return null;
	const projectionStory = (projection as { story?: unknown }).story;
	if (!projectionStory || typeof projectionStory !== 'object' || Array.isArray(projectionStory)) return null;
	return appliedStrategicFrameForStory(
		(projectionStory as { id?: unknown }).id,
		(projectionStory as { currentTurn?: unknown }).currentTurn,
		(projectionStory as { metadata?: unknown }).metadata,
	);
}

function compact(value: string | null | undefined, max = 1400): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
}

function compactBlock(value: string, max: number): string {
	const text = value.split(/\r?\n/u).map(line => compact(line, max)).filter(Boolean).join('\n');
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
}

function activationKey(value: string | null | undefined): string {
	return (value ?? '').trim().toLowerCase();
}

interface ActivationFrame {
	plotCards: Array<{
		id: string;
		title: string;
		storyThreadId?: string | null;
		sourceRefs?: Array<{ sourceType: string; sourceId?: string | null }>;
	}>;
	activationPlan: {
		activateNow: string[];
		keepDormant?: string[];
		retireOrMerge?: string[];
	};
}

function resolvedActivationPlan(frame: ActivationFrame): Required<ActivationFrame['activationPlan']> {
	const aliases = new Map<string, string | null>();
	for (const card of frame.plotCards ?? []) {
		const id = card.id.trim() || card.title.trim();
		if (!id) continue;
		const values = [
			card.id,
			card.title,
			card.storyThreadId,
			...(card.sourceRefs ?? []).filter(ref => ref.sourceType === 'thread').map(ref => ref.sourceId),
		];
		for (const value of values) {
			const key = activationKey(value);
			if (!key) continue;
			aliases.set(key, aliases.has(key) && aliases.get(key) !== id ? null : id);
		}
	}
	const resolve = (values: string[]) => [...new Set(values
		.map(value => aliases.get(activationKey(value)))
		.filter((value): value is string => Boolean(value)))];
	return {
		activateNow: resolve(frame.activationPlan.activateNow),
		keepDormant: resolve(frame.activationPlan.keepDormant ?? []),
		retireOrMerge: resolve(frame.activationPlan.retireOrMerge ?? []),
	};
}

export function hasResolvedStrategicFrameActivation(frame: ActivationFrame): boolean {
	return resolvedActivationPlan(frame).activateNow.length > 0;
}

export function normalizeStrategicFrameActivations(frame: StrategicWorldFrame): StrategicWorldFrame {
	return {
		...frame,
		activationPlan: {
			...frame.activationPlan,
			...resolvedActivationPlan(frame),
		},
	};
}

function activePlotCards(frame: StrategicWorldFrame, limit = 5): StrategicWorldFrame['plotCards'] {
	const normalized = normalizeStrategicFrameActivations(frame);
	const activeIds = new Set(normalized.activationPlan.activateNow.map(activationKey));
	return normalized.plotCards
		.filter(card => card.lifecycleStage !== 'resolved'
			&& card.lifecycleStage !== 'dormant'
			&& (activeIds.has(activationKey(card.id)) || activeIds.has(activationKey(card.title))))
		.sort((a, b) => b.pressure - a.pressure)
		.slice(0, limit);
}

const cueStopWords = new Set(['about', 'after', 'again', 'before', 'city', 'could', 'from', 'hall', 'have', 'house', 'into', 'just', 'more', 'some', 'that', 'their', 'them', 'there', 'these', 'this', 'they', 'what', 'when', 'where', 'which', 'with', 'would']);
const cueWords = (value: string) => new Set((value.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter(word => !cueStopWords.has(word)));

/** Choose one sourced, observable development only when the player's action touches it. */
export function selectStrategicSceneCue(frame: StrategicWorldFrame | null | undefined, input: {
	playerAction: string;
	locationId?: string | null;
	actorIds?: readonly string[];
	usedSourceKeys?: readonly string[];
	scheduledEventIds?: readonly string[];
	sceneAlreadyUsed?: boolean;
}): { cardId: string; sourceKey: string; mode: 'ambient' | 'direct' } | null {
	if (!frame) return null;
	const actionWords = cueWords(input.playerAction);
	if (!actionWords.size) return null;
	const canonicalCueKey = (key: string) => key.replace(/^event:/, 'world_event:');
	const used = new Set((input.usedSourceKeys ?? []).map(canonicalCueKey));
	const scheduled = new Set(input.scheduledEventIds ?? []);
	const explicit = /\b(?:ask|who|why|how|investigat\w*|explain|learn|find out)\b/i.test(input.playerAction);
	if (input.sceneAlreadyUsed && !explicit) return null;
	const candidates = activePlotCards(frame, frame.plotCards.length).flatMap(card => {
		if (card.visibility === 'secret') return [];
		if (!explicit && card.sourceRefs.some(ref => ref.sourceType === 'world_event'
			&& ref.sourceId && scheduled.has(ref.sourceId))) return [];
		const sourceOrder = ['world_event', 'event', 'agreement', 'entry', 'rumor'];
		const rank = (type: string) => { const index = sourceOrder.indexOf(type); return index < 0 ? sourceOrder.length : index; };
		const source = card.sourceRefs.filter(ref => ref.sourceId && sourceOrder.includes(ref.sourceType)).sort((a, b) =>
			rank(a.sourceType) - rank(b.sourceType)
			|| String(a.sourceId).localeCompare(String(b.sourceId)))[0];
		const sourceKey = source?.sourceId ? `${source.sourceType}:${source.sourceId}` : '';
		if (!sourceKey || used.has(canonicalCueKey(sourceKey)) && !explicit) return [];
		const topic = cueWords([card.title, card.logline, ...card.playerTouchpoints].join(' '));
		const topicalHits = [...actionWords].filter(word => topic.has(word)).length;
		const touchpoints = cueWords(card.playerTouchpoints.join(' '));
		if (!topicalHits || (!explicit && topicalHits < 2 && ![...actionWords].some(word => touchpoints.has(word)))) return [];
		const local = Boolean(input.locationId && card.locationIds.includes(input.locationId));
		const actor = [...card.actorEntityIds, ...card.targetEntityIds].some(id => input.actorIds?.includes(id));
		const direct = explicit && (topicalHits > 0 || actor);
		// A remote card needs a specific player inquiry; locality or an involved actor
		// is still insufficient without a match to the current action.
		if (!local && !actor && !direct) return [];
		return [{ cardId: card.id, sourceKey, mode: direct ? 'direct' as const : 'ambient' as const,
			score: topicalHits * 10 + Number(local) * 4 + Number(actor) * 3 + (direct ? 2 : 0) }];
	});
	const best = candidates.sort((a, b) => b.score - a.score || a.cardId.localeCompare(b.cardId))[0];
	return best ? { cardId: best.cardId, sourceKey: best.sourceKey, mode: best.mode } : null;
}

function antagonistForCard(frame: StrategicWorldFrame, card: StrategicWorldFrame['plotCards'][number]) {
	const linkedIds = new Set((card.antagonistCandidateIds ?? []).map(value => value.toLowerCase()));
	return (frame.antagonistCandidates ?? [])
		.filter(candidate => linkedIds.has(candidate.id.toLowerCase()))
		.sort((a, b) =>
			Number(Boolean(b.actorEntityId || b.actorFactionId)) - Number(Boolean(a.actorEntityId || a.actorFactionId))
			|| (b.plausibilityScore + b.dramaticScore - b.agencyRisk)
			- (a.plausibilityScore + a.dramaticScore - a.agencyRisk)
			|| a.id.localeCompare(b.id)
		)[0];
}

function formatAntagonist(frame: StrategicWorldFrame, card: StrategicWorldFrame['plotCards'][number]): string {
	const candidate = antagonistForCard(frame, card);
	if (!candidate) return '';
	const actor = candidate.actorEntityId
		? `entity ${candidate.actorEntityId}`
		: candidate.actorFactionId
			? `faction ${candidate.actorFactionId}`
			: null;
	const label = actor
		? `Antagonist pressure: ${compact(candidate.name, 120)} [${candidate.role}; ${actor}].`
		: `Opposition candidate (unbound): ${compact(candidate.name, 120)} [${candidate.role}]. Treat this identity as provisional; do not establish a new actor from it.`;
	return `  ${label} ${[
		candidate.motive ? `Motive: ${compact(candidate.motive, 220)}.` : '',
		candidate.method ? `Method: ${compact(candidate.method, 220)}.` : '',
		candidate.escalationTrigger ? `Escalates when: ${compact(candidate.escalationTrigger, 180)}.` : '',
		candidate.hesitationTrigger ? `Hesitates when: ${compact(candidate.hesitationTrigger, 180)}.` : '',
		candidate.lineTheyWillNotCross ? `Boundary: ${compact(candidate.lineTheyWillNotCross, 180)}.` : '',
	].filter(Boolean).join(' ')}`.trimEnd();
}

function formatNarratorPlotCards(frame: StrategicWorldFrame, selectedCardId?: string | null): string {
	return activePlotCards(frame, selectedCardId === undefined ? 5 : frame.plotCards.length)
		.filter(card => selectedCardId === undefined || card.id === selectedCardId)
		.map(card => {
			const selected = selectedCardId !== undefined;
			const clues = selected ? '' : card.clueTrail.slice(0, 2).map(clue => `${clue.delivery}: ${clue.clue}`).join('; ');
			const touchpoints = selected ? '' : card.playerTouchpoints.slice(0, 3).join('; ');
			const guard = card.antiRailroadNotes.slice(0, 2).join('; ');
			const antagonist = selected ? '' : formatAntagonist(frame, card);
			return [
				selected ? `- ${card.title}: ${card.logline}`
					: `- [${card.lifecycleStage}/${card.urgency}/${card.visibility}/${card.pressure}] ${card.title}: ${card.logline}`,
				antagonist,
				touchpoints ? `  Touchpoints: ${touchpoints}` : '',
				clues ? `  Safe clues: ${clues}` : '',
				guard ? `  Agency guard: ${guard}` : '',
			].filter(Boolean).join('\n');
		})
		.join('\n');
}

function formatWorldSimPlotCards(frame: StrategicWorldFrame): string {
	return activePlotCards(frame)
		.map(card => {
			const beats = card.pressureBeats.slice(0, 3).map(beat => `Beat: ${beat.title} (${beat.urgency}/${beat.visibility}, +${beat.delayTurns} turns)`).join('; ');
			const clues = card.clueTrail.slice(0, 3).map(clue => `clue: ${clue.clue}`).join('; ');
			const antagonist = formatAntagonist(frame, card);
			return [
				`- [${card.lifecycleStage}/${card.urgency}/${card.visibility}/${card.pressure}] ${card.title}: ${card.logline}`,
				antagonist,
				clues ? `  ${clues}` : '',
				beats ? `  ${beats}` : '',
			].filter(Boolean).join('\n');
		})
		.join('\n');
}

const PLOT_QUALITY_GUARD = 'PLOT QUALITY: Allow cooperation, discovery, payoff, and quiet. Resistance requires an established motive or concrete constraint. Never add suspicion, conditions, or setbacks merely to maintain tension. Honor earned progress and resolved agreements.';

export function buildStrategicNarratorBlock(frame: StrategicWorldFrame | null | undefined, selectedCardId?: string | null): string {
	if (!frame) return '';
	const plotCards = formatNarratorPlotCards(frame, selectedCardId);
	if (!plotCards) return '';
	const normalized = normalizeStrategicFrameActivations(frame);
	const dormantIds = new Set(normalized.activationPlan.keepDormant);
	const dormantTitles = selectedCardId === undefined
		? normalized.plotCards.filter(card => dormantIds.has(card.id)).map(card => card.title).slice(0, 3) : [];
	return [
		'## Plot Director Pressure',
		'Use this as soft story steering, not a script. Scene evidence, player action, and established canon outrank these cards.',
		PLOT_QUALITY_GUARD,
		'Advance at most one scene-relevant active pressure this turn. If none fits, deliberately defer it; do not restage a beat the recent scene already completed or reintroduce resolved pressure.',
		'Do not force player action, travel, discovery, loyalty, injury, or outcomes.',
		'Do not reveal secret faction plans unless the current scene, evidence, or player investigation already justifies it.',
		'',
		`Active plot pressure:\n${compactBlock(plotCards, 2600)}`,
		dormantTitles.length ? `Dormant ongoing pressure: ${dormantTitles.join('; ')}. Keep these pending off-screen this turn; do not restage their reports or choices unless the player engages or the clock materially advances.` : '',
	].filter(Boolean).join('\n');
}

export function buildStrategicWorldSimBlock(frame: StrategicWorldFrame | null | undefined): string {
	if (!frame) return '';
	const plotCards = formatWorldSimPlotCards(frame);
	if (!plotCards) return '';
	return [
		'STRATEGIC WORLD FRAME',
		'Only the explicitly activated cards below are strategic instructions. Choose immediate visible movement and do not invent a new grand strategy.',
		PLOT_QUALITY_GUARD,
		`Plot pressure cards:\n${compactBlock(plotCards, 3000)}`,
	].filter(Boolean).join('\n\n');
}
