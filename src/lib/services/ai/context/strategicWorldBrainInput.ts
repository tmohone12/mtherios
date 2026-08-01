import type {
	Agreement,
	Arc,
	Chapter,
	Entry,
	CharacterEntryState,
	FactionEntryState,
	FactionGoal,
	FactionResources,
	Scheme,
	Story,
	StoryEntry,
	StoryMode,
	StoryThread,
	StrategicBrainTrigger,
	StrategicWorldFrame,
	TimeTracker,
	WorldEvent,
	RumorRecord,
	FactionActionRecord,
	POV,
	Tense,
} from '$lib/types';
import { buildWarStrategicDoctrineBlock } from './warDoctrine';

export interface StrategicWorldBrainInput {
	story: Story;
	trigger: StrategicBrainTrigger;
	currentArc: Arc | null;
	recentArcs: Arc[];
	relevantOlderArcs: Arc[];
	currentArcChapters: Chapter[];
	recentChapters: Chapter[];
	recentEntries: StoryEntry[];
	factions: Entry[];
	characters: Entry[];
	activeSchemes: Scheme[];
	recentlyResolvedSchemes: Scheme[];
	storyThreads: StoryThread[];
	worldEvents: WorldEvent[];
	rumors: RumorRecord[];
	agreements: Agreement[];
	factionActions: FactionActionRecord[];
	playerLedger: string | null;
	playerReputation: string | null;
	previousStrategicFrame: StrategicWorldFrame | null;
	mode: StoryMode;
	pov: POV;
	tense: Tense;
	timeTracker: TimeTracker | null;
	currentTurn?: number;
	currentWorldTime?: string | null;
	contextBudget?: number;
	includeSecret?: boolean;
	knownEntityIds?: string[];
	knownFactionIds?: string[];
	knownThreadIds?: string[];
}

function compact(value: string | null | undefined, max = 500): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
}

function lineList(lines: string[], empty = 'None known.'): string {
	const filtered = lines.map(line => line.trim()).filter(Boolean);
	return filtered.length > 0 ? filtered.join('\n') : empty;
}

function parseChapterRange(range: string): { from: number; to: number } {
	const nums = range.match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
	if (nums.length === 0) return { from: 0, to: 0 };
	if (nums.length === 1) return { from: nums[0], to: nums[0] };
	return { from: nums[0], to: nums[nums.length - 1] };
}

export function frameChapterRange(input: StrategicWorldBrainInput): { from: number; to: number } {
	if (input.currentArc?.chapterRange) return parseChapterRange(input.currentArc.chapterRange);
	const numbers = input.currentArcChapters.map(chapter => chapter.number).filter(Number.isFinite);
	if (numbers.length === 0) return { from: 0, to: 0 };
	return { from: Math.min(...numbers), to: Math.max(...numbers) };
}

function uniqueCleanStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const clean = value.trim();
		const key = clean.toLowerCase();
		if (!clean || seen.has(key)) continue;
		seen.add(key);
		out.push(clean);
	}
	return out;
}

function resolveFactionMemberNames(memberRefs: string[], characters: Entry[]): string[] {
	return uniqueCleanStrings(memberRefs.map((memberRef) => {
		const clean = memberRef.trim();
		const lower = clean.toLowerCase();
		const character = characters.find(entry =>
			entry.id === clean ||
			entry.name.toLowerCase() === lower ||
			(entry.aliases ?? []).some(alias => alias.toLowerCase() === lower)
		);
		return character?.name ?? clean;
	}));
}

function formatUnresolvedFactionMemberNames(names: string[]): string {
	return uniqueCleanStrings(names)
		.slice(0, 8)
		.map(name => `${name} (review context; not character canon)`)
		.join(', ');
}

