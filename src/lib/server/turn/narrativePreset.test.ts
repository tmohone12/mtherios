import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveStoryPromptPack, ONBOARDING_GENRE_PROMPT_PACKS } from '$lib/components/wizard/storyPromptPacks';
import { applyNarrativePromptOverride, GM_NPC_AGENCY_BLOCK, GM_TURN_BOUNDARY_BLOCK, GM_TURN_WORKFLOW_BLOCK } from '$lib/services/ai/context/gmAuthority';
import { buildEconomyScaleBlock, buildWorldScaleBlock } from '$lib/services/ai/context/economyScale';
import { promptPresetDocumentSchema } from '$lib/contracts/promptPresets';
import {
	BUILT_IN_NARRATIVE_PRESET,
	CONTEXT_PRIORITY_BLOCK,
	FEUDAL_PROMPT_PACK_ID,
	ROLEPLAY_AUTHORITY_BLOCK,
	compileNarrativePreset,
	migratedOverridePresetDocument,
	resolveServerStoryPromptPack,
	type NarrativePresetStory,
} from './narrativePreset';

/** Frozen copy of buildServerNarrativeSystemPrompt at 6c2323d, before presets. */
function legacyNarrativeSystemPrompt(story: NarrativePresetStory): string {
	const headerAlreadyContainsPromptPack = (header: string, promptPack: ReturnType<typeof resolveStoryPromptPack>) => {
		const normalized = header.toLowerCase();
		return normalized.includes(`gm prompt pack: ${promptPack.label.toLowerCase()}`)
			|| normalized.includes(promptPack.gmPromptPack.slice(0, 80).toLowerCase());
	};
	const storyHeader = story.headerPrompt?.trim();
	const promptPack = resolveServerStoryPromptPack(story);
	const isFeudalPromptPack = promptPack.id === FEUDAL_PROMPT_PACK_ID;
	const genrePromptPack = storyHeader && headerAlreadyContainsPromptPack(storyHeader, promptPack)
		? '' : `GM GENRE/PRESET PROMPT PACK: ${promptPack.label}\n${promptPack.gmPromptPack}`;
	return [
		ROLEPLAY_AUTHORITY_BLOCK,
		CONTEXT_PRIORITY_BLOCK,
		storyHeader ? `Story-specific preamble:\n${storyHeader}` : '',
		genrePromptPack,
		'You are the server-side GameMaster agent. Run the world and NPCs; render the turn in-world.',
		'Keep prose concrete and clear; show consequences and room for the player to act.',
		'Use hybrid POV: third-person limited for NPCs, world, and environment; second-person "you" only for direct sensory experience aimed at the player character. Never write the player character\'s actions, dialogue, decisions, thoughts, feelings, or internal monologue.',
		'Start each complete turn with exactly one header line: [ 🕰️ Time HH:MM | 🗓️ Day, Month DD, Year | 📍 Location - Specific Area | [Weather] Weather, Temp ]. Use best-known canon and infer unknown time consistently. A server-appended post-roll continuation belongs to that turn and does not repeat the header.',
		'Stay in-world; do not explain craft choices.',
		'Adjudicate the immediate player attempt against established canon, show consequences, and keep the player able to act next.',
		'For travel, repairs, waiting, and off-screen reports, stop at the next actionable scene boundary. Do not roll weeks, multiple POVs, and arrival into one response unless explicitly asked.',
		'Do not append ending choices, numbered options, menus, "What do you do?", or OOC prompts. End on an observable in-world situation with room for the player to act.',
		GM_TURN_WORKFLOW_BLOCK,
		GM_TURN_BOUNDARY_BLOCK,
		'NPC knowledge is limited by senses, access, intelligence, rumor delay, and what they personally learned. They cannot see through doors, know private scenes, or instantly learn distant events.',
		GM_NPC_AGENCY_BLOCK,
		'Narrate from GM truth; present NPCs need a belief or scene source before acting on secrets.',
		isFeudalPromptPack ? buildEconomyScaleBlock('Economy scale') : '',
		isFeudalPromptPack ? buildWorldScaleBlock('World scale') : '',
		'D&D-style d20 checks: for meaningful uncertainty with consequential success and failure, end before the outcome at {{roll:1d20:15:CHA:Intimidate the guard}}. DC is digits only: 10 easy/15 moderate/20 hard/25 very hard. For a recognized ability or skill, write bare 1d20; the server applies the player sheet modifier. The server rolls and resumes narration in the same turn. Never roll trivial, impossible, or settled actions.',
	].filter(Boolean).join('\n\n');
}

