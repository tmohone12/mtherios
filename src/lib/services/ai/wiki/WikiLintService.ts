/**
 * WikiLintService
 *
 * Health-checks the lorebook by asking the LLM to scan for:
 *   - Contradictions between entries
 *   - Stale claims superseded by newer chapters
 *   - Orphan entries with no inbound links and no recent mentions
 *   - Missing entries — names mentioned in chapters but with no entry
 *   - Gap suggestions — topics that would benefit from elaboration
 *
 * Pure read pass: returns a report, doesn't mutate state.
 */

import { BaseAIService } from '../BaseAIService';
import { wikiLintResultSchema, type WikiLintResult } from '../sdk/schemas/wikiLint';
import type { Entry, Chapter, EntryRelationship } from '$lib/types';

const MAX_ENTRIES_IN_PROMPT = 80;
const MAX_CHAPTERS_IN_PROMPT = 8;
const MAX_DESCRIPTION_CHARS = 400;

export class WikiLintService extends BaseAIService {
	constructor() {
		super('wikiLint');
	}

	async lint(
		entries: Entry[],
		relationships: EntryRelationship[],
		recentChapters: Chapter[],
	): Promise<WikiLintResult> {
		const system = `You are a meticulous wiki librarian. Given a fictional-world wiki and recent narrative, identify problems and gaps. Be concrete and conservative — only flag REAL issues, not stylistic preferences. If everything looks healthy, return a brief summary and empty arrays.

Categories:
- contradictions: two entries (or one entry's description vs its state) make incompatible claims
- staleClaims: an entry says X but a recent chapter shows ¬X
- orphans: an entry has zero inbound mentions AND zero outbound relationships AND has not been mentioned in recent chapters
- missingEntries: a name referenced in a chapter has no corresponding entry
- gapSuggestions: a topic that's important but thinly developed (e.g. faction with members but no leader entry)

Respond ONLY with valid JSON matching the schema.`;

		const lines: string[] = [];

		// Entries (capped, ordered by recency)
		const sortedEntries = [...entries]
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
			.slice(0, MAX_ENTRIES_IN_PROMPT);

		lines.push(`## Lorebook Entries (${entries.length} total, showing ${sortedEntries.length})`);
		for (const e of sortedEntries) {
			const desc = (e.description ?? '').slice(0, MAX_DESCRIPTION_CHARS);
			const aliases = e.aliases?.length ? ` [aliases: ${e.aliases.join(', ')}]` : '';
			lines.push(`- (${e.type}) **${e.name}**${aliases}: ${desc}`);
		}

		// Relationships
		if (relationships.length > 0) {
			const entryById = new Map(entries.map((e) => [e.id, e.name]));
			lines.push(`\n## Relationships (${relationships.length})`);
			for (const r of relationships.slice(0, 60)) {
				const src = entryById.get(r.sourceEntryId) ?? r.sourceEntryId;
				const tgt = entryById.get(r.targetEntryId) ?? r.targetEntryId;
				lines.push(`- ${src} —[${r.type}]→ ${tgt}${r.label ? ` (${r.label})` : ''}`);
			}
		}

		// Recent chapters
		if (recentChapters.length > 0) {
			const recent = recentChapters.slice(-MAX_CHAPTERS_IN_PROMPT);
			lines.push(`\n## Recent Chapters (${recent.length} of ${recentChapters.length})`);
			for (const c of recent) {
				lines.push(`### Chapter ${c.number}: ${c.title}`);
				lines.push(c.summary?.slice(0, 600) ?? '');
				if (c.characters?.length) lines.push(`Characters: ${c.characters.join(', ')}`);
				if (c.locations?.length) lines.push(`Locations: ${c.locations.join(', ')}`);
			}
		}

		const prompt = `Audit the following wiki and recent narrative. Return JSON matching this shape:

{
  "contradictions": [{ "entryName": "...", "issue": "...", "conflictsWith": "...", "severity": "minor|moderate|major" }],
  "staleClaims": [{ "entryName": "...", "claim": "...", "supersededBy": "..." }],
  "orphans": [{ "entryName": "...", "reason": "..." }],
  "missingEntries": [{ "suggestedName": "...", "suggestedType": "character|location|item|faction|concept|event", "mentionedIn": "...", "reason": "..." }],
  "gapSuggestions": [{ "topic": "...", "suggestion": "..." }],
  "summary": "One-paragraph health summary."
}

Wiki:
${lines.join('\n')}`;

		// Fail loud if the prompt is large enough that truncated output is likely.
		// Rough chars→tokens ratio is ~4; we want ~70% headroom below the output
		// budget to leave room for the structured JSON response.
		const estInputTokens = Math.ceil((system.length + prompt.length) / 4);
		const budget = this.serviceMaxTokens;
		if (estInputTokens > budget * 3) {
			throw new Error(
				`Wiki lint prompt is too large (~${estInputTokens} input tokens vs ${budget} output budget). ` +
					`Raise wikiLint.maxTokens in Settings, or narrow the lorebook (type filter / search) before running Health.`,
			);
		}

		return this.generateStructured<WikiLintResult>(wikiLintResultSchema, system, prompt);
	}
}
