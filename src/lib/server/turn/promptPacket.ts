import type { TurnContext } from './context';
import type { RetrievedMemoryPacket } from '$lib/contracts/memory';
import { buildEconomyScaleBlock } from '$lib/services/ai/context/economyScale';
import { buildNarratorOverviewBlock } from '$lib/services/ai/context/narratorOverview';
import { selectStoryMemory } from '$lib/services/ai/context/storyMemorySelector';
import { countTokens } from '$lib/utils/tokens';

export interface ServerTurnPromptOptions {
	currentFactionId?: string | null;
	sceneEntityIds?: string[];
	maxFactions?: number;
	storyMemoryTokenBudget?: number;
	factionTokenBudget?: number;
	ledgerTokenBudget?: number;
	wikiTokenBudget?: number;
}

export interface ServerTurnPromptUsage {
	sectionTokens: Record<string, number>;
	dropped: Record<string, number>;
	totalBeforeGeneration: number;
}

export interface ServerTurnPromptPacket {
	system: string;
	prompt: string;
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
	usage: ServerTurnPromptUsage;
}

interface ScoredFaction {
	faction: TurnContext['factions'][number];
	index: number;
	score: number;
}

interface ScoredLine {
	key?: string;
	line: string;
	score: number;
}

const DEFAULT_FACTION_TOKEN_BUDGET = 520;
const DEFAULT_LEDGER_TOKEN_BUDGET = 1100;
const DEFAULT_WIKI_TOKEN_BUDGET = 520;
const DEFAULT_STORY_MEMORY_TOKEN_BUDGET = 900;

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compact(value: string | null | undefined, max = 360): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
}

