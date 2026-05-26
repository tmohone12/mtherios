import { countTokens, truncateToTokenBudget } from '$lib/utils/tokens';

export type PromptSectionKey =
	| 'characters'
	| 'playerReputation'
	| 'playerLedger'
	| 'factions'
	| 'lore'
	| 'episodicMemory'
	| 'proceduralMemory'
	| 'plotLedger'
	| 'conversationMemory'
	| 'backendMemory'
	| 'storyMemory'
	| 'arcs'
	| 'chapters'
	| 'chapterIntro'
	| 'entryHistory'
	| 'livingWorld'
	| 'schemes'
	| 'plotMomentum'
	| 'finalInstructions';

export interface PromptSection {
	key: PromptSectionKey;
	text: string;
	maxTokens?: number;
	minTokens?: number;
	priority?: number;
}

export interface PromptBudgetResult {
	text: string;
	usage: Record<string, number>;
	originalUsage: Record<string, number>;
	truncated: PromptSectionKey[];
	total: number;
	originalTotal: number;
}

interface SectionBudget {
	maxTokens: number;
	minTokens: number;
	priority: number;
}

export const DEFAULT_PROMPT_SECTION_BUDGETS: Record<PromptSectionKey, SectionBudget> = {
	characters: { maxTokens: 1800, minTokens: 500, priority: 5 },
	playerReputation: { maxTokens: 300, minTokens: 80, priority: 5 },
	playerLedger: { maxTokens: 520, minTokens: 120, priority: 5 },
	factions: { maxTokens: 900, minTokens: 180, priority: 2 },
	lore: { maxTokens: 1600, minTokens: 300, priority: 4 },
	episodicMemory: { maxTokens: 1600, minTokens: 260, priority: 5 },
	proceduralMemory: { maxTokens: 420, minTokens: 100, priority: 3 },
	plotLedger: { maxTokens: 720, minTokens: 160, priority: 5 },
	conversationMemory: { maxTokens: 520, minTokens: 120, priority: 4 },
	backendMemory: { maxTokens: 1200, minTokens: 280, priority: 5 },
	storyMemory: { maxTokens: 1800, minTokens: 420, priority: 5 },
	arcs: { maxTokens: 2600, minTokens: 600, priority: 5 },
	chapters: { maxTokens: 2200, minTokens: 600, priority: 5 },
	chapterIntro: { maxTokens: 300, minTokens: 120, priority: 4 },
	entryHistory: { maxTokens: 160, minTokens: 80, priority: 5 },
	livingWorld: { maxTokens: 1200, minTokens: 260, priority: 4 },
	schemes: { maxTokens: 700, minTokens: 160, priority: 3 },
	plotMomentum: { maxTokens: 900, minTokens: 220, priority: 4 },
	finalInstructions: { maxTokens: 420, minTokens: 220, priority: 5 },
};

const DEFAULT_DYNAMIC_HARD_CAP = 12000;
const CREATIVE_DYNAMIC_HARD_CAP = 3600;

export function getDynamicPromptBudget(
	contextWindow: number,
	configuredContextBudget: number,
	mode: string,
	snapshotTokenCap = 0,
): number {
	const hardCap = mode === 'adventure' ? DEFAULT_DYNAMIC_HARD_CAP : CREATIVE_DYNAMIC_HARD_CAP;
	const autoBudget = Math.floor(contextWindow * 0.16);
	const configured = configuredContextBudget > 0 ? Math.floor(configuredContextBudget * 0.35) : autoBudget;
	const modelAwareCap = Math.floor(contextWindow * 0.30);
	const userCap = snapshotTokenCap > 0 ? Math.floor(snapshotTokenCap) : Number.POSITIVE_INFINITY;
	const floor = userCap < 1200 ? Math.max(1, userCap) : 1200;
	return Math.max(floor, Math.min(configured, modelAwareCap, hardCap, userCap));
}

function buildCaps(sections: PromptSection[], totalBudget: number): number[] {
	const resolved = sections.map((section) => {
		const defaults = DEFAULT_PROMPT_SECTION_BUDGETS[section.key];
		const maxTokens = Math.max(1, section.maxTokens ?? defaults.maxTokens);
		const minTokens = Math.min(maxTokens, Math.max(1, section.minTokens ?? defaults.minTokens));
		const priority = Math.max(1, section.priority ?? defaults.priority);
		return { maxTokens, minTokens, priority };
	});

	const maxTotal = resolved.reduce((sum, budget) => sum + budget.maxTokens, 0);
	if (maxTotal <= totalBudget) return resolved.map(budget => budget.maxTokens);

	const minTotal = resolved.reduce((sum, budget) => sum + budget.minTokens, 0);
	if (minTotal >= totalBudget) {
		const scale = totalBudget / minTotal;
		return resolved.map(budget => Math.max(16, Math.floor(budget.minTokens * scale)));
	}

	const flexibleTotal = resolved.reduce(
		(sum, budget) => sum + ((budget.maxTokens - budget.minTokens) * budget.priority),
		0,
	);
	const flexibleAllowance = totalBudget - minTotal;

	return resolved.map((budget) => {
		const flexible = budget.maxTokens - budget.minTokens;
		if (flexible <= 0 || flexibleTotal <= 0) return budget.minTokens;
		const weightedShare = (flexible * budget.priority) / flexibleTotal;
		return budget.minTokens + Math.floor(weightedShare * flexibleAllowance);
	});
}

export function budgetPromptSections(
	sections: PromptSection[],
	options: { totalBudget: number; joiner?: string },
): PromptBudgetResult {
	const joiner = options.joiner ?? '\n\n';
	const active = sections.filter(section => section.text.trim().length > 0);
	const caps = buildCaps(active, Math.max(1, options.totalBudget));
	const usage: Record<string, number> = {};
	const originalUsage: Record<string, number> = {};
	const truncated: PromptSectionKey[] = [];

	const texts = active.map((section, index) => {
		const cap = caps[index];
		const originalTokens = countTokens(section.text);
		originalUsage[section.key] = (originalUsage[section.key] ?? 0) + originalTokens;

		if (originalTokens <= cap) {
			usage[section.key] = (usage[section.key] ?? 0) + originalTokens;
			return section.text;
		}

		const trimmed = truncateToTokenBudget(section.text, Math.max(1, cap - 4));
		const trimmedTokens = countTokens(trimmed);
		usage[section.key] = (usage[section.key] ?? 0) + trimmedTokens;
		truncated.push(section.key);
		return trimmed;
	});

	return {
		text: texts.join(joiner),
		usage,
		originalUsage,
		truncated,
		total: Object.values(usage).reduce((sum, value) => sum + value, 0),
		originalTotal: Object.values(originalUsage).reduce((sum, value) => sum + value, 0),
	};
}
