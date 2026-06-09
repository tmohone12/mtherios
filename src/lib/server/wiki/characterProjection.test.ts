import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CHARACTER_PROJECTION_SCHEMA_VERSION,
	buildCharacterProjectionMarkdown,
	getStoredCharacterHumanEdits,
	resolveCharacterProjectionPath,
	scanCharacterProjectionPages,
} from './characterProjection';

const tempRoots: string[] = [];

const sampleInput = {
	id: 'char_01JZ1234567890',
	canonicalName: 'Mira Vey',
	aliases: ['Mira', 'the glass-market smuggler'],
	status: 'active',
	firstSeenEntryId: 'entry_01JZ',
	sourceRefs: ['entry_01JZ', 'event_01JZ'],
	confidence: 0.92,
	description: 'Mira Vey keeps the harbor moving by moving information and metal scraps.',
	profileLines: ['- Temper: guarded', '- Disposition: opportunistic and practical'],
	relatedFactions: ['- Linked to [[Harbor Compact]]'],
	relationships: ['- Mira trusts [[Korrin Vale]]'],
	beliefsHeld: ['- The coast guard is underfunded.'],
	beliefsAbout: ['- Rivals usually overpay first and pay less later.'],
	relatedEvents: ['- [[Event: Dockside Accord|Dockside Accord]] (agreement, public)'],
	relatedMemory: ['- [[Memory: Harbor Nightfall|Harbor Nightfall]] (incident, importance 7)'],
	sourceEntryIds: ['entry_01JZ'],
	sourceEventIds: ['event_01JZ'],
	canonState: { knownFor: 'smuggling', risk: 'high' },
};

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('character projection markdown service', () => {
	it('generates required frontmatter fields from canonical inputs', () => {
		const markdown = buildCharacterProjectionMarkdown(sampleInput);
		const frontmatter = parseFrontmatter(markdown);

		expect(frontmatter).toEqual({
			id: sampleInput.id,
			type: 'character',
			canonical_name: sampleInput.canonicalName,
			aliases: sampleInput.aliases,
			status: sampleInput.status,
			first_seen_entry_id: sampleInput.firstSeenEntryId,
			source_refs: sampleInput.sourceRefs,
			confidence: sampleInput.confidence,
			schema_version: CHARACTER_PROJECTION_SCHEMA_VERSION,
		});
		expect(markdown).toContain('## Human Edits');
	});

	it('does not duplicate character pages by stable ID and preserves human edits during regeneration', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'mtherios-char-proj-'));
		tempRoots.push(root);
		const vaultPath = path.join(root, 'story');
		const oldRelPath = 'wiki/characters/legacy-mira--char_01JZ1234567890.md';
		const oldAbsPath = path.join(vaultPath, oldRelPath);
		const preservedHumanText = 'My secret notes about the harbor route.';
		const existing = [
			'---',
			`id: "${sampleInput.id}"`,
			'type: "character"',
			'canonical_name: "Mira Vey"',
			'aliases: ["Mira"]',
			'status: "active"',
			'first_seen_entry_id: "entry_01JZ"',
			'source_refs: ["entry_01JZ"]',
			'confidence: 0.92',
			`schema_version: ${CHARACTER_PROJECTION_SCHEMA_VERSION}`,
			'---',
			'',
			'# Mira Vey',
			'',
			'## Human Edits',
			'<!-- character-human-edits:start -->',
			preservedHumanText,
			'<!-- character-human-edits:end -->',
		].join('\n');

		await mkdir(path.dirname(oldAbsPath), { recursive: true });
		await writeFile(oldAbsPath, existing, 'utf8');

	const scanned = await scanCharacterProjectionPages(vaultPath);
		const expected = scanned.get(sampleInput.id);
		expect(expected).toBeDefined();
		if (!expected) return;
		const projectedPath = resolveCharacterProjectionPath({
			canonicalName: 'Mira Vey (renamed)',
			id: sampleInput.id,
			existingPages: scanned,
		});

		expect(projectedPath).toBe(oldRelPath);
		expect(expected.relativePath).toBe(oldRelPath);
		await expect(readFile(oldAbsPath, 'utf8').then((value) => getStoredCharacterHumanEdits(value))).resolves.toBe(preservedHumanText);
		expect(
			buildCharacterProjectionMarkdown(sampleInput, expected.content).includes(preservedHumanText),
		).toBe(true);
	});
});

function parseFrontmatter(markdown: string): Record<string, unknown> {
	const match = markdown.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	const payload: Record<string, unknown> = {};
	const lines = match[1].split('\n');
	for (const line of lines) {
		const parsed = line.match(/^\s*([A-Za-z0-9_]+):\s*(.+)\s*$/);
		if (!parsed) continue;
		try {
			payload[parsed[1]] = JSON.parse(parsed[2]);
		} catch {
			payload[parsed[1]] = parsed[2].trim().replace(/^"|"$/g, '');
		}
	}
	return payload;
}
