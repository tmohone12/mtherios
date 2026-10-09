import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

// Run the actual event handlers with deferred I/O; browser checks cover rendering.
function handlers(file: string, names: string[], state: Record<string, unknown>) {
	const script = readFileSync(`src/lib/components/${file}.svelte`, 'utf8').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
	const ast = ts.createSourceFile('component.ts', script, ts.ScriptTarget.Latest, true);
	const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''));
	expect(functions).toHaveLength(names.length);
	const context = createContext({ Error, console: { error: vi.fn(), warn: vi.fn() }, ...state });
	runInContext(ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
	return context;
}
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

describe('library request recovery', () => {
	function library() {
		return handlers('library/LibraryPanel', ['loadStories'], { storyRequest: 0, alive: true, allShelves: false, selectedShelfId: 'a', stories: [], loadingStories: false, storiesError: '', catalogWarning: '' });
	}
	it('keeps the newest shelf when requests finish out of order', async () => {
		const page = library(), a = deferred<unknown>(), b = deferred<unknown>();
		page.refreshStoryCatalog = vi.fn(options => options.shelfId === 'a' ? a.promise : b.promise);
		const first = page.loadStories();
		page.selectedShelfId = 'b';
		const second = page.loadStories();
		b.resolve([{ id: 'story_b' }]); await second;
		a.resolve([{ id: 'story_a' }]); await first;
		expect(page.stories).toEqual([{ id: 'story_b' }]);
		expect(page.loadingStories).toBe(false);
	});
	it('fetches the selected shelf and labels cached data, then clears the warning on retry', async () => {
		const page = library();
		page.refreshStoryCatalog = vi.fn(async (_options, unavailable) => { unavailable(new Error('Offline')); return [{ id: 'cached' }]; });
		await page.loadStories();
		expect(page.refreshStoryCatalog.mock.calls[0][0]).toEqual({ shelfId: 'a' });
		expect(page.catalogWarning).toContain('cached stories');
		page.refreshStoryCatalog = vi.fn(async () => [{ id: 'fresh' }]);
		await page.loadStories();
		expect(page.catalogWarning).toBe(''); expect(page.stories).toEqual([{ id: 'fresh' }]);
	});
	it('shows a failure and preserves loaded results, ignoring failures after unmount', async () => {
		const page = library(); page.stories = [{ id: 'previous' }];
		page.refreshStoryCatalog = vi.fn(async () => { throw new Error('Cache unavailable'); });
		await page.loadStories();
		expect(page.storiesError).toBe('Cache unavailable');
		expect(page.stories).toEqual([{ id: 'previous' }]);
		const pending = deferred<unknown>(); page.refreshStoryCatalog = () => pending.promise;
		const loading = page.loadStories(); page.alive = false; page.storiesError = 'New workspace';
		pending.reject(new Error('Late failure')); await loading;
		expect(page.storiesError).toBe('New workspace');
	});
});

describe('lore navigation guards', () => {
	it('keeps a dirty editor mounted for sidebar and new-story navigation', () => {
		const app = { startNewStory: vi.fn() };
		const page = handlers('layout/AppShell', ['canLeaveLore', 'selectPanel', 'startNewStory', 'updateLoreDirty'], { app, loreDirty: true, activePanel: 'database', mobileToolsOpen: true, navigationNotice: '' });
		page.selectPanel('library'); page.startNewStory();
		expect(page.activePanel).toBe('database'); expect(app.startNewStory).not.toHaveBeenCalled();
		expect(page.navigationNotice).toContain('Save or discard');
		page.updateLoreDirty(false); page.selectPanel('library');
		expect(page.activePanel).toBe('library'); expect(page.navigationNotice).toBe('');
	});
	it('protects reader Lore against the play tab and back-to-library button', () => {
		const story = { clear: vi.fn() }, app = { closeStory: vi.fn() };
		const page = handlers('story/StoryView', ['canLeaveLore', 'selectWorkspaceTab', 'goBack', 'updateLoreDirty'], { story, app, loreDirty: true, headerSaving: false, workspaceTab: 'lore', navigationNotice: '' });
		page.selectWorkspaceTab('play'); page.goBack();
		expect(page.workspaceTab).toBe('lore'); expect(story.clear).not.toHaveBeenCalled();
		page.updateLoreDirty(false); page.goBack(); expect(app.closeStory).toHaveBeenCalledOnce();
	});
});

