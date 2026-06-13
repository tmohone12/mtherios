/**
 * Wiki import — inverse of wikiExport.ts.
 *
 * Reads a wiki .zip (markdown files with YAML-ish frontmatter, laid out the
 * way downloadStoryAsWiki writes them) and builds a fresh story from it:
 *   - README.md            → Story (new id)
 *   - wiki/<type>/*.md     → Entry[] (lorebook)
 *   - chapters/*.md        → Chapter[] (summaries; no StoryEntry rows)
 *   - agreements/**\/*.md  → Agreement[]
 *   - rumors.md            → RumorRecord[]
 *   - meters.md            → Meter[] (attached to the new Story)
 *
 * Obsidian [[wikilinks]] are stripped back to plain text on import — the
 * orchestrator re-renders them on demand via wikilinks.ts.
 */

import JSZip from 'jszip';
import { uuid } from '$lib/utils/uuid';
import {
	createStory,
	updateStory,
	putChapter,
	putLorebookEntry,
	putAgreement,
	bulkPutRumors,
} from './database';
import { importStoryBundleToBackend } from '$lib/services/backendImport';
import type { StoryExportData } from '$lib/services/storySync';
import type {
	Story,
	StoryMode,
	Entry,
	EntryState,
	EntryType,
	EntryCreator,
	Chapter,
	Agreement,
	AgreementCategory,
	AgreementStatus,
	AgreementSecrecy,
	RumorRecord,
	Meter,
	CharacterEntryState,
	FactionEntryState,
	LocationEntryState,
	ItemEntryState,
	ConceptEntryState,
	EventEntryState,
} from '$lib/types';

// ============================================================================
// Parsers — frontmatter, sections, wikilinks
// ============================================================================

interface ParsedMarkdown {
	fm: Record<string, unknown>;
	body: string;
}

/**
 * Parse the leading `---` frontmatter block our exporter emits. Values are
 * JSON-encoded (strings in quotes, arrays in brackets), so JSON.parse per
 * value is both correct and lenient enough.
 */
