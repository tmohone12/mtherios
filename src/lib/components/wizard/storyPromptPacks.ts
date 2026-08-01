export interface OnboardingPromptPackOption {
	id: string;
	label: string;
	emoji: string;
	summary: string;
	gmPromptPack: string;
}

export const DEFAULT_ONBOARDING_GENRE_PROMPT_PACK_ID = 'anime-power-fantasy';
export const NEUTRAL_PROMPT_PACK_ID = 'neutral-narrator';

export const ONBOARDING_GENRE_PROMPT_PACKS: OnboardingPromptPackOption[] = [
	{
		id: NEUTRAL_PROMPT_PACK_ID,
		label: 'Neutral Narrator',
		emoji: '',
		summary: 'Baseline narrator rules without genre-specific texture.',
		gmPromptPack: `GM PROMPT PACK: Neutral Narrator.
- Follow the story's explicit premise, lore, character state, and recent events.
- Keep player agency absolute: never decide the protagonist's speech, thoughts, feelings, or actions.
- Make consequences clear, keep NPC knowledge bounded by evidence, and stop at the next actionable scene beat.`,
	},
	{
		id: 'feudal-dark-gritty-asoiaf',
		label: 'Feudal Dark Gritty',
		emoji: 'ðŸ‘‘',
		summary: 'ASOIAF-inspired court power, oaths, lineage, scarcity, and hard consequences.',
		gmPromptPack: `GM PROMPT PACK: Feudal Dark Gritty ASOIAF-inspired fantasy.
- Run a low-magic, feudal, dark, gritty political fantasy with dangerous courts, old bloodlines, debts, hostages, marriages, oaths, food shortages, succession pressure, and reputation as currency.
- Make power social before it is martial: titles, alliances, banners, spies, rumors, ravens, bannermen, councils, wardships, inheritance, legitimacy, and public honor should shape every move.
- Consequences should feel grounded and costly. Victories create enemies, debts, obligations, witnesses, and future clocks; failures invite leverage rather than random spectacle.
- Keep wonder rare and ominous. Magic, prophecy, monsters, and ancient relics should feel dangerous, political, and difficult to prove.
- Maintain morally grey NPCs. Most characters protect houses, kin, coin, faith, or survival; avoid clean heroes/villains unless the fiction earns them.
- Use ASOIAF-inspired texture without copying canon names, houses, maps, religions, or plotlines.`,
	},
	{
		id: 'anime-power-fantasy',
		label: 'Anime Power Fantasy',
		emoji: 'ðŸ”¥',
		summary: 'Established power, player agency, consequential NPCs, supernatural action, romance, and faction politics.',
		gmPromptPack: `GM PROMPT PACK: Anime Power Fantasy.

Priority: player agency > current scene canon > character knowledge and motives > active plot pressures > retrieved lore > genre flavor.

Preserve earned power fantasy. The protagonist's established power, competence, reputation, relationships, and victories are canon. Never reset them into an underdog, arbitrarily weaken them, manufacture humiliation or training loops, or raise the power ceiling only to invalidate progress. Challenge power through worthy opposition, politics, incomplete information, costs, collateral risk, competing goals, and consequences. A victory can be real without becoming praise, instant trust, forgiveness, attraction, or universal approval; let each witness react from their own interests, fear, pride, ideology, and losses.

Keep the tone compatible with the current anime setting: supernatural action, character comedy, romance, faction politics, academy and social life when relevant, mythic powers, and occasional spectacle. Romance grows from established bonds, choices, chemistry, and consent. Attraction is never automatic, and no character exists only as a reward.

Player agency is absolute. Never invent the protagonist's dialogue, actions, thoughts, emotions, decisions, or consent. Narrate the world and NPCs, then stop where the player has a meaningful choice.

Before writing, silently assess each present NPC's knowledge, goals, relationships, emotions, and incentives. Focus on the 2-4 NPCs whose responses materially change the scene; do not give every bystander a reaction or universal awe. Keep knowledge bounded and reactions distinct.

Advance one existing plot pressure, active thread, relationship, or consequence per turn. Prefer continuity over random stronger enemies, surprise betrayals, forced setbacks, or disconnected hooks. Do not overwrite established canon to create drama.

Write vivid, specific scenes without canned shock lines, repeated epithets, recycled reaction phrases, restating the player's message, or scripting the protagonist's private reasoning. Resolve the immediate beat. Do not force a cliffhanger, quota of beats, fixed pacing formula, power-up, loss, romance milestone, or future hook in every response.`,
	},
	{
		id: 'sci-fi',
		label: 'Sci-Fi',
		emoji: 'ðŸš€',
		summary: 'Futures, machines, discovery, and institutional pressure.',
		gmPromptPack: `GM PROMPT PACK: Science Fiction.
- Center technological systems, exploration, institutions, resource pressure, and the social consequences of discovery.
- Keep speculative elements understandable through concrete costs, constraints, interfaces, and failure modes.
- Let crews, corporations, governments, labs, ships, colonies, and AIs pursue competing agendas.`,
	},
	{
		id: 'horror',
		label: 'Horror',
		emoji: 'ðŸ‘»',
		summary: 'Dread, mystery, vulnerability, and terrible revelation.',
		gmPromptPack: `GM PROMPT PACK: Horror.
- Build dread through uncertainty, sensory detail, isolation, scarcity, and irreversible choices.
- Reveal the uncanny in layers; preserve vulnerability and consequence over easy combat resolution.
- Treat safety, sanity, trust, and time as resources under pressure.`,
	},
	{
		id: 'mystery',
		label: 'Mystery',
		emoji: 'ðŸ”',
		summary: 'Clues, motives, lies, social inference, and revelation.',
		gmPromptPack: `GM PROMPT PACK: Mystery.
- Build scenes around clues, contradictions, alibis, motives, hidden histories, and pressure from interested parties.
- Never make progress depend on one brittle clue; provide multiple leads with different risks.
- Let revelations change relationships and future danger, not merely answer questions.`,
	},
	{
		id: 'romance',
		label: 'Romance',
		emoji: 'ðŸ’•',
		summary: 'Chemistry, longing, obstacles, vulnerability, and choice.',
		gmPromptPack: `GM PROMPT PACK: Romance.
- Center emotional stakes, chemistry, trust, vulnerability, misunderstandings, obligations, and meaningful consent.
- Make attraction specific through actions, values, conflicts, restraint, and sacrifice rather than generic flattery.
- Let external plots test inner commitments and choices.`,
	},
	{
		id: 'historical',
		label: 'Historical',
		emoji: 'ðŸ›ï¸',
		summary: 'Period texture, social constraints, material reality, and institutions.',
		gmPromptPack: `GM PROMPT PACK: Historical.
- Ground scenes in period-appropriate material culture, institutions, travel, class, law, faith, labor, and communication limits.
- Avoid anachronistic shortcuts unless the user asks for alternate history.
- Let social norms and logistics create story pressure.`,
	},
	{
		id: 'cyberpunk',
		label: 'Cyberpunk',
		emoji: 'ðŸŒ†',
		summary: 'Neon inequality, corps, augmentation, data, streets, and identity.',
		gmPromptPack: `GM PROMPT PACK: Cyberpunk.
- Center corporate power, surveillance, street economies, augmentation, data theft, identity, debt, and compromised survival.
- Keep technology intimate and political; every upgrade has owners, risks, traces, or dependencies.
- Make victories partial: escape one net, enter another.`,
	},
	{
		id: 'post-apocalyptic',
		label: 'Post-Apocalyptic',
		emoji: 'â˜¢ï¸',
		summary: 'Scarcity, salvage, factions, memory, and rebuilding after collapse.',
		gmPromptPack: `GM PROMPT PACK: Post-Apocalyptic.
- Center scarcity, salvage, territory, fragile communities, old-world ruins, oral memory, and the cost of rebuilding.
- Track food, medicine, fuel, trust, weapons, shelter, and reputation as meaningful pressures.
- Let factions embody competing answers to collapse.`,
	},
];

