/**
 * Wiki export — bundles a story's lorebook + chapters as a folder of
 * markdown files, zipped for download. The output opens cleanly in
 * Obsidian: cross-references use [[Entry Name]] syntax.
 */

import JSZip from 'jszip';
import { exportStory } from './storySync';
import { toObsidianLinks } from '$lib/utils/wikilinks';
import type { Entry, Chapter, Story, EntryType } from '$lib/types';

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
	return `${slug(entry.name)}.md`;
}

function entryRelPath(entry: Entry): string {
	return `wiki/${TYPE_FOLDERS[entry.type]}/${entryFilename(entry)}`;
}

function chapterFilename(chapter: Chapter): string {
	return `${String(chapter.number).padStart(3, '0')}-${slug(chapter.title || `chapter-${chapter.number}`)}.md`;
}

function renderEntryMarkdown(entry: Entry, allEntries: Entry[]): string {
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

function renderIndexMarkdown(entries: Entry[], chapters: Chapter[]): string {
	const buckets: Record<EntryType, Entry[]> = {
		character: [], location: [], item: [], faction: [], concept: [], event: [],
	};
	for (const e of entries) buckets[e.type]?.push(e);
	for (const t of Object.keys(buckets) as EntryType[]) {
		buckets[t].sort((a, b) => a.name.localeCompare(b.name));
	}

	const lines: string[] = ['# Wiki Index', ''];
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
	}

	return lines.join('\n') + '\n';
}

function renderLogMarkdown(
	entries: Entry[],
	chapters: Chapter[],
	worldEvents: Array<{ name: string; description: string; appliedAt?: number | null }>,
): string {
	type Row = { when: number; line: string };
	const rows: Row[] = [];

	for (const ch of chapters) {
		rows.push({
			when: ch.createdAt,
			line: `## [${new Date(ch.createdAt).toISOString().slice(0, 10)}] chapter | Chapter ${ch.number}: ${ch.title}\n${ch.summary ? firstSentence(ch.summary, 200) : ''}`,
		});
	}
	for (const ev of worldEvents) {
		const when = ev.appliedAt ?? Date.now();
		rows.push({
			when,
			line: `## [${new Date(when).toISOString().slice(0, 10)}] event | ${ev.name}\n${ev.description ?? ''}`,
		});
	}
	for (const e of entries) {
		rows.push({
			when: e.createdAt,
			line: `## [${new Date(e.createdAt).toISOString().slice(0, 10)}] entry-created | ${e.type}: [[${e.name}]]`,
		});
	}

	rows.sort((a, b) => b.when - a.when);

	const header = `# Log\n\nChronological record of wiki growth and notable events.\nFormat: \`## [YYYY-MM-DD] kind | title\` — greppable with \`grep "^## \\[" log.md\`.\n\n`;
	return header + rows.map((r) => r.line).join('\n\n') + '\n';
}

function renderReadme(story: Story, entryCount: number, chapterCount: number): string {
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
- **Exported:** ${new Date().toLocaleString()}

Open this folder as an Obsidian vault for the best browsing experience. Cross-references use \`[[Entry Name]]\` syntax.

## Structure

- \`index.md\` — categorized list of all entries.
- \`log.md\` — chronological log of chapters, events, and entries.
- \`wiki/<type>/<entry>.md\` — one file per lorebook entry.
- \`chapters/<n>-<title>.md\` — one file per chapter.
`;
}

export async function downloadStoryAsWiki(storyId: string, worldEvents: Array<{ name: string; description: string; appliedAt?: number | null }> = []): Promise<void> {
	const data = await exportStory(storyId);
	const zip = new JSZip();

	// README
	zip.file('README.md', renderReadme(data.story, data.lorebookEntries.length, data.chapters.length));

	// Index
	zip.file('index.md', renderIndexMarkdown(data.lorebookEntries, data.chapters));

	// Log
	zip.file('log.md', renderLogMarkdown(data.lorebookEntries, data.chapters, worldEvents));

	// Per-entry pages
	for (const e of data.lorebookEntries) {
		zip.file(entryRelPath(e), renderEntryMarkdown(e, data.lorebookEntries));
	}

	// Per-chapter pages
	for (const ch of data.chapters) {
		zip.file(`chapters/${chapterFilename(ch)}`, renderChapterMarkdown(ch, data.lorebookEntries));
	}

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