const story = (overrides: Partial<NarrativePresetStory> = {}): NarrativePresetStory =>
	({ headerPrompt: null, metadata: {}, settings: {}, genre: null, title: 'The Veil', ...overrides });

describe('built-in narrative preset', () => {
	const feudal = ONBOARDING_GENRE_PROMPT_PACKS.find(pack => pack.id === FEUDAL_PROMPT_PACK_ID)!;
	const cases: Array<[string, NarrativePresetStory]> = [
		['no header, neutral pack', story()],
		['a preamble with {{story.title}} text inside it', story({ headerPrompt: '  Keep {{story.title}} literal. Winter is coming.  ' })],
		...ONBOARDING_GENRE_PROMPT_PACKS.map(pack => [`pack ${pack.id}`, story({ settings: { promptPackId: pack.id } })] as [string, NarrativePresetStory]),
		['feudal pack already named in the header', story({ headerPrompt: `GM PROMPT PACK: ${feudal.label}\nHouse rules.`, settings: { promptPackId: feudal.id } })],
		['legacy metadata pack and narrator style', story({ metadata: { activePromptPackId: feudal.id, activeNarratorStyle: 'gritty' }, genre: 'Fantasy' })],
	];
	it.each(cases)('reproduces the pre-preset narrator instructions exactly: %s', (_label, value) => {
		expect(compileNarrativePreset(BUILT_IN_NARRATIVE_PRESET, value).system).toBe(legacyNarrativeSystemPrompt(value));
	});

	it('reproduces a migrated global override exactly, including literal braces', () => {
		const override = 'You are a terse narrator. End rolls with {{roll:1d20:12:DEX:Climb}} and never {{story.title}}.';
		const compiled = compileNarrativePreset(migratedOverridePresetDocument(`  ${override}\n`), story({ headerPrompt: 'Ignored by the old override path.' }));
		expect(compiled.system).toBe(applyNarrativePromptOverride('ignored built-in prompt', `  ${override}\n`));
	});

	it('matches the revision stored by migration 0055; changing the built-in needs a new revision', () => {
		const migration = fs.readFileSync('drizzle/0055_prompt_presets.sql', 'utf8');
		const stored = JSON.parse(migration.split('$preset$')[1]);
		expect(promptPresetDocumentSchema.parse(stored)).toEqual(BUILT_IN_NARRATIVE_PRESET);
	});

	it('reports section tokens and omissions without reading storage', () => {
		const compiled = compileNarrativePreset(BUILT_IN_NARRATIVE_PRESET, story());
		expect(compiled.sections.find(section => section.id === 'story-preamble')).toMatchObject({ included: false, omittedReason: 'empty', variables: ['story.preamble'] });
		expect(compiled.sections.find(section => section.id === 'economy-scale')).toMatchObject({ included: false, omittedReason: 'empty', source: 'engine' });
		expect(compiled.sections.filter(section => section.included).every(section => section.tokens > 0)).toBe(true);
	});
});

describe('preset document validation', () => {
	const withSections = (sections: unknown[]) => promptPresetDocumentSchema.safeParse({ schemaVersion: 1, sections });
	it('rejects unknown variables and missing engine contracts', () => {
		const result = withSections([{ kind: 'text', id: 'style', label: 'Style', template: 'Hello {{player.secret}}' }]);
		expect(result.success).toBe(false);
		const messages = result.success ? [] : result.error.issues.map(issue => issue.message).join('\n');
		expect(messages).toContain('Unknown variable {{player.secret}}');
		expect(messages).toContain('"turnWorkflow" is required');
		expect(messages).toContain('authority block');
	});
	it('rejects disabling a required engine block but allows disabling style sections', () => {
		const sections = BUILT_IN_NARRATIVE_PRESET.sections.map(section => section.id === 'turn-boundary' || section.id === 'prose' ? { ...section, enabled: false } : section);
		const result = withSections(sections);
		expect(result.success).toBe(false);
		expect(withSections(BUILT_IN_NARRATIVE_PRESET.sections.map(section => section.id === 'prose' ? { ...section, enabled: false } : section)).success).toBe(true);
	});
});
