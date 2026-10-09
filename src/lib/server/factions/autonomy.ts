export { canonicalFactionIdentity, isWorldSimEligibleFaction } from '$lib/services/ai/context/factionEligibility';

export type FactionDoctrineKind =
	| 'feudal_house'
	| 'commercial'
	| 'faith'
	| 'military_order'
	| 'intrigue_network'
	| 'civic'
	| 'scholarly'
	| 'generic';

export type FactionMoveActionType =
	| 'military'
	| 'diplomatic'
	| 'economic'
	| 'intelligence'
	| 'internal'
	| 'dynastic'
	| 'intrigue'
	| 'religious'
	| 'seasonal';

export interface FactionProjectSeed {
	id: string;
	project: string;
	projectKind: string;
	progress: number;
	nextActionTurn: number;
	targetFactionId: string | null;
	subjectEntityId: string | null;
	targetEntityId: string | null;
}

export interface FactionMovePlan {
	factionKind: FactionDoctrineKind;
	actionType: FactionMoveActionType;
	projectKind: string | null;
	objective: string;
	action: string;
	motivation: string;
	consequences: string[];
	urgency: 'low' | 'medium' | 'high' | 'critical';
	delayTurns: number;
	publicSignal: string;
	projectId: string | null;
	projectProgressBefore: number | null;
	projectProgressAfter: number | null;
	startProject: FactionProjectSeed | null;
	actorEntityIds: string[];
	targetEntityIds: string[];
	targetFactionIds: string[];
	targetFactionNames: string[];
}

export interface FactionMoveVariant {
	actionType: FactionMoveActionType;
	projectKind: string | null;
}

