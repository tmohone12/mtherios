/**
 * Wiki export — bundles a story's lorebook + chapters as a folder of
 * markdown files, zipped for download. The output opens cleanly in
 * Obsidian: cross-references use [[Entry Name]] syntax.
 */

import JSZip from 'jszip';
import { exportStory } from './storySync';
import { toObsidianLinks } from '$lib/utils/wikilinks';
import { normalizeRelation } from './ai/tools/helpers';
import {
	getAgreements,
	getFactionActions,
	getRumors,
	getWorldEvents,
} from './database';
import type {
	Entry,
	Chapter,
	Story,
	StoryEntry,
	Arc,
	EntryType,
	EntryRelationship,
	Agreement,
	AgreementCategory,
	FactionActionRecord,
	RumorRecord,
	WorldEvent,
	Meter,
	CharacterEntryState,
	FactionEntryState,
	Scheme,
	StoryThread,
} from '$lib/types';

function slug(text: string, max = 60): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, max) || 'untitled';
}

function frontmatter(obj: Record<string, unknown>): string {
	const lines: string[] = ['---'];
	for (const [k, v] of Object.entries(obj)) {
		if (v == null || v === '') continue;
		if (Array.isArray(v)) {
			if (v.length === 0) continue;
			lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(', ')}]`);
		} else if (typeof v === 'object') {
			lines.push(`${k}: ${JSON.stringify(v)}`);
		} else {
			lines.push(`${k}: ${JSON.stringify(v)}`);
		}
	}
	lines.push('---', '');
	return lines.join('\n');
}

function firstSentence(text: string | null | undefined, max = 140): string {
	if (!text) return '';
	const t = text.trim();
	if (!t) return '';
	const first = t.split(/(?<=[.!?])\s/)[0] ?? t;
	return first.length > max ? first.slice(0, max - 1) + '…' : first;
}

function compactText(text: string | null | undefined, max = 220): string {
	if (!text) return '';
	const t = text.replace(/\s+/g, ' ').trim();
	if (!t) return '';
	return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function tableCell(text: string | null | undefined): string {
	return compactText(text, 180)
		.replace(/\|/g, '\\|')
		.replace(/\n/g, '<br>');
}

const TYPE_FOLDERS: Record<EntryType, string> = {
	character: 'characters',
	location: 'locations',
	item: 'items',
	faction: 'factions',
	concept: 'concepts',
	event: 'events',
};

const TYPE_LABELS: Record<EntryType, string> = {
	character: 'Characters',
	location: 'Locations',
	item: 'Items',
	faction: 'Factions',
	concept: 'Concepts',
	event: 'Events',
};

function entryFilename(entry: Entry): string {
	// Include a short id suffix so two entries with case-only name differences
	// ("The Wall" vs "the wall") don't collide in the flat filename namespace.
	// Obsidian wikilinks resolve by display name, so the suffix is invisible
	// when browsing the vault.
	const suffix = entry.id ? `--${entry.id.slice(0, 8)}` : '';
	return `${slug(entry.name)}${suffix}.md`;
}

function entryRelPath(entry: Entry): string {
	return `wiki/${TYPE_FOLDERS[entry.type]}/${entryFilename(entry)}`;
}

function chapterFilename(chapter: Chapter): string {
	return `${String(chapter.number).padStart(3, '0')}-${slug(chapter.title || `chapter-${chapter.number}`)}.md`;
}

function arcFilename(arc: Arc): string {
	return `${String(arc.arcNumber).padStart(3, '0')}-${slug(arc.title || `arc-${arc.arcNumber}`)}.md`;
}

function storyEntrySourceFilename(entry: StoryEntry): string {
	const type = entry.type.replace(/_/g, '-');
	const suffix = entry.id ? `--${entry.id.slice(0, 8)}` : '';
	return `${String(entry.position).padStart(6, '0')}-${type}${suffix}.md`;
}

function entryNeedles(entry: Entry): string[] {
	return [entry.name, ...(entry.aliases ?? [])]
		.map((name) => name?.trim())
		.filter((name): name is string => !!name);
}

function mentionsAny(text: string, needles: string[]): boolean {
	if (!text || needles.length === 0) return false;
	return needles.some((needle) => {
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i').test(text);
	});
}

function chaptersForEntry(entry: Entry, chapters: Chapter[]): Chapter[] {
	const needles = entryNeedles(entry);
	return chapters
		.filter((chapter) => {
			const directNames = [...(chapter.characters ?? []), ...(chapter.locations ?? [])];
			if (directNames.some((name) => needles.some((needle) => name.toLowerCase() === needle.toLowerCase()))) {
				return true;
			}
			const haystack = [
				chapter.title ?? '',
				chapter.summary ?? '',
				...(chapter.keywords ?? []),
				...(chapter.plotThreads ?? []),
			].join('\n');
			return mentionsAny(haystack, needles);
		})
		.sort((a, b) => a.number - b.number);
}

function renderEntryMarkdown(
	entry: Entry,
	allEntries: Entry[],
	chapters: Chapter[],
	agreements: Agreement[],
	worldEvents: WorldEvent[],
	rumors: RumorRecord[],
	factionActions: FactionActionRecord[],
	meters: Meter[],
): string {
	const fm = frontmatter({
		name: entry.name,
		type: entry.type,
		aliases: entry.aliases ?? [],
		keywords: entry.injection?.keywords ?? [],
		injection: entry.injection?.mode,
		mentions: entry.mentionCount,
		created: new Date(entry.createdAt).toISOString(),
		updated: new Date(entry.updatedAt).toISOString(),
	});
	const parts: string[] = [fm, `# ${entry.name}\n`];
	if (entry.aliases?.length) {
		parts.push(`*Also known as:* ${entry.aliases.join(', ')}\n`);
	}
	const desc = entry.description?.trim();
	if (desc) {
		parts.push(toObsidianLinks(desc, allEntries, entry.id), '');
	}

	// ── Type-specific enrichment from Entry.state ──
	if (entry.type === 'character' && entry.state) {
		const cs = entry.state as CharacterEntryState;
		const bits: string[] = [];
		if (cs.bio?.trim()) bits.push(`**Bio.** ${cs.bio.trim()}`);
		if (Array.isArray(cs.motivations) && cs.motivations.length > 0) {
			bits.push(`**Motivations.** ${cs.motivations.join('; ')}`);
		} else if (typeof (cs as any).motivations === 'string' && (cs as any).motivations.trim()) {
			bits.push(`**Motivations.** ${(cs as any).motivations.trim()}`);
		}
		if (cs.personality?.trim()) bits.push(`**Personality.** ${cs.personality.trim()}`);
		if (cs.currentDisposition) bits.push(`**Disposition.** ${cs.currentDisposition}`);
		if (cs.personalOpinion) bits.push(`**Opinion of player.** ${cs.personalOpinion}`);
		if (bits.length > 0) parts.push('## Character', bits.map((b) => toObsidianLinks(b, allEntries, entry.id)).join('\n\n'), '');
	}

	if (entry.type === 'faction' && entry.state) {
		const fs = entry.state as FactionEntryState;
		const bits: string[] = [];
		if (typeof fs.playerStanding === 'number') bits.push(`**Player standing.** ${fs.playerStanding}`);
		if (fs.status) bits.push(`**Status.** ${fs.status}`);
		if (fs.disposition) bits.push(`**Disposition.** ${fs.disposition}`);
		if (Array.isArray(fs.territory) && fs.territory.length > 0) {
			bits.push(`**Territory.** ${fs.territory.join(', ')}`);
		}
		if (fs.resources) {
			const r = fs.resources;
			const rs = Object.entries(r)
				.filter(([, v]) => typeof v === 'number')
				.map(([k, v]) => `${k}: ${v}`)
				.join(' · ');
			if (rs) bits.push(`**Resources.** ${rs}`);
		}
		if (Array.isArray(fs.goals) && fs.goals.length > 0) {
			bits.push('**Goals.**');
			for (const g of fs.goals) bits.push(`- [p${g.priority}] ${g.description} — ${g.progress}% (${g.type})`);
		}
		if (fs.interFactionRelations && Object.keys(fs.interFactionRelations).length > 0) {
			bits.push('**Inter-faction relations.**');
			for (const [name, raw] of Object.entries(fs.interFactionRelations)) {
				const r = normalizeRelation(raw);
				const sFmt = (n: number) => `${n > 0 ? '+' : ''}${n}`;
				const affPart = r.affinity !== r.standing ? ` (af:${sFmt(r.affinity)})` : '';
				bits.push(`- [[${name}]]: ${sFmt(r.standing)}${affPart}`);
			}
		}
		if (bits.length > 0) parts.push('## Faction', bits.join('\n'), '');
	}

	// ── Reputation section: agreements, recent events, rumors ──
	const aliasLower = [entry.name, ...(entry.aliases ?? [])].filter(Boolean).map((s) => s.toLowerCase());
	const nameLower = entry.name?.toLowerCase() ?? '';
	const matchesEntity = (s: string) => {
		const sl = s.toLowerCase();
		return aliasLower.some((a) => sl.includes(a));
	};

	const relAgreements = agreements.filter((a) => a.parties.some(matchesEntity));
	const relEvents = worldEvents
		.filter((ev) => ev.sourceEntityId === entry.id || matchesEntity(ev.name) || matchesEntity(ev.description))
		.sort((a, b) => (b.appliedAt ?? b.createdAt) - (a.appliedAt ?? a.createdAt))
		.slice(0, 10);
	const relRumors = rumors
		.filter((r) => r.status !== 'stale' && r.status !== 'debunked')
		.filter((r) => (r.relatedFaction && r.relatedFaction.toLowerCase() === nameLower) || matchesEntity(r.content))
		.slice(0, 10);
	const relMeters = meters.filter((m) => aliasLower.some((a) => m.name.toLowerCase().includes(a)));
	const relFactionActions = entry.type === 'faction'
		? factionActions.filter((fa) => fa.factionName.toLowerCase() === nameLower).slice(0, 10)
		: [];

	if (
		relAgreements.length > 0 ||
		relEvents.length > 0 ||
		relRumors.length > 0 ||
		relMeters.length > 0 ||
		relFactionActions.length > 0
	) {
		parts.push('## Reputation');
		if (relMeters.length > 0) {
			parts.push('### Meters');
			for (const m of relMeters) parts.push(`- ${m.name}: ${m.value}/${m.max}${m.visible ? '' : ' *(hidden)*'}`);
		}
		if (relAgreements.length > 0) {
			parts.push('### Active agreements');
			for (const a of relAgreements.filter((x) => x.status === 'active')) {
				parts.push(`- **${a.category}** with ${a.parties.filter((p) => !matchesEntity(p)).map((p) => `[[${p}]]`).join(', ') || '—'}: ${a.terms}${a.secrecy !== 'public' ? ` *(${a.secrecy})*` : ''}`);
			}
			const resolved = relAgreements.filter((x) => x.status !== 'active');
			if (resolved.length > 0) {
				parts.push('', '### Past agreements');
				for (const a of resolved) {
					parts.push(`- ~~**${a.category}**~~ *(${a.status})* with ${a.parties.filter((p) => !matchesEntity(p)).map((p) => `[[${p}]]`).join(', ') || '—'}: ${a.terms}`);
				}
			}
		}
		if (relFactionActions.length > 0) {
			parts.push('### Recent actions');
			for (const fa of relFactionActions) {
				parts.push(`- *(${fa.actionType}, urgency ${fa.urgency})* ${fa.action}${fa.motivation ? ` — *${fa.motivation}*` : ''}`);
			}
		}
		if (relEvents.length > 0) {
			parts.push('### Recent events');
			for (const ev of relEvents) {
				parts.push(`- **${ev.name}** *(${ev.severity})*: ${ev.description}`);
			}
		}
		if (relRumors.length > 0) {
			parts.push('### Rumors');
			for (const r of relRumors) {
				const band = r.truthfulness >= 0.7 ? 'reliable' : r.truthfulness >= 0.4 ? 'uncertain' : 'dubious';
				parts.push(`- *(${band}, ${r.spreadRadius})* ${r.content}`);
			}
		}
		parts.push('');
	}

	const sourceChapters = chaptersForEntry(entry, chapters);
	if (sourceChapters.length > 0) {
		parts.push('## Source Trail');
		for (const ch of sourceChapters.slice(-12)) {
			const title = ch.title || `Chapter ${ch.number}`;
			parts.push(`- [Chapter ${ch.number}: ${title}](../../chapters/${chapterFilename(ch)})`);
		}
		parts.push('');
	}

	if (entry.hiddenInfo?.trim()) {
		parts.push('## GM Notes', toObsidianLinks(entry.hiddenInfo.trim(), allEntries, entry.id), '');
	}
	return parts.join('\n');
}

