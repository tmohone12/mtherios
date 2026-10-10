import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn(), deleteSetting: vi.fn(), catalog: vi.fn() }));
vi.mock('$lib/services/database', () => ({ getSetting: mocks.getSetting, setSetting: mocks.setSetting, deleteSetting: mocks.deleteSetting }));
vi.mock('$lib/services/serverStories', () => ({ refreshStoryCatalog: mocks.catalog }));
import { app } from './app.svelte';

function browser(url: string) {
	const listeners = new Map<string, Set<(event: any) => void>>();
	const entries = [{ url, state: { routerState: 'keep' } as Record<string, unknown> }];
	let position = 0;
	const emit = (name: string, event: unknown) => { for (const listener of listeners.get(name) ?? []) listener(event); };
	const history = {
		get state() { return entries[position].state; },
		get length() { return entries.length; },
		pushState: vi.fn((state: Record<string, unknown>, _title: string, next: string | URL) => {
			entries.splice(position + 1);
			entries.push({ state, url: String(next) });
			position += 1;
		}),
		replaceState: vi.fn((state: Record<string, unknown>, _title: string, next: string | URL) => { entries[position] = { state, url: String(next) }; }),
		go: vi.fn((delta: number) => {
			const target = position + delta;
			if (target < 0 || target >= entries.length) return;
			position = target;
			emit('popstate', { state: history.state });
		}),
	};
	const window = {
		location: { get href() { return entries[position].url; } }, history,
		addEventListener: (name: string, fn: (event: any) => void) => {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name)!.add(fn);
		},
		removeEventListener: (name: string, fn: (event: any) => void) => { listeners.get(name)?.delete(fn); },
	};
	vi.stubGlobal('window', window);
	return { history, window, emit };
}

describe('app view navigation', () => {
	beforeEach(() => {
		mocks.getSetting.mockImplementation(async (key: string) => key === 'onboardingComplete' ? 'true' : key === 'lastStoryId' ? 'story-a' : null);
		mocks.setSetting.mockResolvedValue(undefined);
		mocks.deleteSetting.mockResolvedValue(undefined);
		mocks.catalog.mockResolvedValue([{ id: 'story-a', shelfId: 'shelf-a' }, { id: 'story-b', serverStoryId: 'server-b', shelfId: 'shelf-b' }]);
	});
	afterEach(() => { app.disposeNavigation(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

	it('restores explicit Story tabs and workspace views while retaining source links', async () => {
		const { window, history } = browser('http://localhost/?story=server-b&tab=chapters&source=content%3Anote%401&project=shelf-b');
		await app.init();
		expect(app.currentStoryId).toBe('story-b');
		expect(app.storyTab).toBe('chapters');
		expect(app.activeShelfId).toBe('shelf-b');
		expect(app.selectWorkspace('engine')).toBe(true);
		expect(new URL(window.location.href).searchParams.get('source')).toBe('content:note@1');
		expect(history.state.routerState).toBe('keep');
		await app.init();
		expect(app.currentStoryId).toBeNull();
		expect(app.workspacePanel).toBe('engine');
	});

	it('honors source links ahead of the saved story and rejects missing story IDs', async () => {
		browser('http://localhost/?source=content%3Anote%401');
		await app.init();
		expect(app.currentStoryId).toBeNull();
		expect(app.workspacePanel).toBe('content');
		app.disposeNavigation();
		const { window } = browser('http://localhost/?story=missing&tab=bogus');
		await app.init();
		expect(app.currentStoryId).toBeNull();
		expect(app.storyTab).toBe('play');
		expect(new URL(window.location.href).searchParams.has('story')).toBe(false);
	});

	it('supports Back/Forward across stories, tabs and workspaces without duplicate entries', async () => {
		const { history } = browser('http://localhost/?workspace=library');
		await app.init();
		app.openStory('story-a');
		app.selectStoryTab('lore');
		app.selectStoryTab('lore');
		app.selectWorkspace('database');
		expect(history.length).toBe(4);
		history.go(-1);
		expect([app.currentStoryId, app.storyTab]).toEqual(['story-a', 'lore']);
		history.go(-1);
		expect(app.storyTab).toBe('play');
		history.go(-1);
		expect([app.currentStoryId, app.workspacePanel]).toEqual([null, 'library']);
		history.go(2);
		expect([app.currentStoryId, app.storyTab]).toEqual(['story-a', 'lore']);
	});

	it('retains a dirty editor on direct navigation, Back and reload; Back works after saving', async () => {
		const { history, window, emit } = browser('http://localhost/?workspace=library');
		await app.init();
		app.selectWorkspace('content');
		const accepted = window.location.href;
		let dirty = true;
		const removeGuard = app.registerNavigationGuard(() => !dirty);
		try {
			expect(app.openStory('story-b')).toBe(false);
			expect(app.startNewStory()).toBe(false);
			history.go(-1);
			expect(app.workspacePanel).toBe('content');
			expect(window.location.href).toBe(accepted);
			const unload = { preventDefault: vi.fn(), returnValue: undefined };
			emit('beforeunload', unload);
			expect(unload.preventDefault).toHaveBeenCalledOnce();
			dirty = false;
			history.go(-1);
			expect(app.workspacePanel).toBe('library');
			history.go(1);
			expect(app.workspacePanel).toBe('content');
		} finally { removeGuard(); }
	});

	it('hydrates the saved story for a bare URL and disposes browser listeners', async () => {
		const { history } = browser('http://localhost/');
		await app.init();
		expect(app.currentStoryId).toBe('story-a');
		app.selectStoryTab('chapters');
		app.disposeNavigation();
		history.go(-1);
		expect(app.storyTab).toBe('chapters');
	});
});