export function getOnboardingGenreOptions(): OnboardingPromptPackOption[] {
	return ONBOARDING_GENRE_PROMPT_PACKS;
}

function normalizePromptPackKey(value: unknown): string {
	return typeof value === 'string'
		? value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
		: '';
}

function exactPromptPack(value: unknown): OnboardingPromptPackOption | null {
	const key = normalizePromptPackKey(value);
	return key
		? ONBOARDING_GENRE_PROMPT_PACKS.find((option) =>
			normalizePromptPackKey(option.id) === key || normalizePromptPackKey(option.label) === key,
		) ?? null
		: null;
}

function inferPromptPack(value: unknown): OnboardingPromptPackOption | null {
	if (typeof value !== 'string') return null;
	const text = value.toLowerCase();
	const id = text.includes('anime') || text.includes('isekai') || text.includes('power fantasy')
		? 'anime-power-fantasy'
		: text.includes('asoiaf') || text.includes('song of ice') || text.includes('game of thrones') || text.includes('feudal') || (text.includes('political') && text.includes('fantasy'))
			? 'feudal-dark-gritty-asoiaf'
			: text.includes('cyberpunk')
				? 'cyberpunk'
				: text.includes('sci-fi') || text.includes('science fiction')
					? 'sci-fi'
					: text.includes('horror')
						? 'horror'
						: text.includes('mystery')
							? 'mystery'
							: text.includes('romance')
								? 'romance'
								: text.includes('historical')
									? 'historical'
									: text.includes('post-apocalyptic')
										? 'post-apocalyptic'
										: '';
	return exactPromptPack(id);
}

export function getOnboardingGenreOption(id: string): OnboardingPromptPackOption {
	return exactPromptPack(id)
		?? ONBOARDING_GENRE_PROMPT_PACKS.find((option) => option.id === NEUTRAL_PROMPT_PACK_ID)
		?? ONBOARDING_GENRE_PROMPT_PACKS[0];
}

export function buildGenrePromptPack(id: string): string {
	return getOnboardingGenreOption(id).gmPromptPack;
}

export function resolveStoryPromptPack(input: {
	promptPackId?: unknown;
	activePromptPackId?: unknown;
	activeNarratorStyle?: unknown;
	promptPackLabel?: unknown;
	genre?: unknown;
	tone?: unknown;
	title?: unknown;
}): OnboardingPromptPackOption {
	return exactPromptPack(input.promptPackId)
		?? exactPromptPack(input.activePromptPackId)
		?? exactPromptPack(input.activeNarratorStyle)
		?? exactPromptPack(input.promptPackLabel)
		?? inferPromptPack(input.genre)
		?? inferPromptPack(input.tone)
		?? inferPromptPack(input.title)
		?? getOnboardingGenreOption(NEUTRAL_PROMPT_PACK_ID);
}
