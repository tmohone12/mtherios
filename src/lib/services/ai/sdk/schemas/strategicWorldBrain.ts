import { z } from 'zod';

export const strategicBrainTriggerSchema = z.enum([
	'arc_created',
	'manual',
	'major_event',
	'scheme_threshold',
	'faction_shock',
	'scheme_exposed',
	'scheme_completed',
	'leader_killed',
	'war_declared',
	'treaty_signed',
	'territory_changed',
	'major_secret_revealed',
	'manual_debug_run',
]);

export const strategicVisibilitySchema = z.enum(['public', 'rumored', 'secret', 'unknown']);

const stringArray = z.preprocess((value) => {
	if (Array.isArray(value)) {
		return value
			.map(item => typeof item === 'string' ? item.trim() : JSON.stringify(item))
			.filter(Boolean);
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed ? [trimmed] : [];
	}
	if (value == null) return [];
	return [String(value)];
}, z.array(z.string()).default([]));

const confidence = z.preprocess((value) => {
	const numeric = asNumber(value);
	if (numeric == null) return value;
	if (numeric > 1) return Math.min(1, numeric / 100);
	return numeric;
}, z.number().min(0).max(1).default(0.5));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const match = value.match(/-?\d+(?:\.\d+)?/);
		if (!match) return undefined;
		const parsed = Number(match[0]);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function pressureBand(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
	const pressure = asNumber(value);
	if (pressure == null) return 'medium';
	if (pressure >= 80) return 'critical';
	if (pressure >= 60) return 'high';
	if (pressure >= 30) return 'medium';
	return 'low';
}

function normalizePressure(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
	const text = asString(value)?.toLowerCase();
	if (text) {
		if (['low', 'medium', 'high', 'critical'].includes(text)) return text as 'low' | 'medium' | 'high' | 'critical';
		if (/\b(critical|crisis|existential|extreme|severe|maximum)\b/.test(text)) return 'critical';
		if (/\b(high|urgent|volatile|major|strong)\b/.test(text)) return 'high';
		if (/\b(medium|moderate|rising|strained|active)\b/.test(text)) return 'medium';
		if (/\b(low|quiet|minor|dormant|background)\b/.test(text)) return 'low';
	}
	return pressureBand(value);
}

function normalizeUrgency(value: unknown): 'low' | 'rising' | 'urgent' | 'critical' {
	const text = asString(value)?.toLowerCase();
	if (text) {
		if (['low', 'rising', 'urgent', 'critical'].includes(text)) return text as 'low' | 'rising' | 'urgent' | 'critical';
		if (/\b(critical|crisis|existential|immediate|severe)\b/.test(text)) return 'critical';
		if (/\b(urgent|high|soon|fast|surging)\b/.test(text)) return 'urgent';
		if (/\b(rising|medium|active|building|steady)\b/.test(text)) return 'rising';
	}
	const pressure = asNumber(value);
	if (pressure == null) return 'rising';
	if (pressure >= 80) return 'critical';
	if (pressure >= 55) return 'urgent';
	if (pressure >= 25) return 'rising';
	return 'low';
}

function normalizePlotUrgency(value: unknown): 'simmer' | 'emerging' | 'immediate' {
	const text = asString(value)?.toLowerCase() ?? '';
	if (/immediate|urgent|critical|high|now/.test(text)) return 'immediate';
	if (/emerging|rising|medium|soon/.test(text)) return 'emerging';
	return 'simmer';
}

function normalizeClockVelocity(value: unknown): 'stalled' | 'slow' | 'steady' | 'fast' | 'surging' {
	const text = asString(value)?.toLowerCase() ?? '';
	if (/stall|block|pause|stop/.test(text)) return 'stalled';
	if (/slow|sluggish/.test(text)) return 'slow';
	if (/surg|accelerat|escalat|critical/.test(text)) return 'surging';
	if (/fast|rapid|quick/.test(text)) return 'fast';
	return 'steady';
}

function normalizeStrategicVisibility(value: unknown): 'public' | 'rumored' | 'secret' | 'unknown' | undefined {
	const text = asString(value)?.toLowerCase().replace(/[^a-z0-9]+/g, '_');
	if (!text) return undefined;
	if (['public', 'rumored', 'secret', 'unknown'].includes(text)) return text as 'public' | 'rumored' | 'secret' | 'unknown';
	if (/rumou?r|whisper|hearsay/.test(text)) return 'rumored';
	if (/secret|hidden|covert|private|classified/.test(text)) return 'secret';
	if (/public|visible|open|known|player_known/.test(text)) return 'public';
	return 'unknown';
}

