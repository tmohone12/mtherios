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
		const characterStart = source.indexOf("{#if editMode && editorRecord?.type === 'character'}");
		const conceptStart = source.indexOf("{#if editMode && editorRecord?.type === 'concept'}", characterStart);
		expect(characterStart).toBeGreaterThan(-1);
		expect(conceptStart).toBeGreaterThan(characterStart);
		// Candidate authoring has its own Role label; these restrictions apply to the canonical state editor.
		const characterEditor = source.slice(characterStart, conceptStart);

		expect(characterEditor).toContain('Character State');
		for (const label of ['Bio', 'Appearance (stable features)', 'Personality', 'Rank', 'Disposition', 'Affinity', 'Goals', 'Faction Tags', 'Known Facts', 'Current presentation (clothing / injuries)', 'Voice / speech style']) {
			expect(characterEditor).toContain(`<span>${label}</span>`);
		}
		expect(characterEditor).toContain('factionTags');
		expect(characterEditor).toContain('AI Refinement');
		for (const label of ['Voice', 'Role', 'Species', 'Personal Opinion', 'Mannerisms', 'Conversation Topics', 'Revealed Secrets', 'Visibility Note', 'Player Prompt']) {
			expect(characterEditor).not.toContain(`<span>${label}</span>`);
		}
		expect(source).not.toContain('accept="image/*"');
		expect(source).not.toContain('photoUrl');
		expect(source).not.toContain('promptTemplate');
		expect(source).not.toContain('eventMemory');
		expect(characterEditor).not.toContain('currentLocation');
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
		expect(source).toContain("type: recordCommandType(sectionId)");
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

	it('exposes the four evidence tools through the shared command route', () => {
		const source = readFileSync(resolve('src/lib/components/database/WorldExplorer.svelte'), 'utf8');

		expect(source).toContain('GM Toolkit');
		expect(source).toContain("command = 'world.actor.brief'");
		expect(source).toContain("command = 'world.scene.check'");
		expect(source).toContain("command = 'world.relationship.web'");
		expect(source).toContain("command = 'plot.thread.board'");
		expect(source).toContain('Evidence receipt');
	});

	it('labels the required preview seeds and sends generated creation to review instead of canon', () => {
		const source = readFileSync(resolve('src/lib/components/database/WorldExplorer.svelte'), 'utf8');
		const previewStart = source.indexOf('async function createCharacterDraft()');
		const directStart = source.indexOf('async function createCharacterDirect()', previewStart);
		expect(previewStart).toBeGreaterThan(-1);
		expect(directStart).toBeGreaterThan(previewStart);
		const previewHandler = source.slice(previewStart, directStart);

		expect(previewHandler).toContain("'world.character.draftCreate'");
		expect(source).toContain('Narrative purpose (preview required)');
		expect(previewHandler).toContain("body.status === 'existing'");
		expect(previewHandler).toContain("await openRecord('characters', body.recordId)");
		expect(previewHandler).toContain("await openRecord('patchProposals', proposalId)");
		expect(previewHandler).toContain('Choose Create character to add them to this story.');
		expect(previewHandler).not.toContain('patchProposal.review');
		expect(previewHandler).not.toContain('world.record.patch');
		expect(previewHandler).not.toContain('content.item.create');
		expect(source).toContain('Review the result before saving canon.');
	});
});
