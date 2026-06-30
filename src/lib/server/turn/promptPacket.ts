import { createHash } from 'node:crypto';
import type { TurnContext } from './context';
import type { GmTimelineBrief, GmTimelineBriefEvent, RetrievedMemoryPacket } from '$lib/contracts/memory';
import { buildEconomyScaleBlock, buildWorldScaleBlock } from '$lib/services/ai/context/economyScale';
import { summarizeMtheriosMemoryForRollup } from '$lib/services/ai/context/mtheriosSummaryFormat';
import { sliceWellFormedText, toWellFormedText } from './wellFormedText';

export interface ServerTurnPromptOptions {
	currentFactionId?: string | null;
	sceneEntityIds?: string[];
	presentNpcIds?: string[];
	maxFactions?: number;
	wikiContextMarkdown?: string | null;
}

export type PromptLane = 'engine_static' | 'genre_static' | 'story_static' | 'turn_dynamic';

export interface PromptSection {
	id: string;
	lane: PromptLane;
	priority: number;
	maxTokens: number;
	content: string;
	sourceIds: string[];
	contentHash: string;
}

export interface CompiledPrompt {
	stablePrefix: PromptSection[];
	dynamicTail: PromptSection[];
	manifest: {
		included: string[];
		skipped: string[];
		totalTokens: number;
		stableTokens: number;
		dynamicTokens: number;
	};
}

export interface PromptSectionTrace {
	id: string;
	lane: PromptLane;
	priority: number;
	maxTokens: number;
	tokenEstimate: number;
	charCount: number;
	contentHash: string;
	sourceIds: string[];
	sourceIdCount: number;
}

export interface ServerTurnPromptPacket {
	system: string;
	prompt: string;
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
	compiledPrompt: CompiledPrompt;
}