function normalizeTimeHorizon(value: unknown): 'next_tick' | 'next_few_turns' | 'this_arc' | 'future_arc' | 'long_burn' | undefined {
	const text = asString(value)?.toLowerCase().replace(/[^a-z0-9]+/g, '_');
	if (!text) return undefined;
	if (['next_tick', 'next_few_turns', 'this_arc', 'future_arc', 'long_burn'].includes(text)) {
		return text as 'next_tick' | 'next_few_turns' | 'this_arc' | 'future_arc' | 'long_burn';
	}
	if (/immediate|now|next_turn|next_tick/.test(text)) return 'next_tick';
	if (/soon|short|near|few_turn/.test(text)) return 'next_few_turns';
	if (/future|next_arc|later/.test(text)) return 'future_arc';
	if (/long|slow_burn|eventual/.test(text)) return 'long_burn';
	return 'this_arc';
}

function normalizeExpectedPayoff(value: unknown): 'soon' | 'this_arc' | 'future_arc' | 'long_burn' | 'optional' {
	const text = asString(value)?.toLowerCase().replace(/[^a-z0-9]+/g, '_') ?? '';
	if (['soon', 'this_arc', 'future_arc', 'long_burn', 'optional'].includes(text)) {
		return text as 'soon' | 'this_arc' | 'future_arc' | 'long_burn' | 'optional';
	}
	if (/future|later|following_arc|next_arc/.test(text)) return 'future_arc';
	if (/immediate|next_turn|near|short/.test(text)) return 'soon';
	if (/long|slow|eventual/.test(text)) return 'long_burn';
	if (/optional|side|player_choice/.test(text)) return 'optional';
	return 'this_arc';
}

function normalizeOperationType(value: unknown): 'diplomatic' | 'military' | 'economic' | 'intelligence' | 'propaganda' | 'logistics' | 'internal' {
	const text = asString(value)?.toLowerCase() ?? '';
	if (['diplomatic', 'military', 'economic', 'intelligence', 'propaganda', 'logistics', 'internal'].includes(text)) {
		return text as 'diplomatic' | 'military' | 'economic' | 'intelligence' | 'propaganda' | 'logistics' | 'internal';
	}
	if (/\b(envoy|treaty|marriage|alliance|court|petition|oath|summons)\b/.test(text)) return 'diplomatic';
	if (/\b(raid|muster|army|fleet|patrol|battle|siege|soldier|troop|blockade)\b/.test(text)) return 'military';
	if (/\b(coin|debt|trade|market|price|tax|grain|supply|bank)\b/.test(text)) return 'economic';
	if (/\b(spy|agent|secret|blackmail|letter|surveillance|informant)\b/.test(text)) return 'intelligence';
	if (/\b(rumor|sermon|public|reputation|scandal|proclamation)\b/.test(text)) return 'propaganda';
	if (/\b(caravan|road|ship|port|warehouse|provision|transport)\b/.test(text)) return 'logistics';
	if (/\b(purge|succession|discipline|council|mutiny|loyalty)\b/.test(text)) return 'internal';
	return 'diplomatic';
}

function politicalTemperature(value: unknown): 'calm' | 'tense' | 'volatile' | 'war' | 'collapse' {
	const pressure = asNumber(value);
	if (pressure == null) return 'tense';
	if (pressure >= 95) return 'collapse';
	if (pressure >= 80) return 'war';
	if (pressure >= 60) return 'volatile';
	if (pressure >= 25) return 'tense';
	return 'calm';
}

function compact(value: unknown, max = 700): string {
	const text = asString(value)?.replace(/\s+/g, ' ') ?? '';
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
}

const strategicPlotKinds = [
	'main_plot', 'subplot', 'character_arc', 'faction_plot', 'mystery', 'war',
	'political_intrigue', 'survival', 'personal_goal', 'background_pressure',
] as const;

