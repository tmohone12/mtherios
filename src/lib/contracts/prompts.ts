import { z } from 'zod';
import { ONBOARDING_GENRE_PROMPT_PACKS } from '$lib/components/wizard/storyPromptPacks';

export const narrativePromptQuerySchema = z.object({
	storyId: z.string().trim().min(1).optional(),
	promptPackId: z.string().refine(
		(value) => ONBOARDING_GENRE_PROMPT_PACKS.some((pack) => pack.id === value),
		'Unknown narrative prompt pack.',
	).optional(),
}).strict().refine(
	(query) => !(query.storyId && query.promptPackId),
	'Choose either a story or a prompt pack.',
);

export const narrativePromptPreviewSchema = z.object({
	builtInPrompt: z.string().min(1),
	promptPackId: z.string().min(1),
	promptPackLabel: z.string().min(1),
	storyId: z.string().nullable(),
	storyTitle: z.string().nullable(),
}).strict();

export type NarrativePromptPreview = z.infer<typeof narrativePromptPreviewSchema>;
