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
import type {
	Entry, Chapter, EntryRelationship,
	CharacterEntryState, FactionEntryState, LocationEntryState,
	ItemEntryState, ConceptEntryState, EventEntryState,
} from '$lib/types';

const DETAILED_RECENT_CHAPTERS = 12;
const MAX_CHAPTER_SUMMARY_CHARS = 520;

interface WikiLintPromptPayload {
	system: string;
	prompt: string;
	coverage: WikiLintResult['coverage'];
	estInputTokens: number;
}

function compact(value: string | null | undefined, max: number): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function list(values: Array<string | null | undefined>, maxItems = 8, maxChars = 180): string {
	const clean = values.map(v => v?.trim()).filter((v): v is string => Boolean(v));
	if (clean.length === 0) return '';
	const shown = clean.slice(0, maxItems).join('; ');
	const suffix = clean.length > maxItems ? `; +${clean.length - maxItems} more` : '';
	return compact(`${shown}${suffix}`, maxChars);
}

function descLimitForEntryCount(count: number): number {
	if (count <= 60) return 420;
	if (count <= 140) return 260;
	if (count <= 320) return 150;
	return 90;
}

function hiddenLimitForEntryCount(count: number): number {
	if (count <= 60) return 220;
	if (count <= 140) return 140;
	if (count <= 320) return 80;
	return 50;
}

function formatEntryState(entry: Entry): string {
	const state = entry.state;
	if (!state) return '';
	switch (entry.type) {
		case 'character': {
			const s = state as CharacterEntryState;
			return list([
				s.isPresent ? 'present' : 'not present',
				s.lastSeenLocation ? `last seen ${s.lastSeenLocation}` : '',
				s.currentDisposition ? `disposition ${s.currentDisposition}` : '',
				s.relationship ? `relationship ${s.relationship.level}/${s.relationship.status}` : '',
				s.motivations?.length ? `motivations ${list(s.motivations, 3, 120)}` : '',
				s.pressures?.length ? `pressures ${list(s.pressures, 3, 120)}` : '',
				s.factionTags?.length ? `factions ${list(s.factionTags, 5, 120)}` : '',
			], 8, 320);
		}
		case 'faction': {
			const s = state as FactionEntryState;
			const goals = s.goals?.map(goal => `${goal.description} (${goal.progress}%, p${goal.priority}, ${goal.type})`) ?? [];
			const resources = s.resources
				? `resources mil:${s.resources.military} wealth:${s.resources.wealth} infl:${s.resources.influence} info:${s.resources.information} morale:${s.resources.morale}`
				: '';
			return list([
				`status ${s.status}`,
				`playerStanding ${s.playerStanding}`,
				s.disposition ? `disposition ${s.disposition}` : '',
				s.knownMembers?.length ? `members ${list(s.knownMembers, 8, 140)}` : '',
				goals.length ? `goals ${list(goals, 4, 260)}` : '',
				resources,
				s.territory?.length ? `territory ${list(s.territory, 6, 140)}` : '',
			], 8, 420);
		}
		case 'location': {
			const s = state as LocationEntryState;
			return list([
				s.isCurrentLocation ? 'current location' : '',
				`visits ${s.visitCount ?? 0}`,
				s.region ? `region ${s.region}` : '',
				s.terrain ? `terrain ${s.terrain}` : '',
				s.presentCharacters?.length ? `present chars ${list(s.presentCharacters, 6, 120)}` : '',
				s.presentItems?.length ? `present items ${list(s.presentItems, 6, 120)}` : '',
			], 6, 260);
		}
		case 'item': {
			const s = state as ItemEntryState;
			return list([
				s.inInventory ? 'in inventory' : '',
				s.currentLocation ? `location ${s.currentLocation}` : '',
				s.condition ? `condition ${s.condition}` : '',
				s.uses?.length ? `uses ${s.uses.length}` : '',
			], 5, 220);
		}
		case 'concept': {
			const s = state as ConceptEntryState;
			return list([
				s.revealed ? 'revealed' : 'not revealed',
				`comprehension ${s.comprehensionLevel}`,
				s.relatedEntries?.length ? `related ${list(s.relatedEntries, 8, 140)}` : '',
			], 4, 220);
		}
		case 'event': {
			const s = state as EventEntryState;
			return list([
				s.occurred ? 'occurred' : 'not occurred',
				s.occurredAt != null ? `occurredAt ${s.occurredAt}` : '',
				s.witnesses?.length ? `witnesses ${list(s.witnesses, 8, 140)}` : '',
				s.consequences?.length ? `consequences ${list(s.consequences, 4, 180)}` : '',
			], 5, 260);
		}
		default:
			return '';
	}
}

