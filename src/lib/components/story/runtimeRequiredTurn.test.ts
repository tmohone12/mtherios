import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('runtime-required turn submission boundary', () => {
	it('does not queue local turns when terminal generation fails', () => {
		const source = readFileSync(resolve('src/lib/components/story/ActionInput.svelte'), 'utf8');

		expect(source).not.toContain('queueOfflineBackendTurn');
		expect(source).not.toContain('queued turn command');
		expect(source).toContain('startBackendAgentRun');
		expect(source).toContain('prepareBackendAgentTurn');
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
		const restoreDraftBlock = source.slice(
			source.indexOf('function restoreSubmittedDraft'),
			source.indexOf('function handleDraftInput'),
		);

		expect(submitBlock.indexOf("setInputDraft('')")).toBeLessThan(submitBlock.indexOf('submitBackendAuthoritativeTurn'));
		expect(submitBlock.indexOf("setInputDraft('')")).toBeLessThan(submitBlock.indexOf("story.addEntry('user_action'"));
		expect(submitBlock).toContain("story.addEntry('user_action', content, undefined, submittedStoryId)");
		expect(submitBlock).toContain('submitBackendAuthoritativeTurn(content, submittedInput, submittedActionType)');
		expect(restoreDraftBlock).toContain('draftStoryId !== storyId || draftRevision !== revision');
		expect(backendTurnBlock).toContain('restoreSubmittedDraft(submittedStoryId, submittedDraftRevision, submittedInput, submittedActionType)');
	});

	it('sends the selected action mode and keeps prefixed OOC text out of Do formatting', () => {
		const source = readFileSync(resolve('src/lib/components/story/ActionInput.svelte'), 'utf8');
		const helperSource = readFileSync(resolve('src/lib/components/story/actionInput.ts'), 'utf8');
		const submitBlock = source.slice(
			source.indexOf('async function handleSubmit'),
			source.indexOf('async function submitBackendAuthoritativeTurn'),
		);
		const backendTurnBlock = source.slice(
			source.indexOf('async function submitBackendAuthoritativeTurn'),
			source.indexOf('function handleStop'),
		);

		expect(source).toContain('turnActionTypeForInput');
		expect(helperSource).toContain('isNarrativeControlInput(rawInput)');
		expect(submitBlock).toContain("turnActionTypeForInput(rawInput, submittedActionType) === 'ooc'");
		expect(submitBlock).toContain('content = rawInput');
		expect(backendTurnBlock).toContain('actionType: turnActionTypeForInput(submittedInput, submittedActionType)');
	});
});
