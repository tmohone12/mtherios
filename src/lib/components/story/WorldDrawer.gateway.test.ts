import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('WorldDrawer terminal control-surface diagnostics', () => {
	it('renders last-turn performance from backend stream state without direct turn APIs', () => {
		const source = readFileSync(resolve('src/lib/components/story/WorldDrawer.svelte'), 'utf8');

		expect(source).toContain('story.lastTurnPerformance');
		expect(source).toContain('Last Turn');
		expect(source).toContain('Prepared');
		expect(source).not.toContain('/api/turn');
	});
});
