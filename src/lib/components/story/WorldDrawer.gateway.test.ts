import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('WorldDrawer terminal control-surface diagnostics', () => {
	it('shows the same canonical campaign brief in both world surfaces', () => {
		for (const surface of ['WorldSheet', 'WorldDrawer']) {
			expect(readFileSync(resolve(`src/lib/components/story/${surface}.svelte`), 'utf8')).toContain('<CampaignFacts />');
		}
		const panel = readFileSync(resolve('src/lib/components/story/CampaignFacts.svelte'), 'utf8');
		expect(panel).toContain('story.currentStory.campaignState');
		expect(panel).toContain('{fact.evidence}');
	});
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

	it('normalizes escaped imported line breaks in character summaries', () => {
		const source = readFileSync(resolve('src/lib/components/story/WorldDrawer.svelte'), 'utf8');

		expect(source).toContain("replace(/\\\\r\\\\n|\\\\n|\\\\r/g, '\\n')");
		expect(source).toContain('{displayText(character.description)}');
		expect(source).toContain('{displayText(protagonist?.description)}');
		expect(source).toContain('{displayText(char.description)}');
	});

	it('shows the persisted Plot Director in both shells and rejects stale drafts', () => {
		const source = readFileSync(resolve('src/lib/components/story/WorldDrawer.svelte'), 'utf8');
		const sheet = readFileSync(resolve('src/lib/components/story/WorldSheet.svelte'), 'utf8');
		const panel = readFileSync(resolve('src/lib/components/story/PlotDirectorPanel.svelte'), 'utf8');
		expect(source).toContain('<PlotDirectorPanel />');
		expect(sheet).toContain('<PlotDirectorPanel />');
		expect(sheet).toContain("label: 'Director'");
		expect(panel).toContain('pendingFrameId');
		expect(panel).toContain('pendingBaseServerVersion');
		expect(panel).toContain('pendingBaseVersion === projectionVersion');
		expect(panel).toContain('appliedStrategicFrameFromProjection(story.campaignProjection)');
		expect(panel).toContain('event.metadata.plotCardId');
		expect(panel).toContain('description.startsWith(`${title}:`)');
		expect(panel).toContain('await story.pullBackendProjection()');
	});
});
