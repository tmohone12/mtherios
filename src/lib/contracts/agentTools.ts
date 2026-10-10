import { z } from 'zod';

export const agentRoleSchema = z.enum(['gm', 'assistant', 'research', 'batch']);
export type AgentRole = z.infer<typeof agentRoleSchema>;
export const gmContextModeSchema = z.enum(['pinned', 'partial', 'searchable']);
export const agentToolSchema = z.enum(['read', 'search', 'list', 'write', 'update', 'saveType', 'folder', 'bash', 'map', 'askUserQuestion', 'askPlayerToRoll', 'gmRollDice', 'askJev', 'generateNames', 'research', 'recall', 'generateImage', 'generateFileImage', 'revert', 'clearLayout', 'subagent', 'storyContent']);
export type AgentTool = z.infer<typeof agentToolSchema>;

export const agentSettingLabels = {
	// gmPiRuntime is retired (every new GM turn uses Pi); the key stays readable for saved documents.
	gmPiRuntime: 'Pi GM runtime for new turns (retired; always on)', assistantPiRuntime: 'Pi Assistant runtime for new messages',
	gmResearch: 'GM Research', gmAdaptiveResearch: 'Adaptive GM research for direct turns', gmNames: 'GM Names', gmPlayerRolls: 'Player roll requests', gmQuestions: 'GM questions',
	gmImages: 'GM chat images', assistantQuestions: 'Assistant questions', assistantSubagents: 'Assistant batch helpers', assistantImages: 'Assistant chat images', automaticCovers: 'Automatic project covers',
} as const;
export type AgentSettingKey = keyof typeof agentSettingLabels;
export const shippedAgentSettings: Record<AgentSettingKey, boolean> = {
	gmPiRuntime: true, assistantPiRuntime: true,
	gmResearch: true, gmAdaptiveResearch: false, gmNames: true, gmPlayerRolls: true, gmQuestions: false,
	gmImages: false, assistantQuestions: true, assistantSubagents: true, assistantImages: false, automaticCovers: false,
};
export const agentOverridesSchema = z.object({
	gmPiRuntime: z.boolean().optional(), assistantPiRuntime: z.boolean().optional(),
	gmResearch: z.boolean().optional(), gmAdaptiveResearch: z.boolean().optional(), gmNames: z.boolean().optional(), gmPlayerRolls: z.boolean().optional(), gmQuestions: z.boolean().optional(),
	gmImages: z.boolean().optional(), assistantQuestions: z.boolean().optional(), assistantSubagents: z.boolean().optional(), assistantImages: z.boolean().optional(), automaticCovers: z.boolean().optional(),
}).strict();
export const agentSettingsPatchSchema = z.object({
	gmPiRuntime: z.boolean().nullable().optional(), assistantPiRuntime: z.boolean().nullable().optional(),
	gmResearch: z.boolean().nullable().optional(), gmAdaptiveResearch: z.boolean().nullable().optional(), gmNames: z.boolean().nullable().optional(), gmPlayerRolls: z.boolean().nullable().optional(), gmQuestions: z.boolean().nullable().optional(),
	gmImages: z.boolean().nullable().optional(), assistantQuestions: z.boolean().nullable().optional(), assistantSubagents: z.boolean().nullable().optional(), assistantImages: z.boolean().nullable().optional(), automaticCovers: z.boolean().nullable().optional(),
}).strict();
export const agentSettingsDocumentSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), overrides: agentOverridesSchema }).strict();
export const agentSettingsReadSchema = z.object({ projectId: z.string().min(1), gameId: z.string().min(1).optional() }).strict();
export const agentSettingsSaveSchema = agentSettingsReadSchema.extend({ expectedRevision: z.number().int().nonnegative(), changes: agentSettingsPatchSchema }).strict();
export const projectJobActionSchema = z.object({ projectId: z.string().min(1), jobId: z.string().min(1), expectedUpdatedAt: z.string().min(1).optional() }).strict();
export type AgentSettingsDocument = z.infer<typeof agentSettingsDocumentSchema>;

export function resolveAgentSettings(project: AgentSettingsDocument, game?: AgentSettingsDocument, disabled: AgentSettingKey[] = []) {
	const effective = { ...shippedAgentSettings, ...project.overrides, ...game?.overrides };
	// Covers are always a project-wide spending choice, independent of either chat switch.
	effective.automaticCovers = project.overrides.automaticCovers ?? shippedAgentSettings.automaticCovers;
	const sources = {} as Record<AgentSettingKey, 'engine' | 'game' | 'project' | 'default' | 'legacy'>;
	for (const key of Object.keys(shippedAgentSettings) as AgentSettingKey[]) {
		sources[key] = key !== 'automaticCovers' && game?.overrides[key] !== undefined ? 'game' : project.overrides[key] !== undefined ? 'project' : 'default';
		if (disabled.includes(key)) { effective[key] = false; sources[key] = 'engine'; }
	}
	return { effective, sources };
}
