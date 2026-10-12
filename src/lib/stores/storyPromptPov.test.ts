import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('story POV defaults', () => {
	it('defaults adventure stories to first person and other modes to third person', () => {
		const source = readFileSync(resolve('src/lib/stores/story.svelte.ts'), 'utf8');
		const wizard = readFileSync(resolve('src/lib/components/wizard/OnboardingWizard.svelte'), 'utf8');

		expect(source).toContain("get pov() { return this.currentStory?.settings?.pov ?? 'first'; }");
		expect(wizard).toContain("pov: storyMode === 'adventure' ? 'first' : 'third'");
	});
});