function formatEntry(entry: Entry, totalEntries: number): string {
	const descLimit = descLimitForEntryCount(totalEntries);
	const hiddenLimit = hiddenLimitForEntryCount(totalEntries);
	const aliases = entry.aliases?.length ? ` aliases="${list(entry.aliases, 10, 220)}"` : '';
	const keywords = entry.injection?.keywords?.length ? ` keywords="${list(entry.injection.keywords, 10, 180)}"` : '';
	const hidden = entry.hiddenInfo ? ` hidden="${compact(entry.hiddenInfo, hiddenLimit)}"` : '';
	const state = formatEntryState(entry);
	const stateText = state ? ` state="${state}"` : '';
	const branch = entry.branchId ? ` branch=${entry.branchId}` : '';
	return `- id=${entry.id} type=${entry.type} name="${entry.name}"${aliases}${keywords}${branch} mentions=${entry.mentionCount ?? 0} updated=${entry.updatedAt ?? 0} desc="${compact(entry.description, descLimit)}"${hidden}${stateText}`;
}

function formatRelationship(relationship: EntryRelationship, entryById: Map<string, Entry>): string {
	const src = entryById.get(relationship.sourceEntryId);
	const tgt = entryById.get(relationship.targetEntryId);
	const label = relationship.label ? ` label="${compact(relationship.label, 100)}"` : '';
	return `- id=${relationship.id} ${src?.name ?? relationship.sourceEntryId} (${relationship.sourceEntryId}) -[${relationship.type}, strength=${relationship.strength}, bidirectional=${relationship.bidirectional}${label}]-> ${tgt?.name ?? relationship.targetEntryId} (${relationship.targetEntryId})`;
}

function chapterLine(chapter: Chapter): string {
	return `- id=${chapter.id} number=${chapter.number} title="${chapter.title ?? 'Untitled'}" chars="${list(chapter.characters ?? [], 10, 180)}" locations="${list(chapter.locations ?? [], 10, 180)}" threads="${list(chapter.plotThreads ?? [], 8, 180)}"`;
}

export function buildWikiLintPromptPayload(
	entries: Entry[],
	relationships: EntryRelationship[],
	recentChapters: Chapter[],
): WikiLintPromptPayload {
	const activeEntries = entries
		.filter(entry => !entry.deleted)
		.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
	const activeEntryIds = new Set(activeEntries.map(entry => entry.id));
	const entryById = new Map(activeEntries.map(entry => [entry.id, entry]));
	const activeRelationships = relationships
		.filter(relationship => activeEntryIds.has(relationship.sourceEntryId) || activeEntryIds.has(relationship.targetEntryId))
		.sort((a, b) => a.type.localeCompare(b.type) || a.sourceEntryId.localeCompare(b.sourceEntryId));

	const coverage: WikiLintResult['coverage'] = {
		entryCount: activeEntries.length,
		relationshipCount: activeRelationships.length,
		chapterCount: recentChapters.length,
		allEntriesIncluded: true,
		notes: `All ${activeEntries.length} active lorebook entries are included in the audit prompt with adaptive detail.`,
	};

	const system = `You are a meticulous wiki librarian for an interactive fiction story. Given a fictional-world wiki and recent narrative, identify problems and gaps. Be concrete and conservative: only flag real issues backed by evidence, not stylistic preferences.

Faction goals define why a faction fights; schemes define how they try to win; story threads define how the war becomes player-facing plot; world events record what actually happened.

Coverage requirement:
- Every active entry in the wiki is present in the prompt. Do not claim an entry was omitted.
- Use entry IDs exactly as written. Do not invent entry IDs.
- Prefer entryId over entryName whenever identifying an existing wiki entry.

Categories:
- contradictions: two entries, or one entry's description vs its state, make incompatible claims.
- staleClaims: an entry says X but recent chapters show X changed.
- orphans: an entry has no inbound relationships, no outbound relationships, and no meaningful recent mentions.
- missingEntries: a named character, place, faction, item, concept, or event appears in chapters but has no corresponding entry or alias.
- gapSuggestions: an important tracked thing is thinly developed, underlinked, or missing operational state.
- textFixes: exact replacements for typos, spelling errors, duplicate wording, or stale wording. Only include textFixes when originalText appears verbatim in the listed field and safeToAutoApply is true.

Return valid JSON only. Every issue object must include evidence and confidence.`;

	const lines: string[] = [];
	const countsByType = activeEntries.reduce<Record<string, number>>((acc, entry) => {
		acc[entry.type] = (acc[entry.type] ?? 0) + 1;
		return acc;
	}, {});

	lines.push('## Coverage');
	lines.push(`All active entries included: ${coverage.allEntriesIncluded}`);
	lines.push(`Active entries: ${coverage.entryCount}; deleted tombstones excluded: ${entries.length - activeEntries.length}; relationships: ${coverage.relationshipCount}; chapters supplied: ${coverage.chapterCount}`);
	lines.push(`Entry type counts: ${Object.entries(countsByType).map(([type, count]) => `${type}=${count}`).join(', ') || 'none'}`);

	lines.push('\n## Lorebook Entry Index - ALL ACTIVE ENTRIES');
	if (activeEntries.length === 0) {
		lines.push('(empty lorebook)');
	} else {
		for (const entry of activeEntries) lines.push(formatEntry(entry, activeEntries.length));
	}

	lines.push(`\n## Relationships - ALL ACTIVE RELATIONSHIPS (${activeRelationships.length})`);
	if (activeRelationships.length === 0) {
		lines.push('(no relationships)');
	} else {
		for (const relationship of activeRelationships) lines.push(formatRelationship(relationship, entryById));
	}

	if (recentChapters.length > 0) {
		lines.push(`\n## Chapter Inventory - ALL SUPPLIED CHAPTERS (${recentChapters.length})`);
		for (const chapter of recentChapters) lines.push(chapterLine(chapter));

		const detailed = recentChapters.slice(-DETAILED_RECENT_CHAPTERS);
		lines.push(`\n## Recent Chapter Detail (${detailed.length} of ${recentChapters.length})`);
		for (const chapter of detailed) {
			lines.push(`### Chapter ${chapter.number}: ${chapter.title ?? 'Untitled'} [id=${chapter.id}]`);
			lines.push(compact(chapter.summary ?? '', MAX_CHAPTER_SUMMARY_CHARS));
		}
	}

	const prompt = `Audit the wiki and recent narrative below. Return JSON matching this exact shape:

{
  "coverage": { "entryCount": ${coverage.entryCount}, "relationshipCount": ${coverage.relationshipCount}, "chapterCount": ${coverage.chapterCount}, "allEntriesIncluded": true, "notes": "..." },
  "contradictions": [{ "entryId": "...", "entryName": "...", "issue": "...", "conflictingEntryId": null|"entry-id", "conflictsWith": "...", "severity": "minor|moderate|major", "evidence": ["..."], "confidence": 0.0-1.0 }],
  "staleClaims": [{ "entryId": "...", "entryName": "...", "claim": "...", "supersededBy": "...", "severity": "minor|moderate|major", "evidence": ["..."], "confidence": 0.0-1.0 }],
  "orphans": [{ "entryId": "...", "entryName": "...", "reason": "...", "evidence": ["..."], "confidence": 0.0-1.0 }],
  "missingEntries": [{ "suggestedName": "...", "suggestedType": "character|location|item|faction|concept|event", "mentionedIn": "...", "reason": "...", "evidence": ["..."], "confidence": 0.0-1.0 }],
  "gapSuggestions": [{ "topic": "...", "suggestion": "...", "relatedEntryIds": ["..."], "severity": "minor|moderate|major", "evidence": ["..."], "confidence": 0.0-1.0 }],
  "textFixes": [{ "entryId": "...", "entryName": "...", "field": "name|description|hiddenInfo", "originalText": "...", "correctedText": "...", "reason": "...", "evidence": ["..."], "confidence": 0.0-1.0, "safeToAutoApply": true }],
  "summary": "One-paragraph health summary."
}

Rules:
- For contradictions, staleClaims, orphans, gapSuggestions, and textFixes, entryId must match an id from the Lorebook Entry Index.
- If a suspected issue lacks concrete evidence, omit it.
- Missing entries must not duplicate an existing entry name or alias.
- Text fixes must be exact, local replacements only. Never rewrite whole descriptions as a textFix.
- Keep arrays focused: highest-confidence findings first.

Wiki:
${lines.join('\n')}`;

	return {
		system,
		prompt,
		coverage,
		estInputTokens: Math.ceil((system.length + prompt.length) / 4),
	};
}