function normalizePlotKind(value: unknown, fallback: typeof strategicPlotKinds[number]): typeof strategicPlotKinds[number] {
	const text = asString(value)?.toLowerCase().replace(/[^a-z0-9]+/g, '_') ?? '';
	if (strategicPlotKinds.includes(text as typeof strategicPlotKinds[number])) return text as typeof strategicPlotKinds[number];
	if (/roman|relationship|character/.test(text)) return 'character_arc';
	if (/politic|conspiracy|intrigue/.test(text)) return 'political_intrigue';
	if (/mystery|secret|investigat/.test(text)) return 'mystery';
	if (/war|battle|invasion/.test(text)) return 'war';
	if (/survival/.test(text)) return 'survival';
	if (/personal|moral/.test(text)) return 'personal_goal';
	if (/background|social|economic/.test(text)) return 'background_pressure';
	if (/faction/.test(text)) return 'faction_plot';
	return fallback;
}

function normalizePlotLine(value: unknown, fallback: typeof strategicPlotKinds[number] = 'faction_plot'): unknown {
	if (!isRecord(value)) return value;
	return {
		...value,
		title: value.title ?? value.name ?? 'Strategic plot pressure',
		kind: normalizePlotKind(value.kind, fallback),
		pressure: normalizePressure(value.pressure),
		summary: value.summary ?? value.description ?? value.reason ?? 'Strategic pressure is rising.',
		linkedSchemeIds: value.linkedSchemeIds ?? [],
		linkedFactionGoalIds: value.linkedFactionGoalIds ?? [],
		linkedThreadIds: value.linkedThreadIds ?? [],
		expectedPayoff: normalizeExpectedPayoff(value.expectedPayoff ?? value.timeHorizon),
		playerAgency: value.playerAgency ?? 'world_driven',
	};
}

function normalizeSchemeDirective(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const rawType = asString(value.type);
	const mappedType = ({
		create: 'create_scheme',
		update: 'update_scheme',
		advance: 'advance_scheme',
		stall: 'stall_scheme',
		fork: 'fork_scheme',
		merge: 'merge_scheme',
		expose: 'expose_scheme',
		complete: 'complete_scheme',
		retire: 'retire_scheme',
	} as Record<string, string>)[rawType ?? ''] ?? rawType;
	const title = value.title ?? value.name;
	const description = value.description ?? value.goal ?? value.reason ?? title;
	return {
		...value,
		type: mappedType,
		schemeId: value.schemeId ?? value.id,
		title,
		ownerType: value.ownerType ?? (value.factionId ? 'faction' : undefined),
		ownerName: value.ownerName ?? value.factionName ?? value.ownerId ?? value.factionId,
		goal: value.goal ?? description,
		progressDelta: value.progressDelta ?? value.progress,
		pressureDelta: value.pressureDelta ?? value.progress,
		visibleEffects: stringArray.parse(value.visibleEffects),
		hiddenEffects: stringArray.parse(value.hiddenEffects),
		nextMoves: stringArray.parse(value.nextMoves),
		linkedFactionGoalIds: value.linkedFactionGoalIds ?? [],
		linkedThreadIds: value.linkedThreadIds ?? [],
		linkedWorldEventIds: value.linkedWorldEventIds ?? [],
		evidenceRefs: value.evidenceRefs ?? [],
		confidence: value.confidence,
		reason: value.reason ?? description ?? 'Strategic directive proposed by the world brain.',
	};
}

function normalizeFactionOperation(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const action = value.operation ?? value.action ?? value.nextAction ?? value.move ?? value.description ?? value.objective;
	const objective = value.objective ?? value.goal ?? value.reason ?? action;
	return {
		...value,
		id: value.id ?? value.operationId ?? '',
		factionName: value.factionName ?? value.ownerName ?? value.owner ?? value.faction,
		operation: action ?? 'Background faction operation',
		objective: objective ?? 'Advance faction goals without direct player involvement.',
		actionType: normalizeOperationType(value.actionType ?? value.kind ?? value.type ?? action),
		target: value.target ?? value.targetName ?? value.targetFaction ?? value.targetLocation ?? null,
		urgency: normalizeUrgency(value.urgency ?? value.pressure ?? value.priority),
		visibility: normalizeStrategicVisibility(value.visibility ?? value.secrecy) ?? 'secret',
		timeHorizon: normalizeTimeHorizon(value.timeHorizon ?? value.horizon ?? value.when) ?? 'this_arc',
		triggerConditions: stringArray.parse(value.triggerConditions ?? value.triggers ?? value.tickTriggers),
		stallConditions: stringArray.parse(value.stallConditions ?? value.blockers ?? value.stallTriggers),
		visibleSignals: stringArray.parse(value.visibleSignals ?? value.visibleEffects ?? value.publicSignals),
		hiddenSteps: stringArray.parse(value.hiddenSteps ?? value.hiddenEffects ?? value.steps),
		linkedClockIds: value.linkedClockIds ?? value.clockIds ?? [],
		linkedSchemeIds: value.linkedSchemeIds ?? value.schemeIds ?? [],
		evidenceRefs: value.evidenceRefs ?? [],
		confidence: value.confidence,
	};
}