function formatFaction(entry: Entry, characters: Entry[] = []): string {
	const state = entry.state as FactionEntryState | undefined;
	const goals = formatFactionGoals(state?.goals ?? []);
	const resources = formatFactionResources(state?.resources);
	const relations = state?.interFactionRelations
		? Object.entries(state.interFactionRelations)
			.slice(0, 8)
			.map(([name, rel]) => {
				const standing = typeof rel === 'number' ? rel : rel.standing;
				const affinity = typeof rel === 'number' ? rel : rel.affinity;
				return `${name}: standing ${standing}, affinity ${affinity}`;
			})
			.join('; ')
		: '';
	const territory = state?.territory?.length ? `territory: ${state.territory.join(', ')}` : '';
	const disposition = state?.disposition ? `disposition: ${state.disposition}` : '';
	const memberNames = resolveFactionMemberNames(state?.knownMembers ?? [], characters).slice(0, 8);
	const unresolvedMemberNames = formatUnresolvedFactionMemberNames(state?.unresolvedKnownMembers ?? []);
	return [
		`- ${entry.name} [id:${entry.id}]`,
		`  Description: ${compact(entry.description, 260)}`,
		`  Status: ${state?.status ?? 'unknown'}, player standing ${state?.playerStanding ?? 0}`,
		disposition ? `  ${disposition}` : '',
		territory ? `  ${territory}` : '',
		memberNames.length ? `  Members: ${memberNames.join(', ')}` : '',
		unresolvedMemberNames ? `  Unresolved member references: ${unresolvedMemberNames}` : '',
		goals ? `  Goals: ${goals}` : '',
		resources ? `  Resources: ${resources}` : '',
		relations ? `  Relations: ${relations}` : '',
	].filter(Boolean).join('\n');
}

function formatFactionGoals(goals: FactionGoal[]): string {
	return goals
		.slice(0, 6)
		.map(goal => `${goal.description} (${goal.type}, priority ${goal.priority}, progress ${goal.progress}${goal.deadline ? `, deadline ${goal.deadline}` : ''})`)
		.join('; ');
}

function formatFactionResources(resources: FactionResources | undefined): string {
	if (!resources) return '';
	return [
		`military ${resources.military}`,
		`wealth ${resources.wealth}`,
		`influence ${resources.influence}`,
		`information ${resources.information}`,
		`morale ${resources.morale}`,
	].join(', ');
}

function formatCharacter(entry: Entry): string {
	const state = entry.state as CharacterEntryState | undefined;
	const relationship = state?.relationship
		? `relationship: ${state.relationship.status}, level ${state.relationship.level}`
		: '';
	const factionTags = state?.factionTags?.length ? `factions: ${state.factionTags.join(', ')}` : '';
	return [
		`- ${entry.name} [id:${entry.id}]`,
		`  Description: ${compact(state?.bio || entry.description, 260)}`,
		state?.personality ? `  Personality: ${compact(state.personality, 180)}` : '',
		state?.currentDisposition ? `  Disposition: ${state.currentDisposition}` : '',
		state?.personalOpinion ? `  Opinion of player: ${compact(state.personalOpinion, 180)}` : '',
		relationship ? `  ${relationship}` : '',
		state?.motivations?.length ? `  Motivations: ${state.motivations.slice(0, 5).join('; ')}` : '',
		state?.pressures?.length ? `  Pressures: ${state.pressures.slice(0, 5).join('; ')}` : '',
		state?.knownFacts?.length ? `  Known facts: ${state.knownFacts.slice(-5).join('; ')}` : '',
		state?.revealedSecrets?.length ? `  Revealed secrets: ${state.revealedSecrets.slice(-4).join('; ')}` : '',
		factionTags ? `  ${factionTags}` : '',
		entry.hiddenInfo ? `  Hidden: ${compact(entry.hiddenInfo, 180)}` : '',
	].filter(Boolean).join('\n');
}

function formatScheme(scheme: Scheme): string {
	const currentStage = scheme.stages[scheme.currentStageIndex];
	const stageLines = scheme.stages
		.slice(0, 6)
		.map(stage => `${stage.index + 1}. ${stage.label}${stage.completed ? ' [done]' : ''}: ${compact(stage.hook, 120)}`)
		.join(' | ');
	return [
		`- [id:${scheme.id}] ${scheme.ownerName} (${scheme.ownerType}, ${scheme.status}, ${scheme.secrecy}, pressure ${scheme.pressure})`,
		`  Goal: ${compact(scheme.goal, 220)}`,
		currentStage ? `  Current stage: ${currentStage.label} - ${compact(currentStage.hook, 180)}` : '',
		stageLines ? `  Stages: ${stageLines}` : '',
	].filter(Boolean).join('\n');
}

function formatThread(thread: StoryThread): string {
	return `- [id:${thread.id}] ${thread.status}/${thread.significance}: ${compact(thread.description, 220)}`;
}