interface FactionCandidate {
	id: string;
	name: string;
	pressure: number;
	metadata: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function normalized(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function stableNumber(parts: string[]): number {
	let hash = 2166136261;
	for (const char of parts.join('|')) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function stableSlug(value: string): string {
	const slug = normalized(value).replace(/\s+/g, '_') || 'move';
	if (slug.length <= 64) return slug;
	const hash = stableNumber([value]).toString(16).padStart(8, '0');
	return `${slug.slice(0, 55)}_${hash}`;
}

function explicitFactionKind(value: unknown): FactionDoctrineKind | null {
	const key = normalized(text(value));
	if (!key) return null;
	if (/\b(feudal|noble|house|court|dynasty|clan)\b/.test(key)) return 'feudal_house';
	if (/\b(commercial|merchant|guild|bank|company|trade)\b/.test(key)) return 'commercial';
	if (/\b(faith|religion|religious|cult|church|temple)\b/.test(key)) return 'faith';
	if (/\b(military|army|watch|guard|mercenary|knightly)\b/.test(key)) return 'military_order';
	if (/\b(intrigue|intelligence|criminal|secret society|spy)\b/.test(key)) return 'intrigue_network';
	if (/\b(civic|government|council|city|realm|kingdom)\b/.test(key)) return 'civic';
	if (/\b(scholarly|academy|school|arcane|maester)\b/.test(key)) return 'scholarly';
	return null;
}

export function inferFactionDoctrine(input: {
	name: string;
	metadata?: unknown;
	entityMetadata?: unknown;
	entityState?: unknown;
	entityDescription?: string | null;
}): FactionDoctrineKind {
	const metadata = asRecord(input.metadata);
	const entityMetadata = asRecord(input.entityMetadata);
	const entityState = asRecord(input.entityState);
	const classification = asRecord(entityMetadata.classification);
	for (const value of [
		metadata.factionType,
		metadata.factionKind,
		metadata.archetype,
		metadata.kind,
		metadata.category,
		entityState.factionType,
		entityState.archetype,
		entityState.kind,
		entityMetadata.factionType,
		entityMetadata.archetype,
		entityMetadata.kind,
		entityMetadata.sourcePrefix,
		classification.sourcePrefix,
	]) {
		const explicit = explicitFactionKind(value);
		if (explicit) return explicit;
	}
	const corpus = normalized([
		input.name,
		input.entityDescription ?? '',
		text(metadata.description),
		text(entityMetadata.description),
	].join(' '));
	if (/\b(house|dynasty|noble|court|clan|great family|old blood)\b/.test(corpus)) return 'feudal_house';
	if (/\b(bank|guild|merchant|company|trade|traders|commerce|coin)\b/.test(corpus)) return 'commercial';
	if (/\b(faith|religion|religious|cult|church|temple|priest|sept|god)\b/.test(corpus)) return 'faith';
	if (/\b(army|watch|guard|military|mercenary|knight|warrior|fleet|legion|order)\b/.test(corpus)) return 'military_order';
	if (/\b(spy|assassin|criminal|thief|smuggler|syndicate|secret society|intelligence)\b/.test(corpus)) return 'intrigue_network';
	if (/\b(council|government|senate|magistrate|kingdom|realm|free city|city state)\b/.test(corpus)) return 'civic';
	if (/\b(academy|school|scholar|maester|library|arcane|mage|wizard)\b/.test(corpus)) return 'scholarly';
	return 'generic';
}

function actionTypeFromProject(project: { project: string; metadata?: unknown } | null | undefined): FactionMoveActionType | null {
	if (!project) return null;
	const explicit = normalized(text(asRecord(project.metadata).actionType));
	const allowed: FactionMoveActionType[] = ['military', 'diplomatic', 'economic', 'intelligence', 'internal', 'dynastic', 'intrigue', 'religious', 'seasonal'];
	if (allowed.includes(explicit as FactionMoveActionType)) return explicit as FactionMoveActionType;
	const corpus = normalized(project.project);
	if (/\b(marriage|betrothal|heir|succession|legitimiz|dowry|dynast)\b/.test(corpus)) return 'dynastic';
	if (/\b(raid|siege|muster|army|troops|fleet|patrol|war)\b/.test(corpus)) return 'military';
	if (/\b(loan|trade|contract|embargo|market|debt|supply)\b/.test(corpus)) return 'economic';
	if (/\b(spy|informant|surveillance|intercept|intelligence)\b/.test(corpus)) return 'intelligence';
	if (/\b(blackmail|assassin|bribe|infiltrat|poison|sabotage)\b/.test(corpus)) return 'intrigue';
	if (/\b(faith|convert|doctrine|heresy|priest|ritual|censure)\b/.test(corpus)) return 'religious';
	if (/\b(envoy|treaty|alliance|ward|oath|claim|council)\b/.test(corpus)) return 'diplomatic';
	return 'internal';
}

function variantsFor(kind: FactionDoctrineKind): FactionMoveVariant[] {
	switch (kind) {
		case 'feudal_house': return [
			{ actionType: 'dynastic', projectKind: 'marriage_negotiation' },
			{ actionType: 'diplomatic', projectKind: 'wardship_exchange' },
			{ actionType: 'dynastic', projectKind: 'marriage_negotiation' },
			{ actionType: 'dynastic', projectKind: 'succession_settlement' },
			{ actionType: 'military', projectKind: null },
			{ actionType: 'diplomatic', projectKind: 'land_claim' },
		];
		case 'commercial': return [
			{ actionType: 'economic', projectKind: 'trade_contract' },
			{ actionType: 'economic', projectKind: 'credit_pressure' },
			{ actionType: 'internal', projectKind: null },
			{ actionType: 'intelligence', projectKind: null },
		];
		case 'faith': return [
			{ actionType: 'religious', projectKind: 'doctrinal_campaign' },
			{ actionType: 'religious', projectKind: 'appointment' },
			{ actionType: 'diplomatic', projectKind: null },
		];
		case 'military_order': return [
			{ actionType: 'military', projectKind: 'muster' },
			{ actionType: 'military', projectKind: 'patrol_network' },
			{ actionType: 'internal', projectKind: null },
		];
		case 'intrigue_network': return [
			{ actionType: 'intelligence', projectKind: 'informant_network' },
			{ actionType: 'intrigue', projectKind: 'blackmail_operation' },
			{ actionType: 'internal', projectKind: null },
			{ actionType: 'intrigue', projectKind: null },
		];
		case 'civic': return [
			{ actionType: 'diplomatic', projectKind: 'envoy_mission' },
			{ actionType: 'internal', projectKind: 'council_measure' },
			{ actionType: 'economic', projectKind: null },
		];
		case 'scholarly': return [
			{ actionType: 'intelligence', projectKind: 'research_program' },
			{ actionType: 'internal', projectKind: 'relic_inquiry' },
			{ actionType: 'internal', projectKind: null },
			{ actionType: 'diplomatic', projectKind: null },
		];
		default: return [
			{ actionType: 'internal', projectKind: null },
			{ actionType: 'diplomatic', projectKind: null },
			{ actionType: 'intelligence', projectKind: null },
		];
	}
}

function variantNeedsTarget(variant: FactionMoveVariant): boolean {
	return ['marriage_negotiation', 'wardship_exchange', 'land_claim', 'trade_contract', 'credit_pressure', 'informant_network', 'blackmail_operation', 'envoy_mission', 'research_program'].includes(variant.projectKind ?? '')
		|| (!variant.projectKind && ['diplomatic', 'economic', 'intelligence', 'intrigue'].includes(variant.actionType));
}

export function eligibleFactionMoveVariants(kind: FactionDoctrineKind, allowProjectStart: boolean, hasTarget = true): FactionMoveVariant[] {
	const seen = new Set<string>();
	const variants = variantsFor(kind).filter((variant) => {
		if (!allowProjectStart && variant.projectKind) return false;
		if (!hasTarget && variantNeedsTarget(variant)) return false;
		const key = `${variant.actionType}:${variant.projectKind ?? 'none'}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return variants.length ? variants : [{ actionType: 'internal', projectKind: null }];
}

function projectLabel(kind: string, target: string | null, objective: string): string {
	const destination = target ?? 'a suitable counterpart';
	switch (kind) {
		case 'marriage_negotiation': return `Negotiate a dynastic marriage with ${destination}`;
		case 'wardship_exchange': return `Arrange a wardship exchange with ${destination}`;
		case 'succession_settlement': return 'Secure the house succession';
		case 'land_claim': return `Press a territorial claim against ${destination}`;
		case 'trade_contract': return `Secure a long-term contract with ${destination}`;
		case 'credit_pressure': return `Build financial leverage over ${destination}`;
		case 'doctrinal_campaign': return 'Expand doctrinal influence';
		case 'appointment': return 'Place a loyal religious appointee';
		case 'muster': return 'Prepare a disciplined muster';
		case 'patrol_network': return 'Extend patrol and warning routes';
		case 'informant_network': return `Build an informant network around ${destination}`;
		case 'blackmail_operation': return `Develop leverage over ${destination}`;
		case 'envoy_mission': return `Win concessions from ${destination}`;
		case 'council_measure': return 'Pass a favorable council measure';
		case 'research_program': return `Investigate evidence connected to ${destination}`;
		case 'relic_inquiry': return 'Locate and authenticate a valuable relic';
		default: return objective;
	}
}

function moveLanguage(input: {
	factionName: string;
	actionType: FactionMoveActionType;
	projectKind: string | null;
	objective: string;
	targetName: string | null;
	subjectName: string | null;
	targetEntityName: string | null;
	progressAfter: number | null;
}): { action: string; signal: string } {
	const target = input.targetName ?? 'a useful counterpart';
	if (input.projectKind === 'marriage_negotiation') {
		const pair = input.subjectName && input.targetEntityName ? ` between ${input.subjectName} and ${input.targetEntityName}` : '';
		const verb = (input.progressAfter ?? 0) >= 1 ? 'concludes' : (input.progressAfter ?? 0) >= 0.66 ? 'formalizes terms for' : (input.progressAfter ?? 0) >= 0.33 ? 'bargains over the terms of' : 'opens discreet talks for';
		return {
			action: `${input.factionName} ${verb} a dynastic marriage with ${target}${pair}.`,
			signal: `Envoys, genealogists, and dowry assessors linked to ${input.factionName} are seen traveling between courts.`,
		};
	}
	if (input.projectKind === 'wardship_exchange') return {
		action: `${input.factionName} negotiates a wardship exchange with ${target} to bind the next generation to its interests.`,
		signal: `A guarded young retinue and new tutors are being prepared under ${input.factionName}'s colors.`,
	};
	if (input.projectKind === 'succession_settlement') return {
		action: `${input.factionName} quietly gathers witnesses, genealogies, and oaths to settle its succession before rivals can exploit it.`,
		signal: `Household knights and legal witnesses receive unusual summons from ${input.factionName}.`,
	};
	const byType: Record<FactionMoveActionType, { action: string; signal: string }> = {
		military: { action: `${input.factionName} musters, scouts, and repositions forces to advance ${input.objective}.`, signal: `More patrols, requisitions, and armed riders bearing ${input.factionName}'s marks appear on the roads.` },
		diplomatic: { action: `${input.factionName} sends envoys and trades concessions with ${target} to advance ${input.objective}.`, signal: `Couriers and formal delegations connected to ${input.factionName} begin moving between interested parties.` },
		economic: { action: `${input.factionName} adjusts contracts, credit, and supply access around ${target} to advance ${input.objective}.`, signal: `Prices, contracts, and access to credit begin shifting wherever ${input.factionName} has influence.` },
		intelligence: { action: `${input.factionName} recruits observers and quietly maps vulnerabilities around ${target}.`, signal: `Servants, travelers, and minor officials begin asking unusually precise questions on ${input.factionName}'s behalf.` },
		internal: { action: `${input.factionName} reorganizes personnel and resources to advance ${input.objective}.`, signal: `Appointments, closed meetings, and resource movements suggest new priorities inside ${input.factionName}.` },
		dynastic: { action: `${input.factionName} uses inheritance, kinship, and household obligations to advance ${input.objective}.`, signal: `Genealogies, household invitations, and private family councils draw new attention around ${input.factionName}.` },
		intrigue: { action: `${input.factionName} cultivates leverage, compromised agents, and deniable pressure around ${target}.`, signal: `A dismissal, a sudden payment, and a changed routine hint that ${input.factionName} has gained hidden leverage.` },
		religious: { action: `${input.factionName} uses appointments, doctrine, and public observance to advance ${input.objective}.`, signal: `Sermons, ritual schedules, and religious appointments begin echoing ${input.factionName}'s priorities.` },
		seasonal: { action: `${input.factionName} secures stores, routes, and labor against the coming season.`, signal: `Granaries, caravans, and labor levies connected to ${input.factionName} change pace.` },
	};
	return byType[input.actionType];
}

export function buildFactionMovePlan(input: {
	factionId?: string;
	factionName: string;
	factionKind?: FactionDoctrineKind;
	pressure: number;
	currentTurn?: number;
	fallbackGoals?: string[];
	goal?: { goal: string } | null;
	project?: { id: string; project: string; progress: number; metadata?: unknown } | null;
	targetFaction?: { id: string; name: string } | null;
	participantPair?: { subjectEntityId: string; subjectName: string; targetEntityId: string; targetName: string } | null;
	allowProjectStart?: boolean;
	variant?: FactionMoveVariant;
}): FactionMovePlan {
	const fallbackGoal = input.fallbackGoals?.find((goal) => goal.trim())?.trim();
	const motivation = input.goal?.goal.trim() || fallbackGoal || 'protect its current interests';
	const factionKind = input.factionKind ?? inferFactionDoctrine({ name: input.factionName });
	const projectMetadata = asRecord(input.project?.metadata);
	const existingProjectKind = text(projectMetadata.projectKind)
		|| (/\b(marriage|betrothal|dowry)\b/i.test(input.project?.project ?? '') ? 'marriage_negotiation' : '');
	let variant: FactionMoveVariant;
	if (input.project) {
		variant = { actionType: actionTypeFromProject(input.project) ?? 'internal', projectKind: existingProjectKind || null };
	} else {
		const variants = variantsFor(factionKind).filter((item) => input.targetFaction || !variantNeedsTarget(item));
		const goalText = normalized(motivation);
		const preferred = factionKind === 'feudal_house' && /\b(marriage|betroth|dynast|heir)\b/.test(goalText)
			? variants.find((item) => item.projectKind === 'marriage_negotiation')
			: null;
		variant = input.variant && variants.some((item) => item.actionType === input.variant?.actionType && item.projectKind === input.variant?.projectKind)
			? input.variant
			: preferred ?? variants[stableNumber([input.factionName, String(input.currentTurn ?? 0), motivation]) % variants.length] ?? { actionType: 'internal', projectKind: null };
		if (variant.projectKind && input.allowProjectStart === false) {
			variant = variants.find((item) => item.projectKind === null) ?? { actionType: 'internal', projectKind: null };
		}
	}
	const urgency = input.pressure >= 90 ? 'critical' : input.pressure >= 78 ? 'high' : input.pressure >= 45 ? 'medium' : 'low';
	const progressDelta = urgency === 'critical' ? 0.24 : urgency === 'high' ? 0.18 : urgency === 'medium' ? 0.12 : 0.1;
	const progressBefore = input.project ? clamp(input.project.progress, 0, 1) : variant.projectKind ? 0 : null;
	const rawProgressAfter = progressBefore == null ? null : clamp(progressBefore + progressDelta, 0, 1);
	const isMarriage = variant.projectKind === 'marriage_negotiation';
	const usesTarget = variantNeedsTarget(variant);
	const activeTarget = usesTarget ? input.targetFaction : null;
	const activePair = isMarriage ? input.participantPair : null;
	const progressAfter = isMarriage && !activePair && rawProgressAfter != null
		? Math.min(0.9, rawProgressAfter)
		: rawProgressAfter;
	const targetName = activeTarget?.name ?? null;
	const objective = input.project?.project.trim()
		|| (variant.projectKind ? projectLabel(variant.projectKind, targetName, motivation) : motivation);
	const language = moveLanguage({
		factionName: input.factionName,
		actionType: variant.actionType,
		projectKind: variant.projectKind,
		objective,
		targetName,
		subjectName: activePair?.subjectName ?? null,
		targetEntityName: activePair?.targetName ?? null,
		progressAfter,
	});
	const consequences = progressBefore == null || progressAfter == null
		? [`${input.factionName} changes its position in pursuit of ${objective}.`]
		: [
			`Project progress rises from ${Math.round(progressBefore * 100)}% to ${Math.round(progressAfter * 100)}%.`,
			...(isMarriage && !activePair ? ['No binding match can be concluded until two eligible non-player participants are verified.'] : []),
		];
	const delayTurns = urgency === 'critical' ? 1 : urgency === 'high' ? 2 : urgency === 'medium' ? 3 : 4;
	const startProjectId = !input.project && variant.projectKind && input.factionId
		? `faction_project_${stableSlug(`${input.factionId}_${variant.projectKind}_${activeTarget?.id ?? 'open'}_${input.currentTurn ?? 0}`)}`
		: null;
	const projectId = input.project?.id ?? startProjectId;
	return {
		factionKind,
		actionType: variant.actionType,
		projectKind: variant.projectKind,
		objective,
		action: language.action,
		motivation,
		consequences,
		urgency,
		delayTurns,
		publicSignal: language.signal,
		projectId,
		projectProgressBefore: progressBefore,
		projectProgressAfter: progressAfter,
		startProject: startProjectId && variant.projectKind && progressAfter != null
			? {
				id: startProjectId,
				project: objective,
				projectKind: variant.projectKind,
				progress: progressAfter,
				nextActionTurn: Math.max(0, input.currentTurn ?? 0) + delayTurns,
				targetFactionId: activeTarget?.id ?? null,
				subjectEntityId: activePair?.subjectEntityId ?? null,
				targetEntityId: activePair?.targetEntityId ?? null,
			}
			: null,
		actorEntityIds: activePair ? [activePair.subjectEntityId] : [],
		targetEntityIds: activePair ? [activePair.targetEntityId] : [],
		targetFactionIds: activeTarget ? [activeTarget.id] : [],
		targetFactionNames: activeTarget ? [activeTarget.name] : [],
	};
}

export function selectFactionWorldTickCandidates<T extends FactionCandidate>(input: {
	factions: T[];
	minimumPressure: number;
	readyProjectFactionIds?: ReadonlySet<string>;
	pausedProjectFactionIds?: ReadonlySet<string>;
	allowAmbient: boolean;
	currentTurn: number;
	rotationKey?: string;
	limit?: number;
}): T[] {
	const limit = Math.max(1, Math.min(3, Math.trunc(input.limit ?? 3)));
	const ready = input.readyProjectFactionIds ?? new Set<string>();
	const ranked = [...input.factions].sort((a, b) => b.pressure - a.pressure || a.name.localeCompare(b.name));
	const lastTick = (faction: T) => {
		const value = asRecord(faction.metadata).lastWorldSimTickTurn;
		return typeof value === 'number' && Number.isFinite(value) ? value : -1;
	};
	const eligible = [
		...ranked.filter((faction) => ready.has(faction.id)),
		...ranked.filter((faction) => faction.pressure >= input.minimumPressure),
	];
	const unique = [...new Map(eligible.map((faction) => [faction.id, faction])).values()];
	const fresh = input.allowAmbient
		? unique.filter(faction => ready.has(faction.id) || lastTick(faction) < 0 || input.currentTurn - lastTick(faction) >= 10)
		: unique;
	if (fresh.length > 0) return fresh.slice(0, limit);
	if (!input.allowAmbient || ranked.length === 0) return [];
	const paused = input.pausedProjectFactionIds ?? new Set<string>();
	const available = ranked.filter((faction) => !paused.has(faction.id));
	const basePool = available.length > 0 ? available : ranked;
	const ambientPriority = (faction: T) => {
		const metadata = asRecord(faction.metadata);
		return metadata.currentStoryEvidence === true || metadata.worldSimEnabled === true || metadata.sourceType === 'character_faction_tag' ? 1 : 0;
	};
	const highestPriority = Math.max(...basePool.map(ambientPriority));
	const priorityPool = basePool.filter((faction) => ambientPriority(faction) === highestPriority);
	const oldestTurn = Math.min(...priorityPool.map(lastTick));
	const stale = priorityPool.filter((faction) => lastTick(faction) === oldestTurn);
	const highestAmbientPressure = Math.max(...stale.map((faction) => faction.pressure));
	const stalest = stale.filter((faction) => faction.pressure === highestAmbientPressure).sort((a, b) => a.name.localeCompare(b.name));
	const index = stableNumber([input.rotationKey ?? '', String(input.currentTurn)]) % stalest.length;
	return [stalest[index]];
}

export function isExplicitDynasticParticipant(input: {
	membership: { role?: string | null; metadata?: unknown };
	entity: { status?: string | null; state?: unknown; metadata?: unknown };
	blocked?: boolean;
}): boolean {
	if (input.blocked) return false;
	const membershipMetadata = asRecord(input.membership.metadata);
	const state = asRecord(input.entity.state);
	const rawEntityMetadata = asRecord(input.entity.metadata);
	const entityMetadata = { ...asRecord(rawEntityMetadata.originalMetadata), ...rawEntityMetadata };
	const relationship = asRecord(state.relationship);
	const relationshipStatus = normalized(text(relationship.status));
	const metadataRelationshipRecord = asRecord(entityMetadata.relationship);
	const metadataRelationship = normalized(text(entityMetadata.relationship));
	const metadataRelationshipStatus = normalized(text(metadataRelationshipRecord.status));
	if (normalized(text(state.relationship)) === 'self'
		|| relationshipStatus === 'self'
		|| relationshipStatus === 'player character'
		|| state.isProtagonist === true
		|| normalized(text(state.currentDisposition)) === 'self'
		|| metadataRelationship === 'self'
		|| metadataRelationship === 'player character'
		|| metadataRelationshipStatus === 'self'
		|| metadataRelationshipStatus === 'player character'
		|| typeof state.playerPrompt === 'string'
		|| typeof entityMetadata.playerPrompt === 'string') return false;
	const familyRole = normalized(text(membershipMetadata.kinshipRole ?? membershipMetadata.familyRole ?? input.membership.role));
	if (!['daughter', 'son', 'child', 'heir'].includes(familyRole)) return false;
	const ageValues = [membershipMetadata.age, state.age, entityMetadata.age]
		.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
	if (ageValues.some((age) => age < 18)) return false;
	const adult = membershipMetadata.adult === true || state.adult === true || entityMetadata.adult === true
		|| ageValues.some((age) => age >= 18);
	if (!adult) return false;
	const activeEraValues = [membershipMetadata.activeEra, state.activeEra, entityMetadata.activeEra];
	if (activeEraValues.includes(false) || !activeEraValues.includes(true)) return false;
	const lifeStatuses = [membershipMetadata.lifeStatus, state.lifeStatus, entityMetadata.lifeStatus]
		.map((value) => normalized(text(value)))
		.filter(Boolean);
	const entityStatus = normalized(text(input.entity.status));
	if (entityStatus && entityStatus !== 'active') return false;
	if (lifeStatuses.some((status) => ['dead', 'deceased', 'historical', 'inactive'].includes(status)) || !lifeStatuses.includes('alive')) return false;
	const maritalStatuses = [membershipMetadata.maritalStatus, state.maritalStatus, entityMetadata.maritalStatus]
		.map((value) => normalized(text(value)))
		.filter(Boolean);
	if (maritalStatuses.some((status) => ['married', 'betrothed', 'engaged'].includes(status))) return false;
	return maritalStatuses.includes('unmarried');
}

export function validFactionTag(value: string): boolean {
	const key = normalized(value);
	return key.length >= 2
		&& value.trim().length <= 120
		&& !['none', 'unknown', 'unaffiliated', 'neutral', 'no faction', 'n a'].includes(key);
}
