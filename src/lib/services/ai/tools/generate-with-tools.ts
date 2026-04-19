/**
 * Orchestrator Generation Flow — Mtherios
 *
 * Option A (Sequential): After narrative streaming completes, makes one
 * structured call to extract world-state changes from the narrative.
 * Replaces the 15-call GenerationPipeline with a single tool call.
 */

import { generateStructuredWithTools } from '$lib/services/ai/sdk/generate';
import { GM_TOOLS } from './schemas';
import { executeToolCall } from './executor';
import { runBackgroundJobs } from '$lib/services/ai/background/runner';
import { settings } from '$lib/stores/settings.svelte';

/**
 * Execute the world-state update after narrative generation.
 * This is the core of the orchestrator pattern — one structured call
 * replaces ClassifierService + all Pipeline Phase 1 work.
 */
export async function executeWorldUpdate(
	narrative: string,
	stateSnapshot: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const errors: string[] = [];

	if (!narrative.trim()) return errors;

	// ── Phase 1: World state extraction via tool call ──
	try {
		const classifierConfig = settings.getServiceConfig('classifier');

		const systemPrompt = `You are a world state tracker for an interactive fiction game. Your job is to analyze a narrative passage and extract ALL state changes that occurred. Be thorough — anything not recorded here is forgotten.`;

		const userPrompt = `You just narrated the following scene:

---
${narrative}
---

Current world state:
${stateSnapshot}

Now call update_world_state with ALL changes from this scene. Include:
- Character status changes (who appeared, departed, died, and their descriptions/traits)
- Location changes (where is the player now, new locations discovered)
- Item changes (picked up, used, dropped, equipped)
- Time progression (how much time passed)
- Any conversations that occurred (what NPCs learned, emotional shifts)
- Any relationship changes between entities
- Any significant story beats or plot events
- Meter changes (sanity, morality, reputation, hunger, suspicion, etc.) — invent meters as the fiction calls for them, adjust existing ones with signed deltas. The current values are listed under "Meters:" in the snapshot above.

Be thorough and accurate. Only include entities that actually changed or appeared in the scene.`;

		const result = await generateStructuredWithTools({
			system: systemPrompt,
			prompt: userPrompt,
			model: classifierConfig.model || undefined,
			temperature: 0.2,
			maxTokens: 4096,
			signal,
			tools: GM_TOOLS,
			forceTool: 'update_world_state',
			profileId: classifierConfig.profileId || undefined,
			_service: 'world-update',
		} as any);

		// Execute all tool calls
		for (const toolCall of result.toolCalls) {
			try {
				await executeToolCall(toolCall.name, toolCall.arguments);
			} catch (e) {
				const msg = `Tool ${toolCall.name}: ${e}`;
				errors.push(msg);
				console.error(`[Orchestrator] ${msg}`);
			}
		}

		if (result.toolCalls.length === 0) {
			console.warn('[Orchestrator] No tool calls returned from world update');
		}
	} catch (e) {
		const msg = `World update: ${e instanceof Error ? e.message : e}`;
		errors.push(msg);
		console.error(`[Orchestrator] ${msg}`);
	}

	// ── Phase 2: Background jobs (chapters, arcs, lore) ──
	try {
		const bgErrors = await runBackgroundJobs();
		errors.push(...bgErrors);
	} catch (e) {
		errors.push(`Background: ${e}`);
	}

	return errors;
}
