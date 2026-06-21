import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('story narrative prompt POV defaults', () => {
	it('defaults adventure narration to hybrid GM text RPG framing', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');
		const wizard = readFileSync(resolve('src/lib/components/wizard/OnboardingWizard.svelte'), 'utf8');

		expect(source).toContain("get pov() { return this.currentStory?.settings?.pov ?? 'first'; }");
		expect(source).toContain("s.settings?.pov ?? 'first'");
		expect(source).toContain('Hybrid POV');
		expect(source).toContain('Time HH:MM');
		expect(source).toContain('Do not append ending choices');
		expect(source).toContain('not a writing assistant');
		expect(source).toContain('Use D&D-style d20 checks only when failure would be interesting');
		expect(wizard).toContain("pov: storyMode === 'adventure' ? 'first' : 'third'");
	});

	it('labels unresolved faction member names as context instead of canon in prompt text', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');

		expect(source).toContain('state.unresolvedKnownMembers');
		expect(source).toContain('(unresolved)');
	});

	it('does not re-inject recent chapters after arcs already cover them', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');

		expect(source).toContain('const coveredIds = new Set(snap.arcs.flatMap(a => a.chapterIds));');
		expect(source).toContain('const merged = sorted.filter(c => c.pinned || !coveredIds.has(c.id));');
		expect(source).not.toContain('const recent = sorted.slice(-2);');
		expect(source).not.toContain('recency matters');
	});
});
