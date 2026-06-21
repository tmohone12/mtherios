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

	it('renders backend context receipts with continuity audit counts', () => {
		const source = readFileSync(resolve('src/lib/components/story/WorldDrawer.svelte'), 'utf8');

		expect(source).toContain('story.lastContextReceipt');
		expect(source).toContain('Context Receipt');
		expect(source).toContain('Unresolved refs');
		expect(source).toContain('lastContextReceipt.unresolvedCharacterReferences');
		expect(source).toContain('Ledger evidence');
		expect(source).toContain('lastContextReceipt.continuityLedger');
		expect(source).toContain('Patch proposals');
		expect(source).toContain('Skipped');
		expect(source).toContain('Cache segments');
		expect(source).toContain('lastContextReceipt.cacheSegments');
		expect(source).not.toContain('/api/turn');
	});

	it('renders unresolved faction member names as review context, not canon members', () => {
		const source = readFileSync(resolve('src/lib/components/story/WorldDrawer.svelte'), 'utf8');

		expect(source).toContain('fs.unresolvedKnownMembers');
		expect(source).toContain('Unresolved members');
		expect(source).toContain('factionSearchText');
		expect(source).toContain('state.unresolvedKnownMembers');
	});
});