function parseFrontmatter(md: string): ParsedMarkdown {
	const fm: Record<string, unknown> = {};
	const trimmed = md.replace(/^﻿/, '');
	if (!trimmed.startsWith('---')) return { fm, body: trimmed };

	const lines = trimmed.split(/\r?\n/);
	if (lines[0]?.trim() !== '---') return { fm, body: trimmed };

	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '---') {
			end = i;
			break;
		}
	}
	if (end === -1) return { fm, body: trimmed };

	for (let i = 1; i < end; i++) {
		const line = lines[i];
		const colon = line.indexOf(':');
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const raw = line.slice(colon + 1).trim();
		if (!key) continue;
		if (raw === '') continue;
		// Try JSON parse — exporter always emits JSON-encoded values
		try {
			fm[key] = JSON.parse(raw);
		} catch {
			// Fallback: strip surrounding quotes if any
			fm[key] = raw.replace(/^["']|["']$/g, '');
		}
	}

	return { fm, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

/**
 * Remove a `## Heading` block and everything under it up to the next `## `
 * or EOF. Used to strip derived sections (Reputation, GM Notes) from entry
 * markdown before treating the remainder as the canonical description.
 */
function stripSection(body: string, heading: string): string {
	const re = new RegExp(`(^|\\n)##\\s+${heading}\\b[\\s\\S]*?(?=\\n##\\s|$)`, 'i');
	return body.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Strip Obsidian [[wikilinks]] back to plain display text. Handles both
 * [[Name]] and [[Target|Display]] forms.
 */
function stripObsidianLinks(text: string): string {
	return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, display) =>
		(display ?? target) as string,
	);
}

function coerceStr(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

function coerceStrArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === 'string');
}

function coerceNum(v: unknown, fallback: number): number {
	return typeof v === 'number' ? v : fallback;
}

// ============================================================================
// File-type parsers
// ============================================================================

function parseReadme(md: string): { title: string; description: string; genre: string | null; mode: StoryMode } {
	const { fm, body } = parseFrontmatter(md);
	const title = coerceStr(fm.title) || 'Imported Wiki';
	const genre = coerceStr(fm.genre) || null;
	const rawMode = coerceStr(fm.mode);
	const mode: StoryMode = rawMode === 'creative-writing' ? 'creative-writing' : 'adventure';
	// First non-empty paragraph of body that isn't a heading or bullet — best-effort description
	const firstPara = body
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.find((p) => p && !p.startsWith('#') && !p.startsWith('-') && !p.startsWith('*'));
	return { title, description: firstPara ?? '', genre, mode };
}

const VALID_ENTRY_TYPES: EntryType[] = ['character', 'location', 'item', 'faction', 'concept', 'event'];

function parseEntry(md: string, storyId: string): Entry | null {
	const { fm, body } = parseFrontmatter(md);
	const name = coerceStr(fm.name).trim();
	if (!name) return null;

	const rawType = coerceStr(fm.type);
	if (!VALID_ENTRY_TYPES.includes(rawType as EntryType)) return null;
	const type = rawType as EntryType;

	const aliases = coerceStrArray(fm.aliases);
	const keywords = coerceStrArray(fm.keywords);
	const injectionMode = coerceStr(fm.injection) as Entry['injection']['mode'];

	// Strip derived sections before treating body as description
	let description = body;
	description = stripSection(description, 'Reputation');
	description = stripSection(description, 'Source Trail');
	description = stripSection(description, 'GM Notes');
	// The exporter writes `# <name>` as the first heading; strip it.
	description = description.replace(/^#\s.+\n+/, '');
	description = stripObsidianLinks(description).trim();

	// Extract GM Notes as hiddenInfo if present
	const hiddenMatch = body.match(/(^|\n)##\s+GM Notes\s*\n([\s\S]*?)(?=\n##\s|$)/i);
	const hiddenInfo = hiddenMatch ? stripObsidianLinks(hiddenMatch[2]).trim() : null;

	// Type-specific state parsing from "## Character" / "## Faction" sections
	const state = parseEntryState(type, body);

	const now = Date.now();
	return {
		id: uuid(),
		storyId,
		name,
		type,
		description,
		hiddenInfo,
		aliases,
		state,
		adventureState: null,
		creativeState: null,
		injection: {
			mode: (['always', 'keyword', 'never'] as const).includes(injectionMode as any) ? injectionMode : 'keyword',
			keywords,
			priority: 0,
		},
		firstMentioned: null,
		lastMentioned: null,
		mentionCount: coerceNum(fm.mentions, 0),
		createdBy: 'import' as EntryCreator,
		createdAt: now,
		updatedAt: now,
		loreManagementBlacklisted: false,
		branchId: null,
	};
}

function parseEntryState(type: EntryType, body: string): EntryState {
	if (type === 'character') {
		const cs: CharacterEntryState = {
			type: 'character',
			isPresent: false,
			lastSeenLocation: null,
			currentDisposition: null,
			relationship: { level: 0, status: 'neutral', history: [] },
			knownFacts: [],
			revealedSecrets: [],
		};
		// Pull bullets from "## Character" section (**Bio.**, **Motivations.**, etc.)
		const section = body.match(/(^|\n)##\s+Character\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[2];
		if (section) {
			const bio = section.match(/\*\*Bio\.\*\*\s+([^\n]+)/)?.[1];
			if (bio) cs.bio = stripObsidianLinks(bio.trim());
			const motivations = section.match(/\*\*Motivations\.\*\*\s+([^\n]+)/)?.[1];
			if (motivations) cs.motivations = motivations.split(';').map((s) => s.trim()).filter(Boolean);
			const personality = section.match(/\*\*Personality\.\*\*\s+([^\n]+)/)?.[1];
			if (personality) cs.personality = stripObsidianLinks(personality.trim());
			const disposition = section.match(/\*\*Disposition\.\*\*\s+([^\n]+)/)?.[1];
			if (disposition) cs.currentDisposition = disposition.trim();
			const opinion = section.match(/\*\*Opinion of player\.\*\*\s+([^\n]+)/)?.[1];
			if (opinion) cs.personalOpinion = opinion.trim();
		}
		return cs;
	}

	if (type === 'faction') {
		const fs: FactionEntryState = {
			type: 'faction',
			playerStanding: 0,
			status: 'unknown',
			knownMembers: [],
		};
		const section = body.match(/(^|\n)##\s+Faction\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[2];
		if (section) {
			const standing = section.match(/\*\*Player standing\.\*\*\s+(-?\d+)/)?.[1];
			if (standing) fs.playerStanding = parseInt(standing, 10);
			const status = section.match(/\*\*Status\.\*\*\s+([^\n]+)/)?.[1]?.trim();
			if (status === 'allied' || status === 'neutral' || status === 'hostile' || status === 'unknown') {
				fs.status = status;
			}
			const disposition = section.match(/\*\*Disposition\.\*\*\s+([^\n]+)/)?.[1]?.trim();
			if (disposition === 'aggressive' || disposition === 'defensive' || disposition === 'scheming' || disposition === 'neutral' || disposition === 'desperate') {
				fs.disposition = disposition;
			}
			const territory = section.match(/\*\*Territory\.\*\*\s+([^\n]+)/)?.[1];
			if (territory) fs.territory = territory.split(',').map((s) => s.trim()).filter(Boolean);
		}
		return fs;
	}

	if (type === 'location') {
		const s: LocationEntryState = {
			type: 'location',
			isCurrentLocation: false,
			visitCount: 0,
			changes: [],
			presentCharacters: [],
			presentItems: [],
		};
		return s;
	}

	if (type === 'item') {
		const s: ItemEntryState = {
			type: 'item',
			inInventory: false,
			currentLocation: null,
			condition: null,
			uses: [],
		};
		return s;
	}

	if (type === 'concept') {
		const s: ConceptEntryState = {
			type: 'concept',
			revealed: false,
			comprehensionLevel: 'unknown',
			relatedEntries: [],
		};
		return s;
	}

	// event
	const s: EventEntryState = {
		type: 'event',
		occurred: false,
		occurredAt: null,
		witnesses: [],
		consequences: [],
	};
	return s;
}

function parseChapter(md: string, storyId: string): Chapter | null {
	const { fm, body } = parseFrontmatter(md);
	const number = coerceNum(fm.number, -1);
	if (number < 0) return null;

	// First `# Chapter N: Title` line strips out of summary
	const summary = stripObsidianLinks(body.replace(/^#\s.+\n+/, '')).trim();

	const now = Date.now();
	return {
		id: uuid(),
		storyId,
		number,
		title: coerceStr(fm.title) || null,
		startEntryId: '',
		endEntryId: '',
		entryCount: 0,
		summary,
		startTime: null,
		endTime: null,
		keywords: coerceStrArray(fm.keywords),
		characters: coerceStrArray(fm.characters),
		locations: coerceStrArray(fm.locations),
		plotThreads: [],
		emotionalTone: coerceStr(fm.emotionalTone) || null,
		branchId: null,
		createdAt: now,
	};
}

function parseAgreement(md: string, storyId: string): Agreement | null {
	const { fm, body } = parseFrontmatter(md);
	const rawCategory = coerceStr(fm.category);
	const validCategories: AgreementCategory[] = ['treaty', 'pact', 'alliance', 'oath', 'debt', 'promise', 'marriage', 'bond', 'contract', 'vassalage', 'bargain-with-entity'];
	if (!validCategories.includes(rawCategory as AgreementCategory)) return null;

	const rawStatus = coerceStr(fm.status);
	const validStatuses: AgreementStatus[] = ['active', 'broken', 'fulfilled', 'expired', 'contested'];
	const status: AgreementStatus = validStatuses.includes(rawStatus as AgreementStatus)
		? (rawStatus as AgreementStatus)
		: 'active';

	const rawSecrecy = coerceStr(fm.secrecy);
	const validSecrecy: AgreementSecrecy[] = ['public', 'known', 'secret'];
	const secrecy: AgreementSecrecy = validSecrecy.includes(rawSecrecy as AgreementSecrecy)
		? (rawSecrecy as AgreementSecrecy)
		: 'public';

	const parties = coerceStrArray(fm.parties);
	if (parties.length === 0) return null;

	// Pull body sections: ## Terms, ## Consequences
	const terms = body.match(/(^|\n)##\s+Terms\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[2]?.trim() ?? '';
	const consequencesSection = body.match(/(^|\n)##\s+Consequences\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[2] ?? '';
	const consequences = consequencesSection
		.split('\n')
		.map((l) => l.replace(/^[-*]\s+/, '').trim())
		.map(stripObsidianLinks)
		.filter(Boolean);

	const now = Date.now();
	return {
		id: uuid(),
		storyId,
		parties,
		category: rawCategory as AgreementCategory,
		terms: stripObsidianLinks(terms),
		status,
		secrecy,
		createdChapterNumber: typeof fm.createdChapter === 'number' ? fm.createdChapter : null,
		resolvedChapterNumber: typeof fm.resolvedChapter === 'number' ? fm.resolvedChapter : null,
		consequences,
		metadata: null,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * rumors.md has two relevant sections:
 *   ## Active rumors  → pipe-separated table rows: Spread | Truth | Origin | Related | Content
 *   ## Old rumors     → `- (status) content` bullet list
 */
function parseRumorsFile(md: string, storyId: string): RumorRecord[] {
	const { body } = parseFrontmatter(md);
	const rumors: RumorRecord[] = [];
	const now = Date.now();

	// Active table
	const activeSection = body.match(/(^|\n)##\s+Active rumors\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[2];
	if (activeSection) {
		const rows = activeSection.split('\n').filter((l) => l.trim().startsWith('|') && !l.includes('---'));
		for (const row of rows) {
			const cells = row.split('|').map((c) => c.trim()).filter((c) => c !== '');
			// Header row: "Spread | Truth | Origin | Related | Content"
			if (cells[0]?.toLowerCase() === 'spread') continue;
			if (cells.length < 5) continue;
			const [spread, truth, origin, related, content] = cells;
			const spreadRadius = (['local', 'regional', 'continental'] as const).includes(spread as any)
				? (spread as 'local' | 'regional' | 'continental')
				: 'regional';
			const truthMatch = truth.match(/\(([\d.]+)\)/);
			const truthfulness = truthMatch ? parseFloat(truthMatch[1]) : 0.5;
			const relatedFaction = related === '—' || related === '-' ? null : stripObsidianLinks(related);
			rumors.push({
				id: uuid(),
				storyId,
				content: stripObsidianLinks(content),
				truthfulness,
				originRegion: origin,
				spreadRadius,
				sourceType: 'imported',
				relatedFaction,
				chapterNumber: null,
				staleAfterChapters: 5,
				status: 'spreading',
				createdAt: now,
			});
		}
	}

	// Old (stale/debunked) bullets
	const oldSection = body.match(/(^|\n)##\s+Old rumors\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[2];
	if (oldSection) {
		for (const line of oldSection.split('\n')) {
			const m = line.match(/^-\s+\*\(([^)]+)\)\*\s+(.+)$/);
			if (!m) continue;
			const [, status, content] = m;
			rumors.push({
				id: uuid(),
				storyId,
				content: stripObsidianLinks(content),
				truthfulness: 0.3,
				originRegion: 'unknown',
				spreadRadius: 'regional',
				sourceType: 'imported',
				relatedFaction: null,
				chapterNumber: null,
				staleAfterChapters: 5,
				status: status === 'debunked' ? 'debunked' : 'stale',
				createdAt: now,
			});
		}
	}

	return rumors;
}

/**
 * meters.md has a markdown table: | Meter | Value | Max | Visible |
 */
function parseMetersFile(md: string): Meter[] {
	const { body } = parseFrontmatter(md);
	const meters: Meter[] = [];
	const rows = body.split('\n').filter((l) => l.trim().startsWith('|') && !l.includes('---'));
	for (const row of rows) {
		const cells = row.split('|').map((c) => c.trim()).filter((c) => c !== '');
		if (cells[0]?.toLowerCase() === 'meter') continue;
		if (cells.length < 4) continue;
		const [name, value, max, visible] = cells;
		const v = parseInt(value, 10);
		const mx = parseInt(max, 10);
		if (!name || isNaN(v) || isNaN(mx)) continue;
		meters.push({ name, value: v, max: mx, visible: visible.toLowerCase() === 'yes' });
	}
	return meters;
}

// ============================================================================
// Top-level importer
// ============================================================================

export interface WikiImportResult {
	storyId: string;
	counts: {
		entries: number;
		chapters: number;
		agreements: number;
		rumors: number;
		meters: number;
	};
}

/**
 * Read a wiki .zip and create a new story from its contents.
 * Returns the new story's id (caller typically navigates to it).
 */
export async function importStoryFromWiki(file: File): Promise<WikiImportResult> {
	const zip = await JSZip.loadAsync(file);

	// README — identifies the story
	const readmeFile = zip.file('README.md');
	if (!readmeFile) throw new Error('Not a wiki export — README.md missing.');
	const readmeText = await readmeFile.async('string');
	const storyMeta = parseReadme(readmeText);

	const now = Date.now();
	const storyId = uuid();

	// Meters (attached to Story)
	let meters: Meter[] = [];
	const metersFile = zip.file('meters.md');
	if (metersFile) {
		const text = await metersFile.async('string');
		meters = parseMetersFile(text);
	}

	const story: Story = {
		id: storyId,
		title: storyMeta.title,
		description: storyMeta.description || null,
		genre: storyMeta.genre,
		templateId: null,
		mode: storyMeta.mode,
		createdAt: now,
		updatedAt: now,
		settings: null,
		memoryConfig: null,
		retryState: null,
		styleReviewState: null,
		timeTracker: null,
		currentBranchId: null,
		currentBgImage: null,
		headerPrompt: null,
		playerReputation: null,
		playerLedger: null,
		lastWorldSimDay: null,
		compactedLore: null,
		compactedLoreHistory: null,
		meters: meters.length > 0 ? meters : null,
		serverStoryId: null,
		serverVersion: null,
		syncStatus: 'syncing',
	};
	await createStory(story);

	// Lorebook entries — wiki/<type>/*.md
	const lorebookEntries: Entry[] = [];
	const entryPaths = Object.keys(zip.files).filter(
		(p) => p.startsWith('wiki/') && p.endsWith('.md') && !zip.files[p].dir,
	);
	for (const path of entryPaths) {
		const text = await zip.files[path].async('string');
		const entry = parseEntry(text, storyId);
		if (!entry) continue;
		lorebookEntries.push(entry);
	}

	// Chapters — chapters/*.md
	const chapters: Chapter[] = [];
	const chapterPaths = Object.keys(zip.files).filter(
		(p) => p.startsWith('chapters/') && p.endsWith('.md') && !zip.files[p].dir,
	);
	for (const path of chapterPaths) {
		const text = await zip.files[path].async('string');
		const chapter = parseChapter(text, storyId);
		if (!chapter) continue;
		chapters.push(chapter);
	}

	// Agreements — agreements/<category>/*.md (index.md is the only non-agreement)
	const agreements: Agreement[] = [];
	const agreementPaths = Object.keys(zip.files).filter(
		(p) =>
			p.startsWith('agreements/') &&
			p.endsWith('.md') &&
			!p.endsWith('/index.md') &&
			!zip.files[p].dir,
	);
	for (const path of agreementPaths) {
		const text = await zip.files[path].async('string');
		const agreement = parseAgreement(text, storyId);
		if (!agreement) continue;
		agreements.push(agreement);
	}

	// Rumors — rumors.md
	let rumors: RumorRecord[] = [];
	const rumorsFile = zip.file('rumors.md');
	if (rumorsFile) {
		const text = await rumorsFile.async('string');
		rumors = parseRumorsFile(text, storyId);
	}

	const bundle: StoryExportData = {
		version: 1,
		exportedAt: now,
		story,
		storyEntries: [],
		characters: [],
		locations: [],
		items: [],
		storyBeats: [],
		chapters,
		lorebookEntries,
		arcs: [],
		agreements,
		rumors,
	};

	try {
		await importStoryBundleToBackend(bundle, storyId);
	} catch (error) {
		console.warn('[Wiki Import] Imported wiki remains local until backend is reachable:', error);
		await updateStory(storyId, { syncStatus: 'offline' });
	}

	let entryCount = 0;
	for (const entry of lorebookEntries) {
		try {
			await putLorebookEntry(entry);
			entryCount++;
		} catch (e) {
			console.warn(`[Wiki Import] Failed to write entry ${entry.name}:`, e);
		}
	}

	let chapterCount = 0;
	for (const chapter of chapters) {
		try {
			await putChapter(chapter);
			chapterCount++;
		} catch (e) {
			console.warn(`[Wiki Import] Failed to write chapter ${chapter.title ?? chapter.id}:`, e);
		}
	}

	let agreementCount = 0;
	for (const agreement of agreements) {
		try {
			await putAgreement(agreement);
			agreementCount++;
		} catch (e) {
			console.warn(`[Wiki Import] Failed to write agreement ${agreement.id}:`, e);
		}
	}

	let rumorCount = 0;
	try {
		await bulkPutRumors(rumors);
		rumorCount = rumors.length;
	} catch (e) {
		console.warn('[Wiki Import] Failed to write rumors:', e);
	}

	return {
		storyId,
		counts: {
			entries: entryCount,
			chapters: chapterCount,
			agreements: agreementCount,
			rumors: rumorCount,
			meters: meters.length,
		},
	};
}
