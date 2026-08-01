import { z } from 'zod';
import { BaseAIService } from '../BaseAIService';
import type { StoryMode } from '$lib/types';

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textValue(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
	return '';
}

function firstText(record: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = textValue(record[key]);
		if (value) return value;
	}
	return '';
}

function keywordsValue(value: unknown): string {
	if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(', ');
	return textValue(value);
}

function normalizeLorebookEntry(value: unknown): unknown | null {
	if (typeof value === 'string') {
		const content = value.trim();
		return content ? { name: content.slice(0, 64), content, keywords: '' } : null;
	}

	const record = asRecord(value);
	if (!record) return null;

	const name = firstText(record, ['name', 'title', 'entryName', 'label', 'concept', 'term']);
	const content = firstText(record, ['content', 'description', 'summary', 'details', 'text', 'lore', 'premise']);
	if (!name || !content) return null;

	return {
		name,
		content,
		keywords: keywordsValue(record.keywords ?? record.keyTerms ?? record.triggers ?? record.aliases),
	};
}

export const storySetupLoreEntrySchema = z.object({
	name: z.string().trim().min(1),
	content: z.string().trim().min(1),
	keywords: z.string().trim().default(''),
});

export const storySetupAssistResultSchema = z.object({
	title: z.string().trim().min(1),
	worldDescription: z.string().trim().min(1),
	protagonistName: z.string().trim().optional().default(''),
	protagonistDescription: z.string().trim().optional().default(''),
	lorebookEntries: z.preprocess((value) => {
		if (!Array.isArray(value)) return value;
		return value.map(normalizeLorebookEntry).filter((entry) => entry !== null);
	}, z.array(storySetupLoreEntrySchema).max(5).default([])),
	rationale: z.string().trim().optional().default(''),
});

export type StorySetupAssistResult = z.infer<typeof storySetupAssistResultSchema>;

export interface StorySetupAssistInput {
	mode: StoryMode;
	genre: string;
	title: string;
	worldDescription: string;
	protagonistName: string;
	protagonistDescription: string;
	notes: string;
	promptPack?: string;
}

function filled(value: string): string {
	return value.trim() || '(blank)';
}

export function buildStorySetupAssistPrompt(input: StorySetupAssistInput): { system: string; user: string } {
	const system = `You are a story setup writing assistant for Mtherios. Help the user turn a rough new-story seed into a concise, playable foundation.

Rules:
- Focus only on writing support for the new story: title, world premise, protagonist, and a few useful lorebook seeds.
- Do not discuss provider selection, API keys, models, onboarding, settings, or configuration.
- Preserve explicit user ideas. Expand blank or thin fields instead of replacing strong existing choices.
- Keep the result immediately usable in an interactive fiction/RPG engine.
- For lorebook entries, return 2-4 compact objects using exactly: name, content, keywords. Keywords must be a comma-separated string.

Return JSON with: title, worldDescription, protagonistName, protagonistDescription, lorebookEntries, rationale.`;

	const user = `New story setup:
Mode: ${input.mode}
Genre: ${filled(input.genre)}
Current title: ${filled(input.title)}
World description: ${filled(input.worldDescription)}
Protagonist name: ${filled(input.protagonistName)}
Protagonist description: ${filled(input.protagonistDescription)}
User writing notes: ${filled(input.notes)}
GM prompt pack selected in onboarding:
${input.promptPack?.trim() || '(none)'}

Draft or refine these fields into a strong starting point. Do not mention configuration.`;

	return { system, user };
}

export class StorySetupAssistService extends BaseAIService {
	constructor() {
		super('storySetupAssist');
	}

	async assist(input: StorySetupAssistInput): Promise<StorySetupAssistResult> {
		const prompt = buildStorySetupAssistPrompt(input);
		return this.generateStructured(storySetupAssistResultSchema, prompt.system, prompt.user);
	}
}