function formatArc(arc: Arc): string {
	return [
		`- Arc ${arc.arcNumber}: ${arc.title} (Ch. ${arc.chapterRange})`,
		`  Summary: ${compact(arc.summary, 420)}`,
		arc.unresolvedThreads?.length ? `  Open threads: ${arc.unresolvedThreads.slice(0, 6).join('; ')}` : '',
	].filter(Boolean).join('\n');
}

function formatChapter(chapter: Chapter): string {
	return [
		`- Ch. ${chapter.number}: ${chapter.title}`,
		`  ${compact(chapter.summary, 260)}`,
		chapter.plotThreads?.length ? `  Threads: ${chapter.plotThreads.slice(0, 5).join('; ')}` : '',
		chapter.characters?.length ? `  Characters: ${chapter.characters.slice(0, 8).join(', ')}` : '',
	].filter(Boolean).join('\n');
}

function formatWorldEvent(event: WorldEvent): string {
	const consequences = event.consequences?.map(c => c.description).filter(Boolean).slice(0, 3).join('; ');
	return `- ${event.name}: ${compact(event.description, 180)}${consequences ? ` Consequences: ${consequences}` : ''}`;
}

function formatRumor(rumor: RumorRecord): string {
	return `- ${compact(rumor.content, 180)} (${rumor.originRegion}, truth ${rumor.truthfulness}, ${rumor.status})`;
}

function formatAgreement(agreement: Agreement): string {
	return `- ${agreement.parties.join(' <-> ')} (${agreement.category}, ${agreement.status}, ${agreement.secrecy}): ${compact(agreement.terms, 180)}`;
}

function formatFactionAction(action: FactionActionRecord): string {
	return `- ${action.factionName}: ${compact(action.action, 180)} (${action.actionType}, ${action.urgency})`;
}

function formatPreviousPlotCard(card: StrategicWorldFrame['plotCards'][number]): string {
	const touchpoints = card.playerTouchpoints?.length
		? ` Touchpoints: ${card.playerTouchpoints.slice(0, 3).join('; ')}`
		: '';
	return `- [id:${card.id}] ${card.title} [${card.lifecycleStage}/${card.urgency}/${card.visibility}/${card.pressure}]: ${compact(card.logline, 180)}${touchpoints}`;
}

export function buildStrategicWorldBrainSystemPrompt(): string {
	return `You are the Strategic World Brain for a living-world fiction engine.

You are not the narrator.
You do not write scenes.
You do not decide the player's actions.
You do not force outcomes that require player choice.

Your job:
- read chapters and arcs for continuity
- read active schemes as executable plans
- read faction goals as strategic intent
- read story threads as plots and subplots
- mine canon tensions into tensionSeeds
- score plausible antagonistCandidates by motive, capacity, proximity, and agency risk
- shape plotCards with goals, motives, methods, clue trails, pressure beats, and outcomes-if-ignored
- choose an activationPlan for which plots surface now, remain dormant, or retire/merge
- draft only existing-thread updates and hard-canon patch proposals; the server deterministically derives new threads and timeline events from activated plotCards
- decide what factions and NPCs are trying to do over the next arc
- create, update, stall, fork, expose, or retire schemes through directives
- identify which plots and subplots should gain pressure
- produce compact instructions for cheaper simulation and narration

Faction goals define why a faction fights; schemes define how they try to win; story threads define how the war becomes player-facing plot; world events record what actually happened.

${buildWarStrategicDoctrineBlock()}

Rules:
- Do not overwrite canon without evidence.
- Treat hard canon, hidden intent, and prompt pressure as separate things.
- Spend most of the output budget on forward operations, not recapping the past.
- Prefer source-linked changes.
- Respect existing scheme status.
- Preserve player agency.
- Create pressure, not railroaded outcomes.
- Do not reveal secrets directly. The narrator card may mention hidden pressure only as conditional background.
- Canon patch suggestions are proposals only; scheme directives are the executable planning layer.
- factionOperations are the tactical contract for background faction movement. Every major faction with an active goal should get an operation when it can plausibly act without the player present.
- Pressure, not rails: create friction, costs, rumors, clues, opportunities, NPC intentions, and consequences. Never force player action, emotion, travel, capture, confession, loyalty, or predetermined outcomes.
- Return at most six plotCards. Activate at most three: one main plot, up to two subplots, and no more than one immediate card.
- When story evidence exists, return at least one main plot and one subplot as plotCards, activate at least the main card, and link a canon-bound antagonist or opposing faction when one plausibly fits.
- Every activated plotCard must cite at least one real source id from the supplied context.

Use these exact JSON field names:
- mainPlots and subplots, not plotUpdates.
- schemeDirectives[].type must be one of create_scheme, update_scheme, advance_scheme, stall_scheme, fork_scheme, merge_scheme, expose_scheme, complete_scheme, retire_scheme.
- For new schemes, use title, ownerName, goal, progressDelta, visibleEffects, hiddenEffects, nextMoves, reason, confidence.
- factionOperations[] items must include factionName, operation, objective, actionType, urgency, visibility, timeHorizon, triggerConditions, stallConditions, visibleSignals, hiddenSteps, linkedClockIds, linkedSchemeIds, evidenceRefs, confidence.
- warPressureCard is required when war, rebellion, invasion, siege, occupation, large raid campaigns, or military collapse are active or plausibly imminent.
- tensionSeeds[] must include title, kind, involved ids, pressure, volatility, playerRelevance, canonConfidence, unresolvedQuestion, whyItMatters, and evidenceRefs.
- antagonistCandidates[] must include name, role, motive, method, plausibilityScore, dramaticScore, agencyRisk, and evidenceRefs. Pick antagonists because they are dramatically plausible, not randomly villainous.
- Prefer candidates bound to supplied actorEntityId or actorFactionId values. Every activated plotCard should link a canon-bound antagonist when one plausibly fits; leave invented candidates dormant and propose their canon separately.
- plotCards[] must encode Actor wants Goal because Motive, but Obstacle prevents it, so Actor uses Method, leaving Clues, causing Consequence if ignored.
- plotCards[].pressureBeats are scheduler intents only: they may reveal clues, rumors, prices, absences, NPC moves, or consequences, but must not force player choices.
- activationPlan must use exact plot card ids to name cards to activateNow, keepDormant, or retireOrMerge. Empty activateNow means activate nothing.
- plotBrainWritePlan.storyThreadCreates and timelineEvents must be empty because the server derives them from activated plotCards. Use storyThreadUpdates only for supplied thread ids and patchProposals only for reviewable hard-canon changes.
- canonPatchSuggestions[] must include type, reason, confidence, and evidenceRefs.

Output valid JSON for a StrategicWorldFrame.`;
}

