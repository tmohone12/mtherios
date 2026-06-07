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
});
