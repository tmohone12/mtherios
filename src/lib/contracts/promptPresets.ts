import { z } from 'zod';

/**
 * Narrative prompt presets: named, versioned compositions of editable style sections and
 * locked engine blocks. Templates are data. A text section may reference only the variable
 * vocabulary below with {{name}}; nothing is evaluated. Engine blocks carry the authority,
 * workflow and output contracts and cannot be edited or removed by a preset.
 */
export const PROMPT_ENGINE_BLOCK_IDS = [
	'roleplayAuthority',
	'contextPriority',
	'outcomeAuthority',
	'npcAgency',
	'turnWorkflow',
	'turnBoundary',
	'npcKnowledge',
	'npcSourceRule',
	'turnHeader',
	'economyScale',
	'worldScale',
	'diceRolls',
	'immutableCoreHeader',
] as const;
export type PromptEngineBlockId = typeof PROMPT_ENGINE_BLOCK_IDS[number];

/** Every preset must keep these engine contracts enabled. */
export const REQUIRED_PROMPT_ENGINE_BLOCKS: readonly PromptEngineBlockId[] = ['npcAgency', 'turnWorkflow', 'turnBoundary'];
/** At least one of these carries player/GM authority. */
export const PROMPT_AUTHORITY_BLOCKS: readonly PromptEngineBlockId[] = ['roleplayAuthority', 'outcomeAuthority'];

export const PROMPT_VARIABLES = {
	'story.title': 'Story title',
	'story.genre': 'Story genre',
	'story.tone': 'Story tone setting',
	'story.preamble': 'Story-specific preamble (the story header prompt)',
	'story.genrePackLabel': 'Selected genre pack name (empty when the preamble already includes it)',
	'story.genrePack': 'Selected genre pack instructions (empty when the preamble already includes them)',
} as const;
export type PromptVariable = keyof typeof PROMPT_VARIABLES;

const VARIABLE_PATTERN = /{{\s*([A-Za-z][\w.]*)\s*}}/g;

export function promptTemplateVariables(template: string): string[] {
	return [...new Set([...template.matchAll(VARIABLE_PATTERN)].map(match => match[1]))];
}

const sectionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Section IDs use lowercase letters, digits and dashes.');

export const promptPresetSectionSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('engine'),
		id: sectionId,
		label: z.string().trim().min(1).max(120),
		engineBlock: z.enum(PROMPT_ENGINE_BLOCK_IDS),
		enabled: z.boolean().default(true),
	}).strict(),
	z.object({
		kind: z.literal('text'),
		id: sectionId,
		label: z.string().trim().min(1).max(120),
		template: z.string().max(40_000),
		/** Literal text is never substituted (used for migrated free-form instructions). */
		literal: z.boolean().default(false),
		enabled: z.boolean().default(true),
	}).strict(),
]);
export type PromptPresetSection = z.infer<typeof promptPresetSectionSchema>;

export const promptPresetDocumentSchema = z.object({
	schemaVersion: z.literal(1),
	sections: z.array(promptPresetSectionSchema).min(1).max(64),
}).strict().superRefine((document, context) => {
	const ids = new Set<string>();
	for (const [index, section] of document.sections.entries()) {
		if (ids.has(section.id)) context.addIssue({ code: 'custom', path: ['sections', index, 'id'], message: `Duplicate section ID "${section.id}".` });
		ids.add(section.id);
		if (section.kind === 'text' && !section.literal) {
			for (const variable of promptTemplateVariables(section.template)) {
				if (!Object.hasOwn(PROMPT_VARIABLES, variable)) context.addIssue({ code: 'custom', path: ['sections', index, 'template'], message: `Unknown variable {{${variable}}}. Use one of: ${Object.keys(PROMPT_VARIABLES).join(', ')}.` });
			}
		}
	}
	const enabledEngine = new Set(document.sections.filter(section => section.kind === 'engine' && section.enabled).map(section => section.kind === 'engine' ? section.engineBlock : ''));
	for (const block of REQUIRED_PROMPT_ENGINE_BLOCKS) {
		if (!enabledEngine.has(block)) context.addIssue({ code: 'custom', path: ['sections'], message: `The engine block "${block}" is required and must stay enabled.` });
	}
	if (!PROMPT_AUTHORITY_BLOCKS.some(block => enabledEngine.has(block))) {
		context.addIssue({ code: 'custom', path: ['sections'], message: 'Keep an enabled authority block (roleplayAuthority or outcomeAuthority).' });
	}
});
export type PromptPresetDocument = z.infer<typeof promptPresetDocumentSchema>;

export const promptPresetSummarySchema = z.object({
	id: z.string(),
	kind: z.literal('narrative'),
	name: z.string(),
	description: z.string(),
	currentRevision: z.number().int().positive(),
	/** Revision used by stories without an explicit selection, when this is the default preset. */
	defaultRevision: z.number().int().positive().nullable(),
	isDefault: z.boolean(),
	archived: z.boolean(),
	updatedAt: z.string(),
});
export type PromptPresetSummary = z.infer<typeof promptPresetSummarySchema>;

/** What a turn used: recorded in receipts so later revisions never rewrite history. */
export const promptPresetUseSchema = z.object({
	presetId: z.string(),
	revision: z.number().int().positive(),
	contentHash: z.string(),
	source: z.enum(['story', 'default']),
});
export type PromptPresetUse = z.infer<typeof promptPresetUseSchema>;

export const promptPresetExportSchema = z.object({
	format: z.literal('mythengine.prompt-preset'),
	version: z.literal(1),
	name: z.string().trim().min(1).max(120),
	description: z.string().max(2000).default(''),
	document: promptPresetDocumentSchema,
}).strict();
export type PromptPresetExport = z.infer<typeof promptPresetExportSchema>;