export function buildStrategicWorldBrainUserPrompt(input: StrategicWorldBrainInput): string {
	const currentArc = input.currentArc;
	const chapterRange = frameChapterRange(input);
	const previousFrame = input.previousStrategicFrame;
	const prompt = [
		`Story: ${input.story.title}`,
		input.story.description ? `Description: ${compact(input.story.description, 700)}` : '',
		`Mode: ${input.mode}; POV: ${input.pov}; tense: ${input.tense}`,
		`Current turn: ${input.currentTurn ?? 0}`,
		input.currentWorldTime ? `World time: ${input.currentWorldTime}` : '',
		input.timeTracker ? `Time: year ${input.timeTracker.years}, day ${input.timeTracker.days}, ${input.timeTracker.hours}:${String(input.timeTracker.minutes).padStart(2, '0')}` : '',
		`Trigger: ${input.trigger}`,
		`Target arc number: ${currentArc?.arcNumber ?? Math.max(0, ...input.recentArcs.map(arc => arc.arcNumber)) + 1}`,
		`Chapter range under review: ${chapterRange.from}-${chapterRange.to}`,
		'',
		'CURRENT ARC',
		currentArc ? formatArc(currentArc) : 'No current arc is available.',
		'',
		'RECENT ARCS',
		lineList(input.recentArcs.slice(-4).map(formatArc)),
		'',
		'RELEVANT OLDER ARCS',
		lineList(input.relevantOlderArcs.slice(-4).map(formatArc)),
		'',
		'CURRENT ARC CHAPTERS',
		lineList(input.currentArcChapters.map(formatChapter)),
		'',
		'RECENT CHAPTERS',
		lineList(input.recentChapters.slice(-8).map(formatChapter)),
		'',
		'RECENT RAW ENTRIES',
		lineList(input.recentEntries.slice(-16).map(entry => `- [${entry.type}] ${compact(entry.content, 220)}`)),
		'',
		'FACTION DOSSIERS AND VERBOSE GOALS',
		lineList(input.factions.map(faction => formatFaction(faction, input.characters))),
		'',
		'CHARACTER STATE DOSSIERS',
		lineList(input.characters.slice(0, 32).map(formatCharacter)),
		'',
		'ACTIVE SCHEMES',
		lineList(input.activeSchemes.map(formatScheme)),
		'',
		'RECENTLY RESOLVED SCHEMES',
		lineList(input.recentlyResolvedSchemes.slice(-8).map(formatScheme)),
		'',
		'OPEN STORY THREADS / PLOTS / SUBPLOTS',
		lineList(input.storyThreads.filter(thread => thread.status !== 'closed' && thread.status !== 'abandoned').map(formatThread)),
		'',
		'RECENT WORLD EVENTS',
		lineList(input.worldEvents.slice(-12).map(formatWorldEvent)),
		'',
		'RECENT FACTION ACTIONS',
		lineList(input.factionActions.slice(-12).map(formatFactionAction)),
		'',
		'RUMORS',
		lineList(input.rumors.filter(rumor => rumor.status !== 'stale').slice(-12).map(formatRumor)),
		'',
		'AGREEMENTS / TREATIES / DEBTS',
		lineList(input.agreements.filter(agreement => agreement.status === 'active' || agreement.status === 'contested').map(formatAgreement)),
		'',
		input.playerReputation ? `PLAYER REPUTATION\n${compact(input.playerReputation, 700)}` : '',
		input.playerLedger ? `PLAYER LEDGER\n${compact(input.playerLedger, 900)}` : '',
		previousFrame ? [
			'',
			'PREVIOUS STRATEGIC FRAME',
			`Arc ${previousFrame.arcNumber}: ${compact(previousFrame.publicSummary, 300)}`,
			`Hidden summary: ${compact(previousFrame.hiddenStrategicSummary, 300)}`,
			`Fast sim instructions: ${compact(previousFrame.fastWorldSimInstructions, 360)}`,
			`Strategic clocks: ${previousFrame.strategicClocks.map(clock => `${clock.name} ${clock.progress}% ${clock.velocity}`).join('; ')}`,
			`Forward operations: ${(previousFrame.factionOperations ?? []).slice(0, 8).map(op => `${op.factionName}: ${compact(op.operation, 120)} (${op.urgency}, ${op.timeHorizon})`).join('; ')}`,
			previousFrame.plotCards?.length ? `Previous plot cards:\n${previousFrame.plotCards.slice(0, 8).map(formatPreviousPlotCard).join('\n')}` : '',
		].filter(Boolean).join('\n') : '',
		'',
		'BUILD THE NEXT STRATEGIC WORLD FRAME',
		'Faction goals define why a faction fights; schemes define how they try to win; story threads define how the war becomes player-facing plot; world events record what actually happened.',
		'Return a compact but useful strategic artifact. Put the full deep reasoning into structured fields, not prose sprawl.',
		'This is a forward planning pass. Use past chapters only as evidence, then decide what factions are about to try next.',
		'If war pressure exists, output a warPressureCard: phase, factions and war aims, fronts/theaters, important schemes, visible signs, hidden facts, next escalation if ignored, and player intervention points.',
		'Create factionOperations for concrete off-screen moves: letters sent, patrols raised, agents bribed, prices manipulated, musters prepared, envoys dispatched, rumors planted, or internal purges begun.',
		'Each factionOperation needs a horizon and triggers so the cheap world sim knows when to turn it into visible factionActions, rumors, shortages, invitations, threats, or NPC behavior.',
		'At least half of the useful content should be next moves, clocks, scheme directives, or operations. Do not spend the frame mostly summarizing old arcs.',
		'The narratorPromptCard and fastWorldSimInstructions are runtime-critical fields. Keep each under roughly 1200 words, preferably much less.',
		'Use schemeDirectives for executable plan changes. Use canonPatchSuggestions only for hard-canon proposals backed by evidence.',
	].filter(Boolean).join('\n');
	const maxChars = input.contextBudget ? Math.max(8000, Math.floor(input.contextBudget)) : 0;
	if (!maxChars || prompt.length <= maxChars) return prompt;
	const marker = '\nBUILD THE NEXT STRATEGIC WORLD FRAME';
	const tailAt = prompt.lastIndexOf(marker);
	if (tailAt < 0) return `${prompt.slice(0, maxChars - 3).trimEnd()}...`;
	const tail = prompt.slice(tailAt + 1);
	const headBudget = Math.max(1000, maxChars - tail.length - 48);
	return `${prompt.slice(0, headBudget).trimEnd()}\n\n[Context truncated to configured budget.]\n\n${tail}`;
}
