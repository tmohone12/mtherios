import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { loadTurnContext } from '$lib/server/turn/context';
import { buildServerTurnPrompt } from '$lib/server/turn/promptPacket';

export interface PromptPacketDebugInput {
	storyId: string;
	query: string;
	tokenBudget: number;
}

export async function buildPromptPacketDebug(input: PromptPacketDebugInput): Promise<Record<string, unknown>> {
	const retrieved = await retrieveMemoryPacket({
		storyId: input.storyId,
		query: input.query,
		tokenBudget: input.tokenBudget,
	});
	const ctx = await loadTurnContext(input.storyId);
	const prompt = buildServerTurnPrompt(ctx, retrieved, 'debug_prompt', {});
	return {
		storyId: input.storyId,
		query: input.query,
		retrieved,
		prompt,
		tokenEstimate: retrieved.tokenEstimate,
	};
}
