import fs from 'node:fs/promises';
import path from 'node:path';

export const CHARACTER_PROJECTION_SCHEMA_VERSION = 1;

const HUMAN_EDITS_START = '<!-- character-human-edits:start -->';
const HUMAN_EDITS_END = '<!-- character-human-edits:end -->';

export interface CharacterProjectionInput {
	id: string;
	canonicalName: string;
	aliases: string[];
	status: string;
	firstSeenEntryId: string | null;
	sourceRefs: string[];
	confidence: number | null;
	description: string;
	currentStateLines?: string[];
	profileLines: string[];
	eventMemoryLines?: string[];
	relatedFactions: string[];
	relationships: string[];
	beliefsHeld: string[];
	beliefsAbout: string[];
	relatedEvents: string[];
	relatedMemory: string[];
	sourceEntryIds: string[];
	sourceEventIds: string[];
	canonState: unknown;
	schemaVersion?: number;
}

export interface ExistingCharacterProjectionRecord {
	relativePath: string;
	content: string;
}

export function characterProjectionPath(canonicalName: string, id: string): string {
	return `wiki/characters/${slug(canonicalName)}--${id.slice(0, 8)}.md`;
}

export function resolveCharacterProjectionPath(input: {
	canonicalName: string;
	id: string;
	existingPages?: Map<string, ExistingCharacterProjectionRecord>;
}): string {
	const existing = input.existingPages?.get(input.id);
	if (existing?.relativePath) return existing.relativePath;
	return characterProjectionPath(input.canonicalName, input.id);
}

export async function scanCharacterProjectionPages(vaultPath: string): Promise<Map<string, ExistingCharacterProjectionRecord>> {
	const characterDir = path.join(vaultPath, 'wiki', 'characters');
	try {
		const entries = await fs.readdir(characterDir, { withFileTypes: true });
		const records = new Map<string, ExistingCharacterProjectionRecord>();
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
			const absolutePath = path.join(characterDir, entry.name);
			const content = await fs.readFile(absolutePath, 'utf8');
			const id = extractFrontmatterId(content);
			if (!id) continue;
			records.set(id, {
				relativePath: toSlashPath(path.join('wiki', 'characters', entry.name)),
				content,
			});
		}
		return records;
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') return new Map();
		throw error;
	}
}

export function buildCharacterProjectionMarkdown(
	input: CharacterProjectionInput,
	existingContent: string | null = null,
): string {
	const schemaVersion = input.schemaVersion ?? CHARACTER_PROJECTION_SCHEMA_VERSION;
	const frontmatter: Record<string, unknown> = {
		id: input.id,
		type: 'character',
		canonical_name: input.canonicalName,
		aliases: [...input.aliases],
		status: input.status,
		first_seen_entry_id: input.firstSeenEntryId,
		source_refs: [...input.sourceRefs],
		confidence: input.confidence,
		schema_version: schemaVersion,
	};

	const sections: string[] = [
		`# ${input.canonicalName}`,
		'',
		'## Identity',
		`- Type: character`,
		`- Status: ${input.status}`,
		`- First seen entry: ${input.firstSeenEntryId ?? 'unknown'}`,
		input.aliases.length ? `- Aliases: ${input.aliases.join(', ')}` : '',
		'',
		'## Description',
		input.description || '_No description yet._',
		'',
		input.currentStateLines?.length ? `## Current State\n${input.currentStateLines.join('\n')}` : '',
		input.profileLines.length ? `## Profile\n${input.profileLines.join('\n')}` : '',
		input.eventMemoryLines?.length ? `## NPC Event Memory\n${input.eventMemoryLines.join('\n')}` : '',
		input.relatedFactions.length ? `## Factions\n${input.relatedFactions.join('\n')}` : '',
		input.relationships.length ? `## Relationships\n${input.relationships.join('\n')}` : '',
		input.beliefsHeld.length ? `## Beliefs Held\n${input.beliefsHeld.join('\n')}` : '',
		input.beliefsAbout.length ? `## Beliefs About This Entity\n${input.beliefsAbout.join('\n')}` : '',
		input.relatedEvents.length ? `## Related Events\n${input.relatedEvents.join('\n')}` : '',
		input.relatedMemory.length ? `## Related Memory\n${input.relatedMemory.join('\n')}` : '',
		'## Canon State',
		formatJsonBlock(input.canonState),
		'',
		...sourceLinks(input.sourceEntryIds, input.sourceEventIds),
		renderCharacterHumanEditsSection(existingContent),
	].filter(Boolean);

	return [
		renderFrontmatter(frontmatter),
		sections.join('\n'),
	].filter(Boolean).join('\n');
}

export function getStoredCharacterHumanEdits(existingContent: string | null): string {
	if (!existingContent) return '';
	const start = existingContent.indexOf(HUMAN_EDITS_START);
	const end = existingContent.indexOf(HUMAN_EDITS_END);
	if (start < 0 || end <= start) return '';
	return existingContent.slice(start + HUMAN_EDITS_START.length, end).trim();
}

function renderCharacterHumanEditsSection(existingContent: string | null): string {
	const preserved = getStoredCharacterHumanEdits(existingContent);
	const body = preserved || '_Add manual notes in this block and keep them between the marker comments._';
	return [
		'## Human Edits',
		HUMAN_EDITS_START,
		body,
		HUMAN_EDITS_END,
	].join('\n');
}

function sourceLinks(entryIds: string[], eventIds: string[]): string[] {
	const lines = [
		...entryIds.map((id) => `- source entry: ${id}`),
		...eventIds.map((id) => `- source event: ${id}`),
	];
	return lines.length ? ['## Sources', ...lines] : [];
}

function renderFrontmatter(record: Record<string, unknown>): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(record)) {
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	lines.push('---', '');
	return lines.join('\n');
}

function formatJsonBlock(value: unknown): string {
	return `\`\`\`json\n${JSON.stringify(value ?? {}, null, 2)}\n\`\`\``;
}

function extractFrontmatterId(markdown: string): string | null {
	const match = markdown.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;
	const lines = match[1].split('\n');
	for (const line of lines) {
		const parsed = line.match(/^\s*id:\s*(.+)\s*$/);
		if (!parsed) continue;
		const raw = parsed[1];
		try {
			const value = JSON.parse(raw);
			return typeof value === 'string' && value ? value : null;
		} catch {
			const trimmed = raw.replace(/^["']|["']$/g, '').trim();
			return trimmed ? trimmed : null;
		}
	}
	return null;
}

function slug(value: string): string {
	return String(value || 'untitled')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80) || 'untitled';
}

function toSlashPath(value: string): string {
	return value.replace(/\\/g, '/');
}
