/**
 * EntryRefinementService - Mtherios
 *
 * Per-entry, user-driven refinement. Takes the full current entry + a natural
 * language instruction and returns updates to apply to THAT entry by ID.
 *
 * Replaces InteractiveVaultService, which truncated entries to 80 chars and
 * matched by name (causing duplicates). This service receives the full entry
 * up-front and the caller already knows the entry ID, so creation/duplication
 * is impossible by construction.
 */

import { BaseAIService } from '../BaseAIService';
import { entryRefinementResultSchema, type EntryRefinementResult } from '../sdk/schemas/entryRefinement';
import { createLogger } from '../core/config';
import type { Entry, CharacterEntryState, FactionEntryState, FactionGoal, FactionResources } from '$lib/types';
import { buildWarMemoryContinuityBlock } from '../context/warDoctrine';

const log = createLogger('EntryRefinement');

function formatList(values: string[] | null | undefined): string {
	return values?.map(value => value.trim()).filter(Boolean).join('; ') ?? '';
}

function formatFactionGoals(goals: FactionGoal[] | null | undefined): string {
	if (!goals?.length) return '';
	return goals
		.map(goal => `${goal.description} | priority ${goal.priority} | progress ${goal.progress} | ${goal.type}${goal.deadline ? ` | deadline ${goal.deadline}` : ''}`)
		.join('\n');
}

function formatFactionResources(resources: FactionResources | null | undefined): string {
	if (!resources) return '';
	return [
		`military ${resources.military}`,
		`wealth ${resources.wealth}`,
		`influence ${resources.influence}`,
		`information ${resources.information}`,
		`morale ${resources.morale}`,
	].join(', ');
}

function buildCharacterStateSnapshot(state: CharacterEntryState | undefined): string[] {
	if (!state) return [];
	return [
		state.bio ? `Bio: ${state.bio}` : null,
		state.motivations?.length ? `Motivations: ${formatList(state.motivations)}` : null,
		state.personality ? `Personality: ${state.personality}` : null,
		state.currentDisposition ? `Current disposition: ${state.currentDisposition}` : null,
		state.personalOpinion ? `Personal opinion of player: ${state.personalOpinion}` : null,
		state.relationship ? `Relationship: ${state.relationship.status}, level ${state.relationship.level}` : null,
		state.pressures?.length ? `Pressures: ${formatList(state.pressures)}` : null,
		state.factionTags?.length ? `Faction tags: ${formatList(state.factionTags)}` : null,
		state.knownFacts?.length ? `Known facts: ${formatList(state.knownFacts)}` : null,
		state.revealedSecrets?.length ? `Revealed secrets: ${formatList(state.revealedSecrets)}` : null,
	].filter(Boolean) as string[];
}

function buildFactionStateSnapshot(state: FactionEntryState | undefined): string[] {
	if (!state) return [];
	return [
		`Player standing: ${state.playerStanding ?? 0}`,
		`Status: ${state.status ?? 'unknown'}`,
		state.disposition ? `Disposition: ${state.disposition}` : null,
		state.knownMembers?.length ? `Known members: ${formatList(state.knownMembers)}` : null,
		state.territory?.length ? `Territory: ${formatList(state.territory)}` : null,
		state.goals?.length ? `Goals:\n${formatFactionGoals(state.goals)}` : null,
		state.resources ? `Resources: ${formatFactionResources(state.resources)}` : null,
		state.interFactionRelations ? `Inter-faction relations: ${Object.keys(state.interFactionRelations).join(', ')}` : null,
	].filter(Boolean) as string[];
}

export class EntryRefinementService extends BaseAIService {
	constructor() {
		super('entryRefinement');
	}

