import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Behaviour of the submission decisions lives in actionInput.test.ts; these checks pin the
// composer's wiring to that server-only path.
const source = readFileSync(resolve('src/lib/components/story/ActionInput.svelte'), 'utf8');
const block = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));

describe('server-only turn submission', () => {
	it('has no browser narration, tool, classifier or background-job path', () => {
		for (const retired of ['streamNarrative', 'continueAfterTools', 'executeToolCall', 'executeWorldUpdate',
			'extractInlineToolCalls', 'GM_TOOLS', 'runBackgroundJobs', 'buildStateSnapshot', 'buildOrchestratorSystemBlocks',
			"story.addEntry('user_action'", "story.addEntry('narration'", 'queueOfflineBackendTurn']) {
			expect(source, retired).not.toContain(retired);
		}
		expect(source).toContain('startServerTurn<BackendAgentRun>');
		expect(source).toContain('story.prepareBackendAgentTurn()');
	});

	it('asks a browser-only save to be imported before play and keeps its draft', () => {
		const submit = block('async function handleSubmit', 'async function submitServerTurn');
		expect(source).toMatch(/const sendBlocked = \$derived\(!online \|\| localOnlyStory/);
		expect(submit.indexOf('sendBlocked) return')).toBeLessThan(submit.indexOf("setInputDraft('')"));
		expect(source).toContain('story.importCurrentStoryToServer()');
		expect(source).toContain('Import and continue');
	});

	it('blocks input while the story server is unreachable', () => {
		expect(source).toContain('storyServerUnavailable');
		expect(source).toContain('!story.engineStreamStatus.connected');
		expect(source).toContain('isTerminalReachabilityError(outcome.error)');
	});

	it('keeps failed sends out of the story transcript', () => {
		const serverTurn = block('async function submitServerTurn', 'function openModeSheet');
		expect(serverTurn).toContain('turnError =');
		expect(serverTurn).not.toContain('story.addEntry');
		expect(source).not.toContain('submitPlayerPlan');
		expect(serverTurn).toContain('restoreSubmittedDraft(submittedStoryId, submittedDraftRevision, submittedInput, submittedActionType)');
	});

	it('sends the selected action mode and keeps prefixed OOC text out of Do formatting', () => {
		const helperSource = readFileSync(resolve('src/lib/components/story/actionInput.ts'), 'utf8');
		expect(helperSource).toContain('isNarrativeControlInput(rawInput)');
		expect(source).toContain("if (turnActionTypeForInput(rawInput, selectedActionType) === 'ooc' || isCreativeMode) return rawInput;");
		expect(block('async function submitServerTurn', 'function openModeSheet'))
			.toContain('actionType: turnActionTypeForInput(submittedInput, submittedActionType)');
	});

	it('returns the move to the composer when an accepted run later fails or is stopped', () => {
		const accept = block('async function acceptAgentRun', '$effect(() => {\n\t\tconst snapshot = agentRun;');
		const failed = accept.slice(accept.indexOf("snapshot.status === 'failed' || snapshot.status === 'cancelled'"));
		expect(failed).toContain('pendingSubmission?.runId === snapshot.id');
		expect(failed).toContain('await restoreSubmittedDraft(submission.storyId, submission.revision, submission.text, submission.actionType)');
		expect(block('async function submitServerTurn', 'function openModeSheet')).toContain('pendingSubmission = { runId: outcome.run.id');
	});

	it('runs post-turn suggestions and images when a run started here completes', () => {
		const accept = block('async function acceptAgentRun', '$effect(() => {\n\t\tconst snapshot = agentRun;');
		expect(accept).toContain('followedAgentRunId === snapshot.id');
		expect(accept).toContain('onTurnEnd?.(turn.narration)');
	});
});
