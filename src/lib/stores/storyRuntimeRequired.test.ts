import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('terminal runtime required story store boundary', () => {
	it('does not load cached transcript fallback for backend-bound stories when the runtime is unavailable', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');

		expect(source).not.toContain('applyBackendUnavailableControlSurface');
		expect(source).not.toContain('showing cached transcript');
	});

	it('does not expose an offline backend turn queue from the frontend store', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');

		expect(source).not.toContain('queueOfflineBackendTurn');
		expect(source).not.toContain('queued_backend_turn');
		expect(source).not.toContain('turn_command');
	});

	it('clears stale missing terminal story bindings instead of showing runtime unavailable', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');

		expect(source).toContain('isMissingBackendStoryError');
		expect(source).toContain("serverStoryId: null, syncStatus: 'local-only'");
		expect(source).toContain('terminal database binding missing');
	});

	it('filters persisted transient runtime errors out of backend transcript windows', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');

		expect(source).toContain('isTransientRuntimeEntry');
		expect(source).toContain('if (isTransientRuntimeEntry(entry)) return null;');
	});

	it('keeps streamed turn diagnostics as control-surface state only', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');

		expect(source).toContain('lastTurnPerformance');
		expect(source).toContain('onTurnPerformance');
		expect(source).not.toContain('putTurnPerformance');
	});

	it('clears stale runtime errors after a backend projection refresh succeeds', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');

		expect(source).toContain('this.worldHydrationError = null;');
		expect(source).toContain('error: null,');
	});

	it('does not mislabel schema validation failures as an offline terminal runtime', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');

		expect(source).toContain('isRetryableEngineCommandFailure(error)');
		expect(source).toContain('applyTerminalStoryLoadFailure');
		expect(source).toContain("syncStatus: 'conflict'");
		expect(source).toContain('Story data failed validation.');
	});

	it('hydrates externally edited story fields from campaign projections', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');

		expect(source).toContain('title: asString(storyRow.title, this.currentStory.title)');
		expect(source).toContain('description: asNullableString(storyRow.description)');
		expect(source).toContain('headerPrompt: asNullableString(storyRow.headerPrompt)');
		expect(source).toContain('settings: projectedSettings');
	});
});
