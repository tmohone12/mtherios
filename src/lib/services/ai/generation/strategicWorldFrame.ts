import type { StrategicWorldBrainInput } from '../context/strategicWorldBrainInput';
import type { StrategicEvidenceRef, StrategicWorldFrame } from '$lib/types';
import { uuid } from '$lib/utils/uuid';
import { frameChapterRange } from '../context/strategicWorldBrainInput';
import { describesForcedPlayerAction } from '../context/plotMomentumAgency';

function compactCard(value: string, fallback: string): string {
	const text = (value || fallback).replace(/\s+\n/g, '\n').trim();
	return text.length <= 4200 ? text : `${text.slice(0, 4197).trimEnd()}...`;
}

function fallbackCard(frame: Pick<StrategicWorldFrame, 'publicSummary' | 'worldMood' | 'mainPlots' | 'strategicClocks'>): string {
	const plots = frame.mainPlots.slice(0, 3).map(plot => `- ${plot.title}: ${plot.summary}`).join('\n');
	const clocks = frame.strategicClocks.slice(0, 3).map(clock => `- ${clock.name}: ${clock.currentPhase}`).join('\n');
	return [
		'STRATEGIC WORLD PRESSURE:',
		frame.publicSummary,
		`Political temperature: ${frame.worldMood.politicalTemperature}.`,
		plots ? `Key plot pressure:\n${plots}` : '',
		clocks ? `Strategic clocks:\n${clocks}` : '',
		'Use as background pressure only. Do not reveal hidden plans without scene evidence or player investigation.',
	].filter(Boolean).join('\n');
}

function idPart(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'item';
}