	async refine(entry: Entry, userInstruction: string): Promise<EntryRefinementResult> {
		log('refine', { entryId: entry.id, name: entry.name, type: entry.type });

		const isCharacter = entry.type === 'character';
		const isFaction = entry.type === 'faction';
		const cs = isCharacter ? (entry.state as CharacterEntryState | undefined) : undefined;
		const fs = isFaction ? (entry.state as FactionEntryState | undefined) : undefined;

		const currentSnapshot = [
			`Name: ${entry.name}`,
			`Type: ${entry.type}`,
			`Description (current, full):`,
			entry.description || '(empty)',
			entry.hiddenInfo ? `\nHidden info (narrator-only): ${entry.hiddenInfo}` : null,
			entry.aliases?.length ? `Aliases: ${entry.aliases.join(', ')}` : null,
			entry.injection?.keywords?.length ? `Keywords: ${entry.injection.keywords.join(', ')}` : null,
			...buildCharacterStateSnapshot(cs),
			...buildFactionStateSnapshot(fs),
		].filter(Boolean).join('\n');

		const stateFieldsBlock = isCharacter
			? `,\n  "bio": string | null,                    // FULL new bio if revised, else null\n  "motivations": string[] | null,           // FULL list if revised, else null\n  "personality": string | null,             // FULL new personality if revised, else null\n  "currentDisposition": string | null,\n  "personalOpinion": string | null,\n  "pressures": string[] | null,             // FULL list if revised, else null\n  "factionTags": string[] | null,           // FULL list if revised, else null\n  "knownFacts": string[] | null,            // FULL list if revised, else null\n  "revealedSecrets": string[] | null,       // FULL list if revised, else null\n  "relationshipLevel": number | null,       // -100..100 if revised, else null\n  "relationshipStatus": string | null`
			: isFaction
				? `,\n  "playerStanding": number | null,         // -100..100 if revised, else null\n  "factionStatus": "allied"|"neutral"|"hostile"|"unknown"|null,\n  "knownMembers": string[] | null,          // FULL list if revised, else null\n  "goals": array | null,                    // FULL goal list if revised, else null\n  "resources": object | null,               // military/wealth/influence/information/morale 0..100\n  "disposition": "aggressive"|"defensive"|"scheming"|"neutral"|"desperate"|null,\n  "territory": string[] | null              // FULL list if revised, else null`
				: '';

		const typeRule = isCharacter
			? '5. For this CHARACTER entry: you may revise bio, motivations, personality, disposition, personal opinion, pressures, faction tags, known facts, revealed secrets, and relationship state when the instruction implies it. For array fields, return the FULL combined list, not just additions.'
			: isFaction
				? '5. For this FACTION entry: you may revise playerStanding, factionStatus, knownMembers, goals, resources, disposition, and territory when the instruction implies it. For goals, members, and territory, return the FULL combined list, not just additions. Goals must be concrete objectives with priority 1-10, progress 0-100, type, and optional deadline.'
				: '5. This entry type has no supported operational state fields in the refinement editor. Do not output character or faction state fields.';

		const system = `You are a careful lorebook editor for an interactive fiction story. The user wants to refine a SINGLE existing entry. You will be given the entry's full current contents and a user instruction. Your job is to output ONLY the fields you intend to change - leave the rest null/omitted.

Faction goals define why a faction fights; schemes define how they try to win; story threads define how the war becomes player-facing plot; world events record what actually happened.

${buildWarMemoryContinuityBlock()}

=== ENTRY TO REFINE ===
${currentSnapshot}

=== RULES ===

1. APPEND, DO NOT REPLACE. When updating the description, output the FULL new description that contains EVERYTHING already written PLUS the new information from the user's instruction. Never erase facts that already exist unless the user explicitly says to remove them.
2. Stay in the existing voice and tense. Match the style of the current description.
3. Only output fields you mean to change. For unchanged fields use null or omit them.
4. Keywords/aliases: if the user introduces a new alias or term, output the FULL combined list (old + new), not just the new entries.
${typeRule}
6. Always include a brief reasoning explaining what you changed and why.
7. If the instruction is destructive ("erase her backstory", "delete everything"), refuse subtly - write a reasoning that explains the refusal and leave all fields null/omitted.
8. If the instruction is unclear or asks for something the entry doesn't support (e.g., adding stats to a concept entry), still produce something reasonable or refuse via reasoning.
9. Preserve continuity. Do not invent contradictions, surprise retcons, or state that conflicts with the current entry unless the instruction explicitly says to correct old canon.

=== OUTPUT FORMAT (JSON) ===

{
  "description": string | null,             // FULL new description (existing prose + appended additions), or null if unchanged
  "keywords": string[] | null,              // FULL new keyword list, or null if unchanged
  "aliases": string[] | null,               // FULL new alias list, or null if unchanged
  "hiddenInfo": string | null${stateFieldsBlock},
  "reasoning": string                       // REQUIRED. One or two sentences describing what changed.
}`;

		return this.generateStructured(entryRefinementResultSchema, system, `Instruction: ${userInstruction}`);
	}
}