describe('reader controls', () => {
	it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }])('does not submit composition or repeated Enter: %j', flags => {
		const page = handlers('story/ActionInput', ['handleKeydown'], { window: { matchMedia: () => ({ matches: false }) }, handleSubmit: vi.fn() });
		const event = { key: 'Enter', shiftKey: false, preventDefault: vi.fn(), ...flags };
		page.handleKeydown(event); expect(page.handleSubmit).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled();
	});
	it.each([[false, false, true], [false, true, false], [true, false, false], [true, true, true]])('retains desktop/mobile Enter behavior (%s/%s)', (mobile, shiftKey, submits) => {
		const page = handlers('story/ActionInput', ['handleKeydown'], { window: { matchMedia: () => ({ matches: mobile }) }, handleSubmit: vi.fn() });
		page.handleKeydown({ key: 'Enter', shiftKey, preventDefault: vi.fn() });
		expect(page.handleSubmit).toHaveBeenCalledTimes(submits ? 1 : 0);
	});
	it('keeps a failed story-controls draft open and ignores duplicate save clicks', async () => {
		const pending = deferred<void>();
		const story = { currentStory: { id: 'a' }, updateStoryDetails: vi.fn(() => pending.promise) };
		const page = handlers('story/StoryView', ['saveHeaderPrompt'], { story, headerSaving: false, headerError: '', titleDraft: 'Title', headerDraft: 'Rules', descriptionDraft: 'Setting', closeHeaderEditor: vi.fn() });
		const saving = page.saveHeaderPrompt(); await page.saveHeaderPrompt();
		expect(story.updateStoryDetails).toHaveBeenCalledExactlyOnceWith({ title: 'Title', headerPrompt: 'Rules', description: 'Setting' });
		pending.reject(new Error('Please reconnect')); await saving;
		expect(page.closeHeaderEditor).not.toHaveBeenCalled(); expect(page.headerDraft).toBe('Rules'); expect(page.headerError).toBe('Please reconnect'); expect(page.headerSaving).toBe(false);
	});
});

describe('provider model request ownership', () => {
	function provider() {
		return handlers('settings/SettingsModal', ['fetchModelsForEditing', 'testConnection', 'fetchModelsForActiveProfile'], { editingProvider: 'first', modelRequest: 0, activeModelRequest: 0, apiKey: 'key', customUrl: '', model: '', fetchingEditorModels: false, fetchingModels: false, fetchedModelsForProfile: [], testStatus: 'idle', testMessage: '', modelFetchMessage: '', PROVIDERS: { first: { baseUrl: 'https://first.example', fallbackModels: ['first-model'] }, second: { baseUrl: 'https://second.example', fallbackModels: [] } } });
	}
	it.each(['fetchModelsForEditing', 'testConnection'])('ignores stale %s results after switching provider', async handler => {
		const page = provider(), pending = deferred<string[]>();
		page.fetchOpenAIModels = () => pending.promise;
		const request = page[handler](); page.editingProvider = 'second'; page.modelRequest += 1;
		page.testStatus = 'idle'; page.testMessage = 'Second provider'; page.fetchedModelsForProfile = ['second-model'];
		pending.resolve(['first-model']); await request;
		expect(page.fetchedModelsForProfile).toEqual(['second-model']); expect(page.testMessage).toBe('Second provider'); expect(page.testStatus).toBe('idle');
	});
	it('ignores changed credentials and releases the loading state for a retry', async () => {
		const page = provider(), pending = deferred<string[]>(); page.fetchOpenAIModels = () => pending.promise;
		const request = page.fetchModelsForEditing(); page.apiKey = 'different-key'; pending.reject(new Error('Old credentials')); await request;
		expect(page.fetchedModelsForProfile).toEqual([]); expect(page.testMessage).toBe(''); expect(page.testStatus).toBe('idle'); expect(page.fetchingEditorModels).toBe(false);
	});
	it('does not persist the old active profile list after changing profiles', async () => {
		const page = provider(), pending = deferred<string[]>(); page.fetchOpenAIModels = () => pending.promise;
		const first = { id: 'first', apiKey: 'key', fetchedModels: ['old'] };
		page.settings = { activeProfile: first, activeProvider: { baseUrl: 'https://first.example' }, saveProfiles: vi.fn() };
		const request = page.fetchModelsForActiveProfile(); page.settings.activeProfile = { id: 'second', apiKey: 'other' };
		pending.resolve(['first-model']); await request;
		expect(first.fetchedModels).toEqual(['old']); expect(page.settings.saveProfiles).not.toHaveBeenCalled(); expect(page.modelFetchMessage).toBe(''); expect(page.fetchingModels).toBe(false);
	});
});

 describe('portrait upload boundary', () => {
	it.each([3_000_000, 3_000_001])('handles a %i-byte portrait at the 3 MB boundary', async size => {
		const savePartyDetails = vi.fn();
		class FileReader { result = 'data:image/png;base64,portrait'; onload = () => {}; readAsDataURL() { this.onload(); } }
		const page = handlers('story/WorldSheet', ['loadPortraitFile'], { FileReader, portraitDrafts: {}, partyError: '', savePartyDetails });
		await page.loadPortraitFile({ currentTarget: { files: [{ type: 'image/png', size }], value: 'portrait.png' } }, { id: 'npc' });
		expect(savePartyDetails).toHaveBeenCalledTimes(size === 3_000_000 ? 1 : 0);
		if (size > 3_000_000) expect(page.partyError).toContain('3 MB');
	});
 });
