import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MtheriosAppConfig } from '$lib/server/app/config';

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock('$lib/server/db/client', () => ({ getDb: dbMocks.getDb }));

import { appendTurnEvidence, campaignVaultPath, rawTurnSourcePairError, readCampaignPage, renderTurnEvidenceMarkdown, writeCampaignPage } from './campaignVault';

const tempRoots: string[] = [];

function testConfig(root: string): MtheriosAppConfig {
	return {
		dataRoot: root,
		vaultRoot: path.join(root, 'vaults'),
		defaultVault: path.join(root, 'vaults', 'default'),
		allowExternalVaults: false,
		qdrantUrl: 'http://127.0.0.1:6333',
		qdrantCollection: 'mtherios_wiki',
		localKevEnabled: false, localEmbeddingsEnabled: false, ollamaUrl: 'http://127.0.0.1:11434',
		wikiEmbedProvider: 'openrouter',
		wikiEmbedModel: 'openai/text-embedding-3-small',
		wikiEmbedBaseUrl: 'https://openrouter.ai/api/v1',
		wikiEmbedApiKey: '',
		wikiAutoIndexStoryVaults: false,
		jobWorkerEnabled: true,
		chapterRunnerEnabled: false,
		chapterRunnerStoryId: '',
		jobWorkerScope: 'all',
		jobIntervalMs: 5000,
	};
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('campaign vault storage', () => {
	it('invalidates indexed raw turns when their canonical source pair was removed or changed', () => {
		const metadata = { clientTurnId: 'turn_1' };
		const validEntries = [
			{ id: 'entry_turn_1', type: 'user_action', content: 'I accept.', parentId: null, metadata: {} },
			{ id: 'narration_turn_1', type: 'narration', content: 'The emperor nods.', parentId: 'entry_turn_1', metadata: {} },
		];

		expect(rawTurnSourcePairError(metadata, validEntries)).toBeNull();
		expect(rawTurnSourcePairError(metadata, validEntries.slice(0, 1))).toBe('source_entries_missing');
		expect(rawTurnSourcePairError(metadata, [validEntries[0], { ...validEntries[1], parentId: 'entry_other' }]))
			.toBe('source_entry_pair_changed');
		expect(rawTurnSourcePairError(metadata, [
			validEntries[0],
			{ ...validEntries[1], metadata: { nonCanon: true } },
		])).toBe('source_entries_non_canon');
	});

	it('invalidates raw turns when canonical content or the indexed file content changes', () => {
		const playerText = 'I accept the emperor\'s offer.';
		const narration = 'The emperor offers his daughter and the court falls silent.';
		const rawContent = renderTurnEvidenceMarkdown({
			story: { id: 'story_veil', title: 'Veil', serverVersion: 12 },
			clientTurnId: 'turn_offer',
			position: 24,
			playerText,
			narration,
		});
		const hash = (value: string) => createHash('sha256').update(value).digest('hex');
		const metadata = {
			clientTurnId: 'turn_offer',
			playerContentHash: hash(playerText),
			narrationContentHash: hash(narration),
		};
		const entries = [
			{ id: 'entry_turn_offer', type: 'user_action', content: playerText, parentId: null, metadata: {} },
			{ id: 'narration_turn_offer', type: 'narration', content: narration, parentId: 'entry_turn_offer', metadata: {} },
		];

		expect(rawTurnSourcePairError(metadata, entries, {
			rawContent,
			indexedContentHash: hash(rawContent),
		})).toBeNull();
		expect(rawTurnSourcePairError(metadata, [
			entries[0],
			{ ...entries[1], content: 'Poisoned replacement lore.' },
		])).toBe('source_entry_content_changed');
		expect(rawTurnSourcePairError(metadata, entries, {
			rawContent: `${rawContent}\npoisoned`,
			indexedContentHash: hash(rawContent),
		})).toBe('raw_turn_file_content_changed');
	});

	it('validates legacy raw pages against their rendered canonical sections when source hashes are absent', () => {
		const playerText = 'I ask for the terms.';
		const narration = 'The emperor names his daughter as the offered bride.';
		const rawContent = renderTurnEvidenceMarkdown({
			story: { id: 'story_veil', title: 'Veil', serverVersion: 8 },
			clientTurnId: 'legacy_turn',
			position: 18,
			playerText,
			narration,
		});
		const entries = [
			{ id: 'entry_legacy_turn', type: 'user_action', content: playerText, parentId: null, metadata: {} },
			{ id: 'narration_legacy_turn', type: 'narration', content: narration, parentId: 'entry_legacy_turn', metadata: {} },
		];

		expect(rawTurnSourcePairError({ clientTurnId: 'legacy_turn' }, entries, { rawContent })).toBeNull();
		expect(rawTurnSourcePairError({ clientTurnId: 'legacy_turn' }, [
			entries[0],
			{ ...entries[1], content: 'Scrambled replacement lore.' },
		], { rawContent })).toBe('source_entry_content_changed');
	});

	it('refuses orphan raw evidence left behind by a story replacement', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'mtherios-campaign-'));
		tempRoots.push(root);
		const config = testConfig(root);
		const result = await appendTurnEvidence({
			story: { id: 'story_replaced', title: 'Replaced', serverVersion: 9 },
			clientTurnId: 'deleted_turn',
			position: 15,
			playerText: 'Discarded action.',
			narration: 'Discarded narration.',
		}, { config, indexFile: async () => undefined });
		const limit = vi.fn().mockResolvedValue([]);
		const where = vi.fn(() => ({ limit }));
		const from = vi.fn(() => ({ where }));
		dbMocks.getDb.mockReturnValue({ select: vi.fn(() => ({ from })) });

		await expect(readCampaignPage({
			storyId: 'story_replaced',
			kind: 'raw_turn',
			relativePath: result.files[0].relativePath,
			config,
		})).rejects.toThrow('not part of the current story');
	});

	it('appends bounded turn evidence markdown and indexes the file metadata', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'mtherios-campaign-'));
		tempRoots.push(root);
		const config = testConfig(root);
		const indexed: Array<{ relativePath: string; kind: string; contentHash: string; byteLength: number; serverVersion: number; metadata?: Record<string, unknown> }> = [];

		const result = await appendTurnEvidence({
			story: {
				id: 'story_alpha',
				title: 'A Very Long Campaign',
				serverVersion: 42,
			},
			clientTurnId: 'client_turn_1',
			position: 128,
			playerText: 'I ask the queen what her spies learned.',
			narration: 'The queen lowers her voice and names three houses.',
			eventIds: ['event_spies'],
			statePatchIds: ['patch_spies'],
			retrievedMemoryIds: ['mem_spies'],
			warnings: ['minor warning'],
			generationTimings: [{ operation: 'turn.narration', serviceId: 'narrative', durationMs: 321 }],
		}, {
			config,
			indexFile: async (record) => {
				indexed.push(record);
			},
		});

		const vaultRoot = campaignVaultPath('story_alpha', config);
		const manifest = JSON.parse(await readFile(path.join(vaultRoot, '.mtherios', 'campaign.json'), 'utf8'));
		const markdown = await readFile(result.files[0].absolutePath, 'utf8');
		const fileStat = await stat(result.files[0].absolutePath);

		expect(result.files).toHaveLength(1);
		expect(result.files[0].relativePath).toBe('raw/turns/000128-client-turn-1.md');
		expect(fileStat.size).toBeGreaterThan(0);
		expect(manifest.storyId).toBe('story_alpha');
		expect(manifest.layout).toBe('hybrid-markdown-db');
		expect(markdown).toContain('## Player Action');
		expect(markdown).toContain('I ask the queen');
		expect(markdown).toContain('## Narration');
		expect(markdown).toContain('three houses');
		expect(markdown).toContain('retrievedMemoryIds');
		expect(markdown.length).toBeLessThan(4000);
		expect(indexed).toEqual([
			expect.objectContaining({
				relativePath: 'raw/turns/000128-client-turn-1.md',
				kind: 'raw_turn',
				serverVersion: 42,
				byteLength: Buffer.byteLength(markdown, 'utf8'),
				contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
				metadata: expect.objectContaining({
					playerContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
					narrationContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
			}),
		]);

		const rawPage = await readCampaignPage({
			storyId: 'story_alpha',
			kind: 'raw_turn',
			relativePath: result.files[0].relativePath,
			config,
			requireIndexedRawTurn: false,
		});
		expect(rawPage.kind).toBe('raw_turn');
		expect(rawPage.relativePath).toBe('raw/turns/000128-client-turn-1.md');
		expect(rawPage.content).toBe(markdown);
		expect(rawPage.contentHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it('writes maintained derived character pages with portrayal metadata and indexes the page hash', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'mtherios-campaign-'));
		tempRoots.push(root);
		const config = testConfig(root);
		const indexed: Array<{ relativePath: string; kind: string; contentHash: string; byteLength: number; metadata?: Record<string, unknown> }> = [];

		const result = await writeCampaignPage({
			story: {
				id: 'story_alpha',
				title: 'A Very Long Campaign',
				serverVersion: 43,
			},
			kind: 'character_page',
			name: 'Mira of the Harbor',
			title: 'Mira of the Harbor',
			tags: ['npc', 'harbor-court'],
			entityIds: ['npc_mira'],
			sourceEventIds: ['event_marriage_alliance'],
			metadata: {
				appearance: 'Salt-dark hair, pearl pins, and a knife-thin smile.',
				personalityDescriptors: ['calculating', 'patient', 'status-conscious'],
			},
			body: [
				'## Looks',
				'Salt-dark hair, pearl pins, and a knife-thin smile.',
				'',
				'## Personality',
				'Calculating, patient, and status-conscious.',
				'',
				'## Event Memory',
				'- [[event_marriage_alliance]] changed her prospects.',
			].join('\n'),
		}, {
			config,
			indexFile: async (record) => {
				indexed.push(record);
			},
		});

		expect(result.files).toHaveLength(1);
		expect(result.files[0].relativePath).toBe('characters/mira-of-the-harbor.md');

		const page = await readCampaignPage({
			storyId: 'story_alpha',
			kind: 'character_page',
			name: 'Mira of the Harbor',
			config,
		});

		expect(page.content).toContain('type: "character_page"');
		expect(page.content).toContain('tags:');
		expect(page.content).toContain('## Looks');
		expect(page.content).toContain('## Personality');
		expect(page.content).toContain('[[event_marriage_alliance]]');
		expect(indexed).toEqual([
			expect.objectContaining({
				relativePath: 'characters/mira-of-the-harbor.md',
				kind: 'character_page',
				contentHash: page.contentHash,
				byteLength: Buffer.byteLength(page.content, 'utf8'),
				metadata: expect.objectContaining({
					name: 'Mira of the Harbor',
					entityIds: ['npc_mira'],
					sourceEventIds: ['event_marriage_alliance'],
				}),
			}),
		]);
	});

	it('can return an empty optional rules page when a vault page is not created yet', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'mtherios-campaign-'));
		tempRoots.push(root);
		const config = testConfig(root);

		const page = await readCampaignPage({
			storyId: 'story_alpha',
			kind: 'rules_page',
			relativePath: 'rules/default.md',
			missingOk: true,
			config,
		});

		expect(page).toEqual({
			storyId: 'story_alpha',
			kind: 'rules_page',
			relativePath: 'rules/default.md',
			content: '',
			contentHash: '',
			updatedAt: null,
			byteLength: 0,
			missing: true,
		});
	});
});
