/**
 * InteractiveVaultService — Mtherios
 * 
 * Provides an AI-powered interface for querying and manipulating
 * the lorebook interactively. Used by agentic workflows and
 * the lorebook management panel.
 */

import { BaseAIService } from '../BaseAIService';
import { vaultResultSchema, type VaultResult } from '../sdk/schemas/vault';
import { createLogger } from '../core/config';
import type { Entry } from '$lib/types';

const log = createLogger('Vault');

export class InteractiveVaultService extends BaseAIService {
	constructor() {
		super('interactiveVault');
	}

	/**
	 * Process a natural language query/command against the lorebook.
	 */
	async process(
		userQuery: string,
		entries: Entry[],
	): Promise<VaultResult> {
		log('process', { query: userQuery, entryCount: entries.length });

		const entryList = entries.map(e =>
			`[${e.id}] ${e.name} (${e.type}): ${e.description.slice(0, 80)}... [kw: ${e.injection.keywords.join(', ')}]`
		).join('\n');

		const system = `You are the interactive lorebook vault manager for a fiction story. You process natural language requests from the user and translate them into precise lorebook operations.

═══ CURRENT LOREBOOK ═══
${entryList || '(empty vault)'}

═══ UNDERSTANDING USER REQUESTS ═══

Users may ask things like:
- "Add a new character named Kael who is a fire mage" → create action
- "Update the description of Thornwall to mention the new gate" → update action
- "Remove the old tavern entry, it's not relevant anymore" → delete action
- "Kael is a member of the Shadow Guild" → link action
- "What do we know about the northern territories?" → this is a QUERY, not an action — respond with reasoning that answers the question using existing entries, and return an empty actions array

═══ AVAILABLE ACTIONS ═══

• create: Add a new lorebook entry
  - Requires: name, type, description, keywords
  - Infer the entry type from context (character, location, item, faction, concept, event)

• update: Modify an existing entry
  - Requires: entryId (match by name from the list above), updated fields
  - APPEND new information to the description rather than replacing it entirely

• delete: Remove an entry
  - Requires: entryId
  - Confirm with reasoning why the entry should be removed

• link: Create a relationship between two entries
  - Requires: entryId (source) + targetEntryId (related entry)
  - Add the relationship to both entries' descriptions

• unlink: Remove a relationship between entries
  - Requires: entryId + targetEntryId

═══ OUTPUT FORMAT ═══

Respond with JSON:
{
  "actions": [{ "action": "create"|"update"|"delete"|"link"|"unlink", "entryId": string|null, "name": string|null, "type": string|null, "description": string|null, "keywords": string[]|null, "targetEntryId": string|null, "reason": string }],
  "reasoning": string
}

- reasoning: Explain your interpretation of the user's request and what you did (or why you took no action)
- If the request is a pure query (no changes needed), return empty actions array and answer in reasoning`;

		return this.generateStructured(vaultResultSchema, system, `Request: ${userQuery}`);
	}
}