function normalizeCanonPatch(value: unknown): unknown {
	if (!isRecord(value)) return value;
	if (value.type) return value;
	return {
		type: 'custom',
		label: [
			asString(value.entityId),
			asString(value.field),
		].filter(Boolean).join('.') || 'strategic_canon_patch',
		payload: value,
		confidence: value.confidence ?? 0.65,
		evidenceRefs: value.evidenceRefs ?? [],
		reason: value.reason ?? 'Strategic brain proposed a canon patch.',
	};
}

function normalizeStrategicWorldFrame(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const frame: Record<string, unknown> = { ...value };
	const plotUpdates = Array.isArray(frame.plotUpdates) ? frame.plotUpdates.map(item => normalizePlotLine(item)) : [];

	if (!Array.isArray(frame.tensionSeeds) && Array.isArray(frame.tensions)) frame.tensionSeeds = frame.tensions;
	if (!Array.isArray(frame.antagonistCandidates) && Array.isArray(frame.actors)) frame.antagonistCandidates = frame.actors;
	if (!Array.isArray(frame.plotCards) && Array.isArray(frame.plots)) frame.plotCards = frame.plots;
	if (!isRecord(frame.activationPlan) && isRecord(frame.plotActivationPlan)) frame.activationPlan = frame.plotActivationPlan;
	if (!isRecord(frame.plotBrainWritePlan) && isRecord(frame.writePlan)) frame.plotBrainWritePlan = frame.writePlan;

	if (!Array.isArray(frame.mainPlots) && plotUpdates.length > 0) {
		frame.mainPlots = plotUpdates.filter((plot, index) =>
			isRecord(plot) && (plot.pressure === 'critical' || plot.pressure === 'high' || index < 2),
		);
	}
	if (!Array.isArray(frame.subplots) && plotUpdates.length > 0) {
		frame.subplots = plotUpdates.filter((plot) =>
			isRecord(plot) && plot.pressure !== 'critical' && plot.pressure !== 'high',
		);
	}
	if (Array.isArray(frame.mainPlots)) {
		frame.mainPlots = frame.mainPlots.map(item => normalizePlotLine(item, 'main_plot'));
	}
	if (Array.isArray(frame.subplots)) {
		frame.subplots = frame.subplots.map(item => normalizePlotLine(item, 'subplot'));
	}

	if (Array.isArray(frame.schemeDirectives)) {
		frame.schemeDirectives = frame.schemeDirectives.map(normalizeSchemeDirective);
	}
	const rawOperations = Array.isArray(frame.factionOperations)
		? frame.factionOperations
		: Array.isArray(frame.backgroundFactionMoves)
			? frame.backgroundFactionMoves
			: Array.isArray(frame.factionMoves)
				? frame.factionMoves
				: Array.isArray(frame.operations)
					? frame.operations
					: [];
	frame.factionOperations = rawOperations.map(normalizeFactionOperation);
	if (Array.isArray(frame.canonPatchSuggestions)) {
		frame.canonPatchSuggestions = frame.canonPatchSuggestions.map(normalizeCanonPatch);
	}
	if (!isRecord(frame.warPressureCard) && isRecord(frame.warPressure)) {
		frame.warPressureCard = frame.warPressure;
	}
	if (!isRecord(frame.warPressureCard) && isRecord(frame.warCard)) {
		frame.warPressureCard = frame.warCard;
	}
	if (!isRecord(frame.warPressureCard) && isRecord(frame.war_pressure_card)) {
		frame.warPressureCard = frame.war_pressure_card;
	}
	if (!isRecord(frame.worldMood) && frame.globalPressureLevel != null) {
		frame.worldMood = {
			politicalTemperature: politicalTemperature(frame.globalPressureLevel),
		};
	}
	if (!isRecord(frame.continuityAssessment)) {
		frame.continuityAssessment = {
			summary: compact(frame.publicSummary ?? frame.narratorPromptCard ?? frame.fastWorldSimInstructions),
			unresolvedContinuityRisks: [],
			staleThreads: [],
			contradictionsToReview: [],
		};
	}
	if (!asString(frame.publicSummary)) {
		frame.publicSummary = compact(frame.narratorPromptCard ?? frame.fastWorldSimInstructions);
	}
	if (!asString(frame.hiddenStrategicSummary)) {
		frame.hiddenStrategicSummary = compact(frame.fastWorldSimInstructions ?? frame.narratorPromptCard);
	}

	return frame;
}

