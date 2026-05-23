/**
 * Orchestrator Generation Flow — Mtherios
 *
 * Option A (Sequential): After narrative streaming completes, makes one
 * structured call to extract world-state changes from the narrative.
 * Replaces the 15-call GenerationPipeline with a single tool call.
 */

import { generateStructuredWithTools } from '$lib/services/ai/sdk/generate';
import { GM_TOOLS, worldStateUpdateSchema, type WorldStateUpdate } from './schemas';
import { executeToolCall, runSchemeEvaluation } from './executor';
import { runBackgroundJobs } from '$lib/services/ai/background/runner';
import { settings } from '$lib/stores/settings.svelte';

const WORLD_UPDATE_TOOLS = GM_TOOLS.filter(tool => tool.function.name === 'update_world_state');

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
- NOTE: Characters listed here update RUNTIME tracking only. They do NOT automatically create lorebook entries anymore. If a character is significant enough to track long-term, you must ALSO emit them in \`lorebook_entries\` below.

LOREBOOK ENTRIES (new — explicit creation):
- This is the ONLY way new lorebook entries are created. There is no automatic creation from characters/locations/items.
- Emit an entry for every significant world element introduced or deepened this turn: major NPCs, important locations, key items, factions, concepts (magic systems, customs, laws, religions), and notable events.
- Write rich descriptions: 2–5 sentences based ONLY on what was established in the scene.
- Include \`aliases\` (alternate names, titles, epithets) and \`keywords\` (3–5 terms for context retrieval).
- Use \`hidden_info\` for secrets the protagonist does NOT know yet.
- Set \`injection_mode\` to \`always\` for entries that should be injected every turn (e.g., the protagonist themselves, core factions). Use \`keyword\` for everything else.
- Do not create a new lorebook entry for a known entity under a slightly different title. Use aliases/keywords and relationships instead.
- Skip unnamed, generic elements ("a guard", "the tavern", "some coins").
FACTION GUIDANCE:
- For FACTION entries, include \`known_members\`, \`faction_goals\`, \`faction_resources\`, \`faction_disposition\`, and \`territory\` when the scene or existing state gives enough evidence.
- Also emit relationships such as member-of, leader-of, serves, allied-with, or enemy-of when a character/faction connection is established or changes.
- Faction resources are relative 0-100 scores: military, wealth, influence, information, morale. Unknown scores should be omitted rather than invented.
- Faction goals should be concrete and actionable: what they want, why now, and whether progress changed.
- This preset uses A Song of Ice and Fire-style Known World political rules. Track Westerosi houses, bannermen, wards, hostages, bastardy, marriages, betrothals, oaths, guest right, succession claims, ravens, maesters, septons, religious pressure, debts, and scandal when they matter; also track Essosi free cities, merchant princes, magisters, triarchs, banks, guilds, sellsails, mercenary companies, red priests, slave economies, courtesans, and trade rivalries when the scene points east.
- Sexual scandal is world state when it changes leverage or reputation: affairs, secret lovers, paternity doubts, bastardy, incest rumors, brothel gossip, coerced marriages, fertility pressure, and accusations of sexual deviancy. Record it as hidden_info, relationships, agreements, rumors, or faction goals as appropriate. Keep extracted descriptions non-graphic.

OTHER STATE:
- Item changes (picked up, used, dropped, equipped)
- Conversations that occurred (what NPCs revealed/learned, emotional shifts)
- Relationship changes between entities
- Significant story beats or plot events
- Meter changes (sanity, morality, reputation, hunger, suspicion, etc.) — invent meters as the fiction calls for them, adjust existing ones with signed deltas. Current values are listed under "Meters:" in the snapshot.
- Player reputation — if public standing, titles, scandals, fear, fame, criminal status, or rumor around the protagonist changed, emit \`player_reputation\` as a compact full replacement. Omit it when unchanged.
- Agreement changes — treaties, oaths, debts, promises, marriages, bonds, contracts, vassalage, and bargains with supernatural entities. Use action=create when a new commitment is sworn; action=break when someone violates it (auto-emits a timeline event); action=fulfill when it's paid; action=update to revise terms. Active agreements are listed under "Active agreements:" in the snapshot with their ids.

Be thorough and accurate. Only include entities that actually changed or appeared in the scene.`;

		const result = await generateStructuredWithTools({
			system: systemPrompt,
			prompt: userPrompt,
			model: classifierConfig.model || undefined,
			temperature: classifierConfig.temperature,
			maxTokens: classifierConfig.maxTokens,
			signal,
			tools: WORLD_UPDATE_TOOLS,
			forceTool: 'update_world_state',
			profileId: classifierConfig.profileId || undefined,
			_service: 'world-update',
		} as any);

		// Execute all tool calls
		let worldStateArgs: WorldStateUpdate | null = null;
		for (const toolCall of result.toolCalls) {
			try {
				await executeToolCall(toolCall.name, toolCall.arguments);
				if (toolCall.name === 'update_world_state') {
					const parsed = worldStateUpdateSchema.safeParse(toolCall.arguments);
					if (parsed.success) worldStateArgs = parsed.data;
				}
			} catch (e) {
				const msg = `Tool ${toolCall.name}: ${e}`;
				errors.push(msg);
				console.error(`[Orchestrator] ${msg}`);
			}
		}

		if (result.toolCalls.length === 0) {
			console.warn('[Orchestrator] No tool calls returned from world update');
		}

		// ── Phase 1b: Scheme evaluator — reactive LLM pass gated on story beats ──
		const schemeErrors = await runSchemeEvaluation(narrative, stateSnapshot, worldStateArgs, signal);
		errors.push(...schemeErrors);
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