function fieldValueForFix(entry: Entry, field: 'name' | 'description' | 'hiddenInfo'): string {
	if (field === 'name') return entry.name;
	if (field === 'description') return entry.description;
	return entry.hiddenInfo ?? '';
}

function hardenLintResult(result: WikiLintResult, coverage: WikiLintResult['coverage'], entries: Entry[]): WikiLintResult {
	const activeEntries = entries.filter(entry => !entry.deleted);
	const entryById = new Map(activeEntries.map(entry => [entry.id, entry]));
	const textFixes = result.textFixes.filter(fix => {
		if (!fix.safeToAutoApply) return false;
		const entry = entryById.get(fix.entryId);
		if (!entry) return false;
		const current = fieldValueForFix(entry, fix.field);
		return fix.originalText !== fix.correctedText && current.includes(fix.originalText);
	});

	return {
		...result,
		coverage,
		textFixes,
	};
}

export class WikiLintService extends BaseAIService {
	constructor() {
		super('wikiLint');
	}

	async lint(
		entries: Entry[],
		relationships: EntryRelationship[],
		recentChapters: Chapter[],
	): Promise<WikiLintResult> {
		const { system, prompt, coverage, estInputTokens } = buildWikiLintPromptPayload(
			entries,
			relationships,
			recentChapters,
		);

		// Fail loud if the prompt is large enough that truncated output is likely.
		// Rough chars→tokens ratio is ~4; we want ~70% headroom below the output
		// budget to leave room for the structured JSON response.
		const budget = this.serviceMaxTokens;
		if (estInputTokens > budget * 3) {
			throw new Error(
				`Wiki lint prompt is too large (~${estInputTokens} input tokens vs ${budget} output budget). ` +
					`Raise wikiLint.maxTokens in Settings before running Health on the full wiki.`,
			);
		}

		const result = await this.generateStructured<WikiLintResult>(wikiLintResultSchema, system, prompt);
		return hardenLintResult(result, coverage, entries);
	}
}
