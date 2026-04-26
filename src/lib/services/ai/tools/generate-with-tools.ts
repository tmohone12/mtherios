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

LOCATION (paramount — the system loses track if you skip this):
- If the player moved this turn, you MUST emit a location entry with \`current: true\` for wherever they are now. The previous current location will be unset automatically.
- If the player did NOT move, you may omit \`locations\` entirely OR re-emit the current location with \`current: true\` (either is fine).
- Only ONE location may have \`current: true\`. New side-locations being discovered should be emitted with \`current: false\`.

TIME (paramount — the world sim runs on in-world days):
- You MUST emit a \`time_delta\` whenever any time passed in the scene, even a brief moment. Use natural prose ("a few minutes", "30 minutes", "3 hours", "2 days", "an hour and 15 minutes"). Numbers + units are most reliable.
- If the scene is instantaneous (a single look, a single line of dialogue, an interrupted action) you may emit "moment" or omit the field.

CHARACTERS:
- Status: 'active' for present and engaged; 'inactive' for alive but off-screen; 'departed' for "left the scene this turn" (system will mark inactive); 'deceased' for died this turn.
- \`present: true\` for characters in the immediate scene; \`present: false\` for characters who left this turn or aren't visible. The system uses this to track who's actually around.
- Include descriptions/traits/relationships only when they changed or were newly revealed.

OTHER STATE:
- Item changes (picked up, used, dropped, equipped)
- Conversations that occurred (what NPCs revealed/learned, emotional shifts)
- Relationship changes between entities
- Significant story beats or plot events
- Meter changes (sanity, morality, reputation, hunger, suspicion, etc.) — invent meters as the fiction calls for them, adjust existing ones with signed deltas. Current values are listed under "Meters:" in the snapshot.
- Agreement changes — treaties, oaths, debts, promises, marriages, bonds, contracts, vassalage, and bargains with supernatural entities. Use action=create when a new commitment is sworn; action=break when someone violates it (auto-emits a timeline event); action=fulfill when it's paid; action=update to revise terms. Active agreements are listed under "Active agreements:" in the snapshot with their ids.

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
