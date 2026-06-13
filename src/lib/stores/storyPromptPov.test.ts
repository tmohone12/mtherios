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
		expect(wizard).toContain("pov: storyMode === 'adventure' ? 'first' : 'third'");
	});
});
