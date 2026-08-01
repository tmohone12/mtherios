import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('runtime-required turn submission boundary', () => {
	it('does not queue local turns when terminal generation fails', () => {
		const source = readFileSync(resolve('src/lib/components/story/ActionInput.svelte'), 'utf8');

		expect(source).not.toContain('queueOfflineBackendTurn');
		expect(source).not.toContain('queued turn command');
		expect(source).toContain('submitBackendTurn');
	});

	it('blocks backend-bound input while the terminal runtime is unavailable', () => {
		const source = readFileSync(resolve('src/lib/components/story/ActionInput.svelte'), 'utf8');

		expect(source).toContain('terminalRuntimeUnavailable');
		expect(source).toContain('Terminal agent runtime required. Start the terminal process to use this campaign.');
		expect(source).toContain('!story.engineStreamStatus.connected');
		expect(source).toContain('isTerminalReachabilityError');
		expect(source).toContain('Terminal agent runtime required');
		expect(source).toContain('Terminal turn failed');
		expect(source).not.toContain('transcript is available');
	});

	it('does not persist backend turn failures into the story transcript', () => {
		const source = readFileSync(resolve('src/lib/components/story/ActionInput.svelte'), 'utf8');
		const backendTurnBlock = source.slice(
			source.indexOf('async function submitBackendAuthoritativeTurn'),
			source.indexOf('function handleStop'),
		);

		expect(backendTurnBlock).toContain('turnError =');
		expect(backendTurnBlock).not.toContain("await story.addEntry('system'");
	});

	it('clears a submitted draft immediately and restores it only after an untouched failed send', () => {
		const source = readFileSync(resolve('src/lib/components/story/ActionInput.svelte'), 'utf8');
		const submitBlock = source.slice(
			source.indexOf('async function handleSubmit'),
			source.indexOf('async function submitBackendAuthoritativeTurn'),
		);
		const backendTurnBlock = source.slice(
			source.indexOf('async function submitBackendAuthoritativeTurn'),
			source.indexOf('function handleStop'),
		);

		expect(submitBlock.indexOf("setInputDraft('')")).toBeLessThan(submitBlock.indexOf('submitBackendAuthoritativeTurn'));
		expect(submitBlock.indexOf("setInputDraft('')")).toBeLessThan(submitBlock.indexOf("story.addEntry('user_action'"));
		expect(submitBlock).toContain('submitBackendAuthoritativeTurn(content, submittedInput)');
		expect(backendTurnBlock).toContain('draftStoryId === submittedStoryId && draftRevision === submittedDraftRevision');
		expect(backendTurnBlock).toContain('setInputDraft(submittedInput)');
	});
});
