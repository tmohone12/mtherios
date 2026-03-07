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

		const system = `You manage an interactive lorebook vault for a fiction story. Process the user's request and determine what actions to take.

CURRENT ENTRIES:
${entryList || '(empty)'}

You can:
- create: Add new entries
- update: Modify existing entries (provide entryId)
- delete: Remove entries (provide entryId)
- link: Create a relationship between entries (provide entryId + targetEntryId)
- unlink: Remove a relationship

Always provide a reason for each action.

Respond with JSON: { "actions": [{ "action": "create"|"update"|"delete"|"link"|"unlink", "entryId": string|null, "name": string|null, "type": string|null, "description": string|null, "keywords": string[]|null, "targetEntryId": string|null, "reason": string }], "reasoning": string }`;

		return this.generateStructured(vaultResultSchema, system, `Request: ${userQuery}`);
	}
}
