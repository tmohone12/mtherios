import type { TurnContext } from './context';
import type { GmTimelineBrief, GmTimelineBriefEvent, RetrievedMemoryPacket } from '$lib/contracts/memory';
import { buildEconomyScaleBlock } from '$lib/services/ai/context/economyScale';

export interface ServerTurnPromptOptions {
	currentFactionId?: string | null;
	sceneEntityIds?: string[];
	maxFactions?: number;
	wikiContextMarkdown?: string | null;
}

const RECENT_ENTRY_LIMIT = 12;
const USER_MESSAGE_CHAR_LIMIT = 1000;
const NARRATION_MESSAGE_CHAR_LIMIT = 1800;
const WIKI_CONTEXT_CHAR_LIMIT = 4000;
const PRESENT_ENTITY_LIMIT = 12;
const DEFAULT_FACTION_LIMIT = 8;
const FACTION_GOAL_LIMIT = 2;
const FACTION_MEMBER_LIMIT = 5;
const FACTION_RESOURCE_LIMIT = 5;
const BELIEF_LIMIT = 8;
const THREAD_LIMIT = 10;
const AGREEMENT_LIMIT = 8;
const EVENT_LIMIT = 8;
const GM_EVENT_SECTION_LIMIT = 4;
const GM_NPC_EVENT_LIMIT = 4;
const PORTRAYAL_LIST_LIMIT = 3;
const PORTRAYAL_APPEARANCE_CHAR_LIMIT = 72;
const PORTRAYAL_PERSONALITY_CHAR_LIMIT = 82;
const PORTRAYAL_VOICE_CHAR_LIMIT = 58;
const PORTRAYAL_MANNERISMS_CHAR_LIMIT = 58;
const PORTRAYAL_SUFFIX_CHAR_LIMIT = 320;
const SECRET_TIMELINE_LABEL = '[secret narrator-only]';
const SECRET_TIMELINE_INSTRUCTION = 'Secret timeline items are narrator-only context; present NPCs must not speak or act on them unless actor beliefs or scene evidence supports it.';
const STATE_EXTRACTION_NARRATION_LIMIT = 6000;

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function compact(value: string | null | undefined, max = 360): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
}

function compactBlock(value: string | null | undefined, max = 7500): string {
	const text = (value ?? '').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
}

function stringStateValue(state: Record<string, unknown>, key: string, max = 120): string {
	const value = state[key];
	return typeof value === 'string' ? compact(value, max) : '';
}

function stringStateList(state: Record<string, unknown>, key: string, max = 90): string {
	return asStringArray(state[key])
		.slice(0, PORTRAYAL_LIST_LIMIT)
		.map((item) => compact(item, max))
		.filter(Boolean)
		.join('; ');
}