function renderChapterMarkdown(chapter: Chapter, allEntries: Entry[]): string {
	const fm = frontmatter({
		number: chapter.number,
		title: chapter.title,
		characters: chapter.characters ?? [],
		locations: chapter.locations ?? [],
		keywords: chapter.keywords ?? [],
		emotionalTone: chapter.emotionalTone,
		created: new Date(chapter.createdAt).toISOString(),
	});
	const parts: string[] = [fm, `# Chapter ${chapter.number}: ${chapter.title}\n`];
	if (chapter.summary) {
		parts.push(toObsidianLinks(chapter.summary, allEntries), '');
	}
	if (chapter.plotThreads?.length) {
		parts.push('## Plot Threads');
		for (const t of chapter.plotThreads) parts.push(`- ${t}`);
		parts.push('');
	}
	return parts.join('\n');
}

function renderArcMarkdown(arc: Arc, chapters: Chapter[]): string {
	const sourceChapters = chapters
		.filter((chapter) => arc.chapterIds.includes(chapter.id))
		.sort((a, b) => a.number - b.number);
	const fm = frontmatter({
		arcNumber: arc.arcNumber,
		title: arc.title,
		chapterRange: arc.chapterRange,
		created: new Date(arc.createdAt).toISOString(),
	});
	const parts: string[] = [fm, `# Arc ${arc.arcNumber}: ${arc.title}\n`];
	parts.push(`*Chapters:* ${arc.chapterRange}\n`);
	if (arc.summary?.trim()) parts.push('## Summary', arc.summary.trim(), '');
	if (arc.keyPlotPoints?.length) {
		parts.push('## Key Plot Points');
		for (const point of arc.keyPlotPoints) parts.push(`- ${point}`);
		parts.push('');
	}
	if (arc.characterArcs?.length) {
		parts.push('## Character Arcs');
		for (const row of arc.characterArcs) parts.push(`- **[[${row.name}]]**: ${row.development}`);
		parts.push('');
	}
	if (arc.unresolvedThreads?.length) {
		parts.push('## Open Threads');
		for (const thread of arc.unresolvedThreads) parts.push(`- ${thread}`);
		parts.push('');
	}
	if (arc.emotionalProgression?.trim()) parts.push('## Emotional Progression', arc.emotionalProgression.trim(), '');
	if (sourceChapters.length > 0) {
		parts.push('## Source Chapters');
		for (const ch of sourceChapters) {
			const title = ch.title || `Chapter ${ch.number}`;
			parts.push(`- [Chapter ${ch.number}: ${title}](../chapters/${chapterFilename(ch)})`);
		}
		parts.push('');
	}
	return parts.join('\n');
}

