import type { StrategicWorldFrame } from '$lib/types';

function compact(value: string | null | undefined, max = 1400): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
}

function activePlotCards(frame: StrategicWorldFrame): StrategicWorldFrame['plotCards'] {
	const activeIds = new Set((frame.activationPlan?.activateNow ?? []).map(value => value.trim().toLowerCase()).filter(Boolean));
	return (frame.plotCards ?? [])
		.filter(card => card.lifecycleStage !== 'resolved'
			&& card.lifecycleStage !== 'dormant'
			&& (activeIds.has(card.id.toLowerCase()) || activeIds.has(card.title.toLowerCase())))
		.sort((a, b) => b.pressure - a.pressure)
		.slice(0, 5);
}

function antagonistForCard(frame: StrategicWorldFrame, card: StrategicWorldFrame['plotCards'][number]) {
	const linkedIds = new Set((card.antagonistCandidateIds ?? []).map(value => value.toLowerCase()));
	return (frame.antagonistCandidates ?? [])
		.filter(candidate => linkedIds.has(candidate.id.toLowerCase()) && (candidate.actorEntityId || candidate.actorFactionId))
		.sort((a, b) =>
			(b.plausibilityScore + b.dramaticScore - b.agencyRisk)
			- (a.plausibilityScore + a.dramaticScore - a.agencyRisk)
			|| a.id.localeCompare(b.id)
		)[0];
}

function formatAntagonist(frame: StrategicWorldFrame, card: StrategicWorldFrame['plotCards'][number]): string {
	const candidate = antagonistForCard(frame, card);
	if (!candidate) return '';
	const actor = candidate.actorEntityId ? `entity ${candidate.actorEntityId}` : `faction ${candidate.actorFactionId}`;
	return `  Antagonist pressure: ${compact(candidate.name, 120)} [${candidate.role}; ${actor}]. ${[
		candidate.motive ? `Motive: ${compact(candidate.motive, 220)}.` : '',
		candidate.method ? `Method: ${compact(candidate.method, 220)}.` : '',
		candidate.escalationTrigger ? `Escalates when: ${compact(candidate.escalationTrigger, 180)}.` : '',
		candidate.hesitationTrigger ? `Hesitates when: ${compact(candidate.hesitationTrigger, 180)}.` : '',
		candidate.lineTheyWillNotCross ? `Boundary: ${compact(candidate.lineTheyWillNotCross, 180)}.` : '',
	].filter(Boolean).join(' ')}`.trimEnd();
}