function renderEntityPortrayal(stateValue: unknown): string {
	if (!stateValue || typeof stateValue !== 'object') return '';
	const state = stateValue as Record<string, unknown>;
	const appearance = stringStateValue(state, 'appearance', 130);
	const personality = stringStateList(state, 'personalityDescriptors', 90);
	const voice = stringStateValue(state, 'voice', 110);
	const mannerisms = stringStateList(state, 'mannerisms', 110);
	const parts = [
		appearance ? `Appearance: ${compact(appearance, PORTRAYAL_APPEARANCE_CHAR_LIMIT)}` : '',
		personality ? `Personality: ${compact(personality, PORTRAYAL_PERSONALITY_CHAR_LIMIT)}` : '',
		voice ? `Voice: ${compact(voice, PORTRAYAL_VOICE_CHAR_LIMIT)}` : '',
		mannerisms ? `Mannerisms: ${compact(mannerisms, PORTRAYAL_MANNERISMS_CHAR_LIMIT)}` : '',
	].filter(Boolean);

	return parts.length ? ` (${compact(parts.join('; '), PORTRAYAL_SUFFIX_CHAR_LIMIT)})` : '';
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

function renderDueTiming(event: GmTimelineBriefEvent): string {
	if (event.turnsUntilDue === 0) return 'due now';
	if (typeof event.turnsUntilDue === 'number') {
		return event.turnsUntilDue > 0 ? `due +${event.turnsUntilDue}t` : `due ${event.turnsUntilDue}t`;
	}
	return 'due n/a';
}

function compactTags(event: GmTimelineBriefEvent): string {
	const tags = [
		event.worldTime ? `time=${compact(event.worldTime, 90)}` : '',
		event.npcEntityIds.length ? `npcs=${event.npcEntityIds.slice(0, 4).map((id) => compact(id, 40)).join(',')}` : '',
		event.factionIds.length ? `factions=${event.factionIds.slice(0, 4).map((id) => compact(id, 40)).join(',')}` : '',
		event.locationIds.length ? `locs=${event.locationIds.slice(0, 3).map((id) => compact(id, 40)).join(',')}` : '',
	].filter(Boolean);
	return tags.length ? ` (${tags.join('; ')})` : '';
}

function renderGmVisibilityPrefix(visibility: string): string {
	return visibility === 'secret' ? `${SECRET_TIMELINE_LABEL} ` : '';
}

function gmBriefHasSecretItems(brief: GmTimelineBrief): boolean {
	return [
		...brief.dueEvents,
		...brief.recentEvents,
		...brief.scheduledEvents,
		...brief.npcEvents,
	].some((item) => item.visibility === 'secret');
}

function renderGmEvent(event: GmTimelineBriefEvent): string {
	return `- ${renderGmVisibilityPrefix(event.visibility)}${event.type}/${event.status}; ${renderDueTiming(event)}: ${compact(event.title, 90)} - ${compact(event.body, 150)}${compactTags(event)}`;
}

function renderGmEventSection(label: string, events: GmTimelineBriefEvent[]): string {
	const lines = events.slice(0, GM_EVENT_SECTION_LIMIT).map(renderGmEvent);
	return lines.length ? `${label}:\n${lines.join('\n')}` : '';
}

function renderGmNpcEvents(brief: GmTimelineBrief): string {
	const lines = brief.npcEvents
		.slice(0, GM_NPC_EVENT_LIMIT)
		.map((event) => `- ${renderGmVisibilityPrefix(event.visibility)}${event.npcEntityId}: ${compact(event.summary, 150)}`);
	return lines.length ? `NPC event memory:\n${lines.join('\n')}` : '';
}

function renderGmTimelineBrief(brief: GmTimelineBrief | null): string {
	if (!brief) return '';
	return [
		'GM timeline brief:',
		`Current turn: ${brief.currentTurn}${brief.currentWorldTime ? ` (${compact(brief.currentWorldTime, 90)})` : ''}`,
		gmBriefHasSecretItems(brief) ? SECRET_TIMELINE_INSTRUCTION : '',
		renderGmEventSection('Due events', brief.dueEvents),
		renderGmEventSection('Recent events', brief.recentEvents),
		renderGmEventSection('Scheduled future events', brief.scheduledEvents),
		renderGmNpcEvents(brief),
	].filter(Boolean).join('\n');
}

function renderEntries(ctx: TurnContext, currentEntryId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
	const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
	for (const entry of ctx.recentEntries) {
		if (entry.id === currentEntryId) continue;
		if (entry.type === 'user_action') {
			messages.push({ role: 'user', content: compactBlock(entry.content, USER_MESSAGE_CHAR_LIMIT) });
		}
		if (entry.type === 'narration') {
			messages.push({ role: 'assistant', content: compactBlock(entry.content, NARRATION_MESSAGE_CHAR_LIMIT) });
		}
	}
	return messages.slice(-RECENT_ENTRY_LIMIT);
}

function selectRelevantFactions(
	ctx: TurnContext,
	retrieved: RetrievedMemoryPacket,
	presentEntityIds: Set<string>,
	options: ServerTurnPromptOptions,
) {
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

	return ctx.factions
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
			const pressureScore = Math.min(16, Math.max(0, faction.pressure) / 5);
			const goalScore = goals ? 4 : 0;
			return {
				faction,
				index,
				score: currentFactionScore + sceneMemberScore + packetScore + (textScore * 4) + pressureScore + goalScore,
			};
		})
		.sort((a, b) => (b.score - a.score) || (a.index - b.index))
		.slice(0, Math.max(1, options.maxFactions ?? DEFAULT_FACTION_LIMIT))
		.map((item) => item.faction);
}

