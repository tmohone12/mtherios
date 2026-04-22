/**
 * Wiki-style cross-references for lorebook entries.
 *
 * Detects bare-name mentions of other entries inside markdown text and
 * rewrites them as links to #wiki:<entryId> before handing off to marked.
 * Doing the rewrite in source markdown (not post-render HTML) lets marked
 * own all escaping and avoids double-parsing rendered output.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Entry } from '$lib/types';

export const WIKI_HREF_PREFIX = '#wiki:';

interface PreprocessResult {
	processed: string;
	mentions: Set<string>;
}

/**
 * Replaces case-insensitive whole-word matches of entry names/aliases with
 * markdown links to #wiki:<id>. Skips text already inside a markdown link
 * so we don't produce nested anchors.
 */
function preprocessWikilinks(text: string, entries: Entry[], excludeId?: string): PreprocessResult {
	const mentions = new Set<string>();
	if (!text || entries.length === 0) return { processed: text, mentions };

	type Needle = { needle: string; entryId: string };
	const needles: Needle[] = [];
	for (const e of entries) {
		if (e.id === excludeId) continue;
		const name = e.name?.trim();
		if (!name) continue;
		needles.push({ needle: name, entryId: e.id });
		if (e.aliases) {
			for (const alias of e.aliases) {
				const a = alias?.trim();
				if (a) needles.push({ needle: a, entryId: e.id });
			}
		}
	}
	if (needles.length === 0) return { processed: text, mentions };
	// Longest first so "Lord Stark" wins over "Stark".
	needles.sort((a, b) => b.needle.length - a.needle.length);

	// Split on existing markdown link syntax so we don't rewrite inside one.
	const linkRe = /\[[^\]]*\]\([^)]*\)/g;
	const segments: { text: string; isLink: boolean }[] = [];
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(text)) !== null) {
		if (m.index > lastIdx) {
			segments.push({ text: text.slice(lastIdx, m.index), isLink: false });
		}
		segments.push({ text: m[0], isLink: true });
		lastIdx = m.index + m[0].length;
	}
	if (lastIdx < text.length) {
		segments.push({ text: text.slice(lastIdx), isLink: false });
	}

	for (let i = 0; i < segments.length; i++) {
		if (segments[i].isLink) continue;
		let seg = segments[i].text;
		for (const { needle, entryId } of needles) {
			const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			// Word boundaries on each side; case-insensitive.
			const re = new RegExp(`(?<![\\w])(${escaped})(?![\\w])`, 'gi');
			seg = seg.replace(re, (matched) => {
				mentions.add(entryId);
				return `[${matched}](${WIKI_HREF_PREFIX}${entryId})`;
			});
		}
		segments[i].text = seg;
	}

	return { processed: segments.map((s) => s.text).join(''), mentions };
}

export interface RenderedWiki {
	html: string;
	mentions: Set<string>;
}

/**
 * Render markdown text with wikilinks. Returns HTML safe to drop into
 * `{@html ...}` plus the set of entry IDs referenced (for outbound display).
 *
 * The HTML is sanitized with DOMPurify to strip any <script>/<iframe>/
 * onerror=... injected via user-authored entry descriptions (classifier
 * output, SillyTavern imports, and manual edits are all untrusted).
 */
export function renderWiki(text: string, entries: Entry[], excludeId?: string): RenderedWiki {
	if (!text?.trim()) return { html: '', mentions: new Set() };
	const { processed, mentions } = preprocessWikilinks(text, entries, excludeId);
	const rawHtml = marked.parse(processed, { async: false }) as string;
	const html = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target'] });
	return { html, mentions };
}

/**
 * Inbound: which other entries' description / hiddenInfo references this one
 * by name or alias?
 */
export function findInboundMentions(target: Entry, allEntries: Entry[]): Entry[] {
	const raw = [target.name, ...(target.aliases ?? [])].filter((n): n is string => !!n?.trim());
	if (raw.length === 0) return [];
	const escaped = raw.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	const re = new RegExp(`(?<![\\w])(${escaped.join('|')})(?![\\w])`, 'i');
	const inbound: Entry[] = [];
	for (const e of allEntries) {
		if (e.id === target.id) continue;
		const hay = `${e.description ?? ''}\n${e.hiddenInfo ?? ''}`;
		if (re.test(hay)) inbound.push(e);
	}
	return inbound;
}

/**
 * Parse a clicked link's href. Returns the entry ID if it's a wiki link,
 * or null otherwise.
 */
export function parseWikiHref(href: string | null): string | null {
	if (!href) return null;
	if (!href.startsWith(WIKI_HREF_PREFIX)) return null;
	return href.slice(WIKI_HREF_PREFIX.length) || null;
}

/**
 * Produce Obsidian-style [[Entry Name]] markdown for export. Used by the
 * Phase 4 wiki export so the resulting vault opens cleanly.
 */
export function toObsidianLinks(text: string, entries: Entry[], excludeId?: string): string {
	if (!text || entries.length === 0) return text;
	const needles: { needle: string; targetName: string }[] = [];
	for (const e of entries) {
		if (e.id === excludeId) continue;
		const name = e.name?.trim();
		if (!name) continue;
		needles.push({ needle: name, targetName: name });
		if (e.aliases) {
			for (const alias of e.aliases) {
				const a = alias?.trim();
				if (a) needles.push({ needle: a, targetName: name });
			}
		}
	}
	if (needles.length === 0) return text;
	needles.sort((a, b) => b.needle.length - a.needle.length);

	const linkRe = /\[[^\]]*\]\([^)]*\)/g;
	const segments: { text: string; isLink: boolean }[] = [];
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(text)) !== null) {
		if (m.index > lastIdx) segments.push({ text: text.slice(lastIdx, m.index), isLink: false });
		segments.push({ text: m[0], isLink: true });
		lastIdx = m.index + m[0].length;
	}
	if (lastIdx < text.length) segments.push({ text: text.slice(lastIdx), isLink: false });

	for (let i = 0; i < segments.length; i++) {
		if (segments[i].isLink) continue;
		let seg = segments[i].text;
		for (const { needle, targetName } of needles) {
			const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const re = new RegExp(`(?<![\\w])(${escaped})(?![\\w])`, 'gi');
			seg = seg.replace(re, (matched) =>
				matched.toLowerCase() === targetName.toLowerCase()
					? `[[${targetName}]]`
					: `[[${targetName}|${matched}]]`,
			);
		}
		segments[i].text = seg;
	}
	return segments.map((s) => s.text).join('');
}
