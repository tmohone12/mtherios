/**
 * EntryRefinementService — Mtherios
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
import type { Entry, CharacterEntryState } from '$lib/types';

const log = createLogger('EntryRefinement');

export class EntryRefinementService extends BaseAIService {
	constructor() {
		super('entryRefinement');
	}

	async refine(entry: Entry, userInstruction: string): Promise<EntryRefinementResult> {
		log('refine', { entryId: entry.id, name: entry.name, type: entry.type });

		const isCharacter = entry.type === 'character';
		const cs = isCharacter ? (entry.state as CharacterEntryState | undefined) : undefined;

		const currentSnapshot = [
			`Name: ${entry.name}`,
			`Type: ${entry.type}`,
			`Description (current, full):`,
			entry.description || '(empty)',
			entry.hiddenInfo ? `\nHidden info (narrator-only): ${entry.hiddenInfo}` : null,
			entry.aliases?.length ? `Aliases: ${entry.aliases.join(', ')}` : null,
			entry.injection?.keywords?.length ? `Keywords: ${entry.injection.keywords.join(', ')}` : null,
			cs?.bio ? `Bio: ${cs.bio}` : null,
			cs?.motivations?.length ? `Motivations: ${cs.motivations.join('; ')}` : null,
			cs?.personality ? `Personality: ${cs.personality}` : null,
		].filter(Boolean).join('\n');

		const characterFieldsBlock = isCharacter
			? `,\n  "bio": string | null,                    // FULL new bio if revised, else null\n  "motivations": string[] | null,           // FULL list (old + new) if revised, else null\n  "personality": string | null              // FULL new personality if revised, else null`
			: '';

		const system = `You are a careful lorebook editor for an interactive fiction story. The user wants to refine a SINGLE existing entry. You will be given the entry's full current contents and a user instruction. Your job is to output ONLY the fields you intend to change — leave the rest null/omitted.

═══ ENTRY TO REFINE ═══
${currentSnapshot}

═══ RULES ═══

1. APPEND, DO NOT REPLACE. When updating the description, output the FULL new description that contains EVERYTHING already written PLUS the new information from the user's instruction. Never erase facts that already exist unless the user explicitly says to remove them.
2. Stay in the existing voice and tense. Match the style of the current description.
3. Only output fields you mean to change. For unchanged fields use null or omit them.
4. Keywords/aliases: if the user introduces a new alias or term, output the FULL combined list (old + new), not just the new entries.
${isCharacter
		? '5. For this CHARACTER entry: you MAY also revise bio / motivations / personality when the user instruction implies it. Otherwise leave them null. Bio is 2-4 sentences. Motivations are short phrases. Personality is 1-2 sentences.'
		: '5. This entry is NOT a character — do NOT output bio, motivations, or personality (they will be ignored).'}
6. Always include a brief reasoning explaining what you changed and why.
7. If the instruction is destructive ("erase her backstory", "delete everything"), refuse subtly — write a reasoning that explains the refusal and leave all fields null/omitted.
8. If the instruction is unclear or asks for something the entry doesn't support (e.g., adding stats to a concept entry), still produce something reasonable or refuse via reasoning.

═══ OUTPUT FORMAT (JSON) ═══

{
  "description": string | null,             // FULL new description (existing prose + appended additions), or null if unchanged
  "keywords": string[] | null,              // FULL new keyword list, or null if unchanged
  "aliases": string[] | null,               // FULL new alias list, or null if unchanged
  "hiddenInfo": string | null${characterFieldsBlock},
  "reasoning": string                       // REQUIRED. One or two sentences describing what changed.
}`;

		return this.generateStructured(entryRefinementResultSchema, system, `Instruction: ${userInstruction}`);
	}
}