function renderArcsIndex(arcs: Arc[]): string {
	if (arcs.length === 0) return '';
	const lines: string[] = ['# Arcs', ''];
	lines.push(`*${arcs.length} condensed narrative arc${arcs.length === 1 ? '' : 's'}*`, '');
	for (const arc of [...arcs].sort((a, b) => a.arcNumber - b.arcNumber)) {
		lines.push(`- [Arc ${arc.arcNumber}: ${arc.title}](${arcFilename(arc)}) - chapters ${arc.chapterRange}`);
	}
	return lines.join('\n') + '\n';
}

function renderRelationshipIndex(relationships: EntryRelationship[], entries: Entry[]): string {
	if (relationships.length === 0) return '';
	const entryById = new Map(entries.map((entry) => [entry.id, entry]));
	const lines: string[] = ['# Relationship Graph', ''];
	lines.push(`*${relationships.length} recorded relationship${relationships.length === 1 ? '' : 's'}*`, '');
	lines.push('| Source | Relation | Target | Strength | Notes |', '|---|---|---|---:|---|');
	for (const rel of [...relationships].sort((a, b) => b.strength - a.strength)) {
		const source = entryById.get(rel.sourceEntryId);
		const target = entryById.get(rel.targetEntryId);
		if (!source || !target) continue;
		lines.push(
			`| [[${source.name}]] | ${rel.type}${rel.bidirectional ? ' (bidirectional)' : ''} | [[${target.name}]] | ${rel.strength} | ${tableCell(rel.label)} |`,
		);
	}
	return lines.join('\n') + '\n';
}

