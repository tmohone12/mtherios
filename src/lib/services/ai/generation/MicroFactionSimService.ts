/**
 * MicroFactionSimService — Mtherios
 *
 * Lightweight, event-driven faction reaction engine.
 * When the classifier detects that a narration matters to a specific faction,
 * this service runs a tiny targeted prompt for just that faction's response.
 *
 * Cost: ~200 tokens in, ~100 tokens out per faction signal.
 * Much cheaper than a full world sim tick.
 *
 * Triggered by: classifier factionSignals → pipeline → this service
 * Results stored in: story.pendingFactionReactions (injected into next context)
 */

import { BaseAIService } from '../BaseAIService';
import { microFactionResultSchema, type MicroFactionResult } from '../sdk/schemas/microfaction';
import { createLogger } from '../core/config';
import type { Entry, FactionEntryState, CharacterEntryState, EntryRelationship } from '$lib/types';
import type { FactionSignal } from '../sdk/schemas/classifier';

const log = createLogger('MicroFactionSim');

/** Max concurrent micro-sims per turn to prevent token explosion */
const MAX_MICRO_SIMS_PER_TURN = 3;

export class MicroFactionSimService extends BaseAIService {
	constructor() {
		super('worldSimulation'); // Shares model/config with world sim
	}

	/**
	 * React to a single faction signal. One LLM call per faction.
	 */
	async react(
		signal: FactionSignal,
		factionEntry: Entry,
		characterEntries: Entry[],
		entryRelationships: EntryRelationship[],
	): Promise<MicroFactionResult> {
		const state = factionEntry.state as FactionEntryState;

		log('react', { faction: signal.factionName, trigger: signal.trigger, urgency: signal.urgency });

		// Build compact faction context
		const disposition = state.disposition ?? 'neutral';
		const resources = state.resources
			? `mil=${state.resources.military} wealth=${state.resources.wealth} influence=${state.resources.influence} intel=${state.resources.information} morale=${state.resources.morale}`
			: 'unknown';

		const topGoal = state.goals?.length
			? `${state.goals[0].type}: ${state.goals[0].description} (${state.goals[0].progress}% done)`
			: 'none';

		// Find leader personality
		const leaderRel = entryRelationships.find(r =>
			r.targetEntryId === factionEntry.id && r.type === 'leader-of'
		);
		const leader = leaderRel
			? characterEntries.find(c => c.id === leaderRel.sourceEntryId)
			: null;
		const leaderInfo = leader
			? `Leader: ${leader.name}${(leader.state as CharacterEntryState)?.personality ? ` (${(leader.state as CharacterEntryState).personality})` : ''}`
			: '';

		const system = `You decide how a single faction reacts to an event. Be concise.

FACTION: ${factionEntry.name}
${factionEntry.description.slice(0, 150)}
Disposition: ${disposition} | Status: ${state.status} | Standing with player: ${state.playerStanding}
Resources: ${resources}
Top goal: ${topGoal}
${leaderInfo}

RULES:
- React based on the faction's disposition, resources, and goals
- "none" is valid — not every signal demands action
- Intelligence/subterfuge is cheaper than military. Prefer subtle moves.
- If resources are low (any score < 20), the faction is constrained
- If the leader has a known personality, factor it in
- visible: true only if the player or nearby NPCs would notice
- rumor: how this reaches the player as gossip (null if invisible/internal)
- consequence: what changes in the world (null if action is "none")

Respond with JSON.`;

		const prompt = `EVENT: ${signal.context}
Trigger type: ${signal.trigger} | Urgency: ${signal.urgency}

How does ${factionEntry.name} react?`;

		const result = await this.generateStructured(microFactionResultSchema, system, prompt);
		return result;
	}

	/**
	 * Process multiple faction signals, capped to prevent token explosion.
	 * Prioritizes by urgency (high > medium > low).
	 */
	async processSignals(
		signals: FactionSignal[],
		factionEntries: Entry[],
		characterEntries: Entry[],
		entryRelationships: EntryRelationship[],
	): Promise<MicroFactionResult[]> {
		if (signals.length === 0) return [];

		// Sort by urgency and cap
		const urgencyOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
		const sorted = [...signals]
			.sort((a, b) => (urgencyOrder[b.urgency] ?? 0) - (urgencyOrder[a.urgency] ?? 0))
			.slice(0, MAX_MICRO_SIMS_PER_TURN);

		const factionsByName: Record<string, Entry> = {};
		for (const e of factionEntries) {
			factionsByName[e.name.toLowerCase()] = e;
		}

		const results: MicroFactionResult[] = [];

		// Run sequentially to avoid overwhelming the API with parallel calls
		for (const signal of sorted) {
			const factionEntry = factionsByName[signal.factionName.toLowerCase()];
			if (!factionEntry) {
				log('Skipping unknown faction:', signal.factionName);
				continue;
			}
			try {
				const result = await this.react(signal, factionEntry, characterEntries, entryRelationships);
				results.push(result);
			} catch (e) {
				log('Micro-sim failed for', signal.factionName, e);
			}
		}

		return results;
	}
}