const strategicEvidenceSourceTypes = [
		'arc',
		'chapter',
		'scheme',
		'thread',
		'world_event',
		'faction',
		'rumor',
		'agreement',
		'entry',
		'memory',
		'unknown',
] as const;

export const strategicEvidenceRefSchema = z.object({
	sourceType: z.preprocess((value) => {
		const normalized = asString(value)?.toLowerCase().replace(/[^a-z0-9]+/g, '_');
		return strategicEvidenceSourceTypes.includes(normalized as typeof strategicEvidenceSourceTypes[number]) ? normalized : 'unknown';
	}, z.enum(strategicEvidenceSourceTypes).default('unknown')),
	sourceId: z.string().nullable().optional(),
	label: z.string().default('Unspecified evidence'),
	note: z.string().nullable().optional(),
});

const evidenceRefsArray = z.preprocess((value) => {
	if (Array.isArray(value)) {
		return value.map(item => typeof item === 'string'
			? { sourceType: 'unknown', label: item }
			: item);
	}
	if (typeof value === 'string' && value.trim()) {
		return [{ sourceType: 'unknown', label: value.trim() }];
	}
	if (isRecord(value)) return [value];
	return [];
}, z.array(strategicEvidenceRefSchema).default([]));

export const strategicPlotLineSchema = z.object({
	title: z.string(),
	kind: z.enum(strategicPlotKinds).default('background_pressure'),
	pressure: z.preprocess(normalizePressure, z.enum(['low', 'medium', 'high', 'critical']).default('medium')),
	summary: z.string(),
	linkedSchemeIds: stringArray,
	linkedFactionGoalIds: stringArray,
	linkedThreadIds: stringArray,
	expectedPayoff: z.preprocess(normalizeExpectedPayoff, z.enum(['soon', 'this_arc', 'future_arc', 'long_burn', 'optional']).default('this_arc')),
	playerAgency: z.enum(['player_driven', 'world_driven', 'reactive', 'background']).default('world_driven'),
});

const boundedScore = z.preprocess((value) => {
	const numeric = asNumber(value);
	if (numeric == null) return value;
	return Math.max(0, Math.min(100, numeric));
}, z.number().min(0).max(100).default(50));

export const plotBrainTensionSeedSchema = z.object({
	id: z.string().default(''),
	title: z.string().default('Unresolved tension'),
	kind: z.enum([
		'debt', 'oath', 'rivalry', 'resource_shortage', 'succession', 'secret',
		'romantic_pressure', 'faction_goal_conflict', 'wounded_pride', 'mystery',
		'threat', 'moral_contradiction', 'earned_goodwill', 'location_pressure', 'other',
	]).default('other'),
	involvedEntityIds: stringArray,
	involvedFactionIds: stringArray,
	involvedLocationIds: stringArray,
	pressure: boundedScore,
	volatility: boundedScore,
	playerRelevance: boundedScore,
	canonConfidence: confidence,
	unresolvedQuestion: z.string().default(''),
	whyItMatters: z.string().default(''),
	evidenceRefs: evidenceRefsArray,
});

export const plotBrainAntagonistCandidateSchema = z.object({
	id: z.string().default(''),
	actorEntityId: z.string().nullable().optional(),
	actorFactionId: z.string().nullable().optional(),
	name: z.string().default('Unknown actor'),
	role: z.enum([
		'primary_antagonist', 'subplot_antagonist', 'rival', 'pressure_actor',
		'false_antagonist', 'tragic_opponent', 'hidden_patron', 'unwitting_catalyst',
	]).default('pressure_actor'),
	tensionSeedIds: stringArray,
	motive: z.string().default(''),
	fear: z.string().default(''),
	woundOrNeed: z.string().default(''),
	method: z.string().default(''),
	lineTheyWillNotCross: z.string().default(''),
	escalationTrigger: z.string().default(''),
	hesitationTrigger: z.string().default(''),
	plausibilityScore: boundedScore,
	dramaticScore: boundedScore,
	agencyRisk: boundedScore,
	evidenceRefs: evidenceRefsArray,
});