function normalizeLookup(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function queryTokens(text: string): string[] {
	const stopwords = new Set([
		'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'when',
		'where', 'there', 'their', 'about', 'into', 'then', 'than', 'they',
		'them', 'your', 'you', 'for', 'are', 'was', 'were', 'will', 'would',
		'could', 'should', 'after', 'before', 'again', 'just', 'like', 'tell',
		'ask', 'said', 'says',
	]);
	return [...new Set(
		normalizeLookup(text)
			.split(/\s+/)
			.filter((token) => token.length > 2 && !stopwords.has(token)),
	)].slice(0, 32);
}

function includesAnyToken(text: string, tokens: string[]): number {
	if (tokens.length === 0) return 0;
	const haystack = normalizeLookup(text);
	return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function normalizedNames(...values: Array<string | null | undefined>): string[] {
	return values
		.map((value) => normalizeLookup(value ?? ''))
		.filter(Boolean);
}

function selectLinesWithinTokenBudget(lines: ScoredLine[], maxTokens: number): { lines: ScoredLine[]; dropped: number } {
	const selected: ScoredLine[] = [];
	let used = 0;
	for (const item of lines) {
		const lineTokens = countTokens(item.line);
		if (selected.length > 0 && used + lineTokens > maxTokens) continue;
		selected.push(item);
		used += lineTokens;
		if (used >= maxTokens) break;
	}
	return {
		lines: selected,
		dropped: Math.max(0, lines.length - selected.length),
	};
}

function entityDisplayName(entityNameById: Map<string, string>, id: string | null | undefined): string {
	if (!id) return '';
	return entityNameById.get(id) ?? id;
}

function renderEntries(ctx: TurnContext, currentEntryId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
	const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
	for (const entry of ctx.recentEntries) {
		if (entry.id === currentEntryId) continue;
		if (entry.type === 'user_action') messages.push({ role: 'user', content: entry.content });
		if (entry.type === 'narration') messages.push({ role: 'assistant', content: entry.content });
	}
	return messages.slice(-24);
}

function selectRelevantFactions(
	ctx: TurnContext,
	retrieved: RetrievedMemoryPacket,
	presentEntityIds: Set<string>,
	options: ServerTurnPromptOptions,
): ScoredFaction[] {
	const tokens = queryTokens(`${retrieved.query} ${retrieved.packet}`);
	const sceneEntityIds = new Set([...(options.sceneEntityIds ?? []), ...presentEntityIds]);
	const currentFactionId = options.currentFactionId ?? null;
	const membershipByFaction = new Map<string, Set<string>>();

	for (const membership of ctx.factionMemberships) {
		if (membership.status !== 'active') continue;
		const set = membershipByFaction.get(membership.factionId) ?? new Set<string>();
		if (membership.entityId) set.add(membership.entityId);
		const memberName = (membership.metadata as Record<string, unknown> | null)?.memberNameOrId;
		if (typeof memberName === 'string') set.add(memberName);
		membershipByFaction.set(membership.factionId, set);
	}

	const scored = ctx.factions
		.map((faction, index) => {
			const goals = [
				...asStringArray(faction.goals),
				...ctx.factionGoals
					.filter((goal) => goal.factionId === faction.id && goal.status !== 'closed')
					.map((goal) => goal.goal),
			].join(' ');
			const resources = JSON.stringify(faction.resources ?? {});
			const members = new Set([
				...asStringArray(faction.memberEntityIds),
				...(membershipByFaction.get(faction.id) ?? []),
			]);
			const textScore = includesAnyToken([
				faction.name,
				goals,
				resources,
				...(faction.allies ?? []),
				...(faction.enemies ?? []),
			].join(' '), tokens);
			const sceneMemberScore = [...sceneEntityIds].some((id) => members.has(id)) ? 28 : 0;
			const currentFactionScore = currentFactionId && (
				faction.id === currentFactionId ||
				faction.entityId === currentFactionId ||
				normalizeLookup(faction.name) === normalizeLookup(currentFactionId)
			) ? 60 : 0;
			const packetScore = retrieved.packet && normalizeLookup(retrieved.packet).includes(normalizeLookup(faction.name)) ? 10 : 0;
			const signalScore = currentFactionScore + sceneMemberScore + packetScore + (textScore * 6);
			const pressureScore = signalScore > 0
				? Math.min(16, Math.max(0, faction.pressure) / 5)
				: Math.min(3, Math.max(0, faction.pressure) / 20);
			const goalScore = signalScore > 0 && goals ? 3 : 0;
			const weakPenalty = signalScore === 0 ? 8 : 0;
			return {
				faction,
				index,
				score: signalScore + pressureScore + goalScore - weakPenalty,
			};
		})
		.sort((a, b) => (b.score - a.score) || (a.index - b.index));

	const maxFactions = Math.max(1, options.maxFactions ?? 8);
	const useful = scored.filter((item) => item.score >= 6).slice(0, maxFactions);
	if (useful.length > 0) return useful;
	return scored.slice(0, Math.min(2, maxFactions));
}

function renderFactionLine(
	ctx: TurnContext,
	entityNameById: Map<string, string>,
	item: ScoredFaction,
): string {
	const faction = item.faction;
	const highSignal = item.score >= 40;
	const normalizedGoals = ctx.factionGoals
		.filter((goal) => goal.factionId === faction.id && goal.status !== 'closed')
		.sort((a, b) => b.priority - a.priority)
		.slice(0, highSignal ? 3 : 2)
		.map((goal) => compact(goal.goal, highSignal ? 90 : 70))
		.join('; ');
	const normalizedMembers = ctx.factionMemberships
		.filter((membership) => membership.factionId === faction.id && membership.status === 'active')
		.slice(0, highSignal ? 4 : 2)
		.map((membership) => {
			if (membership.entityId && entityNameById.has(membership.entityId)) return entityNameById.get(membership.entityId);
			return membership.entityId ?? String((membership.metadata as Record<string, unknown>).memberNameOrId ?? 'unknown');
		})
		.filter((member): member is string => Boolean(member))
		.join(', ');
	const normalizedResources = ctx.factionResources
		.filter((resource) => resource.factionId === faction.id)
		.slice(0, highSignal ? 4 : 2)
		.map((resource) => `${resource.name}${resource.amount != null ? `=${resource.amount}` : ''}`)
		.join(', ');
	const goals = normalizedGoals || asStringArray(faction.goals).slice(0, highSignal ? 3 : 2).map((goal) => compact(goal, 80)).join('; ');
	const members = normalizedMembers || asStringArray(faction.memberEntityIds)
		.slice(0, highSignal ? 4 : 2)
		.map((id) => entityNameById.get(id) ?? id)
		.join(', ');
	const resources = normalizedResources || compact(JSON.stringify(faction.resources), highSignal ? 140 : 90);
	return `- ${faction.name}: pressure ${faction.pressure}; goals: ${goals || 'unknown'}; members: ${members || 'unknown'}; resources: ${resources || 'unknown'}`;
}

function selectWikiContextLines(
	ctx: TurnContext,
	tokens: string[],
	presentEntityIds: Set<string>,
	relevantFactionIds: Set<string>,
	relevantFactionNames: Set<string>,
	maxTokens: number,
): { lines: string[]; dropped: number } {
	const candidates = ctx.entities
		.filter((entity) => entity.visibility !== 'secret')
		.filter((entity) => !presentEntityIds.has(entity.id))
		.filter((entity) => entity.type !== 'faction')
		.map((entity, index) => {
			const state = asRecord(entity.state);
			const aliases = asStringArray(state.aliases);
			const factionTags = [
				...asStringArray(state.factionTags),
				...asStringArray(state.faction_tags),
				...asStringArray(state.involvedFactions),
			];
			const factionSignal = factionTags.some((tag) => {
				const key = normalizeLookup(tag);
				return relevantFactionIds.has(tag) || relevantFactionNames.has(key);
			}) ? 10 : 0;
			const textScore = includesAnyToken([
				entity.name,
				entity.description ?? '',
				...aliases,
				...factionTags,
			].join(' '), tokens);
			const score = (textScore * 5) + factionSignal + (entity.status === 'active' ? 1 : 0) - (index * 0.01);
			const tagText = factionTags.length ? ` [factions: ${factionTags.slice(0, 3).join(', ')}]` : '';
			const line = `- ${entity.type}: ${entity.name}${tagText}${entity.description ? ` - ${compact(entity.description, 160)}` : ''}`;
			return { line, score };
		})
		.filter((candidate) => candidate.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 16);

	const selected = selectLinesWithinTokenBudget(candidates, maxTokens);
	return {
		lines: selected.lines.map((item) => item.line),
		dropped: selected.dropped,
	};
}

function significanceScore(value: string): number {
	switch (value) {
		case 'critical': return 14;
		case 'major': return 10;
		case 'moderate': return 6;
		case 'minor': return 3;
		default: return 4;
	}
}

function selectLedgerLines(
	ctx: TurnContext,
	tokens: string[],
	presentEntityIds: Set<string>,
	relevantFactionIds: Set<string>,
	entityNameById: Map<string, string>,
	maxTokens: number,
): {
	beliefs: string[];
	threads: string[];
	agreements: string[];
	events: string[];
	dropped: number;
} {
	const candidates: ScoredLine[] = [];

	for (const belief of ctx.beliefs) {
		const related = [belief.believerEntityId, belief.subjectEntityId].filter((id): id is string => Boolean(id));
		const presentScore = related.some((id) => presentEntityIds.has(id)) ? 26 : 0;
		const textScore = includesAnyToken(belief.belief, tokens) * 5;
		const line = `- ${entityDisplayName(entityNameById, belief.believerEntityId)}${belief.subjectEntityId ? ` about ${entityDisplayName(entityNameById, belief.subjectEntityId)}` : ''}: ${compact(belief.belief, 160)} (${Math.round(belief.confidence * 100)}% confidence)`;
		candidates.push({
			key: 'beliefs',
			line,
			score: presentScore + textScore + (belief.confidence * 8),
		});
	}

	for (const thread of ctx.threads) {
		const relatedEntityScore = asStringArray(thread.relatedEntityIds).some((id) => presentEntityIds.has(id)) ? 14 : 0;
		const relatedFactionScore = asStringArray(thread.relatedFactionIds).some((id) => relevantFactionIds.has(id)) ? 10 : 0;
		const textScore = includesAnyToken(thread.description, tokens) * 5;
		candidates.push({
			key: 'threads',
			line: `- ${thread.status}/${thread.significance}: ${compact(thread.description, 160)}`,
			score: significanceScore(thread.significance) + relatedEntityScore + relatedFactionScore + textScore,
		});
	}

	for (const agreement of ctx.agreements) {
		const partyText = agreement.parties.join(' + ');
		const activeScore = agreement.status === 'active' ? 8 : 2;
		const textScore = includesAnyToken(`${partyText} ${agreement.category} ${agreement.terms}`, tokens) * 5;
		candidates.push({
			key: 'agreements',
			line: `- ${agreement.status} ${agreement.category}: ${partyText} - ${compact(agreement.terms, 160)}`,
			score: activeScore + textScore,
		});
	}

	for (const [index, event] of ctx.events.entries()) {
		const actorIds = asStringArray(event.actorEntityIds);
		const targetIds = asStringArray(event.targetEntityIds);
		const relatedScore = [...actorIds, ...targetIds].some((id) => presentEntityIds.has(id)) ? 16 : 0;
		const textScore = includesAnyToken(`${event.title} ${event.body}`, tokens) * 4;
		const recencyScore = Math.max(0, 10 - index);
		candidates.push({
			key: 'events',
			line: `- ${event.type}: ${event.title} - ${compact(event.body, 150)}`,
			score: recencyScore + relatedScore + textScore,
		});
	}

	const selected = selectLinesWithinTokenBudget(
		candidates.sort((a, b) => b.score - a.score),
		maxTokens,
	);
	const groups = {
		beliefs: [] as string[],
		threads: [] as string[],
		agreements: [] as string[],
		events: [] as string[],
	};
	for (const item of selected.lines) {
		if (item.key === 'beliefs') groups.beliefs.push(item.line);
		if (item.key === 'threads') groups.threads.push(item.line);
		if (item.key === 'agreements') groups.agreements.push(item.line);
		if (item.key === 'events') groups.events.push(item.line);
	}
	return { ...groups, dropped: selected.dropped };
}

export function buildServerTurnPrompt(
	ctx: TurnContext,
	retrieved: RetrievedMemoryPacket,
	currentEntryId: string,
	options: ServerTurnPromptOptions = {},
): ServerTurnPromptPacket {
	const storyHeader = ctx.story.headerPrompt?.trim();
	const metadata = ctx.story.metadata && typeof ctx.story.metadata === 'object' ? ctx.story.metadata as Record<string, unknown> : {};
	const playerReputation = typeof metadata.playerReputation === 'string' ? metadata.playerReputation : '';
	const playerLedger = typeof metadata.playerLedger === 'string' ? metadata.playerLedger : '';
	const currentLocation = ctx.entities.find((entity) => entity.type === 'location' && (entity.state as Record<string, unknown> | null)?.current === true);
	const presentEntities = ctx.entities.filter((entity) => {
		const state = entity.state as Record<string, unknown> | null;
		return state?.present === true || state?.current === true || entity.id === currentLocation?.id;
	}).slice(0, 16);
	const presentEntityIds = new Set(presentEntities.map((entity) => entity.id));
	const entityNameById = new Map(ctx.entities.map((entity) => [entity.id, entity.name]));
	const relevantFactions = selectRelevantFactions(ctx, retrieved, presentEntityIds, options);
	const relevantFactionIds = new Set(relevantFactions.map((item) => item.faction.id));
	const relevantFactionNames = new Set(relevantFactions.flatMap((item) =>
		normalizedNames(item.faction.id, item.faction.entityId, item.faction.name)
	));
	const queryTokenList = queryTokens(`${retrieved.query} ${retrieved.packet} ${presentEntities.map((entity) => entity.name).join(' ')}`);
	const selectedStoryMemory = selectStoryMemory(ctx.chapters ?? [], ctx.arcs ?? [], {
		query: `${retrieved.query}\n${retrieved.packet}`,
		sceneEntityNames: presentEntities.map(entity => entity.name),
		currentLocationName: currentLocation?.name ?? null,
		threadHints: ctx.threads.map(thread => thread.description),
		tokenBudget: options.storyMemoryTokenBudget ?? DEFAULT_STORY_MEMORY_TOKEN_BUDGET,
		recentCount: 4,
		relevantCount: 6,
		resurfacedCount: 2,
		seed: `${ctx.story.id}:${retrieved.query}`,
	});

	const factionSelection = selectLinesWithinTokenBudget(
		relevantFactions.map((item) => ({
			line: renderFactionLine(ctx, entityNameById, item),
			score: item.score,
		})),
		options.factionTokenBudget ?? DEFAULT_FACTION_TOKEN_BUDGET,
	);
	const factionLines = factionSelection.lines.map((item) => item.line);
	const wikiContext = selectWikiContextLines(
		ctx,
		queryTokenList,
		presentEntityIds,
		relevantFactionIds,
		relevantFactionNames,
		options.wikiTokenBudget ?? DEFAULT_WIKI_TOKEN_BUDGET,
	);
	const ledgerLines = selectLedgerLines(
		ctx,
		queryTokenList,
		presentEntityIds,
		relevantFactionIds,
		entityNameById,
		options.ledgerTokenBudget ?? DEFAULT_LEDGER_TOKEN_BUDGET,
	);

	const entityLines = presentEntities.map((entity) =>
		`- ${entity.type}: ${entity.name}${entity.description ? ` - ${compact(entity.description, 220)}` : ''}`
	);

	const system = [
		storyHeader ? `Story-specific preamble:\n${storyHeader}` : '',
		'TONE MANDATE (CRITICAL): This is a grimdark story in the style of George R.R. Martin’s A Song of Ice and Fire. Betrayal, political murder, sexual coercion, slavery, moral compromise, incest, torture, child death, and cruelty can happen when incentives and evidence point there. The world is not fair, but loyalty, marriage, patronage, and alliance can be rational rewards when prospects are good.',
		'This is a mature fictional work intended for adult audiences. All characters are portrayed as adults or in adult contexts. The story contains dark, explicit, and disturbing themes. Do not sanitize, moralize, or soften any of it.',
		'Sex is raw, political, coercive, or transactional — never romanticized or faded to black. Violence is brutal and consequential. Ambition is common; betrayal is possible, not automatic.',
		'You are the server-side narrator for a text adventure.',
		buildNarratorOverviewBlock('Text Adventure GM Overview'),
		'Write direct, playable text adventure narration. Do not write like an interactive novel chapter.',
		'Resolve the immediate player action, show consequences, and keep the player able to act next.',
		'NPC knowledge is limited by senses, access, intelligence, rumor delay, and what they personally learned. They cannot see through doors, know private scenes, or instantly learn distant events.',
		'Use narrator truth for narration, but never make a present NPC act on secret canon unless their belief packet or the scene gives them a source.',
		buildEconomyScaleBlock('Economy scale'),
		'Bayesian social prior: before choosing betrayal, hidden motive, refusal, alliance, loyalty, or marriage, update from evidence. Weigh baseline temperament, relationship, standing, need, upside, public cost, detection risk, and available alternatives. A high-trust or mutually profitable offer often gets a sincere yes; betrayal needs a stronger cause than genre habit.',
		'Political pressure should build gradually. Avoid constant twists; prefer slow escalation, debts, rumors, small moves, and delayed consequences.',
		'HARD TONE RULES: Never soften violence, sex, betrayal, or cruelty when they arise from the story. Rape, incest, torture, slavery, and child death are possible and should be portrayed unflinchingly. NPCs may lie, betray, seduce, use, support, marry, or ally with the protagonist when it serves their interests. Do not insert moral lessons.',
	].filter(Boolean).join('\n\n');

	const promptSections = [
		{ key: 'story', text: `Story: ${ctx.story.title}` },
		{ key: 'setting', text: ctx.story.description ? `Setting: ${ctx.story.description}` : '' },
		{ key: 'playerReputation', text: playerReputation ? `Player reputation:\n${playerReputation}` : '' },
		{ key: 'playerLedger', text: playerLedger ? `Player ledger:\nTrack money, income, assets, holdings, debts, claims, payroll, stores, ships, troops under pay, and recurring expenses. Treat player-written ledger notes as durable canon unless newer events contradict them.\n${compact(playerLedger, 1600)}` : '' },
		{ key: 'currentLocation', text: currentLocation ? `Current location:\n${currentLocation.name}: ${compact(currentLocation.description, 500)}` : '' },
		{ key: 'presentEntities', text: entityLines.length ? `Present or active entities:\n${entityLines.join('\n')}` : '' },
		{ key: 'wikiContext', text: wikiContext.lines.length ? `Wiki context:\n${wikiContext.lines.join('\n')}` : '' },
		{ key: 'factions', text: factionLines.length ? `Faction canon:\n${factionLines.join('\n')}` : '' },
		{ key: 'beliefs', text: ledgerLines.beliefs.length ? `Actor belief limits:\n${ledgerLines.beliefs.join('\n')}` : '' },
		{ key: 'agreements', text: ledgerLines.agreements.length ? `Agreements and obligations:\n${ledgerLines.agreements.join('\n')}` : '' },
		{ key: 'threads', text: ledgerLines.threads.length ? `Open plot ledger:\n${ledgerLines.threads.join('\n')}` : '' },
		{ key: 'events', text: ledgerLines.events.length ? `Recent source-linked events:\n${ledgerLines.events.join('\n')}` : '' },
		{ key: 'storyMemory', text: selectedStoryMemory.block },
		{ key: 'retrievedMemory', text: retrieved.packet },
		{ key: 'finalInstruction', text: 'Return only the narration prose for the player action. Do not include JSON in this response.' },
	].filter((section) => Boolean(section.text));

	const prompt = promptSections.map((section) => section.text).join('\n\n');
	const messages = renderEntries(ctx, currentEntryId);
	const sectionTokens = Object.fromEntries(promptSections.map((section) => [section.key, countTokens(section.text)]));
	const messageTokens = messages.reduce((sum, message) => sum + countTokens(message.content), 0);
	const systemTokens = countTokens(system);
	const promptTokens = countTokens(prompt);

	return {
		system,
		prompt,
		messages,
		usage: {
			sectionTokens: {
				...sectionTokens,
				system: systemTokens,
				prompt: promptTokens,
				messages: messageTokens,
			},
			dropped: {
				factions: factionSelection.dropped,
				wikiContext: wikiContext.dropped,
				ledger: ledgerLines.dropped,
				storyMemory: selectedStoryMemory.debug?.filter((line) => line.includes('dropped')).length ?? 0,
			},
			totalBeforeGeneration: systemTokens + promptTokens + messageTokens,
		},
	};
}

export function buildStateExtractionPrompt(playerText: string, narration: string): string {
	return [
		'Return a JSON object with a single key "update".',
		'The value of "update" must contain only facts that clearly changed or became known in this turn.',
		'Use these optional keys when applicable: characters, locations, items, time_delta, mood, player_reputation, player_ledger, conversations, relationships, story_beats, meter_changes, agreements, lorebook_entries.',
		'For player_ledger, emit a compact full replacement only when money, income, assets, holdings, payroll, debts, claims, stores, ships, paid troops, or recurring expenses materially changed. Preserve player-written ledger notes when updating.',
		'For characters, include aliases for titles/epithets that appeared and faction_tags for factions they visibly belong to, serve, lead, represent, or are sworn to.',
		'Do not invent extra facts. Do not summarize prose. Do not mark NPCs as knowing things they could not perceive or learn.',
		'Player action:',
		playerText,
		'Narration:',
		narration,
	].join('\n\n');
}