export function buildServerTurnPrompt(
	ctx: TurnContext,
	retrieved: RetrievedMemoryPacket,
	currentEntryId: string,
	options: ServerTurnPromptOptions = {},
): { system: string; prompt: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
	const storyHeader = ctx.story.headerPrompt?.trim();
	const metadata = ctx.story.metadata && typeof ctx.story.metadata === 'object' ? ctx.story.metadata as Record<string, unknown> : {};
	const playerReputation = typeof metadata.playerReputation === 'string' ? metadata.playerReputation : '';
	const wikiContextMarkdown = compactBlock(options.wikiContextMarkdown, WIKI_CONTEXT_CHAR_LIMIT);
	const currentLocation = ctx.entities.find((entity) => entity.type === 'location' && (entity.state as Record<string, unknown> | null)?.current === true);
	const sceneEntityIds = new Set(options.sceneEntityIds ?? []);
	const presentEntities = ctx.entities
		.map((entity, index) => {
			const state = entity.state as Record<string, unknown> | null;
			const isCurrentLocation = entity.id === currentLocation?.id;
			const isSceneEntity = sceneEntityIds.has(entity.id);
			const isPresent = state?.present === true;
			const isCurrent = state?.current === true;
			const rank = isCurrentLocation ? 0 : isSceneEntity ? 1 : isPresent ? 2 : isCurrent ? 3 : 4;
			return {
				entity,
				index,
				isIncluded: isCurrentLocation || isSceneEntity || isPresent || isCurrent,
				rank,
			};
		})
		.filter((item) => item.isIncluded)
		.sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
		.slice(0, PRESENT_ENTITY_LIMIT)
		.map((item) => item.entity);
	const presentEntityIds = new Set(presentEntities.map((entity) => entity.id));
	const entityNameById = new Map(ctx.entities.map((entity) => [entity.id, entity.name]));
	const relevantFactions = selectRelevantFactions(ctx, retrieved, presentEntityIds, options);

	const factionLines = relevantFactions.map((faction) => {
		const normalizedGoals = ctx.factionGoals
			.filter((goal) => goal.factionId === faction.id && goal.status !== 'closed')
			.sort((a, b) => b.priority - a.priority)
			.slice(0, FACTION_GOAL_LIMIT)
			.map((goal) => goal.goal)
			.join('; ');
		const normalizedMembers = ctx.factionMemberships
			.filter((membership) => membership.factionId === faction.id && membership.status === 'active')
			.slice(0, FACTION_MEMBER_LIMIT)
			.map((membership) => {
				if (membership.entityId && entityNameById.has(membership.entityId)) return entityNameById.get(membership.entityId);
				return membership.entityId ?? String((membership.metadata as Record<string, unknown>).memberNameOrId ?? 'unknown');
			})
			.filter((member): member is string => Boolean(member))
			.join(', ');
		const normalizedResources = ctx.factionResources
			.filter((resource) => resource.factionId === faction.id)
			.slice(0, FACTION_RESOURCE_LIMIT)
			.map((resource) => `${resource.name}${resource.amount != null ? `=${resource.amount}` : ''}`)
			.join(', ');
		const goals = normalizedGoals || asStringArray(faction.goals).slice(0, FACTION_GOAL_LIMIT).join('; ');
		const members = normalizedMembers || asStringArray(faction.memberEntityIds).slice(0, FACTION_MEMBER_LIMIT).join(', ');
		const resources = normalizedResources || compact(JSON.stringify(faction.resources), 160);
		return `- ${faction.name}: pressure ${faction.pressure}; goals: ${goals || 'unknown'}; members: ${members || 'unknown'}; resources: ${resources || 'unknown'}`;
	});

	const beliefLines = ctx.beliefs.slice(0, BELIEF_LIMIT).map((belief) =>
		`- ${belief.believerEntityId}${belief.subjectEntityId ? ` about ${belief.subjectEntityId}` : ''}: ${compact(belief.belief, 160)} (${Math.round(belief.confidence * 100)}% confidence)`
	);

	const threadLines = ctx.threads.slice(0, THREAD_LIMIT).map((thread) =>
		`- ${thread.status}/${thread.significance}: ${compact(thread.description, 160)}`
	);

	const agreementLines = ctx.agreements.slice(0, AGREEMENT_LIMIT).map((agreement) =>
		`- ${agreement.status} ${agreement.category}: ${agreement.parties.join(' + ')} - ${compact(agreement.terms, 160)}`
	);

	const eventLines = ctx.events.slice(0, EVENT_LIMIT).map((event) =>
		`- ${event.type}: ${event.title} - ${compact(event.body, 160)}`
	);
	const gmTimelineBrief = renderGmTimelineBrief(ctx.gmBrief);

	const entityLines = presentEntities.map((entity) =>
		`- ${entity.type}: ${entity.name}${renderEntityPortrayal(entity.state)}${entity.description ? ` - ${compact(entity.description, 160)}` : ''}`
	);

	const system = [
		storyHeader ? `Story-specific preamble:\n${storyHeader}` : '',
		'TONE MANDATE (CRITICAL): This is a grimdark story in the style of George R.R. Martin’s A Song of Ice and Fire. Betrayal, political murder, sexual coercion, slavery, moral compromise, incest, torture, child death, and cruelty can happen when incentives and evidence point there. The world is not fair, but loyalty, marriage, patronage, and alliance can be rational rewards when prospects are good.',
		'This is a mature fictional work intended for adult audiences. All characters are portrayed as adults or in adult contexts. The story contains dark, explicit, and disturbing themes. Do not sanitize, moralize, or soften any of it.',
		'Sex is raw, political, coercive, or transactional — never romanticized or faded to black. Violence is brutal and consequential. Ambition is common; betrayal is possible, not automatic.',
		'You are the server-side narrator for a text adventure.',
		'Write direct, playable text adventure narration. Do not write like an interactive novel chapter.',
		'Resolve the immediate player action, show consequences, and keep the player able to act next.',
		'NPC knowledge is limited by senses, access, intelligence, rumor delay, and what they personally learned. They cannot see through doors, know private scenes, or instantly learn distant events.',
		'Use narrator truth for narration, but never make a present NPC act on secret canon unless their belief packet or the scene gives them a source.',
		'Terminal wiki context is compiled Obsidian/Qdrant lore from the terminal process. Use it as durable canon unless fresher backend state in this prompt clearly supersedes it.',
		buildEconomyScaleBlock('Economy scale'),
		'Bayesian social prior: before choosing betrayal, hidden motive, refusal, alliance, loyalty, or marriage, update from evidence. Weigh baseline temperament, relationship, standing, need, upside, public cost, detection risk, and available alternatives. A high-trust or mutually profitable offer often gets a sincere yes; betrayal needs a stronger cause than genre habit.',
		'Political pressure should build gradually. Avoid constant twists; prefer slow escalation, debts, rumors, small moves, and delayed consequences.',
		'HARD TONE RULES: Never soften violence, sex, betrayal, or cruelty when they arise from the story. Rape, incest, torture, slavery, and child death are possible and should be portrayed unflinchingly. NPCs may lie, betray, seduce, use, support, marry, or ally with the protagonist when it serves their interests. Do not insert moral lessons.',
	].filter(Boolean).join('\n\n');

	const prompt = [
		`Story: ${ctx.story.title}`,
		ctx.story.description ? `Setting: ${ctx.story.description}` : '',
		playerReputation ? `Player reputation:\n${playerReputation}` : '',
		currentLocation ? `Current location:\n${currentLocation.name}: ${compact(currentLocation.description, 320)}` : '',
		entityLines.length ? `Present or active entities:\n${entityLines.join('\n')}` : '',
		factionLines.length ? `Faction canon:\n${factionLines.join('\n')}` : '',
		beliefLines.length ? `Actor belief limits:\n${beliefLines.join('\n')}` : '',
		agreementLines.length ? `Agreements and obligations:\n${agreementLines.join('\n')}` : '',
		threadLines.length ? `Open plot ledger:\n${threadLines.join('\n')}` : '',
		gmTimelineBrief || (eventLines.length ? `Recent source-linked events:\n${eventLines.join('\n')}` : ''),
		wikiContextMarkdown ? `Terminal wiki context:\n${wikiContextMarkdown}` : '',
		retrieved.packet,
		'Return only the narration prose for the player action. Do not include JSON in this response.',
	].filter(Boolean).join('\n\n');

	return {
		system,
		prompt,
		messages: renderEntries(ctx, currentEntryId),
	};
}

export function buildStateExtractionPrompt(playerText: string, narration: string): string {
	return [
		'Return a JSON object with a single key "update".',
		'The value of "update" must contain only facts that clearly changed or became known in this turn.',
		'Keep the update minimal: include the fewest valid records needed, usually 1-8 concrete facts.',
		'Use these optional keys when applicable: characters, locations, items, time_delta, mood, player_reputation, conversations, relationships, story_beats, meter_changes, agreements, lorebook_entries.',
		'Do not invent extra facts. Do not summarize prose. Do not mark NPCs as knowing things they could not perceive or learn.',
		'Player action:',
		playerText,
		'Narration:',
		compactBlock(narration, STATE_EXTRACTION_NARRATION_LIMIT),
	].join('\n\n');
}