export const plotBrainClueSchema = z.object({
	clue: z.string(),
	delivery: z.enum(['rumor', 'scene_detail', 'npc_behavior', 'document', 'found_object', 'absence', 'price_or_resource', 'direct_confession', 'other']).default('other'),
	truth: z.string().default(''),
	visibility: z.enum(['subtle', 'obvious']).default('subtle'),
	evidenceRefs: evidenceRefsArray,
});

export const plotBrainPressureBeatSchema = z.object({
	delayTurns: z.number().int().min(0).max(50).default(1),
	title: z.string(),
	body: z.string(),
	urgency: z.preprocess(normalizePlotUrgency, z.enum(['simmer', 'emerging', 'immediate']).default('simmer')),
	visibility: z.enum(['secret', 'player_known', 'public']).default('secret'),
	actorEntityIds: stringArray,
	targetEntityIds: stringArray,
	locationIds: stringArray,
	factionIds: stringArray,
	memoryImpact: z.record(z.string(), z.unknown()).default({}),
});

export const plotBrainPlotCardSchema = z.object({
	id: z.string().default(''),
	title: z.string(),
	logline: z.string().default(''),
	kind: z.enum([
		'main_plot', 'subplot', 'character_arc', 'faction_plot', 'mystery', 'war',
		'political_intrigue', 'survival', 'personal_goal', 'background_pressure',
		'romantic_complication', 'moral_dilemma', 'social_pressure', 'economic_pressure',
	]).default('subplot'),
	lifecycleStage: z.enum(['seed', 'simmer', 'reveal', 'escalate', 'crisis', 'fallout', 'resolved', 'dormant']).default('seed'),
	pressure: boundedScore,
	urgency: z.enum(['dormant', 'simmer', 'emerging', 'immediate']).default('simmer'),
	visibility: z.enum(['secret', 'rumored', 'player_known', 'public']).default('secret'),
	actorEntityIds: stringArray,
	actorFactionIds: stringArray,
	antagonistCandidateIds: stringArray,
	targetEntityIds: stringArray,
	targetFactionIds: stringArray,
	locationIds: stringArray,
	goal: z.string().default(''),
	motive: z.string().default(''),
	method: z.string().default(''),
	stakes: z.string().default(''),
	playerTouchpoints: stringArray,
	clueTrail: z.array(plotBrainClueSchema).default([]),
	pressureBeats: z.array(plotBrainPressureBeatSchema).default([]),
	ignoredOutcome: z.string().default(''),
	successOutcome: z.string().default(''),
	failureOutcome: z.string().default(''),
	partialOutcome: z.string().default(''),
	sourceRefs: evidenceRefsArray,
	continuityRisks: stringArray,
	antiRailroadNotes: stringArray,
});

export const plotBrainActivationPlanSchema = z.object({
	activateNow: stringArray,
	keepDormant: stringArray,
	retireOrMerge: stringArray,
	rationale: z.string().default(''),
}).default({ activateNow: [], keepDormant: [], retireOrMerge: [], rationale: '' });

export const plotBrainWritePlanSchema = z.object({
	storyThreadCreates: z.array(z.record(z.string(), z.unknown())).default([]),
	storyThreadUpdates: z.array(z.object({
		threadId: z.string(),
		status: z.enum(['open', 'imminent', 'stalled', 'closed', 'abandoned']).optional(),
		significance: z.enum(['minor', 'moderate', 'major', 'critical']).optional(),
		description: z.string().optional(),
		reason: z.string().default('Strategic plot brain update.'),
	})).default([]),
	timelineEvents: z.array(plotBrainPressureBeatSchema.extend({
		plotCardId: z.string().default(''),
		threadId: z.string().nullable().optional(),
		sourceRefs: evidenceRefsArray,
	})).default([]),
	patchProposals: z.array(z.record(z.string(), z.unknown())).default([]),
}).default({ storyThreadCreates: [], storyThreadUpdates: [], timelineEvents: [], patchProposals: [] });