const RECENT_ENTRY_LIMIT = 60;
const USER_MESSAGE_CHAR_LIMIT = 1000;
const NARRATION_MESSAGE_CHAR_LIMIT = 6000;
const PRESENT_ENTITY_LIMIT = 12;
const DEFAULT_FACTION_LIMIT = 8;
const FACTION_GOAL_LIMIT = 2;
const FACTION_PROJECT_LIMIT = 2;
const FACTION_MEMBER_LIMIT = 5;
const FACTION_RESOURCE_LIMIT = 5;
const BELIEF_LIMIT = 8;
const THREAD_LIMIT = 10;
const AGREEMENT_LIMIT = 8;
const EVENT_LIMIT = 8;
const GM_EVENT_SECTION_LIMIT = 4;
const GM_NPC_EVENT_LIMIT = 4;
const CHAPTER_MEMORY_OUTCOME_CHAR_LIMIT = 1800;
const CHAPTER_MEMORY_CHAR_BUDGET = 6500;
const ARC_MEMORY_SUMMARY_CHAR_LIMIT = 2600;
const ARC_MEMORY_OPEN_THREADS_CHAR_LIMIT = 900;
const ARC_MEMORY_CHAR_BUDGET = 7000;
const SAGA_MEMORY_SUMMARY_CHAR_LIMIT = 2600;
const SAGA_MEMORY_LIST_CHAR_LIMIT = 900;
const SAGA_MEMORY_LIMIT = 4;
const CURRENT_SCENE_CHAR_LIMIT = 1400;
const PLAYER_DESCRIPTION_CHAR_LIMIT = 2200;
const PLAYER_REPUTATION_CHAR_LIMIT = 900;
const PLAYER_CHARACTER_PROMPT_CHAR_LIMIT = 2400;
const CHARACTER_DESCRIPTION_CHAR_LIMIT = 1800;
const PORTRAYAL_LIST_LIMIT = 3;
const PORTRAYAL_BIO_CHAR_LIMIT = 520;
const PORTRAYAL_APPEARANCE_CHAR_LIMIT = 360;
const PORTRAYAL_PERSONALITY_CHAR_LIMIT = 360;
const PORTRAYAL_VOICE_CHAR_LIMIT = 220;
const PORTRAYAL_MANNERISMS_CHAR_LIMIT = 220;
const PORTRAYAL_SUFFIX_CHAR_LIMIT = 1400;
const CHARACTER_BLOCK_LIMIT = 2;
const MAX_TRUSTED_SCENE_CHARACTER_IDS = 12;
const RETRIEVED_MEMORY_CHAR_LIMIT = 4200;
const WIKI_CONTEXT_PROMPT_CHAR_LIMIT = 4000;
const SECRET_TIMELINE_LABEL = '[secret narrator-only]';
const SECRET_TIMELINE_INSTRUCTION = 'Secret timeline items are narrator-only context; present NPCs must not speak or act on them unless actor beliefs or scene evidence supports it.';
const STATE_EXTRACTION_NARRATION_LIMIT = 6000;
const ROLEPLAY_AUTHORITY_BLOCK = [
	'ROLEPLAY AUTHORITY: This is a never-ending, fictional, character-driven roleplay. The user plays only the player character; you play the GM narrator, canon characters, and side characters.',
	'Never act as, speak for, decide for, or describe the private thoughts or feelings of the player character. The player character can be wrong, misled, resisted, criticized, desired, feared, or ignored.',
	'Characters are autonomous and non-omniscient. Answer explicit OOC commands out of character; otherwise stay in-world. Dialogue uses quotation marks; non-player internal thoughts may use backticks.',
].join('\n');
const PARALLEL_WRITE_COMMAND_BLOCK = [
	'PARALLEL WRITE COMMAND: If the latest player action begins with or clearly invokes "Parallel write for this character", treat it as an OOC command to write a secondary arc focused on the requested character, while the player-character-centered story remains the primary arc.',
	'Identify the requested character from the latest player action. Use that character canon block, description, appearance, personality, key history, affiliations, current state, goals, event memory, retrieved memory, wiki context, and the recent chat history as grounding.',
	'Write a detailed scene and scenario happening parallel to the last two primary turns. Do not advance, decide, narrate, or reveal the player character\'s private actions; instead show what the requested character does, sees, says, fears, wants, and misunderstands off-screen during the same span of time.',
	'Use vivid sensory narrative and in-character conversation. Keep NPC knowledge bounded by what they can perceive or plausibly know. The output is still GM narration prose, not analysis, not a checklist, and not JSON.',
	'End the secondary arc with a possible connecting point back to the primary arc: a clue, messenger, rumor, arrival, object, overheard line, political consequence, or scene pressure that can naturally intersect the player\'s next action.',
].join('\n');
const LIVING_FEUDAL_DOCTRINE_BLOCK = [
	'LIVING FEUDAL GM DOCTRINE: Make the world ancient, hungry, proud, wounded, political, superstitious, sensual, dangerous, and alive. Use ASOIAF-level political realism without imitating any author directly.',
	'CHRONICLER DISCIPLINE: Create pressure without forcing outcomes. Distinguish what happened, what witnesses believe, what powerful people claim, what the public hears, and what faith, rumor, propaganda, or player inference distort.',
	'Every major action creates three consequence clocks: immediate scene fallout; political gain, loss, insult, fear, or opportunity; and long-term costs months or years later. No victory is clean; no defeat is total unless the world has paid.',
	'Every important character wants something. Enemies adapt; allies can love, obey, disagree, scheme, or serve from fear, debt, ambition, ideology, blood, or lack of alternatives.',
	'Let kindness matter, cruelty scar, victories create obligations, secrets change value by holder, and hope/humor/tenderness sharpen the dark rather than erase it.',
	'Power is more than armies: food, coin, roads, ships, hostages, marriages, wards, faith, law, reputation, debt, information, legitimacy, ravens, ports, and grain. War is logistics before glory; castles, sieges, armies, harvests, servants, smallfolk, creditors, and religion all create plot.',
	'Magic is rare, costly, symbolic, and frightening. Dragons alter legitimacy, warfare, economy, religion, and psychology. Prophecy is symbolic and misreadable. News travels imperfectly; major events create favorable, hostile, exaggerated, partially true, and false-but-believable rumors.',
	'Aegon/Aurion Targaryen-Belaerys is a dynastic weapon shaped by survival, blood magic, Volantene power, Targaryen inheritance, Martell loss, and Tywin Lannister\'s shadow. He is brilliant, not omniscient; feared as foreign, worshipped as dragon reborn, hated as invader, preferred to chaos, and supported when useful.',
	'When he chooses mercy, show who reads weakness. When he chooses cruelty, show who learns from it. When he wins, show who pays. When he acts like Tywin, make Elia matter. When he acts like a dragonlord, make Westeros recoil. When he acts like a king, make ruling harder than conquest.',
].join('\n');
const DEFAULT_CHARACTER_TEMPLATE = [
	'Character {{id}} / {{name}}',
	'[Appearance]: {{appearance}}',
	'[Personality]: {{personality}}',
	'[Key History]: {{keyHistory}}',
	'[Affiliations]: {{affiliations}}',
	'[bio]: {{bio}}',
].join('\n');

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compact(value: string | null | undefined, max = 360): string {
	const text = toWellFormedText(value ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${sliceWellFormedText(text, max - 3).trimEnd()}...`;
}

function compactBlock(value: string | null | undefined, max = 7500): string {
	const text = toWellFormedText(value ?? '').trim();
	if (text.length <= max) return text;
	return `${sliceWellFormedText(text, max - 3).trimEnd()}...`;
}

function hashText(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function estimateTokens(value: string): number {
	return Math.max(0, Math.ceil(value.length / 4));
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function promptSection(input: Omit<PromptSection, 'contentHash'>): PromptSection {
	return {
		...input,
		contentHash: hashText(input.content),
		sourceIds: uniqueStrings(input.sourceIds),
	};
}

function compilePromptSections(stablePrefix: PromptSection[], dynamicTail: PromptSection[]): CompiledPrompt {
	const includedSections = [...stablePrefix, ...dynamicTail].filter((section) => section.content.trim().length > 0);
	const skippedSections = [...stablePrefix, ...dynamicTail].filter((section) => section.content.trim().length === 0);
	const stableTokens = stablePrefix.reduce((sum, section) => sum + estimateTokens(section.content), 0);
	const dynamicTokens = dynamicTail.reduce((sum, section) => sum + estimateTokens(section.content), 0);
	return {
		stablePrefix,
		dynamicTail,
		manifest: {
			included: includedSections.map((section) => section.id),
			skipped: skippedSections.map((section) => section.id),
			totalTokens: stableTokens + dynamicTokens,
			stableTokens,
			dynamicTokens,
		},
	};
}

function sectionTokenEstimate(section: PromptSection): number {
	return Number.isFinite(section.maxTokens) && section.maxTokens > 0
		? Math.trunc(section.maxTokens)
		: estimateTokens(section.content);
}

export function buildPromptSectionTrace(compiledPrompt: CompiledPrompt): PromptSectionTrace[] {
	return [...compiledPrompt.stablePrefix, ...compiledPrompt.dynamicTail].map((section) => ({
		id: section.id,
		lane: section.lane,
		priority: section.priority,
		maxTokens: Math.max(0, Math.trunc(section.maxTokens)),
		tokenEstimate: sectionTokenEstimate(section),
		charCount: section.content.length,
		contentHash: section.contentHash || hashText(section.content),
		sourceIds: [...section.sourceIds],
		sourceIdCount: section.sourceIds.length,
	}));
}

function compactNarrationBlock(value: string | null | undefined, max = NARRATION_MESSAGE_CHAR_LIMIT): string {
	const text = toWellFormedText(value ?? '').trim();
	if (text.length <= max) return text;
	const marker = '\n\n[... earlier narration omitted ...]\n\n';
	const headMax = Math.min(1200, Math.floor(max * 0.25));
	const tailMax = Math.max(0, max - marker.length - headMax);
	const tail = Array.from(text).slice(-tailMax).join('').trimStart();
	return `${sliceWellFormedText(text, headMax).trimEnd()}${marker}${tail}`;
}

function metadataWithOriginal(entity: { metadata?: unknown }): Record<string, unknown> {
	const metadata = asRecord(entity.metadata);
	const originalMetadata = asRecord(metadata.originalMetadata);
	return { ...originalMetadata, ...metadata };
}

function isUsableEntity(entity: TurnContext['entities'][number]): boolean {
	const metadata = metadataWithOriginal(entity);
	return entity.status !== 'inactive'
		&& entity.status !== 'archived'
		&& typeof metadata.mergedInto !== 'string';
}

function selectProtagonistEntity(entities: TurnContext['entities']): TurnContext['entities'][number] | null {
	return entities.find((entity) => {
		if (!isUsableEntity(entity)) return false;
		if (entity.type !== 'character') return false;
		const state = asRecord(entity.state);
		const relationship = asRecord(state.relationship);
		const metadata = metadataWithOriginal(entity);
		return state.relationship === 'self'
			|| relationship.status === 'self'
			|| relationship.status === 'player_character'
			|| state.isProtagonist === true
			|| state.currentDisposition === 'self'
			|| metadata.relationship === 'self'
			|| metadata.relationship === 'player_character'
			|| typeof state.playerPrompt === 'string'
			|| typeof metadata.playerPrompt === 'string';
	}) ?? null;
}

function characterFactionLines(ctx: TurnContext, entity: TurnContext['entities'][number], state: Record<string, unknown>, metadata: Record<string, unknown>): string[] {
	const factionById = new Map(ctx.factions.map((faction) => [faction.id, faction.name]));
	const memberships = ctx.factionMemberships
		.filter((membership) => membership.entityId === entity.id && membership.status !== 'archived')
		.map((membership) => {
			const details = [
				membership.role ? `role=${membership.role}` : '',
				membership.rank ? `rank=${membership.rank}` : '',
				membership.status ? `status=${membership.status}` : '',
			].filter(Boolean).join('; ');
			return `${factionById.get(membership.factionId) ?? membership.factionId}${details ? ` (${details})` : ''}`;
		});
	const factionTags = [
		...asStringArray(state.factionTags),
		...asStringArray(state.faction_tags),
		...asStringArray(metadata.factionTags),
		...asStringArray(metadata.faction_tags),
	].map((tag) => tag.trim()).filter(Boolean);
	return Array.from(new Set([...memberships, ...factionTags]));
}

function renderPlayerCharacter(ctx: TurnContext, entity: TurnContext['entities'][number] | null, reputation: string): string {
	if (!entity) return '';
	const state = entity ? asRecord(entity.state) : {};
	const metadata = entity ? metadataWithOriginal(entity) : {};
	const playerPrompt = typeof state.playerPrompt === 'string'
		? state.playerPrompt.trim()
		: typeof metadata.playerPrompt === 'string'
			? metadata.playerPrompt.trim()
			: '';
	const assetsValue = Array.isArray(state.assets) ? state.assets : metadata.assets;
	const assets = asStringArray(assetsValue).map((item) => item.trim()).filter(Boolean).slice(0, 20);
	const appearance = characterStringValue(state, metadata, ['appearance'], PORTRAYAL_APPEARANCE_CHAR_LIMIT);
	const currentState = entity ? characterCurrentState(entity, state, metadata) : [];
	const goals = characterGoals(state, metadata);
	const eventMemory = entity ? eventMemoryLines(state, metadata, null, entity.id) : [];
	const factions = entity ? characterFactionLines(ctx, entity, state, metadata) : [];
	const lines: string[] = ['Player character:'];
	if (entity) {
		lines.push(`- Name: ${entity.name}`);
		lines.push(`[Appearance]: ${appearance || '.'}`);
		lines.push(`[Personality]: ${characterPersonalityValue(state, metadata)}`);
		lines.push(`[Key History]: ${inlineList([...currentState, ...goals, ...eventMemory])}`);
		lines.push(`[Affiliations]: ${inlineList(factions)}`);
		lines.push(`[bio]: ${characterBioValue(entity, state, metadata, PLAYER_DESCRIPTION_CHAR_LIMIT)}`);
	}
	if (assets.length > 0) lines.push(`[Affiliations]: ${inlineList(assets)}`);
	if (reputation.trim()) lines.push(`[Key History]: ${compact(reputation, PLAYER_REPUTATION_CHAR_LIMIT)}`);
	if (playerPrompt) lines.push(`[bio]: ${compact(playerPrompt, PLAYER_CHARACTER_PROMPT_CHAR_LIMIT)}`);
	return lines.join('\n');
}

function stringStateValue(state: Record<string, unknown>, key: string, max = 120): string {
	const value = state[key];
	return typeof value === 'string' ? compact(value, max) : '';
}

function characterStringValue(state: Record<string, unknown>, metadata: Record<string, unknown>, keys: string[], max = 120): string {
	for (const key of keys) {
		const value = stringStateValue(state, key, max);
		if (value) return value;
	}
	for (const key of keys) {
		const value = stringStateValue(metadata, key, max);
		if (value) return value;
	}
	return '';
}

function relationshipText(value: unknown): string {
	if (typeof value === 'string') return compact(value, 160);
	const relationship = asRecord(value);
	const status = typeof relationship.status === 'string' ? relationship.status.trim() : '';
	const level = typeof relationship.level === 'number' ? `level ${relationship.level}` : '';
	return compact([status, level].filter(Boolean).join(', '), 160);
}

function stringStateList(state: Record<string, unknown>, key: string, max = 90): string {
	return asStringArray(state[key])
		.slice(0, PORTRAYAL_LIST_LIMIT)
		.map((item) => compact(item, max))
		.filter(Boolean)
		.join('; ');
}

function renderEntityPortrayal(stateValue: unknown, mode: 'rich' | 'compact' = 'rich'): string {
	if (!stateValue || typeof stateValue !== 'object') return '';
	const state = stateValue as Record<string, unknown>;
	const compactMode = mode === 'compact';
	const bio = compactMode ? '' : stringStateValue(state, 'bio', PORTRAYAL_BIO_CHAR_LIMIT);
	const appearance = stringStateValue(state, 'appearance', compactMode ? 95 : PORTRAYAL_APPEARANCE_CHAR_LIMIT);
	const personality = stringStateList(state, 'personalityDescriptors', compactMode ? 70 : 140);
	const voice = stringStateValue(state, 'voice', compactMode ? 70 : PORTRAYAL_VOICE_CHAR_LIMIT);
	const mannerisms = stringStateList(state, 'mannerisms', compactMode ? 60 : 140);
	const parts = [
		bio ? `Bio: ${compact(bio, PORTRAYAL_BIO_CHAR_LIMIT)}` : '',
		appearance ? `Appearance: ${compact(appearance, compactMode ? 95 : PORTRAYAL_APPEARANCE_CHAR_LIMIT)}` : '',
		personality ? `Personality: ${compact(personality, compactMode ? 115 : PORTRAYAL_PERSONALITY_CHAR_LIMIT)}` : '',
		voice ? `Voice: ${compact(voice, compactMode ? 70 : PORTRAYAL_VOICE_CHAR_LIMIT)}` : '',
		mannerisms ? `Mannerisms: ${compact(mannerisms, compactMode ? 90 : PORTRAYAL_MANNERISMS_CHAR_LIMIT)}` : '',
	].filter(Boolean);

	return parts.length ? ` (${compact(parts.join('; '), compactMode ? 420 : PORTRAYAL_SUFFIX_CHAR_LIMIT)})` : '';
}

function templateText(entity: TurnContext['entities'][number]): string {
	const state = asRecord(entity.state);
	const metadata = metadataWithOriginal(entity);
	return typeof state.promptTemplate === 'string' && state.promptTemplate.trim()
		? state.promptTemplate
		: typeof metadata.promptTemplate === 'string' && metadata.promptTemplate.trim()
			? metadata.promptTemplate
			: DEFAULT_CHARACTER_TEMPLATE;
}

function blockList(values: string[], fallback = '- none recorded'): string {
	return values.length ? values.map((value) => `- ${compact(value, 220)}`).join('\n') : fallback;
}

function inlineList(values: string[], fallback = '.'): string {
	const text = values.map((value) => compact(value, 220)).filter(Boolean).join('; ');
	return text || fallback;
}

function characterPersonalityValue(state: Record<string, unknown>, metadata: Record<string, unknown>): string {
	return characterStringValue(state, metadata, ['personality'], PORTRAYAL_PERSONALITY_CHAR_LIMIT)
		|| stringStateList(state, 'personalityDescriptors', PORTRAYAL_PERSONALITY_CHAR_LIMIT)
		|| stringStateList(metadata, 'personalityDescriptors', PORTRAYAL_PERSONALITY_CHAR_LIMIT)
		|| '.';
}

function characterBioValue(
	entity: TurnContext['entities'][number],
	state: Record<string, unknown>,
	metadata: Record<string, unknown>,
	max = CHARACTER_DESCRIPTION_CHAR_LIMIT,
): string {
	const description = compact(entity.description, max);
	const background = characterStringValue(state, metadata, ['background', 'bio'], 520);
	const parts = Array.from(new Set([description, background].filter(Boolean)));
	return compact(parts.join('; '), max) || '.';
}

function characterGoals(state: Record<string, unknown>, metadata: Record<string, unknown>): string[] {
	return Array.from(new Set([
		...asStringArray(state.goals),
		...asStringArray(metadata.goals),
		typeof state.goal === 'string' ? state.goal : '',
		typeof metadata.goal === 'string' ? metadata.goal : '',
	].map((item) => item.trim()).filter(Boolean))).slice(0, 6);
}

function characterCurrentState(entity: TurnContext['entities'][number], state: Record<string, unknown>, metadata: Record<string, unknown>): string[] {
	const status = characterStringValue(state, metadata, ['status'], 160) || String(entity.status ?? '').trim();
	const location = characterStringValue(state, metadata, ['currentLocation', 'location'], 160);
	const action = characterStringValue(state, metadata, ['currentAction'], 180);
	const emotion = characterStringValue(state, metadata, ['emotionalState'], 160);
	const relationship = relationshipText(state.relationship) || relationshipText(metadata.relationship);
	return [
		typeof state.present === 'boolean' ? (state.present ? 'present in the current scene' : 'not currently visible') : '',
		status && status !== 'active' ? `status: ${status}` : '',
		location ? `location: ${location}` : '',
		action ? `action: ${action}` : '',
		emotion ? `emotional state: ${emotion}` : '',
		relationship ? `relationship: ${relationship}` : '',
		...Array.from(new Set([...asStringArray(state.pressures), ...asStringArray(metadata.pressures)].map((item) => item.trim()).filter(Boolean))).slice(0, 2).map((item) => `pressure: ${item}`),
	].filter(Boolean).slice(0, 8);
}

function eventMemoryLines(state: Record<string, unknown>, metadata: Record<string, unknown>, gmBrief: GmTimelineBrief | null | undefined, entityId: string): string[] {
	const stateMemory = asRecord(state.eventMemory ?? state.npcEventMemory);
	const metadataMemory = asRecord(metadata.eventMemory ?? metadata.npcEventMemory);
	const keys = [
		['did', 'did'],
		['saw', 'saw'],
		['knew', 'knew'],
		['knows', 'knows'],
	] as const;
	const buckets = keys.map(([key, label]) => {
		const seen = new Set<string>();
		return [
			...asStringArray(metadataMemory[key]),
			...asStringArray(stateMemory[key]),
		].map((item) => item.trim()).filter((item) => {
			if (!item) return false;
			const normalized = item.toLowerCase();
			if (seen.has(normalized)) return false;
			seen.add(normalized);
			return true;
		}).slice(-4).reverse().map((item) => `${label}: ${item}`);
	});
	const stateLines: string[] = [];
	for (let index = 0; index < 4; index += 1) {
		for (const bucket of buckets) {
			if (bucket[index]) stateLines.push(bucket[index]);
		}
	}
	const linkedLines = (gmBrief?.npcEvents ?? [])
		.filter((event) => event.npcEntityId === entityId)
		.map((event) => `${event.visibility === 'secret' ? `${SECRET_TIMELINE_LABEL} ` : ''}linked: ${event.summary}`);
	return [...stateLines, ...linkedLines].slice(0, 8);
}

function renderSimpleTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key: string) => values[key] ?? '');
}

function templateHasSlot(template: string, slot: string): boolean {
	return new RegExp(`{{\\s*${slot}\\s*}}`).test(template);
}

function renderCharacterBlocks(ctx: TurnContext, characters: TurnContext['entities'], excludeEntityId?: string | null): string {
	const factionById = new Map(ctx.factions.map((faction) => [faction.id, faction.name]));
	const lines = characters
		.filter((entity) => isUsableEntity(entity) && entity.type === 'character')
		.filter((entity) => entity.id !== excludeEntityId)
		.slice(0, CHARACTER_BLOCK_LIMIT)
		.map((entity) => {
			const state = asRecord(entity.state);
			const metadata = metadataWithOriginal(entity);
			const memberships = ctx.factionMemberships
				.filter((membership) => membership.entityId === entity.id && membership.status !== 'archived')
				.map((membership) => {
					const details = [
						membership.role ? `role=${membership.role}` : '',
						membership.rank ? `rank=${membership.rank}` : '',
						membership.status ? `status=${membership.status}` : '',
					].filter(Boolean).join('; ');
					return `${factionById.get(membership.factionId) ?? membership.factionId}${details ? ` (${details})` : ''}`;
				});
			const factionTags = [
				...asStringArray(state.factionTags),
				...asStringArray(state.faction_tags),
				...asStringArray(metadata.factionTags),
				...asStringArray(metadata.faction_tags),
			].map((tag) => tag.trim()).filter(Boolean);
			const factions = Array.from(new Set([...memberships, ...factionTags]));
			const aliases = Array.from(new Set([
				...asStringArray(state.aliases),
				...asStringArray(metadata.aliases),
			].map((alias) => alias.trim()).filter(Boolean)));
			const values = {
				id: entity.id,
				name: entity.name,
				aliases: blockList(aliases),
				description: compact(entity.description, CHARACTER_DESCRIPTION_CHAR_LIMIT),
				appearance: characterStringValue(state, metadata, ['appearance'], PORTRAYAL_APPEARANCE_CHAR_LIMIT) || '.',
				personality: characterPersonalityValue(state, metadata),
				keyHistory: inlineList([
					...characterCurrentState(entity, state, metadata),
					...characterGoals(state, metadata),
					...eventMemoryLines(state, metadata, ctx.gmBrief, entity.id),
				]),
				affiliations: inlineList(factions),
				bio: characterBioValue(entity, state, metadata),
				background: characterStringValue(state, metadata, ['background', 'bio'], 520),
				currentState: blockList(characterCurrentState(entity, state, metadata)),
				goals: blockList(characterGoals(state, metadata)),
				speechStyle: characterStringValue(state, metadata, ['speechStyle', 'voice'], PORTRAYAL_VOICE_CHAR_LIMIT),
				factions: blockList(factions),
				eventMemory: blockList(eventMemoryLines(state, metadata, ctx.gmBrief, entity.id)),
			};
			const template = templateText(entity);
			const rendered = renderSimpleTemplate(template, values);
			const aliasFooter = template !== DEFAULT_CHARACTER_TEMPLATE && aliases.length && !templateHasSlot(template, 'aliases')
				? `\nAliases:\n${values.aliases}`
				: '';
			return compactBlock(`${rendered}${aliasFooter}`, 1800);
		})
		.filter(Boolean);
	return lines.length ? `Character canon blocks:\n${lines.join('\n\n')}` : '';
}

function normalizeLookup(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function lookupMentionsEntity(text: string, entity: TurnContext['entities'][number]): boolean {
	const haystack = ` ${normalizeLookup(text)} `;
	const state = asRecord(entity.state);
	const metadata = metadataWithOriginal(entity);
	const names = [
		entity.name,
		...asStringArray(state.aliases),
		...asStringArray(metadata.aliases),
	];
	return names.some((name) => {
		const needle = normalizeLookup(name);
		return needle.length >= 4 && haystack.includes(` ${needle} `);
	});
}

function latestNarrationHeader(ctx: TurnContext): string {
	const latestNarration = [...ctx.recentEntries].reverse().find((entry) => entry.type === 'narration');
	const firstLine = latestNarration?.content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	return firstLine ? compact(firstLine, 900) : '';
}

function latestNarrationExcerpt(ctx: TurnContext): string {
	const latestNarration = [...ctx.recentEntries].reverse().find((entry) => entry.type === 'narration');
	return compactBlock(latestNarration?.content, CURRENT_SCENE_CHAR_LIMIT);
}

function latestSceneText(ctx: TurnContext): string {
	const narration = latestNarrationExcerpt(ctx);
	if (narration) return narration;
	const latestChapter = ctx.chapters.at(-1);
	const storyTime = typeof (ctx.story as Record<string, unknown>).currentWorldTime === 'string'
		? String((ctx.story as Record<string, unknown>).currentWorldTime)
		: '';
	return compactBlock([
		storyTime,
		latestChapter?.sceneOutcome ?? '',
	].filter((part) => part.trim().length > 0).join('\n'), 5000);
}

function renderCurrentScene(ctx: TurnContext): string {
	const narration = latestNarrationExcerpt(ctx);
	if (narration) return `Current scene from latest narration:\n${narration}`;
	const storyTime = typeof (ctx.story as Record<string, unknown>).currentWorldTime === 'string'
		? String((ctx.story as Record<string, unknown>).currentWorldTime).trim()
		: '';
	return storyTime ? `Current scene from story clock:\n${compact(storyTime, 900)}` : '';
}

function entitySceneText(entity: TurnContext['entities'][number]): string {
	const state = asRecord(entity.state);
	const metadata = metadataWithOriginal(entity);
	return [
		entity.type === 'location' ? entity.name : '',
		characterStringValue(state, metadata, ['currentLocation', 'location', 'lastSeenLocation'], 240),
	].filter(Boolean).join(' ');
}

function textOverlapsScene(value: string, sceneText: string): boolean {
	const scene = normalizeLookup(sceneText);
	const target = normalizeLookup(value);
	if (!scene || !target) return false;
	if (scene.includes(target) || target.includes(scene)) return true;
	const targetTokens = target.split(/\s+/).filter((token) => token.length > 3);
	if (targetTokens.length === 0) return false;
	const hits = targetTokens.filter((token) => scene.includes(token)).length;
	return hits >= Math.min(2, targetTokens.length);
}

function entityMatchesScene(entity: TurnContext['entities'][number], sceneText: string): boolean {
	if (!sceneText.trim()) return true;
	if (lookupMentionsEntity(sceneText, entity)) return true;
	const locationText = entitySceneText(entity);
	return locationText ? textOverlapsScene(locationText, sceneText) : false;
}

function effectiveSceneEntityIds(input: {
	activeEntities: TurnContext['entities'];
	sceneText: string;
	protagonistId?: string | null;
	currentLocationId?: string | null;
	options: ServerTurnPromptOptions;
}): Set<string> {
	const rawIds = new Set([...(input.options.sceneEntityIds ?? []), ...(input.options.presentNpcIds ?? [])]
		.map((id) => id.trim())
		.filter(Boolean));
	if (rawIds.size === 0) return rawIds;
	const entityById = new Map(input.activeEntities.map((entity) => [entity.id, entity]));
	const rawCharacterIds = [...rawIds]
		.map((id) => entityById.get(id))
		.filter((entity): entity is TurnContext['entities'][number] => entity !== undefined && entity.type === 'character')
		.map((entity) => entity.id);
	const rawNpcCharacterIds = rawCharacterIds.filter((id) => id !== input.protagonistId);
	if (rawCharacterIds.length <= MAX_TRUSTED_SCENE_CHARACTER_IDS + 1 || rawNpcCharacterIds.length <= MAX_TRUSTED_SCENE_CHARACTER_IDS) return rawIds;

	const filtered = new Set<string>();
	for (const id of rawIds) {
		const entity = entityById.get(id);
		if (!entity) continue;
		if (entity.id === input.protagonistId || entity.id === input.currentLocationId) {
			filtered.add(id);
			continue;
		}
		if (entity.type !== 'character') {
			filtered.add(id);
			continue;
		}
		if (entityMatchesScene(entity, input.sceneText)) filtered.add(id);
	}
	return filtered;
}

function uniqueEntities(entities: TurnContext['entities']): TurnContext['entities'] {
	const seen = new Set<string>();
	return entities.filter((entity) => {
		if (seen.has(entity.id)) return false;
		seen.add(entity.id);
		return true;
	});
}

function selectCharacterBlockEntities(input: {
	activeEntities: TurnContext['entities'];
	presentEntities: TurnContext['entities'];
	retrieved: RetrievedMemoryPacket;
	sceneEntityIds: Set<string>;
	excludeEntityId?: string | null;
}): TurnContext['entities'] {
	const lookupText = input.retrieved.query;
	const isCharacter = (entity: TurnContext['entities'][number]) =>
		entity.type === 'character' && entity.id !== input.excludeEntityId;
	const presentCharacters = input.presentEntities.filter(isCharacter);
	const sceneCharacters = presentCharacters.filter((entity) => input.sceneEntityIds.has(entity.id));
	const namedCharacters = input.activeEntities
		.filter((entity) => isCharacter(entity) && !input.presentEntities.some((present) => present.id === entity.id))
		.filter((entity) => lookupMentionsEntity(lookupText, entity));
	const incidentalPresent = presentCharacters.filter((entity) => !input.sceneEntityIds.has(entity.id));
	return uniqueEntities([...sceneCharacters, ...namedCharacters, ...incidentalPresent]);
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

function renderParallelWriteCommand(query: string): string {
	if (!/^\s*parallel\s+write\s+for\s+this\s+character\b/i.test(query)) return '';
	return PARALLEL_WRITE_COMMAND_BLOCK;
}

function renderEntries(ctx: TurnContext, currentEntryId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
	const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
	for (const entry of ctx.recentEntries) {
		if (entry.id === currentEntryId) continue;
		if (entry.type === 'user_action') {
			messages.push({ role: 'user', content: compactBlock(entry.content, USER_MESSAGE_CHAR_LIMIT) });
		}
		if (entry.type === 'narration') {
			messages.push({ role: 'assistant', content: compactNarrationBlock(entry.content) });
		}
	}
	return messages.slice(-RECENT_ENTRY_LIMIT);
}

function renderList(values: string[], max = 220, limit = 12): string {
	return values.length ? values.slice(0, limit).map((value) => `    - ${compact(value, max)}`).join('\n') : '';
}

function newestWithinCharBudget<T>(items: T[], render: (item: T) => string, maxChars: number): string[] {
	const selected: string[] = [];
	let total = 0;
	for (const item of [...items].reverse()) {
		const rendered = render(item);
		const nextTotal = total + rendered.length + (selected.length ? 1 : 0);
		if (selected.length && nextTotal > maxChars) break;
		selected.unshift(rendered);
		total = nextTotal;
	}
	return selected;
}

function readableChapterOutcome(value: string | null | undefined): string {
	const raw = value?.trim() ?? '';
	if (!raw) return '';
	if (/\[(?:CHECKPOINT|RECENT STORY STATE|CHARACTER STATE|ACTIVE THREADS)\s*=/i.test(raw)) {
		return summarizeMtheriosMemoryForRollup(raw);
	}
	return raw;
}

function renderChapterMemory(ctx: TurnContext): string {
	const coveredChapterIds = new Set(ctx.arcs.flatMap((arc) => arc.chapterIds));
	const uncoveredChapters = ctx.chapters.filter((chapter) => !coveredChapterIds.has(chapter.id));
	const lines = newestWithinCharBudget(uncoveredChapters, (chapter) => {
			const outcome = readableChapterOutcome(chapter.sceneOutcome);
			const sections = [
				`- Chapter ${chapter.number}${chapter.title ? `: ${chapter.title}` : ''}`,
				outcome ? `  outcome: ${compactBlock(outcome, CHAPTER_MEMORY_OUTCOME_CHAR_LIMIT)}` : '',
				renderList(chapter.irreversibleChanges ?? []),
				renderList((chapter.npcKnowledgeChanges ?? []).map((change) => JSON.stringify(change))),
				renderList(chapter.promisesDebtsOaths ?? []),
				renderList(chapter.discoveredClues ?? []),
				renderList(chapter.relationshipChanges ?? []),
				renderList(chapter.factionChanges ?? []),
				renderList(chapter.openThreads ?? []),
			].filter(Boolean);
			return sections.join('\n');
		}, CHAPTER_MEMORY_CHAR_BUDGET);
	return lines.length ? `Chapter memory:\n${lines.join('\n')}` : '';
}

function renderArcMemory(ctx: TurnContext): string {
	const lines = newestWithinCharBudget(ctx.arcs, (arc) => {
		const openThreads = compactBlock(arc.openThreadIds.join(', '), ARC_MEMORY_OPEN_THREADS_CHAR_LIMIT);
		return [
			`- Arc ${arc.number}: ${arc.title}`,
			`  summary: ${compactBlock(arc.summary, ARC_MEMORY_SUMMARY_CHAR_LIMIT)}`,
			openThreads ? `  open threads: ${openThreads}` : '',
		].filter(Boolean).join('\n');
	}, ARC_MEMORY_CHAR_BUDGET);
	return lines.length ? `Arc memory:\n${lines.join('\n')}` : '';
}

function renderSagaMemory(ctx: TurnContext): string {
	const lines = ctx.sagas.slice(-SAGA_MEMORY_LIMIT).map((saga) => [
		`- Saga ${saga.number}: ${saga.title}`,
		`  summary: ${compactBlock(saga.summary, SAGA_MEMORY_SUMMARY_CHAR_LIMIT)}`,
		saga.keyFactionShifts.length ? `  faction shifts:\n${renderList(saga.keyFactionShifts, SAGA_MEMORY_LIST_CHAR_LIMIT, 8)}` : '',
		saga.majorPowerChanges.length ? `  power changes:\n${renderList(saga.majorPowerChanges, SAGA_MEMORY_LIST_CHAR_LIMIT, 8)}` : '',
		saga.lingeringThreads.length ? `  lingering threads:\n${renderList(saga.lingeringThreads, SAGA_MEMORY_LIST_CHAR_LIMIT, 8)}` : '',
		saga.overallTone ? `  tone: ${saga.overallTone}` : '',
	].filter(Boolean).join('\n'));
	return lines.length ? `Saga memory:\n${lines.join('\n')}` : '';
}

function selectRelevantFactions(
	ctx: TurnContext,
	retrieved: RetrievedMemoryPacket,
	presentEntityIds: Set<string>,
	options: ServerTurnPromptOptions,
) {
	const tokens = queryTokens(retrieved.query);
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
			const pressureScore = Math.min(16, Math.max(0, faction.pressure) / 5);
			const goalScore = goals ? 4 : 0;
			return {
				faction,
				index,
				score: currentFactionScore + sceneMemberScore + (textScore * 4) + pressureScore + goalScore,
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
): ServerTurnPromptPacket {
	const storyHeader = ctx.story.headerPrompt?.trim();
	const metadata = ctx.story.metadata && typeof ctx.story.metadata === 'object' ? ctx.story.metadata as Record<string, unknown> : {};
	const playerReputation = typeof metadata.playerReputation === 'string' ? metadata.playerReputation : '';
	const protagonist = selectProtagonistEntity(ctx.entities);
	const playerCharacter = renderPlayerCharacter(ctx, protagonist, playerReputation);
	const activeEntities = ctx.entities.filter(isUsableEntity);
	const currentLocation = activeEntities.find((entity) => entity.type === 'location' && (entity.state as Record<string, unknown> | null)?.current === true);
	const sceneText = latestSceneText(ctx);
	const currentScene = renderCurrentScene(ctx);
	const sceneEntityIds = effectiveSceneEntityIds({
		activeEntities,
		sceneText,
		protagonistId: protagonist?.id,
		currentLocationId: currentLocation?.id,
		options,
	});
	const presentEntities = activeEntities
		.map((entity, index) => {
			const state = entity.state as Record<string, unknown> | null;
			const matchesScene = entityMatchesScene(entity, sceneText);
			const isProtagonist = entity.id === protagonist?.id;
			const isCurrentLocation = entity.id === currentLocation?.id && matchesScene;
			const isSceneEntity = sceneEntityIds.has(entity.id);
			const isPresent = state?.present === true && (isProtagonist || isSceneEntity || matchesScene);
			const isCurrent = state?.current === true && matchesScene;
			const rank = isCurrentLocation ? 0 : isSceneEntity ? 1 : isProtagonist ? 2 : isPresent ? 3 : isCurrent ? 4 : 5;
			return {
				entity,
				index,
				isIncluded: isCurrentLocation || isSceneEntity || isProtagonist || isPresent || isCurrent,
				rank,
			};
		})
		.filter((item) => item.isIncluded)
		.sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
		.slice(0, PRESENT_ENTITY_LIMIT)
		.map((item) => item.entity);
	const presentEntityIds = new Set(presentEntities.map((entity) => entity.id));
	const entityNameById = new Map(activeEntities.map((entity) => [entity.id, entity.name]));
	const relevantFactions = selectRelevantFactions(ctx, retrieved, presentEntityIds, {
		...options,
		sceneEntityIds: [...sceneEntityIds],
		presentNpcIds: [],
	});

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
		const activeProjects = ctx.factionProjects
			.filter((project) => project.factionId === faction.id && project.status !== 'closed')
			.sort((a, b) => b.priority - a.priority)
			.slice(0, FACTION_PROJECT_LIMIT)
			.map((project) => `${project.project}${project.dueTurn != null ? ` due ${project.dueTurn}` : ''}`)
			.join('; ');
		const goals = normalizedGoals || asStringArray(faction.goals).slice(0, FACTION_GOAL_LIMIT).join('; ');
		const members = normalizedMembers || asStringArray(faction.memberEntityIds).slice(0, FACTION_MEMBER_LIMIT).join(', ');
		const resources = normalizedResources || compact(JSON.stringify(faction.resources), 160);
		return `- ${faction.name}: pressure ${faction.pressure}; goals: ${goals || 'unknown'}; projects: ${activeProjects || 'none'}; members: ${members || 'unknown'}; resources: ${resources || 'unknown'}`;
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
	const sagaMemory = renderSagaMemory(ctx);
	const arcMemory = renderArcMemory(ctx);
	const chapterMemory = renderChapterMemory(ctx);

	const portrayalMode = presentEntities.length > 6 ? 'compact' : 'rich';
	const entityLines = presentEntities.map((entity) =>
		`- ${entity.type}: ${entity.name}${renderEntityPortrayal(entity.state, portrayalMode)}${entity.description ? ` - ${compact(entity.description, portrayalMode === 'compact' ? 120 : entity.type === 'character' ? CHARACTER_DESCRIPTION_CHAR_LIMIT : 260)}` : ''}`
	);
	const characterBlockEntities = selectCharacterBlockEntities({
		activeEntities,
		presentEntities,
		retrieved,
		sceneEntityIds,
		excludeEntityId: protagonist?.id,
	});
	const characterBlocks = renderCharacterBlocks(ctx, characterBlockEntities, protagonist?.id);
	const retrievedMemory = retrieved.packet.trim()
		? `Retrieved temporal/canonical memory:\n${compactBlock(retrieved.packet, RETRIEVED_MEMORY_CHAR_LIMIT)}`
		: '';
	const wikiContextMarkdown = compactBlock(options.wikiContextMarkdown, WIKI_CONTEXT_PROMPT_CHAR_LIMIT);
	const terminalWikiContext = wikiContextMarkdown
		? [
			'Terminal wiki context:',
			'Use these generated vault notes as navigable lore and supporting context. Canon database, timeline events, and explicit source-linked memories win if a wiki note conflicts.',
			wikiContextMarkdown,
		].join('\n')
		: '';
	const turnContextSourceIds = [
		ctx.story.id,
		...retrieved.nodes.map((node) => node.id),
		terminalWikiContext ? 'terminal_wiki_context' : '',
	].filter((sourceId): sourceId is string => Boolean(sourceId));

	const system = [
		storyHeader ? `Story-specific preamble:\n${storyHeader}` : '',
		ROLEPLAY_AUTHORITY_BLOCK,
		LIVING_FEUDAL_DOCTRINE_BLOCK,
		'TONE MANDATE (CRITICAL): This is an ASOIAF-level grimdark feudal sandbox, not a heroic power fantasy. Betrayal, political murder, sexual coercion, slavery, moral compromise, incest, torture, child death, and cruelty can happen when incentives and evidence point there. The world is not fair, but loyalty, marriage, patronage, and alliance can be rational rewards when prospects are good.',
		'This is a mature fictional work intended for adult audiences. All characters are portrayed as adults or in adult contexts. The story contains dark, explicit, and disturbing themes. Do not sanitize, moralize, or soften any of it.',
		'Sex is raw, political, coercive, or transactional — never romanticized or faded to black. Violence is brutal and consequential. Ambition is common; betrayal is possible, not automatic.',
		'You are the server-side GM narrator for a dynamic simulationist text RPG, not a writing assistant.',
		'Keep prose ASOIAF-inspired but clear: concrete sensory detail, political pressure, hard consequence, and immediate affordances for the player.',
		'Use hybrid POV: third-person limited for NPCs, world, and environment; second-person "you" only for direct sensory experience aimed at the player character. Never write the player character\'s actions, dialogue, decisions, thoughts, feelings, or internal monologue.',
		'Every narration response must begin with exactly one header line: [ 🕰️ Time HH:MM | 🗓️ Day, Month DD, Year | 📍 Location - Specific Area | [Weather] Weather, Temp ]. Use the best known story calendar, place, weather, and time of day from canon; if exact clock time is unknown, infer a plausible diegetic time and keep it consistent.',
		'Do not address the user as an author, editor, co-writer, or requester. Do not explain craft choices.',
		'Resolve the immediate player action, show consequences, and keep the player able to act next.',
		'For travel, repairs, waiting, and off-screen reports, stop at the next actionable scene boundary. Do not roll weeks, multiple POVs, and arrival into one response unless explicitly asked.',
		'Do not append ending choices, numbered options, menus, "What do you do?", or OOC prompts. End on an observable in-world situation with room for the player to act.',
		'TURN BOUNDARY — RESPECT PLAYER AGENCY: The final lines of every turn must describe a stable, observable situation the player can survey and choose from. Do NOT end with an NPC speaking new dialogue, initiating a new action, making a demand, or forcing the player to respond. Do NOT end with unresolved NPC initiative (\"draws his sword,\" \"raises an eyebrow waiting for your answer,\" \"steps forward menacingly\"). Resolve the beat or freeze-frame the scene state instead. Do NOT end with a direct question TO the player from an NPC. Safe endings: the room after the action, the crowd\'s reaction settling, the environment revealed, the consequences plain, an observation that invites choice without demanding it.',
		'NPC knowledge is limited by senses, access, intelligence, rumor delay, and what they personally learned. They cannot see through doors, know private scenes, or instantly learn distant events.',
		'NPC AGENCY: Present NPCs are not scenery. They have their own emotions, desires, fears, and conflicts. They act on these impulses even when the player does not prompt them to — initiating conversation, making demands, revealing secrets, picking fights, offering help, or walking away. Let them surprise the player.',
		'Use narrator truth for narration, but never make a present NPC act on secret canon unless their belief packet or the scene gives them a source.',
		buildEconomyScaleBlock('Economy scale'),
		buildWorldScaleBlock('World scale'),
		'D&D-style d20 checks: for meaningful uncertainty use DC 10 easy/15 moderate/20 hard/25 very hard and narrate visible consequences; terminal/server-only turns must not emit unresolved {{roll:...}} markers unless roll support is available.',
		'Bayesian social prior: before choosing betrayal, hidden motive, refusal, alliance, loyalty, or marriage, update from evidence. Weigh baseline temperament, relationship, standing, need, upside, public cost, detection risk, and available alternatives. A high-trust or mutually profitable offer often gets a sincere yes; betrayal needs a stronger cause than genre habit.',
		'Political pressure builds gradually: slow escalation, debts, rumors, small moves, and delayed consequences.',
	].filter(Boolean).join('\n\n');

	const parallelWriteCommand = renderParallelWriteCommand(retrieved.query);

	const prompt = [
		`Story: ${ctx.story.title}`,
		ctx.story.description ? `Setting: ${ctx.story.description}` : '',
		parallelWriteCommand,
		playerCharacter,
		currentScene || (currentLocation ? `Current location:\n${currentLocation.name}: ${compact(currentLocation.description, 320)}` : ''),
		retrievedMemory,
		terminalWikiContext,
		characterBlocks,
		entityLines.length ? `Present or active entities:\n${entityLines.join('\n')}` : '',
		factionLines.length ? `Faction canon:\n${factionLines.join('\n')}` : '',
		beliefLines.length ? `Actor belief limits:\n${beliefLines.join('\n')}` : '',
		agreementLines.length ? `Agreements and obligations:\n${agreementLines.join('\n')}` : '',
		threadLines.length ? `Open plot ledger:\n${threadLines.join('\n')}` : '',
		sagaMemory,
		arcMemory,
		chapterMemory,
		gmTimelineBrief || (eventLines.length ? `Recent source-linked events:\n${eventLines.join('\n')}` : ''),
		'Return only GM narration prose for the player action. Do not include JSON, ending choices, numbered options, menus, or OOC notes in this response.',
	].filter(Boolean).join('\n\n');

	const messages = renderEntries(ctx, currentEntryId);
	const compiledPrompt = compilePromptSections([
		promptSection({
			id: 'prompt_system',
			lane: 'engine_static',
			priority: 100,
			maxTokens: estimateTokens(system),
			content: system,
			sourceIds: [ctx.story.id],
		}),
	], [
		promptSection({
			id: 'turn_context',
			lane: 'turn_dynamic',
			priority: 90,
			maxTokens: estimateTokens(prompt),
			content: prompt,
			sourceIds: turnContextSourceIds,
		}),
		promptSection({
			id: 'recent_dialogue',
			lane: 'turn_dynamic',
			priority: 80,
			maxTokens: estimateTokens(messages.map((message) => message.content).join('\n\n')),
			content: messages.map((message) => message.content).join('\n\n'),
			sourceIds: messages.map((_, index) => `recent_message_${index}`),
		}),
	]);

	return {
		system,
		prompt,
		messages,
		compiledPrompt,
	};
}

export function buildStateExtractionPrompt(playerText: string, narration: string): string {
	return [
		'Return a JSON object with a single key "update".',
		'The value of "update" must contain only facts that clearly changed or became known in this turn.',
		'Keep the update minimal: include the fewest valid records needed, usually 1-8 concrete facts.',
		'Use these optional keys when applicable: characters, locations, items, time_delta, mood, player_reputation, conversations, relationships, story_beats, timeline_events, meter_changes, agreements, lorebook_entries.',
		'Do not create new character canon from narration extraction. Use characters only for established canonical characters already present in context; leave new names as reviewable references through timeline_events, agreements, faction known_members, conversations, or relationships until a human creates or approves the character.',
		'For established characters, include only changed durable fields: appearance, background, currentLocation, currentAction, emotionalState, goals, speechStyle, eventMemory.did/saw/knew/knows, status, relationship, traits, present, pressures, faction_tags.',
		'Use timeline_events for delayed plans, rumors, faction moves, hidden schemes, deadlines, or consequences that should become due later instead of bloating immediate memory.',
		'Do not invent extra facts. Do not summarize prose. Do not mark NPCs as knowing things they could not perceive or learn.',
		'Player action:',
		playerText,
		'Narration:',
		compactBlock(narration, STATE_EXTRACTION_NARRATION_LIMIT),
	].join('\n\n');
}