function unique(values: string[]): string[] {
	return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function refKey(value: string): string {
	return value.trim().toLowerCase();
}

function generatedId(prefix: string, input: StrategicWorldBrainInput, label: string, index: number): string {
	const arcNumber = input.currentArc?.arcNumber ?? Math.max(0, ...(input.recentArcs ?? []).map(arc => arc.arcNumber)) + 1;
	return `${prefix}_${idPart(input.story.id)}_${arcNumber}_${idPart(label)}_${index + 1}`;
}

function resolvedRefs(values: string[], refs: Map<string, string>): string[] {
	return unique(values.map(value => refs.get(refKey(value)) ?? '').filter(Boolean));
}

function addRefs(refs: Map<string, string>, values: string[], id: string): void {
	for (const value of values) {
		const key = refKey(value);
		if (key && !refs.has(key)) refs.set(key, id);
	}
}

function evidenceFilter(input: StrategicWorldBrainInput): (refs: StrategicEvidenceRef[]) => StrategicEvidenceRef[] {
	const byType = new Map<StrategicEvidenceRef['sourceType'], Set<string>>([
		['arc', new Set([...(input.currentArc ? [input.currentArc] : []), ...(input.recentArcs ?? []), ...(input.relevantOlderArcs ?? [])].map(row => row.id))],
		['chapter', new Set([...(input.currentArcChapters ?? []), ...(input.recentChapters ?? [])].map(row => row.id))],
		['scheme', new Set([...(input.activeSchemes ?? []), ...(input.recentlyResolvedSchemes ?? [])].map(row => row.id))],
		['thread', new Set(input.knownThreadIds ?? (input.storyThreads ?? []).map(row => row.id))],
		['world_event', new Set((input.worldEvents ?? []).map(row => row.id))],
		['faction', new Set(input.knownFactionIds ?? (input.factions ?? []).map(row => row.id))],
		['rumor', new Set((input.rumors ?? []).map(row => row.id))],
		['agreement', new Set((input.agreements ?? []).map(row => row.id))],
		['entry', new Set((input.recentEntries ?? []).map(row => row.id))],
		['memory', new Set((input.rumors ?? []).map(row => row.id))],
	]);
	const all = new Set([...byType.values()].flatMap(ids => [...ids]));
	return (refs) => refs.filter(ref => Boolean(ref.sourceId && (ref.sourceType === 'unknown' ? all.has(ref.sourceId) : byType.get(ref.sourceType)?.has(ref.sourceId))));
}

export function finalizeStrategicWorldFrame(
	input: StrategicWorldBrainInput,
	result: StrategicWorldFrame,
): StrategicWorldFrame {
	const previous = input.previousStrategicFrame;
	const previousSeedIds = new Map((previous?.tensionSeeds ?? []).map(seed => [refKey(seed.title), seed.id]));
	const previousCandidateIds = new Map((previous?.antagonistCandidates ?? []).map(candidate => [refKey(candidate.name), candidate.id]));
	const previousCardIds = new Map((previous?.plotCards ?? []).map(card => [refKey(card.title), card.id]));
	const filterEvidence = evidenceFilter(input);
	const validEntityIds = new Set(input.knownEntityIds ?? (input.characters ?? []).map(row => row.id));
	const validFactionIds = new Set(input.knownFactionIds ?? (input.factions ?? []).map(row => row.id));
	const validThreadIds = new Set(input.knownThreadIds ?? (input.storyThreads ?? []).map(row => row.id));
	const validEntities = (values: string[]) => unique(values).filter(id => validEntityIds.has(id));
	const validFactions = (values: string[]) => unique(values).filter(id => validFactionIds.has(id));

	const seedRefs = new Map<string, string>();
	const usedSeedIds = new Set<string>();
	const tensionSeeds = result.tensionSeeds.slice(0, 12).map((seed, index) => {
		const preferred = seed.id.trim() || previousSeedIds.get(refKey(seed.title)) || generatedId('tension', input, seed.title, index);
		const id = usedSeedIds.has(preferred) ? generatedId('tension', input, seed.title, index) : preferred;
		usedSeedIds.add(id);
		addRefs(seedRefs, [seed.id, seed.title, id], id);
		return {
			...seed,
			id,
			involvedEntityIds: validEntities(seed.involvedEntityIds),
			involvedFactionIds: validFactions(seed.involvedFactionIds),
			evidenceRefs: filterEvidence(seed.evidenceRefs),
		};
	});
	const candidateRefs = new Map<string, string>();
	const usedCandidateIds = new Set<string>();
	const antagonistCandidates = result.antagonistCandidates.slice(0, 8).map((candidate, index) => {
		const preferred = candidate.id.trim() || previousCandidateIds.get(refKey(candidate.name)) || generatedId('actor', input, candidate.name, index);
		const id = usedCandidateIds.has(preferred) ? generatedId('actor', input, candidate.name, index) : preferred;
		usedCandidateIds.add(id);
		addRefs(candidateRefs, [candidate.id, candidate.name, id], id);
		return {
			...candidate,
			id,
			actorEntityId: candidate.actorEntityId && validEntityIds.has(candidate.actorEntityId) ? candidate.actorEntityId : null,
			actorFactionId: candidate.actorFactionId && validFactionIds.has(candidate.actorFactionId) ? candidate.actorFactionId : null,
			tensionSeedIds: resolvedRefs(candidate.tensionSeedIds, seedRefs),
			evidenceRefs: filterEvidence(candidate.evidenceRefs),
		};
	});
	const fallbackAntagonistId = antagonistCandidates
		.filter(candidate => candidate.actorEntityId || candidate.actorFactionId)
		.sort((a, b) =>
			(b.plausibilityScore + b.dramaticScore - b.agencyRisk)
			- (a.plausibilityScore + a.dramaticScore - a.agencyRisk)
			|| a.id.localeCompare(b.id)
		)[0]?.id;
	const plotLinesByTitle = new Map([...result.mainPlots, ...result.subplots].map(line => [refKey(line.title), line]));
	const cardRefs = new Map<string, string>();
	const usedCardIds = new Set<string>();
	const plotCards = result.plotCards.slice(0, 6).map((card, index) => {
		const preferred = card.id.trim() || previousCardIds.get(refKey(card.title)) || generatedId('plot', input, card.title, index);
		const id = usedCardIds.has(preferred) ? generatedId('plot', input, card.title, index) : preferred;
		usedCardIds.add(id);
		addRefs(cardRefs, [card.id, card.title, id], id);
		const validSourceRefs = filterEvidence(card.sourceRefs);
		const matchingLine = plotLinesByTitle.get(refKey(card.title));
		const recoveredSourceRefs = validSourceRefs.length > 0 ? validSourceRefs : (matchingLine?.linkedThreadIds ?? [])
			.filter(threadId => validThreadIds.has(threadId))
			.map(threadId => ({ sourceType: 'thread' as const, sourceId: threadId, label: matchingLine?.title ?? card.title }));
		const antagonistCandidateIds = resolvedRefs(card.antagonistCandidateIds, candidateRefs);
		return {
			...card,
			id,
			actorEntityIds: validEntities(card.actorEntityIds),
			targetEntityIds: validEntities(card.targetEntityIds),
			actorFactionIds: validFactions(card.actorFactionIds),
			targetFactionIds: validFactions(card.targetFactionIds),
			antagonistCandidateIds: antagonistCandidateIds.length > 0 || card.kind !== 'main_plot' || !fallbackAntagonistId
				? antagonistCandidateIds
				: [fallbackAntagonistId],
			sourceRefs: recoveredSourceRefs,
			clueTrail: card.clueTrail.slice(0, 4).map(clue => ({ ...clue, evidenceRefs: filterEvidence(clue.evidenceRefs) })),
			pressureBeats: card.pressureBeats
				.filter(beat => !describesForcedPlayerAction(`${beat.title}. ${beat.body}`))
				.slice(0, 3).map(beat => ({
					...beat,
					actorEntityIds: validEntities(beat.actorEntityIds),
					targetEntityIds: validEntities(beat.targetEntityIds),
					factionIds: validFactions(beat.factionIds),
				})),
		};
	});
	const cardById = new Map(plotCards.map(card => [card.id, card]));
	const activateNow: string[] = [];
	let immediate = 0;
	let mainPlots = 0;
	for (const id of resolvedRefs(result.activationPlan.activateNow, cardRefs)) {
		const card = cardById.get(id);
		if (!card || card.sourceRefs.length === 0 || activateNow.length >= 3) continue;
		if (card.urgency === 'immediate' && immediate >= 1) continue;
		if (card.kind === 'main_plot' && mainPlots >= 1) continue;
		activateNow.push(id);
		if (card.urgency === 'immediate') immediate += 1;
		if (card.kind === 'main_plot') mainPlots += 1;
	}
	if (activateNow.length === 0) {
		const fallback = [...plotCards]
			.filter(card => card.sourceRefs.length > 0 && card.lifecycleStage !== 'resolved' && card.lifecycleStage !== 'dormant')
			.sort((a, b) => Number(b.kind === 'main_plot') - Number(a.kind === 'main_plot') || b.pressure - a.pressure || a.id.localeCompare(b.id))[0];
		if (fallback) activateNow.push(fallback.id);
	}

	const shaped = {
		...result,
		tensionSeeds,
		antagonistCandidates,
		plotCards,
		activationPlan: {
			...result.activationPlan,
			activateNow,
			keepDormant: resolvedRefs(result.activationPlan.keepDormant, cardRefs),
			retireOrMerge: resolvedRefs(result.activationPlan.retireOrMerge, cardRefs),
		},
		plotBrainWritePlan: {
			...result.plotBrainWritePlan,
			storyThreadCreates: [],
			storyThreadUpdates: result.plotBrainWritePlan.storyThreadUpdates.filter(update => validThreadIds.has(update.threadId)).slice(0, 6),
			timelineEvents: [],
			patchProposals: result.plotBrainWritePlan.patchProposals.slice(0, 8).map(proposal => ({
				...proposal,
				evidenceRefs: filterEvidence(proposal.evidenceRefs),
			})),
		},
	} satisfies StrategicWorldFrame;

	return {
		...shaped,
		id: uuid(),
		storyId: input.story.id,
		arcId: input.currentArc?.id ?? null,
		arcNumber: input.currentArc?.arcNumber ?? result.arcNumber,
		trigger: input.trigger,
		chapterRange: result.chapterRange.from || result.chapterRange.to ? result.chapterRange : frameChapterRange(input),
		createdAt: Date.now(),
		factionOperations: result.factionOperations.map((operation, index) => ({
			...operation,
			id: operation.id || generatedId('operation', input, operation.factionName, index),
		})),
		narratorPromptCard: compactCard(result.narratorPromptCard, fallbackCard(shaped)),
		fastWorldSimInstructions: compactCard(result.fastWorldSimInstructions, result.narratorPromptCard || fallbackCard(shaped)),
	};
}