export const verboseFactionGoalDirectiveSchema = z.object({
	type: z.enum(['create_goal', 'update_goal', 'retire_goal', 'reframe_goal']),
	factionName: z.string(),
	goalId: z.string().nullable().optional(),
	title: z.string().nullable().optional(),
	description: z.string(),
	publicAim: z.string().nullable().optional(),
	hiddenAim: z.string().nullable().optional(),
	priority: z.number().min(1).max(10).optional(),
	urgency: z.enum(['dormant', 'low', 'rising', 'urgent', 'existential']).optional(),
	progressDelta: z.number().min(-100).max(100).optional(),
	desiredEndState: z.string().nullable().optional(),
	currentPhase: z.string().nullable().optional(),
	constraints: stringArray,
	dependencies: stringArray,
	blockers: stringArray,
	risks: stringArray,
	linkedSchemeIds: stringArray,
	linkedThreadIds: stringArray,
	evidenceRefs: evidenceRefsArray,
	confidence,
	reason: z.string(),
});

export const schemeDirectiveSchema = z.object({
	type: z.enum([
		'create_scheme',
		'update_scheme',
		'advance_scheme',
		'stall_scheme',
		'fork_scheme',
		'merge_scheme',
		'expose_scheme',
		'complete_scheme',
		'retire_scheme',
	]),
	schemeId: z.string().nullable().optional(),
	title: z.string().nullable().optional(),
	ownerType: z.enum(['faction', 'character', 'player', 'unknown']).optional(),
	ownerName: z.string().nullable().optional(),
	goal: z.string().nullable().optional(),
	progressDelta: z.number().min(-100).max(100).optional(),
	pressureDelta: z.number().min(-100).max(100).optional(),
	newStage: z.string().nullable().optional(),
	visibility: strategicVisibilitySchema.optional(),
	status: z.enum(['incubating', 'active', 'climaxing', 'resolved', 'foiled', 'abandoned']).nullable().optional(),
	visibleEffects: stringArray,
	hiddenEffects: stringArray,
	nextMoves: stringArray,
	linkedFactionGoalIds: stringArray,
	linkedThreadIds: stringArray,
	linkedWorldEventIds: stringArray,
	evidenceRefs: evidenceRefsArray,
	confidence,
	reason: z.string(),
});

export const strategicClockSchema = z.object({
	id: z.string(),
	name: z.string(),
	ownerFactionName: z.string(),
	progress: z.number().min(0).max(100).default(0),
	velocity: z.preprocess(normalizeClockVelocity, z.enum(['stalled', 'slow', 'steady', 'fast', 'surging']).default('steady')),
	goal: z.string(),
	visibleToPlayer: z.boolean().default(false),
	tickTriggers: stringArray,
	stallTriggers: stringArray,
	completionConsequences: stringArray,
	currentPhase: z.string(),
});

export const strategicRumorSeedSchema = z.object({
	text: z.string(),
	origin: z.string().default('unknown'),
	truthLevel: z.enum(['false', 'partial', 'true', 'unknown']).default('partial'),
	relatedFactionNames: stringArray,
	revealConditions: stringArray,
});

export const strategicWarPressureCardSchema = z.object({
	phase: z.string().default('tension'),
	mainFactions: stringArray,
	warAims: stringArray,
	frontsOrTheaters: stringArray,
	importantSchemes: stringArray,
	visibleSigns: stringArray,
	hiddenFacts: stringArray,
	nextEscalationIfIgnored: z.string().default('War pressure continues to build gradually.'),
	playerInterventionPoints: stringArray,
}).nullable().default(null);

export const strategicFactionOperationSchema = z.object({
	id: z.string().default(''),
	factionName: z.string(),
	operation: z.string(),
	objective: z.string().default('Advance faction goals without direct player involvement.'),
	actionType: z.preprocess(normalizeOperationType, z.enum(['diplomatic', 'military', 'economic', 'intelligence', 'propaganda', 'logistics', 'internal']).default('diplomatic')),
	target: z.string().nullable().optional(),
	urgency: z.preprocess(normalizeUrgency, z.enum(['low', 'rising', 'urgent', 'critical']).default('rising')),
	visibility: z.preprocess(normalizeStrategicVisibility, strategicVisibilitySchema).default('secret'),
	timeHorizon: z.preprocess(normalizeTimeHorizon, z.enum(['next_tick', 'next_few_turns', 'this_arc', 'future_arc', 'long_burn'])).default('this_arc'),
	triggerConditions: stringArray,
	stallConditions: stringArray,
	visibleSignals: stringArray,
	hiddenSteps: stringArray,
	resourcePressure: z.record(z.enum(['military', 'wealth', 'influence', 'information', 'morale']), z.number().min(-100).max(100)).optional(),
	linkedClockIds: stringArray,
	linkedSchemeIds: stringArray,
	evidenceRefs: evidenceRefsArray,
	confidence,
});

