import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('WorldExplorer control-surface boundary', () => {
	it('does not call legacy JSON APIs directly from the Svelte control surface', () => {
		const source = readFileSync(resolve('src/lib/components/database/WorldExplorer.svelte'), 'utf8');

		expect(source).not.toMatch(/\/api\/stories(?!.*story\.export)/);
		expect(source).not.toContain('/api/settings/llm');
		expect(source).not.toContain('/api/jobs');
		expect(source).not.toContain('/api/records');
		expect(source).toContain('/api/engine/command');
	});

	it('exposes only lorebook character-state fields and draft-first context updates', () => {
		const source = readFileSync(resolve('src/lib/components/database/WorldExplorer.svelte'), 'utf8');

		expect(source).toContain('Character State');
		for (const label of ['Bio', 'Appearance', 'Personality', 'Rank', 'Disposition', 'Affinity', 'Goals', 'Faction Tags', 'Known Facts']) {
			expect(source).toContain(`<span>${label}</span>`);
		}
		expect(source).toContain('factionTags');
		expect(source).toContain('AI Refinement');
		for (const label of ['Voice', 'Role', 'Species', 'Personal Opinion', 'Mannerisms', 'Conversation Topics', 'Revealed Secrets', 'Visibility Note', 'Player Prompt']) {
			expect(source).not.toContain(`<span>${label}</span>`);
		}
		expect(source).not.toContain('accept="image/*"');
		expect(source).not.toContain('photoUrl');
		expect(source).not.toContain('promptTemplate');
		expect(source).not.toContain('eventMemory');
		expect(source).not.toContain('currentLocation');
		expect(source).not.toContain('currentAction');
		expect(source).not.toContain('emotionalState');
		expect(source).toContain('world.character.draftUpdate');
		expect(source).toContain("body.status === 'skipped'");
		expect(source).toContain('No supported character changes found.');
	});

	it('exposes typed LLM service controls through the engine boundary', () => {
		const source = readFileSync(resolve('src/lib/components/database/WorldExplorer.svelte'), 'utf8');

		expect(source).toContain('LLM Service Settings');
		expect(source).toContain('updateLlmSetting');
		expect(source).toContain('serviceId');
		expect(source).toContain('providerType');
		expect(source).toContain('maxTokens');
		expect(source).toContain('systemPromptOverride');
		expect(source).toContain('settings.llm.save');
		expect(source).not.toContain('/api/settings/llm');
	});

	it('can create a terminal database through the engine boundary', () => {
		const source = readFileSync(resolve('src/lib/components/database/WorldExplorer.svelte'), 'utf8');

		expect(source).toContain('createDatabase');
		expect(source).toContain('newDatabaseTitle');
		expect(source).toContain("'story.create'");
		expect(source).toContain("runEngineCommand('__app__', 'story.create'");
		expect(source).not.toContain('/api/stories');
	});

	it('surfaces chapter-important NPC candidates as reviewable character proposals', () => {
		const source = readFileSync(resolve('src/lib/components/database/WorldExplorer.svelte'), 'utf8');

		expect(source).toContain("{ id: 'npcCandidates', label: 'NPC Candidates' }");
		expect(source).toContain('Important NPC Candidates');
		expect(source).toContain('isNpcCandidateProposal');
		expect(source).toContain('character_reference_review');
		expect(source).toContain("recordCommandType(sectionId = activeSection)");
		expect(source).toContain("type: recordCommandType()");
		expect(source).toContain("reviewPatchProposal('approved')");
	});

	it('lets lore-screen patch proposals be reviewed through the engine boundary', () => {
		const source = readFileSync(resolve('src/lib/components/database/WorldExplorer.svelte'), 'utf8');

		expect(source).toContain('Review Proposal');
		expect(source).toContain("{ id: 'patchProposals', label: 'Reviews' }");
		expect(source).toContain("{ id: 'patches', label: 'Patch Log', isAdvanced: true }");
		expect(source).toContain('patchProposal.review');
		expect(source).toContain('formatProposalSummary');
		expect(source).toContain("['summary', 'status', 'proposalType', 'targetRecordId', 'reason']");
		expect(source).toContain("openRecord('patchProposals', body.proposalId)");
		expect(source).toContain("openRecord('characters', firstEntityId)");
		expect(source).toContain('openSearchResult(result)');
		expect(source).toContain("reviewPatchProposal('approved')");
		expect(source).toContain("reviewPatchProposal('rejected')");
	});
});
