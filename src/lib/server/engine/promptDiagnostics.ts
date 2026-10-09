import { prepareServerTurnContext } from '$lib/server/turn/orchestrator';

export interface PromptPacketDebugInput {
	storyId: string;
	query: string;
	tokenBudget: number;
	contextBudget?: number;
	recentDialogueTokens?: number;
	recentDialogueTurns?: number;
}

/** Debug the same server-compiled request that preview and generation use. */
export async function buildPromptPacketDebug(input: PromptPacketDebugInput): Promise<Record<string, unknown>> {
	const prepared = await prepareServerTurnContext({
		storyId: input.storyId,
		clientTurnId: 'debug_prompt',
		playerText: input.query,
		clientContext: {
			memoryTokenBudget: Math.max(160, Math.min(2400, input.tokenBudget)),
			...(input.contextBudget !== undefined ? { contextBudget: input.contextBudget } : {}),
			...(input.recentDialogueTokens !== undefined ? { recentDialogueTokens: input.recentDialogueTokens } : {}),
			...(input.recentDialogueTurns !== undefined ? { recentDialogueTurns: input.recentDialogueTurns } : {}),
		},
	}, { inspection: true });
	return {
		storyId: input.storyId,
		query: input.query,
		retrieved: prepared.retrieved,
		prompt: {
			...prepared.prompt,
			system: prepared.narrativeSystem,
			prompt: prepared.narrativeSystemDynamic,
		},
		selection: prepared.contextReceipt.selection,
		resolution: {
			narrativeOverrideApplied: Boolean(prepared.narrativeService.systemPromptOverride?.trim()),
			contextBudget: prepared.contextReceipt.budgets.dynamicContextTokensMax ?? 0,
			contextBudgetSource: input.contextBudget === undefined ? 'narrative_service' : 'request',
			contextTruncated: prepared.contextReceipt.truncated,
		},
		tokenEstimate: prepared.retrieved.tokenEstimate,
	};
}