export const worldEventSuggestionSchema = z.object({
	title: z.string(),
	description: z.string(),
	type: z.string().default('strategic_pressure'),
	visibility: z.preprocess(normalizeStrategicVisibility, strategicVisibilitySchema).default('unknown'),
	linkedSchemeIds: stringArray,
	linkedThreadIds: stringArray,
	evidenceRefs: evidenceRefsArray,
	confidence,
});

export const strategicCanonPatchSchema = z.object({
	type: z.string(),
	reason: z.string().default(''),
	confidence,
	evidenceRefs: evidenceRefsArray,
}).catchall(z.unknown());

const strategicWorldFrameBaseSchema = z.object({
	id: z.string().optional().default(''),
	storyId: z.string().optional().default(''),
	arcId: z.string().nullable().optional(),
	arcNumber: z.number().int().nonnegative().default(0),
	trigger: strategicBrainTriggerSchema.default('manual'),
	chapterRange: z.object({
		from: z.number().int().nonnegative().default(0),
		to: z.number().int().nonnegative().default(0),
	}).default({ from: 0, to: 0 }),
	createdAt: z.preprocess((value) => {
		if (typeof value === 'string') {
			const parsed = Date.parse(value);
			return Number.isFinite(parsed) ? parsed : 0;
		}
		return value;
	}, z.number().optional().default(0)),
	continuityAssessment: z.object({
		summary: z.string().default(''),
		unresolvedContinuityRisks: stringArray,
		staleThreads: stringArray,
		contradictionsToReview: stringArray,
	}).default({
		summary: '',
		unresolvedContinuityRisks: [],
		staleThreads: [],
		contradictionsToReview: [],
	}),
	worldMood: z.object({
		politicalTemperature: z.enum(['calm', 'tense', 'volatile', 'war', 'collapse']).default('tense'),
		supernaturalPressure: z.enum(['none', 'low', 'rising', 'dominant']).optional(),
		economicPressure: z.enum(['stable', 'strained', 'scarcity', 'famine']).optional(),
		socialPressure: z.enum(['stable', 'anxious', 'unrest', 'rebellion']).optional(),
	}).default({ politicalTemperature: 'tense' }),
	publicSummary: z.string().default(''),
	hiddenStrategicSummary: z.string().default(''),
	mainPlots: z.array(strategicPlotLineSchema).default([]),
	subplots: z.array(strategicPlotLineSchema).default([]),
	factionGoalUpdates: z.array(verboseFactionGoalDirectiveSchema).default([]),
	schemeDirectives: z.array(schemeDirectiveSchema).default([]),
	strategicClocks: z.array(strategicClockSchema).default([]),
	factionOperations: z.array(strategicFactionOperationSchema).default([]),
	warPressureCard: strategicWarPressureCardSchema,
	rumorSeeds: z.array(strategicRumorSeedSchema).default([]),
	worldEventSuggestions: z.array(worldEventSuggestionSchema).default([]),
	fastWorldSimInstructions: z.string().default(''),
	narratorPromptCard: z.string().default(''),
	canonPatchSuggestions: z.array(strategicCanonPatchSchema).default([]),
	tensionSeeds: z.array(plotBrainTensionSeedSchema).default([]),
	antagonistCandidates: z.array(plotBrainAntagonistCandidateSchema).default([]),
	plotCards: z.array(plotBrainPlotCardSchema).default([]),
	activationPlan: plotBrainActivationPlanSchema,
	plotBrainWritePlan: plotBrainWritePlanSchema,
});

export const strategicWorldFrameSchema = z.preprocess(
	normalizeStrategicWorldFrame,
	strategicWorldFrameBaseSchema,
);

export function hasStrategicPlotContent(value: unknown): boolean {
	const parsed = strategicWorldFrameSchema.safeParse(value);
	return parsed.success && (parsed.data.mainPlots.length > 0 || parsed.data.subplots.length > 0 || parsed.data.plotCards.length > 0);
}

export type StrategicWorldFrameResult = z.infer<typeof strategicWorldFrameSchema>;
export type SchemeDirectiveResult = z.infer<typeof schemeDirectiveSchema>;