function renderStoryEntrySourceMarkdown(entry: StoryEntry): string {
	const fm = frontmatter({
		kind: 'raw_source',
		sourceType: 'story_entry',
		entryType: entry.type,
		position: entry.position,
		branchId: entry.branchId,
		created: new Date(entry.createdAt).toISOString(),
		metadata: entry.metadata ?? null,
	});
	const title = `Turn ${entry.position}: ${entry.type.replace(/_/g, ' ')}`;
	const content = entry.content.length > 0 ? entry.content : '(empty source)';
	return `${fm}# ${title}\n\n${content}\n`;
}

function renderRawReadme(story: Story): string {
	const fm = frontmatter({
		story: story.title,
		layer: 'raw_sources',
	});
	return `${fm}# Raw Sources

This folder is the immutable source layer for the story wiki.

Rules for LLM maintainers:

- Do not edit files in \`raw/\` when maintaining the wiki.
- Read raw files to verify claims, resolve contradictions, or rebuild derived pages.
- Put synthesis, entity pages, comparisons, and maintenance notes outside \`raw/\`.
- When a derived page depends on a raw source, link the relevant transcript entry, chapter, or arc from a Source Trail section.

The compiled wiki can change. The raw layer should remain a stable record of what happened.
`;
}

function renderRawIndexMarkdown(storyEntries: StoryEntry[], chapters: Chapter[]): string {
	const lines: string[] = ['# Raw Source Index', ''];
	lines.push(`*${storyEntries.length} transcript entries - ${chapters.length} chapter summaries*`, '');

	if (storyEntries.length > 0) {
		lines.push('## Transcript Entries', '');
		lines.push('| Turn | Type | Created | Source | Preview |', '|---:|---|---|---|---|');
		for (const entry of [...storyEntries].sort((a, b) => a.position - b.position)) {
			lines.push(
				`| ${entry.position} | ${entry.type} | ${new Date(entry.createdAt).toISOString()} | [open](transcript/${storyEntrySourceFilename(entry)}) | ${tableCell(entry.content)} |`,
			);
		}
		lines.push('');
	}

	if (chapters.length > 0) {
		lines.push('## Chapter Summaries', '');
		for (const ch of [...chapters].sort((a, b) => a.number - b.number)) {
			const title = ch.title || `Chapter ${ch.number}`;
			lines.push(`- [Chapter ${ch.number}: ${title}](../chapters/${chapterFilename(ch)})`);
		}
		lines.push('');
	}

	return lines.join('\n') + '\n';
}

function renderAgentSchemaMarkdown(
	story: Story,
	counts: {
		entryCount: number;
		chapterCount: number;
		arcCount: number;
		rawSourceCount: number;
		relationshipCount: number;
	},
): string {
	return `# Mtherios Wiki Maintainer Schema

You are maintaining an LLM-generated Mtherios story wiki. Treat this vault as a persistent knowledge base that compounds over time.

## Layers

- \`raw/\`: immutable source files. Read these for evidence. Do not rewrite them during wiki maintenance.
- \`wiki/\`, \`chapters/\`, \`arcs/\`, \`agreements/\`, and top-level summary pages: derived wiki pages. The LLM may update these when new evidence arrives.
- \`index.md\`: content catalog. Update it whenever pages are added, renamed, archived, or substantially changed.
- \`log.md\`: chronological maintenance and story record. Append entries using \`## [YYYY-MM-DD] kind | title\`.
- \`AGENTS.md\`: this schema. Update only when the wiki workflow or conventions intentionally change.

## Story Scope

- Title: ${story.title}
- Mode: ${story.mode}
- Genre: ${story.genre ?? 'unspecified'}
- Current export contains ${counts.entryCount} wiki entries, ${counts.chapterCount} chapters, ${counts.arcCount} arcs, ${counts.rawSourceCount} raw transcript sources, and ${counts.relationshipCount} relationship edges.

## Page Conventions

- Use Obsidian wikilinks for entities: \`[[Name]]\` or \`[[Name|alias]]\`.
- Keep public/protagonist-known facts in the main body of entity pages.
- Keep narrator-only information under \`## GM Notes\`.
- Add or preserve \`## Source Trail\` on derived pages when a claim depends on specific chapters, arcs, or raw transcript entries.
- Prefer concise factual synthesis over transcript-like retelling.
- Contradictions should be called out explicitly instead of silently overwritten.

## Ingest Workflow

1. Read the new raw source or newly generated chapter/arc summary.
2. Identify entities, concepts, events, agreements, faction moves, rumors, and unresolved threads.
3. Create or update the affected pages across \`wiki/\`, \`chapters/\`, \`arcs/\`, and top-level summaries.
4. Update \`index.md\` and append \`log.md\`.
5. If evidence contradicts old claims, either revise the claim with a source note or add a contradiction note for follow-up.

## Query Workflow

1. Read \`index.md\` first.
2. Open the relevant wiki pages, source trails, chapters, arcs, and raw entries as needed.
3. Answer with citations to wiki pages or raw source paths.
4. If the answer becomes reusable synthesis, file it back into the wiki and update \`index.md\` and \`log.md\`.

## Lint Workflow

Periodically check for stale claims, contradictions, orphan pages, thin high-importance concepts, missing cross-links, and source gaps. Prefer small targeted fixes that keep the wiki trustworthy.
`;
}

