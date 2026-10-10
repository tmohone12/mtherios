import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { proposalRecordView } from '../../services/canonProposalDisplay';

// Execute the real component script; DOM rendering is verified in the browser.
// Rune getters stay live so these tests cover async behavior after state changes.
function explorer() {
	const component = readFileSync(resolve('src/lib/components/database/WorldExplorer.svelte'), 'utf8');
	const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
	const ast = ts.createSourceFile('WorldExplorer.ts', script, ts.ScriptTarget.Latest, true);
	const edits: Array<{ start: number; end: number; text: string }> = [];
	const globals: Record<string, unknown> = {
		$state: (value: unknown) => value,
		$props: () => ({}),
		$effect: () => {},
	};
	for (const statement of ast.statements) {
		if (ts.isImportDeclaration(statement)) {
			const bindings = statement.importClause?.namedBindings;
			if (bindings && ts.isNamedImports(bindings)) {
				for (const binding of bindings.elements) globals[binding.name.text] = () => {};
			}
			edits.push({ start: statement.getStart(ast), end: statement.end, text: '' });
		} else if (ts.isVariableStatement(statement)) {
			const declaration = statement.declarationList.declarations[0];
			const value = declaration.initializer;
			const call = value && ts.isCallExpression(value) ? value : null;
			const rune = call?.expression.getText(ast);
			const text = call && (rune === '$derived' || rune === '$derived.by')
				? `Object.defineProperty(globalThis, '${declaration.name.getText(ast)}', { get: ${rune === '$derived.by' ? call.arguments[0].getText(ast) : `() => (${call.arguments[0].getText(ast)})`} });`
				: statement.getText(ast).replace(/^(const|let)\b/, 'var');
			edits.push({ start: statement.getStart(ast), end: statement.end, text });
		}
	}
	let executable = script;
	for (const edit of edits.reverse()) executable = executable.slice(0, edit.start) + edit.text + executable.slice(edit.end);
	const context = createContext({ ...globals, proposalRecordView });
	runInContext(ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
	context.selectedStoryId = 'story_a';
	context.activeSection = 'characters';
	return context;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
	return { promise, resolve, reject };
}

const a = { id: 'a', type: 'character', name: 'A' };
const b = { id: 'b', type: 'character', name: 'B' };

describe('WorldExplorer request and editor lifecycle', () => {
	it('returns from linked evidence to the original entry and can browse the whole category', async () => {
		const page = explorer();
		page.runEngineCommand = vi.fn(async (_story, command, args) => command === 'world.record.get' ? { record: args.recordId === 'a' ? a : { id: 'source', content: 'Evidence' } } : { records: [a, b] });
		await page.selectRecord(a);
		page.status = 'Previous failure';
		await page.openRecord('transcript', 'source');
		expect(page.status).toBe(''); expect(page.recordHistory).toEqual([{ section: 'characters', id: 'a', title: 'A' }]);
		await page.goBackToRecord();
		expect(page.selectedRecord.id).toBe('a'); expect(page.activeSection).toBe('characters'); expect(page.recordHistory).toEqual([]);
		await page.browseAllRecords();
		expect(page.records.map((row: { id: string }) => row.id)).toEqual(['a', 'b']); expect(page.focusedRecord).toBe(false);
	});

	it('keeps navigation history on a failed back request and blocks it during edits', async () => {
		const page = explorer();
		page.recordHistory = [{ section: 'characters', id: 'a', title: 'A' }];
		page.runEngineCommand = vi.fn(async () => { throw new Error('Source unavailable'); });
		await page.goBackToRecord();
		expect(page.recordHistory).toHaveLength(1); expect(page.status).toContain('Source unavailable');
		page.locationWorkspaceDirty = true; page.runEngineCommand.mockClear();
		await page.goBackToRecord(); await page.browseAllRecords();
		expect(page.runEngineCommand).not.toHaveBeenCalled();
	});

	it('warns before browser reload only while lore edits or a save are pending', () => {
		const page = explorer();
		const event = { preventDefault: vi.fn(), returnValue: undefined };
		page.protectDraft(event); expect(event.preventDefault).not.toHaveBeenCalled();
		page.locationWorkspaceDirty = true; page.protectDraft(event); expect(event.preventDefault).toHaveBeenCalledOnce();
		page.locationWorkspaceDirty = false; page.saving = true; page.protectDraft(event); expect(event.preventDefault).toHaveBeenCalledTimes(2);
	});

	it('queues one job retry with its exact observed version and refreshes failures', async () => {
		const page = explorer();
		page.activeSection = 'jobs';
		page.selectedRecord = { id: 'job_a', retryAllowed: true, updatedAt: '2026-09-05 21:00:00.123456+00' };
		const pending = deferred<unknown>();
		page.runEngineCommand = vi.fn(() => pending.promise);
		page.loadSection = vi.fn(async () => true);
		const first = page.retrySelectedJob();
		await page.retrySelectedJob();
		expect(page.runEngineCommand).toHaveBeenCalledExactlyOnceWith('story_a', 'jobs.retry', { jobId: 'job_a', expectedUpdatedAt: '2026-09-05 21:00:00.123456+00' });
		pending.resolve({ status: 'retry' });
		await first;
		expect(page.loadSection).toHaveBeenCalledOnce();
		expect(page.status).toContain('Retry queued');
		expect(page.retryingJobId).toBe('');
	});

	it('does not overwrite another story or job with a late retry failure', async () => {
		for (const switchStory of [false, true]) {
			const page = explorer();
			page.activeSection = 'jobs';
			page.selectedRecord = { id: 'job_a', retryAllowed: true, updatedAt: '2026-09-05T21:00:00Z' };
			const pending = deferred<unknown>();
			page.runEngineCommand = vi.fn(() => pending.promise);
			const request = page.retrySelectedJob();
			if (switchStory) page.selectedStoryId = 'story_b';
			else page.selectedRecord = { id: 'job_b' };
			page.status = 'Current screen';
			pending.reject(new Error('Stale job'));
			await request;
			expect(page.status).toBe('Current screen');
		}
	});

	it('requests failures from the backend and retains refresh errors after retry', async () => {
		const page = explorer();
		page.activeSection = 'jobs';
		page.runEngineCommand = vi.fn(async () => ({ jobs: [] }));
		await page.loadSection();
		expect(page.runEngineCommand).toHaveBeenCalledWith('story_a', 'jobs.status', { limit: 100, status: 'failed' });
		page.selectedRecord = { id: 'job_a', retryAllowed: true, updatedAt: '2026-09-05T21:00:00Z' };
		page.loadSection = vi.fn(async () => { page.status = 'Refresh failed'; return false; });
		await page.retrySelectedJob();
		expect(page.status).toBe('Refresh failed');
	});

	it('discards typed LLM edits from every view while retaining the selected service', async () => {
		const page = explorer();
		const settings = [{ serviceId: 'summary', model: 'small' }, { serviceId: 'narrative', model: 'original' }];
		page.activeSection = 'llmSettings';
		page.runEngineCommand = vi.fn(() => ({ settings }));
		await page.loadSection();
		page.updateLlmSetting(1, 'model', 'edited');
		expect(page.hasUnsavedChanges).toBe(true);
		expect(page.llmSettings[1].model).toBe('edited');
		page.resetEditor();
		expect(page.llmSettings).toEqual(settings);
		expect(page.records).toEqual(settings);
		expect(page.selectedRecord).toEqual(settings[1]);
		expect(page.detail).toEqual(settings[1]);
		expect(JSON.parse(page.editorText)).toEqual(settings);
		expect(page.hasUnsavedChanges).toBe(false);
	});

	it('rejects non-array LLM JSON without saving and ignores duplicate saves while one is pending', async () => {
		const page = explorer();
		page.activeSection = 'llmSettings';
		const pending = deferred<unknown>();
		page.runEngineCommand = vi.fn(() => pending.promise);
		for (const invalid of ['{}', 'null', '"settings"']) {
			page.editorText = invalid;
			await page.saveLlmSettings();
			expect(page.status).toContain('LLM settings must be a JSON array');
			expect(page.saving).toBe(false);
		}
		expect(page.runEngineCommand).not.toHaveBeenCalled();
		const settings = [{ serviceId: 'narrative', model: 'original' }];
		page.editorText = JSON.stringify(settings);
		const saving = page.saveLlmSettings();
		await page.saveLlmSettings();
		expect(page.runEngineCommand).toHaveBeenCalledTimes(1);
		pending.resolve({ settings });
		await saving;
		expect(page.status).toBe('LLM settings saved.');
		expect(page.hasUnsavedChanges).toBe(false);
	});

	it('ignores late record details and never saves one character over another', async () => {
		const page = explorer();
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		page.runEngineCommand = vi.fn((_story, _command, args) => args.recordId === 'a' ? first.promise : second.promise);
		const selectingA = page.selectRecord(a);
		const selectingB = page.selectRecord(b);
		expect(page.editorText).toBe('');
		expect(page.isDetailLoading).toBe(true);
		await page.saveRecord();
		expect(page.runEngineCommand).toHaveBeenCalledTimes(2);
		second.resolve({ record: b });
		await selectingB;
		first.resolve({ record: a });
		await selectingA;
		expect(page.selectedRecord.id).toBe('b');
		expect(JSON.parse(page.editorText).id).toBe('b');
		expect(page.isDetailLoading).toBe(false);
		page.editorText = JSON.stringify(a);
		await page.saveRecord();
		expect(page.runEngineCommand).toHaveBeenCalledTimes(2);
	});

	it.each(['section', 'story'])('ignores an old list and search response after changing %s', async (scope) => {
		const page = explorer();
		const oldList = deferred<unknown>();
		const oldSearch = deferred<unknown>();
		page.runEngineCommand = vi.fn((_story, command) => {
			if (command === 'world.search') return oldSearch.promise;
			if (command === 'world.record.get') return { record: b };
			return page.runEngineCommand.mock.calls.filter((call: unknown[]) => call[1] === 'world.records').length === 1 ? oldList.promise : { records: [b] };
		});
		const oldLoading = page.loadSection();
		const oldSearching = page.searchStory();
		if (scope === 'section') page.activeSection = 'locations';
		else page.selectedStoryId = 'story_b';
		await page.loadSection();
		oldList.resolve({ records: [a], nextCursor: '60' });
		oldSearch.resolve({ results: [{ recordId: 'a' }] });
		await Promise.all([oldLoading, oldSearching]);
		expect(page.records.map((record: { id: string }) => record.id)).toEqual(['b']);
		expect(JSON.parse(page.editorText).id).toBe('b');
		expect(page.searchResults).toEqual([]);
		expect(page.nextCursor).toBeNull();
	});

	it('keeps the selected character and unsaved edit while loading more, then retains it after save', async () => {
		const page = explorer();
		page.runEngineCommand = vi.fn((_story, command, args) => {
			if (command === 'world.record.get') return { record: args.recordId === 'b' ? b : a };
			if (command === 'world.record.patch') return { patchId: 'patch_b' };
			return { records: args.cursor ? [{ id: 'c', name: 'C' }] : [a, b], nextCursor: args.cursor ? null : '60' };
		});
		await page.loadSection();
		await page.selectRecord(b);
		page.editMode = true;
		page.editorText = JSON.stringify({ ...b, name: 'Edited B' });
		await page.loadSection('60');
		expect(page.selectedRecord.id).toBe('b');
		expect(JSON.parse(page.editorText).name).toBe('Edited B');
		expect(page.hasUnsavedChanges).toBe(true);
		expect(page.editMode).toBe(true);
		page.setActiveSection('locations');
		await page.selectRecord(a);
		expect(page.activeSection).toBe('characters');
		expect(page.selectedRecord.id).toBe('b');
		await page.saveRecord();
		expect(page.runEngineCommand).toHaveBeenCalledWith('story_a', 'world.record.patch', expect.objectContaining({ recordId: 'b', updates: { name: 'Edited B' } }));
		expect(page.selectedRecord.id).toBe('b');
		expect(page.status).toBe('Changes saved.');
		expect(page.hasUnsavedChanges).toBe(false);
		expect(page.editMode).toBe(false);
	});

	it('patches only the changed field so stale character biography data cannot be re-saved', async () => {
		const page = explorer();
		const player = {
			id: 'player_a', server_version: 7, updated_at: '2026-09-21T00:00:00Z',
			type: 'character',
			name: 'Aegon',
			description: 'A stale, unrelated biography.',
			state: { bio: 'The canonical player biography.' },
		};
		page.selectedRecord = player;
		page.setEditor(player);
		page.editorText = JSON.stringify({ ...player, name: 'Aegon Vaelaros' });
		page.runEngineCommand = vi.fn(async () => ({}));
		page.loadSection = vi.fn(async () => true);

		await page.saveRecord();

		expect(page.runEngineCommand).toHaveBeenCalledExactlyOnceWith('story_a', 'world.record.patch', {
			type: 'characters',
			recordId: 'player_a',
			updates: { name: 'Aegon Vaelaros' }, expectedVersion: 7, expectedUpdatedAt: '2026-09-21T00:00:00Z', jsonMode: 'replace',
			reason: 'Manual explorer edit.',
		});
	});
});

describe('WorldExplorer character creation', () => {
	it('finds candidates from the empty queue without starting draft generation or approval', async () => {
		const page = explorer();
		page.activeSection = 'npcCandidates';
		page.records = [];
		page.runEngineCommand = vi.fn(async () => ({ chaptersScanned: 8, created: 2, updated: 0 }));
		page.loadSection = vi.fn().mockResolvedValue(true);
		await page.findCharacterCandidates();
		expect(page.runEngineCommand).toHaveBeenCalledExactlyOnceWith('story_a', 'world.character.findCandidates', { chapterLimit: 8 });
		expect(page.status).toContain('2 new candidates');
		expect(page.loadSection).toHaveBeenCalledOnce();
	});
	function sourceCandidate() {
		const page = explorer();
		page.activeSection = 'npcCandidates';
		const candidate = { id: 'candidate_mara', status: 'pending', serverVersion: 7, proposalType: 'character_reference_review', proposedBy: 'chapter_scribe', operations: [{ op: 'review', path: '/entities/character', value: { name: 'Mara', type: 'character', state: {} } }] };
		page.selectedRecord = candidate;
		page.setEditor(candidate);
		page.openRecord = vi.fn().mockResolvedValue(true);
		page.loadSection = vi.fn().mockResolvedValue(true);
		return page;
	}

	it('builds the selected source candidate once and requires separate versioned approval', async () => {
		const page = sourceCandidate();
		const pending = deferred<unknown>();
		page.runEngineCommand = vi.fn(() => pending.promise);
		const building = page.draftCandidateFromSources();
		await page.draftCandidateFromSources();
		await page.reviewPatchProposal('approved');
		expect(page.runEngineCommand).toHaveBeenCalledExactlyOnceWith('story_a', 'world.character.draftFromSources', { proposalId: 'candidate_mara', expectedProposalVersion: 7 });
		pending.resolve({ status: 'pending', proposalId: 'candidate_mara' });
		await building;
		expect(page.openRecord).toHaveBeenCalledWith('npcCandidates', 'candidate_mara');
		expect(page.loadSection).toHaveBeenCalledOnce();
		page.setEditor({ ...page.selectedRecord, operations: [{ op: 'review', path: '/entities/character', value: { name: 'Mara', type: 'character', state: { bio: 'Mara guides the ship.' } } }], metadata: { sourceDraft: { mode: 'evidence_only', evidence: [{ field: 'bio' }], sourceSnapshot: { entries: [], events: [] } } } });
		page.runEngineCommand = vi.fn(async () => ({ status: 'applied', application: { appliedCount: 1, affectedEntityIds: ['npc_mara'] } }));
		await page.reviewPatchProposal('approved');
		expect(page.runEngineCommand).toHaveBeenCalledWith('story_a', 'patchProposal.review', { proposalId: 'candidate_mara', decision: 'approved', reviewer: 'human', expectedProposalVersion: 7 });
	});

	it('does not approve an unpopulated source placeholder', async () => {
		const page = sourceCandidate();
		page.runEngineCommand = vi.fn();
		expect(page.candidateReady).toBe(false);
		await page.reviewPatchProposal('approved');
		expect(page.runEngineCommand).not.toHaveBeenCalled();
		expect(page.openRecord).not.toHaveBeenCalled();
		expect(page.status).toContain('biography');
		expect(page.status).toContain('story sources');
	});

	it.each(['story', 'record'])('ignores a late source draft after switching %s', async (scope) => {
		const page = sourceCandidate();
		const pending = deferred<unknown>();
		page.runEngineCommand = vi.fn(() => pending.promise);
		const building = page.draftCandidateFromSources();
		if (scope === 'story') page.selectedStoryId = 'story_b';
		else page.selectedRecord = { id: 'another_candidate' };
		page.status = 'Current selection';
		pending.reject(new Error('Old request failed'));
		await building;
		expect(page.status).toBe('Current selection');
		expect(page.openRecord).not.toHaveBeenCalled();
	});

	const draft = { name: 'Tala Venn', type: 'character', description: 'A courier with a debt.', state: { bio: 'Raised among the harbor pilots.', rank: 'Courier', motivations: ['Repay her family debt'] } };
	const proposal = { id: 'proposal_tala', status: 'pending', proposal_type: 'character_reference_review', proposed_by: 'gm_character_draft', operations: [{ op: 'review', path: '/entities/character', value: draft }] };
	function reviewingDraft() {
		const page = explorer();
		page.activeSection = 'patchProposals';
		page.selectedRecord = proposal;
		page.setEditor(proposal);
		page.openRecord = vi.fn().mockResolvedValue(true);
		page.loadSection = vi.fn().mockResolvedValue(true);
		return page;
	}

	it.each(['newCharacterName', 'newCharacterRole', 'newCharacterBackstory', 'newCharacterPurpose'])('does not generate a character preview when %s is empty', async (missingField) => {
		const page = explorer();
		page.newCharacterName = 'Tala Venn';
		page.newCharacterRole = 'Courier';
		page.newCharacterBackstory = 'Raised among the harbor pilots.';
		page.newCharacterPurpose = 'Connect the player to the harbor dispute.';
		page[missingField] = '  ';
		page.runEngineCommand = vi.fn();
		page.openRecord = vi.fn();
		await page.createCharacterDraft();
		expect(page.runEngineCommand).not.toHaveBeenCalled();
		expect(page.openRecord).not.toHaveBeenCalled();
		expect(page.status).toContain('before preparing the character');
	});

	it('prepares a reviewable preview without automatically approving or creating canon', async () => {
		const page = explorer();
		page.newCharacterName = 'Tala Venn';
		page.newCharacterRole = 'Courier';
		page.newCharacterBackstory = 'Raised among the harbor pilots.';
		page.newCharacterPurpose = 'Connect the player to the harbor dispute.';
		page.showGmToolkit = true;
		page.runEngineCommand = vi.fn(() => ({ status: 'pending', proposalId: proposal.id }));
		page.openRecord = vi.fn().mockResolvedValue(true);
		await page.createCharacterDraft();
		expect(page.runEngineCommand).toHaveBeenCalledExactlyOnceWith('story_a', 'world.character.draftCreate', expect.objectContaining({ name: draft.name, role: 'Courier' }));
		expect(page.openRecord).toHaveBeenCalledWith('patchProposals', proposal.id);
		expect(page.showGmToolkit).toBe(false);
		expect(page.status).toContain('Choose Create character');
		const review = reviewingDraft();
		expect(review.isCharacterCreationProposal).toBe(true);
		expect(review.characterCreationPreview).toEqual(draft);
	});

	it('keeps the creation form and load error visible until the proposal preview actually opens', async () => {
		const page = explorer();
		page.newCharacterName = 'Tala Venn';
		page.newCharacterRole = 'Courier';
		page.newCharacterBackstory = 'Raised among the harbor pilots.';
		page.newCharacterPurpose = 'Connect the player to the harbor dispute.';
		page.showGmToolkit = true;
		page.runEngineCommand = vi.fn((_story, command) => {
			if (command === 'world.character.draftCreate') return { status: 'pending', proposalId: proposal.id };
			throw new Error('The draft preview could not be loaded.');
		});
		await page.createCharacterDraft();
		expect(page.showGmToolkit).toBe(true);
		expect(page.status).toContain('The draft preview could not be loaded.');
		expect(page.isDetailLoading).toBe(false);
		expect(page.creatingCharacterDraft).toBe(false);
		expect(page.characterCreationPreview).toBeNull();
		page.runEngineCommand.mockImplementation((_story: string, command: string) => command === 'world.character.draftCreate' ? { status: 'pending', proposalId: proposal.id } : { record: proposal });
		await page.createCharacterDraft();
		expect(page.showGmToolkit).toBe(false);
		expect(page.characterCreationPreview).toEqual(draft);
		expect(page.status).toContain('Choose Create character');
	});

	it('does not publish a late draft failure into another story', async () => {
		const page = explorer();
		page.newCharacterName = 'Tala Venn';
		page.newCharacterRole = 'Courier';
		page.newCharacterBackstory = 'Raised among the harbor pilots.';
		page.newCharacterPurpose = 'Connect the player to the harbor dispute.';
		const pending = deferred<unknown>();
		page.runEngineCommand = vi.fn(() => pending.promise);
		const creating = page.createCharacterDraft();
		page.selectedStoryId = 'story_b';
		page.status = 'Current story status';
		pending.reject(new Error('Old story draft failed.'));
		await creating;
		expect(page.status).toBe('Current story status');
		expect(page.creatingCharacterDraft).toBe(false);
	});

	it.each(['story', 'proposal'])('does not publish a late review failure after changing %s', async (scope) => {
		const page = reviewingDraft();
		const pending = deferred<unknown>();
		page.runEngineCommand = vi.fn(() => pending.promise);
		const reviewing = page.reviewPatchProposal('approved');
		if (scope === 'story') page.selectedStoryId = 'story_b';
		else page.selectedRecord = { id: 'another_proposal' };
		page.status = 'Current selection status';
		pending.reject(new Error('Old proposal review failed.'));
		await reviewing;
		expect(page.status).toBe('Current selection status');
		expect(page.reviewingProposal).toBe(false);
		expect(page.openRecord).not.toHaveBeenCalled();
	});

	it('creates through validated human review, ignores duplicate clicks, and opens the canonical character', async () => {
		const page = reviewingDraft();
		const pending = deferred<unknown>();
		page.runEngineCommand = vi.fn(() => pending.promise);
		const creating = page.reviewPatchProposal('approved');
		await page.reviewPatchProposal('approved');
		expect(page.runEngineCommand).toHaveBeenCalledExactlyOnceWith('story_a', 'patchProposal.review', { proposalId: proposal.id, decision: 'approved', reviewer: 'human' });
		pending.resolve({ status: 'applied', application: { appliedCount: 1, affectedEntityIds: ['entity_tala'] } });
		await creating;
		expect(page.openRecord).toHaveBeenCalledExactlyOnceWith('characters', 'entity_tala');
		expect(page.status).toBe('Tala Venn is now a character in this story.');
		expect(page.reviewingProposal).toBe(false);
	});

	it('shows backend validation rejection instead of claiming the character was created', async () => {
		const page = reviewingDraft();
		page.runEngineCommand = vi.fn(() => ({ status: 'rejected', application: { appliedCount: 0, affectedEntityIds: [], metadata: { rejectionReason: 'Malformed GM character draft payload cannot become canon.' } } }));
		await page.reviewPatchProposal('approved');
		expect(page.openRecord).toHaveBeenCalledExactlyOnceWith('patchProposals', proposal.id);
		expect(page.status).toBe('Malformed GM character draft payload cannot become canon.');
		expect(page.status).not.toContain('approved');
	});

	it.each([
		{ status: 'approved', application: { appliedCount: 0, affectedEntityIds: [] } },
		{ status: 'applied', application: { appliedCount: 0, affectedEntityIds: ['entity_tala'] } },
		{ status: 'applied', application: { appliedCount: 1, affectedEntityIds: [] } },
	])('does not claim creation without a confirmed applied canonical character: %j', async (result) => {
		const page = reviewingDraft();
		page.runEngineCommand = vi.fn(() => result);
		await page.reviewPatchProposal('approved');
		expect(page.openRecord).toHaveBeenCalledExactlyOnceWith('patchProposals', proposal.id);
		expect(page.status).toContain('Character was not created.');
	});

	it('leaves unsaved proposal edits for the user to save before creation', async () => {
		const page = reviewingDraft();
		page.editorText = JSON.stringify({ ...proposal, reason: 'Edited purpose' });
		page.runEngineCommand = vi.fn();
		await page.reviewPatchProposal('approved');
		expect(page.runEngineCommand).not.toHaveBeenCalled();
		expect(page.openRecord).not.toHaveBeenCalled();
	});
});