function formatNarratorPlotCards(frame: StrategicWorldFrame): string {
	return activePlotCards(frame)
		.map(card => {
			const clues = card.clueTrail.slice(0, 2).map(clue => `${clue.delivery}: ${clue.clue}`).join('; ');
			const touchpoints = card.playerTouchpoints.slice(0, 3).join('; ');
			const guard = card.antiRailroadNotes.slice(0, 2).join('; ');
			const antagonist = formatAntagonist(frame, card);
			return [
				`- [${card.lifecycleStage}/${card.urgency}/${card.visibility}/${card.pressure}] ${card.title}: ${card.logline}`,
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
			return [
				`- [${card.lifecycleStage}/${card.urgency}/${card.visibility}/${card.pressure}] ${card.title}: ${card.logline}`,
				clues ? `  ${clues}` : '',
				beats ? `  ${beats}` : '',
			].filter(Boolean).join('\n');
		})
		.join('\n');
}

export function buildStrategicNarratorBlock(frame: StrategicWorldFrame | null | undefined): string {
	if (!frame) return '';
	const war = frame.warPressureCard
		? [
			`War phase: ${frame.warPressureCard.phase}`,
			frame.warPressureCard.mainFactions.length ? `Factions: ${frame.warPressureCard.mainFactions.join('; ')}` : '',
			frame.warPressureCard.warAims.length ? `War aims: ${frame.warPressureCard.warAims.join('; ')}` : '',
			frame.warPressureCard.frontsOrTheaters.length ? `Fronts/theaters: ${frame.warPressureCard.frontsOrTheaters.join('; ')}` : '',
			frame.warPressureCard.visibleSigns.length ? `Visible signs: ${frame.warPressureCard.visibleSigns.slice(0, 6).join('; ')}` : '',
			frame.warPressureCard.hiddenFacts.length ? `Hidden facts: ${frame.warPressureCard.hiddenFacts.slice(0, 4).join('; ')}` : '',
			frame.warPressureCard.nextEscalationIfIgnored ? `If ignored: ${frame.warPressureCard.nextEscalationIfIgnored}` : '',
			frame.warPressureCard.playerInterventionPoints.length ? `Player intervention points: ${frame.warPressureCard.playerInterventionPoints.slice(0, 5).join('; ')}` : '',
		].filter(Boolean).join('\n')
		: '';
	const operations = (frame.factionOperations ?? [])
		.slice(0, 5)
		.map(op => {
			const target = op.target ? ` -> ${op.target}` : '';
			const signal = op.visibleSignals.length ? ` Signals: ${op.visibleSignals.slice(0, 2).join('; ')}` : '';
			return `- [${op.urgency}/${op.timeHorizon}] ${op.factionName}${target}: ${op.operation}.${signal}`;
		})
		.join('\n');
	const plotCards = formatNarratorPlotCards(frame);
	if (!frame.narratorPromptCard?.trim() && !war && !operations && !plotCards) return '';
	return [
		'## Strategic World Pressure',
		'Use this as hidden world pressure. Do not reveal secret faction plans unless the current scene, evidence, or player investigation justifies it.',
		'',
		compact(frame.narratorPromptCard, 1800),
		plotCards ? `Active plot pressure:\n${compact(plotCards, 1800)}` : '',
		war ? `War pressure card:\n${compact(war, 1400)}` : '',
		operations ? `Forward faction operations:\n${operations}` : '',
	].filter(Boolean).join('\n');
}

export function buildStrategicWorldSimBlock(frame: StrategicWorldFrame | null | undefined): string {
	if (!frame) return '';
	const war = frame.warPressureCard
		? [
			`Phase: ${frame.warPressureCard.phase}`,
			frame.warPressureCard.mainFactions.length ? `Main factions: ${frame.warPressureCard.mainFactions.join('; ')}` : '',
			frame.warPressureCard.warAims.length ? `War aims: ${frame.warPressureCard.warAims.join('; ')}` : '',
			frame.warPressureCard.frontsOrTheaters.length ? `Fronts/theaters: ${frame.warPressureCard.frontsOrTheaters.join('; ')}` : '',
			frame.warPressureCard.importantSchemes.length ? `Important schemes: ${frame.warPressureCard.importantSchemes.join('; ')}` : '',
			frame.warPressureCard.visibleSigns.length ? `Visible signs: ${frame.warPressureCard.visibleSigns.join('; ')}` : '',
			frame.warPressureCard.hiddenFacts.length ? `Hidden facts: ${frame.warPressureCard.hiddenFacts.join('; ')}` : '',
			frame.warPressureCard.nextEscalationIfIgnored ? `Next escalation if ignored: ${frame.warPressureCard.nextEscalationIfIgnored}` : '',
			frame.warPressureCard.playerInterventionPoints.length ? `Player intervention points: ${frame.warPressureCard.playerInterventionPoints.join('; ')}` : '',
		].filter(Boolean).join('\n')
		: '';
	const clocks = frame.strategicClocks
		.slice(0, 6)
		.map(clock => `- ${clock.name} (${clock.ownerFactionName}): ${clock.progress}% ${clock.velocity}. ${clock.currentPhase}`)
		.join('\n');
	const operations = (frame.factionOperations ?? [])
		.slice(0, 10)
		.map(op => {
			const target = op.target ? ` -> ${op.target}` : '';
			const triggers = op.triggerConditions.length ? ` triggers: ${op.triggerConditions.slice(0, 3).join('; ')}` : '';
			const stalls = op.stallConditions.length ? ` stalls if: ${op.stallConditions.slice(0, 2).join('; ')}` : '';
			const signals = op.visibleSignals.length ? ` visible signals: ${op.visibleSignals.slice(0, 3).join('; ')}` : '';
			return `- [${op.urgency}/${op.timeHorizon}/${op.visibility}] ${op.factionName}${target}: ${op.operation}. Objective: ${op.objective}.${triggers}${stalls}${signals}`;
		})
		.join('\n');
	const instructions = frame.fastWorldSimInstructions || frame.narratorPromptCard;
	const plotCards = formatWorldSimPlotCards(frame);
	if (!instructions && !clocks && !operations && !plotCards) return '';
	return [
		'STRATEGIC WORLD FRAME',
		`Arc ${frame.arcNumber}; pressure: ${frame.worldMood.politicalTemperature}.`,
		'The fast world sim is subordinate to this frame. Choose immediate visible movement; do not invent a new grand strategy unless no frame applies.',
		instructions ? `Instructions:\n${compact(instructions, 1800)}` : '',
		plotCards ? `Plot pressure cards:\n${compact(plotCards, 2200)}` : '',
		war ? `War pressure card:\n${compact(war, 1800)}` : '',
		operations ? `Forward faction operations:\n${operations}` : '',
		clocks ? `Strategic clocks:\n${clocks}` : '',
	].filter(Boolean).join('\n\n');
}