function renderSynthesisMarkdown(
	story: Story,
	entries: Entry[],
	chapters: Chapter[],
	arcs: Arc[],
	agreements: Agreement[],
	rumors: RumorRecord[],
	worldEvents: WorldEvent[],
	factionActions: FactionActionRecord[],
	schemes: Scheme[],
	storyThreads: StoryThread[],
): string {
	const fm = frontmatter({
		title: story.title,
		kind: 'compiled_synthesis',
		updated: new Date().toISOString(),
	});
	const lines: string[] = [fm, `# ${story.title} Synthesis`, ''];
	if (story.description?.trim()) lines.push(story.description.trim(), '');

	lines.push('## Current Shape', '');
	lines.push(`- Mode: ${story.mode}`);
	lines.push(`- Genre: ${story.genre ?? 'unspecified'}`);
	lines.push(`- Wiki entries: ${entries.length}`);
	lines.push(`- Chapters: ${chapters.length}`);
	lines.push(`- Arcs: ${arcs.length}`);
	lines.push(`- Active agreements: ${agreements.filter((a) => a.status === 'active').length}`);
	lines.push(`- Active rumors: ${rumors.filter((r) => r.status !== 'stale' && r.status !== 'debunked').length}`);
	lines.push('');

	const recentArcs = [...arcs].sort((a, b) => b.arcNumber - a.arcNumber).slice(0, 5);
	if (recentArcs.length > 0) {
		lines.push('## Recent Arc Synthesis', '');
		for (const arc of recentArcs) {
			lines.push(`- [Arc ${arc.arcNumber}: ${arc.title}](arcs/${arcFilename(arc)}) - ${compactText(arc.summary, 220)}`);
		}
		lines.push('');
	}

	const factions = entries
		.filter((entry) => entry.type === 'faction')
		.map((entry) => {
			const state = entry.state as FactionEntryState | null;
			const resources = state?.resources;
			const resourceScore = resources
				? resources.military + resources.wealth + resources.influence + resources.information + resources.morale
				: 0;
			const actionScore = factionActions.some((action) => action.factionName.toLowerCase() === entry.name.toLowerCase()) ? 100 : 0;
			return {
				entry,
				score: Math.abs(state?.playerStanding ?? 0) + resourceScore / 5 + actionScore + (state?.goals?.length ?? 0) * 10,
				state,
			};
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, 10);
	if (factions.length > 0) {
		lines.push('## Power Centers', '');
		for (const row of factions) {
			const bits = [
				row.state?.status ? `status ${row.state.status}` : '',
				typeof row.state?.playerStanding === 'number' ? `standing ${row.state.playerStanding}` : '',
				row.state?.disposition ? row.state.disposition : '',
			].filter(Boolean).join(', ');
			lines.push(`- [[${row.entry.name}]]${bits ? ` - ${bits}` : ''}`);
		}
		lines.push('');
	}

	const activeSchemes = schemes.filter((scheme) => !['resolved', 'foiled', 'abandoned'].includes(scheme.status));
	const openThreads = storyThreads.filter((thread) => ['open', 'imminent', 'stalled'].includes(thread.status));
	const unresolvedArcThreads = recentArcs.flatMap((arc) => arc.unresolvedThreads ?? []);
	if (activeSchemes.length > 0 || openThreads.length > 0 || unresolvedArcThreads.length > 0) {
		lines.push('## Open Pressures', '');
		for (const scheme of activeSchemes.slice(0, 8)) {
			lines.push(`- **${scheme.ownerName}**: ${scheme.goal} (${scheme.status}, pressure ${scheme.pressure})`);
		}
		for (const thread of openThreads.slice(0, 8)) {
			lines.push(`- **${thread.significance} thread**: ${thread.description} (${thread.status})`);
		}
		for (const thread of unresolvedArcThreads.slice(0, 8)) lines.push(`- ${thread}`);
		lines.push('');
	}

	const recentEvents = [...worldEvents]
		.sort((a, b) => (b.appliedAt ?? b.createdAt) - (a.appliedAt ?? a.createdAt))
		.slice(0, 8);
	if (recentEvents.length > 0) {
		lines.push('## Recent Consequences', '');
		for (const event of recentEvents) {
			lines.push(`- **${event.name}** (${event.severity}): ${compactText(event.description, 180)}`);
		}
		lines.push('');
	}

	lines.push('## Maintenance Prompts', '');
	lines.push('- Which high-importance entities lack source trails?');
	lines.push('- Which faction goals no longer match recent chapter evidence?');
	lines.push('- Which rumors should mature, go stale, or be debunked?');
	lines.push('- Which reusable analysis from recent queries should be filed as a wiki page?');

	return lines.join('\n') + '\n';
}

function renderIndexMarkdown(
	entries: Entry[],
	chapters: Chapter[],
	arcs: Arc[],
	relationshipCount: number,
	rawSourceCount: number,
): string {
	const buckets: Record<EntryType, Entry[]> = {
		character: [], location: [], item: [], faction: [], concept: [], event: [],
	};
	for (const e of entries) buckets[e.type]?.push(e);
	for (const t of Object.keys(buckets) as EntryType[]) {
		buckets[t].sort((a, b) => a.name.localeCompare(b.name));
	}

	const lines: string[] = ['# Wiki Index', ''];
	lines.push(`*Vault scope: ${arcs.length} arcs - ${rawSourceCount} raw sources - ${relationshipCount} relationships*`, '');
	lines.push('## Core Pages', '');
	lines.push('- [Synthesis](synthesis.md)');
	lines.push('- [Raw Source Index](raw/index.md)');
	lines.push('- [Log](log.md)');
	lines.push('- [Maintainer Schema](AGENTS.md)');
	if (relationshipCount > 0) lines.push('- [Relationship Graph](relationships.md)');
	lines.push('');
	lines.push(`*${entries.length} entries · ${chapters.length} chapters · generated ${new Date().toLocaleString()}*`, '');

	for (const t of Object.keys(buckets) as EntryType[]) {
		const bucket = buckets[t];
		if (bucket.length === 0) continue;
		lines.push(`## ${TYPE_LABELS[t]} (${bucket.length})`, '');
		for (const e of bucket) {
			const summary = firstSentence(e.description);
			lines.push(`- [[${e.name}]]${summary ? ` — ${summary}` : ''}`);
		}
		lines.push('');
	}

	if (chapters.length > 0) {
		lines.push('## Chapters', '');
		const sorted = [...chapters].sort((a, b) => a.number - b.number);
		for (const ch of sorted) {
			lines.push(`- [Chapter ${ch.number}: ${ch.title}](chapters/${chapterFilename(ch)})`);
		}
		lines.push('');
	}

	if (arcs.length > 0) {
		lines.push('## Arcs', '');
		const sorted = [...arcs].sort((a, b) => a.arcNumber - b.arcNumber);
		for (const arc of sorted) {
			lines.push(`- [Arc ${arc.arcNumber}: ${arc.title}](arcs/${arcFilename(arc)}) - chapters ${arc.chapterRange}`);
		}
	}

	return lines.join('\n') + '\n';
}

function renderLogMarkdown(
	entries: Entry[],
	chapters: Chapter[],
	arcs: Arc[],
	worldEvents: WorldEvent[],
	agreements: Agreement[],
	factionActions: FactionActionRecord[],
): string {
	type Row = { when: number; line: string };
	const rows: Row[] = [];
	const fmtDate = (t: number) => new Date(t).toISOString().slice(0, 10);

	for (const ch of chapters) {
		rows.push({
			when: ch.createdAt,
			line: `## [${fmtDate(ch.createdAt)}] chapter | Chapter ${ch.number}: ${ch.title}\n${ch.summary ? firstSentence(ch.summary, 200) : ''}`,
		});
	}
	for (const arc of arcs) {
		rows.push({
			when: arc.createdAt,
			line: `## [${fmtDate(arc.createdAt)}] arc | Arc ${arc.arcNumber}: ${arc.title}\nChapters ${arc.chapterRange}. ${firstSentence(arc.summary, 220)}`,
		});
	}
	for (const ev of worldEvents) {
		const when = ev.appliedAt ?? ev.createdAt ?? Date.now();
		rows.push({
			when,
			line: `## [${fmtDate(when)}] event | [${ev.type} · ${ev.severity}] ${ev.name}\n${ev.description ?? ''}${
				ev.consequences?.length
					? '\n' + ev.consequences.map((c: any) => `  → ${c.description}`).join('\n')
					: ''
			}`,
		});
	}
	for (const a of agreements) {
		rows.push({
			when: a.createdAt,
			line: `## [${fmtDate(a.createdAt)}] agreement-created | [${a.category}] ${a.parties.join(' ↔ ')}\n${a.terms}`,
		});
		if (a.status !== 'active' && a.updatedAt !== a.createdAt) {
			rows.push({
				when: a.updatedAt,
				line: `## [${fmtDate(a.updatedAt)}] agreement-${a.status} | [${a.category}] ${a.parties.join(' ↔ ')}`,
			});
		}
	}
	for (const fa of factionActions) {
		rows.push({
			when: fa.createdAt,
			line: `## [${fmtDate(fa.createdAt)}] faction-action | ${fa.factionName} (${fa.actionType}, urgency ${fa.urgency})\n${fa.action}${fa.motivation ? ` — *${fa.motivation}*` : ''}`,
		});
	}
	for (const e of entries) {
		rows.push({
			when: e.createdAt,
			line: `## [${fmtDate(e.createdAt)}] entry-created | ${e.type}: [[${e.name}]]`,
		});
	}

	rows.sort((a, b) => b.when - a.when);

	const header = `# Log\n\nChronological record of wiki growth and notable events.\nFormat: \`## [YYYY-MM-DD] kind | title\` — greppable with \`grep "^## \\[" log.md\`.\n\n`;
	return header + rows.map((r) => r.line).join('\n\n') + '\n';
}

function agreementCategoryFolder(cat: AgreementCategory): string {
	// Group pluralized for nicer Obsidian tree
	return `${cat.replace(/-/g, '_')}s`;
}

function renderAgreementMarkdown(a: Agreement, allEntries: Entry[]): string {
	const fm = frontmatter({
		category: a.category,
		status: a.status,
		secrecy: a.secrecy,
		parties: a.parties,
		createdChapter: a.createdChapterNumber,
		resolvedChapter: a.resolvedChapterNumber,
		created: new Date(a.createdAt).toISOString(),
		updated: new Date(a.updatedAt).toISOString(),
	});
	const parts: string[] = [fm];
	parts.push(`# ${a.category}: ${a.parties.join(' ↔ ')}\n`);
	parts.push(`*Status:* **${a.status}** · *Secrecy:* ${a.secrecy}\n`);
	parts.push('## Parties', a.parties.map((p) => `- [[${p}]]`).join('\n'), '');
	parts.push('## Terms', toObsidianLinks(a.terms, allEntries), '');
	if (a.consequences.length > 0) {
		parts.push('## Consequences');
		for (const c of a.consequences) parts.push(`- ${toObsidianLinks(c, allEntries)}`);
		parts.push('');
	}
	return parts.join('\n');
}

function renderAgreementsIndex(agreements: Agreement[]): string {
	if (agreements.length === 0) return '';
	const lines: string[] = ['# Agreements', ''];
	lines.push(`*${agreements.length} recorded commitments*`, '');

	const byStatus: Record<string, Agreement[]> = {};
	for (const a of agreements) (byStatus[a.status] ??= []).push(a);
	const order = ['active', 'broken', 'fulfilled', 'expired', 'contested'];
	for (const status of order) {
		const bucket = byStatus[status];
		if (!bucket?.length) continue;
		lines.push(`## ${status[0].toUpperCase()}${status.slice(1)} (${bucket.length})`, '');
		for (const a of bucket) {
			lines.push(`- **${a.category}** · ${a.parties.map((p) => `[[${p}]]`).join(' ↔ ')}: ${firstSentence(a.terms, 120)}`);
		}
		lines.push('');
	}
	return lines.join('\n') + '\n';
}

function renderMetersMarkdown(meters: Meter[]): string {
	if (meters.length === 0) return '';
	const lines: string[] = ['# Meters', ''];
	lines.push(`*Per-story numeric tracks — ${meters.length} meter${meters.length === 1 ? '' : 's'}*`, '');
	lines.push('| Meter | Value | Max | Visible |', '|---|---|---|---|');
	for (const m of [...meters].sort((a, b) => a.name.localeCompare(b.name))) {
		lines.push(`| ${m.name} | ${m.value} | ${m.max} | ${m.visible ? 'yes' : 'no'} |`);
	}
	return lines.join('\n') + '\n';
}

function renderRumorsMarkdown(rumors: RumorRecord[]): string {
	if (rumors.length === 0) return '';
	const active = rumors.filter((r) => r.status !== 'stale' && r.status !== 'debunked');
	const stale = rumors.filter((r) => r.status === 'stale' || r.status === 'debunked');
	const lines: string[] = ['# Rumors', ''];
	lines.push(`*${active.length} active · ${stale.length} stale/debunked · ${rumors.length} total*`, '');

	const truthBand = (t: number) => (t >= 0.7 ? 'reliable' : t >= 0.4 ? 'uncertain' : 'dubious');

	if (active.length > 0) {
		lines.push('## Active rumors', '');
		lines.push('| Spread | Truth | Origin | Related | Content |', '|---|---|---|---|---|');
		for (const r of active) {
			lines.push(
				`| ${r.spreadRadius} | ${truthBand(r.truthfulness)} (${r.truthfulness.toFixed(2)}) | ${r.originRegion} | ${r.relatedFaction ? `[[${r.relatedFaction}]]` : '—'} | ${r.content} |`,
			);
		}
		lines.push('');
	}
	if (stale.length > 0) {
		lines.push('## Old rumors', '');
		for (const r of stale) lines.push(`- *(${r.status})* ${r.content}`);
	}
	return lines.join('\n') + '\n';
}

function renderReadme(
	story: Story,
	entryCount: number,
	chapterCount: number,
	arcCount: number,
	rawSourceCount: number,
	relationshipCount: number,
	agreementCount: number,
	rumorCount: number,
	meterCount: number,
): string {
	const fm = frontmatter({
		title: story.title,
		genre: story.genre,
		mode: story.mode,
		exported: new Date().toISOString(),
	});
	return `${fm}# ${story.title}

${story.description ?? ''}

- **Mode:** ${story.mode}
- **Genre:** ${story.genre ?? '—'}
- **Wiki entries:** ${entryCount}
- **Chapters:** ${chapterCount}
- **Arcs:** ${arcCount}
- **Raw sources:** ${rawSourceCount}
- **Relationships:** ${relationshipCount}
- **Agreements:** ${agreementCount}
- **Active rumors:** ${rumorCount}
- **Meters tracked:** ${meterCount}
- **Exported:** ${new Date().toLocaleString()}

Open this folder as an Obsidian vault for the best browsing experience. Cross-references use \`[[Entry Name]]\` syntax.

## Structure

Core LLM-maintained layers:

- \`AGENTS.md\` - maintainer schema for future LLM/wiki-agent sessions.
- \`synthesis.md\` - compiled high-level story and world-state snapshot.
- \`raw/\` - immutable transcript source layer used to verify derived claims.
- \`arcs/<n>-<title>.md\` - one file per condensed narrative arc.
- \`relationships.md\` - relationship graph exported as a table when relationships exist.

- \`index.md\` — categorized list of all entries.
- \`log.md\` — chronological log of chapters, events, agreements, faction moves, and entries.
- \`wiki/<type>/<entry>.md\` — one file per lorebook entry, enriched with reputation summary (standing, active agreements, recent events, rumors).
- \`chapters/<n>-<title>.md\` — one file per chapter.
- \`agreements/<category>/<id>-<slug>.md\` — one file per commitment (treaty, oath, marriage, bargain, etc.).
- \`agreements/index.md\` — grouped listing of all agreements by status.
- \`rumors.md\` — active and stale rumors.
- \`meters.md\` — current meter values.
`;
}

export async function downloadStoryAsWiki(storyId: string): Promise<void> {
	const data = await exportStory(storyId);

	// Fetch living-world data directly — these live in tables that the
	// plain JSON exporter doesn't bundle (v1 schema; intentionally kept stable).
	const [agreements, factionActions, rumors, worldEvents] = await Promise.all([
		getAgreements(storyId),
		getFactionActions(storyId),
		getRumors(storyId),
		getWorldEvents(storyId),
	]);
	const meters = data.story.meters ?? [];
	const arcs = data.arcs ?? [];
	const relationships = data.entryRelationships ?? [];
	const storyEntries = data.storyEntries ?? [];
	const schemes = data.schemes ?? [];
	const storyThreads = data.storyThreads ?? [];

	const zip = new JSZip();

	zip.file(
		'README.md',
		renderReadme(
			data.story,
			data.lorebookEntries.length,
			data.chapters.length,
			arcs.length,
			storyEntries.length,
			relationships.length,
			agreements.length,
			rumors.filter((r) => r.status !== 'stale' && r.status !== 'debunked').length,
			meters.length,
		),
	);

	zip.file(
		'AGENTS.md',
		renderAgentSchemaMarkdown(data.story, {
			entryCount: data.lorebookEntries.length,
			chapterCount: data.chapters.length,
			arcCount: arcs.length,
			rawSourceCount: storyEntries.length,
			relationshipCount: relationships.length,
		}),
	);

	zip.file(
		'synthesis.md',
		renderSynthesisMarkdown(
			data.story,
			data.lorebookEntries,
			data.chapters,
			arcs,
			agreements,
			rumors,
			worldEvents,
			factionActions,
			schemes,
			storyThreads,
		),
	);

	zip.file('index.md', renderIndexMarkdown(data.lorebookEntries, data.chapters, arcs, relationships.length, storyEntries.length));
	zip.file('raw/README.md', renderRawReadme(data.story));
	zip.file('raw/index.md', renderRawIndexMarkdown(storyEntries, data.chapters));
	for (const entry of storyEntries) {
		zip.file(`raw/transcript/${storyEntrySourceFilename(entry)}`, renderStoryEntrySourceMarkdown(entry));
	}
	if (relationships.length > 0) zip.file('relationships.md', renderRelationshipIndex(relationships, data.lorebookEntries));

	zip.file(
		'log.md',
		renderLogMarkdown(data.lorebookEntries, data.chapters, arcs, worldEvents, agreements, factionActions),
	);

	// Per-entry pages — enriched with reputation data
	for (const e of data.lorebookEntries) {
		zip.file(
			entryRelPath(e),
			renderEntryMarkdown(e, data.lorebookEntries, data.chapters, agreements, worldEvents, rumors, factionActions, meters),
		);
	}

	// Per-chapter pages
	for (const ch of data.chapters) {
		zip.file(`chapters/${chapterFilename(ch)}`, renderChapterMarkdown(ch, data.lorebookEntries));
	}

	// Per-arc pages
	if (arcs.length > 0) {
		zip.file('arcs/index.md', renderArcsIndex(arcs));
		for (const arc of arcs) {
			zip.file(`arcs/${arcFilename(arc)}`, renderArcMarkdown(arc, data.chapters));
		}
	}

	// Agreements: index + one file per row grouped by category
	if (agreements.length > 0) {
		zip.file('agreements/index.md', renderAgreementsIndex(agreements));
		for (const a of agreements) {
			const folder = agreementCategoryFolder(a.category);
			const fname = `${a.id.slice(0, 8)}-${slug(a.parties.join('-'))}.md`;
			zip.file(`agreements/${folder}/${fname}`, renderAgreementMarkdown(a, data.lorebookEntries));
		}
	}

	if (rumors.length > 0) zip.file('rumors.md', renderRumorsMarkdown(rumors));
	if (meters.length > 0) zip.file('meters.md', renderMetersMarkdown(meters));

	const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
	const url = URL.createObjectURL(blob);
	const slugTitle = slug(data.story.title);
	const date = new Date().toISOString().slice(0, 10);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${slugTitle}-${date}.wiki.zip`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
