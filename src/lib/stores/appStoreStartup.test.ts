import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('app startup story recovery', () => {
	it('does not reopen stale lastStoryId when a fresh catalog excludes it', () => {
		const source = readFileSync(resolve('src/lib/stores/app.svelte.ts'), 'utf8');

		expect(source).toContain('catalog === null');
		expect(source).toContain("deleteSetting('lastStoryId')");
		expect(source).not.toContain(': lastStory ?? null;');
	});
});
