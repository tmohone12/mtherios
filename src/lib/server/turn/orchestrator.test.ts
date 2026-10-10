import { reuseGenerationResult } from '$lib/server/engine/generationAccounting';
import { emptyServerGenerationUsage } from './provider';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryEngineCacheRepository } from '$lib/server/engine/cache';
import { countTokens } from '$lib/utils/tokens';
import { agentRunHash } from '$lib/server/engine/agentRunHash';
import {
	applyPromptContextBudget,
	actorDecisionCandidates,
	buildAutomaticWikiQuery,
	buildMemoryRetrievalQuery,
	buildSceneLoreQuery,
	buildCampaignContinuityCachePayload,
	buildDeterministicGmToolCalls,
	buildGmTurnReceipt,
	buildResolvedRollNarration,
	buildStateExtractionRepairPrompt,
	buildStateExtractionResponseSchema,
	buildTurnContextReceipt,
	buildTurnPerformanceSummary,
	timingFromResult,
	calculateDynamicContextBudget,
	chaptersForPromptContinuity,
	classifierGenerationMaxTokens,
	classifierRepairGeneration,
	chooseDeterministicEvidenceFollowUp,
	emptyGmTimelineBrief,
	gmToolActivityLabel,
	hasMatchingAgentJevAttempt,
	isCompletePersistedTurnPair,
	isOutOfCharacterTurn,
	loadServerWikiContextWithCache,
	logSlowTurn,
	normalizeGmToolArgs,
	parseGmExplorationPlan,
	parseActiveRecallPlan,
	parseActorDecisionProposal,
	reusableAgentJevDecision,
	parseStateExtractionResult,
	publishDeferredGmReceipt,
	resolveNarrationRoll,
	playerSheetForTurn,
	runGmExplorationLoop,
	shouldExtractDurableState,
	shouldPrefetchWikiContext,
	wikiContextMaxChars,
	shouldQueueChapterSummaryWithoutState,
	shouldRunGmExploration,
	shouldRunActiveRecallInvestigation,
	withBudget,
} from './orchestrator';

describe('planner Jev decision handoff', () => {
	it('reuses an immediate response only for the same action, actor evidence, and model', () => {
		const playerText = 'I accept the captain’s terms.';
		const actorEvidence = { actor: { id: 'captain', name: 'Captain' }, beliefs: [{ id: 'belief_1', belief: 'The route is safe.' }] };
		const sourceIds = ['entry_1', 'belief_1'];
		const selected = { status: 'proposed', purpose: 'immediate_response', actorId: 'captain',
			playerActionHash: agentRunHash(playerText), evidenceHash: agentRunHash({ actorEvidence, sourceIds }),
			decisionTaskVersion: 'immediate_response_v1',
			candidateOptions: [{ id: 'honor_terms', description: 'Honor the agreed passage and arrange boarding.' },
				{ id: 'refuse', description: 'Refuse the agreed passage.' }],
			optionId: 'honor_terms', selectedDescription: 'Honor the agreed passage and arrange boarding.',
			confidence: 0.9, sourceIds: ['captain', 'belief_1'], model: 'typesafe/jev-1.13-20260917',
			configuredModel: 'typesafe/jev-1.13' };
		const input = { rows: [selected], actorId: 'captain', playerText, actorEvidence, sourceIds, model: selected.configuredModel };
		expect(reusableAgentJevDecision(input)?.optionId).toBe('honor_terms');
		expect(reusableAgentJevDecision({ ...input, playerText: 'I reject the terms.' })).toBeNull();
		const answeredActionHash = agentRunHash({ playerText, playerInteractions: [
			{ tool: 'askUserQuestion', callId: 'choice', result: { optionId: 'accept' } },
		] });
		expect(reusableAgentJevDecision({ ...input, playerActionHash: answeredActionHash })).toBeNull();
		expect(reusableAgentJevDecision({ ...input, rows: [{ ...selected, playerActionHash: answeredActionHash }],
			playerActionHash: answeredActionHash })?.optionId).toBe('honor_terms');
		expect(reusableAgentJevDecision({ ...input, actorEvidence: { ...actorEvidence, beliefs: [] } })).toBeNull();
		expect(reusableAgentJevDecision({ ...input, model: 'typesafe/jev-latest' })).toBeNull();
		expect(reusableAgentJevDecision({ ...input, rows: [{ ...selected, purpose: 'other' }] })).toBeNull();
		expect(reusableAgentJevDecision({ ...input, rows: [{ ...selected, candidateOptions: [{ id: 'refuse', description: 'Refuse the agreed passage.' }] }] })).toBeNull();
		expect(reusableAgentJevDecision({ ...input, rows: [{ ...selected, sourceIds: ['secret_other_actor'] }] })).toBeNull();
		const interrupted = { ...selected, status: 'unavailable', networkAttempted: true };
		expect(hasMatchingAgentJevAttempt({ ...input, rows: [interrupted] })).toBe(true);
		expect(hasMatchingAgentJevAttempt({ ...input, rows: [{ ...interrupted, sourceIds: ['secret_other_actor'] }] })).toBe(false);
		expect(hasMatchingAgentJevAttempt({ ...input, rows: [interrupted], playerText: 'I reject the terms.' })).toBe(false);
		expect(hasMatchingAgentJevAttempt({ ...input, rows: [interrupted], playerActionHash: answeredActionHash })).toBe(false);
		expect(hasMatchingAgentJevAttempt({ ...input, rows: [interrupted], actorEvidence: { ...actorEvidence, beliefs: [] } })).toBe(false);
		expect(hasMatchingAgentJevAttempt({ ...input, rows: [interrupted], model: 'typesafe/jev-latest' })).toBe(false);
		expect(hasMatchingAgentJevAttempt({ ...input, rows: [{ ...interrupted, purpose: 'other' }] })).toBe(false);
	});
});

describe('turn-mode routing', () => {
	it('adds the named POV antecedent to a deictic lore search', () => {
		const previous = [{ content: '/pov Daenerys asks Su Lan how they met' }] as any;
		expect(buildMemoryRetrievalQuery('/pov GM research that one, the necklace in Yi Ti', previous))
			.toContain('Daenerys asks Su Lan how they met');
		expect(buildMemoryRetrievalQuery('Find the necklace', [])).toBe('Find the necklace');
	});
	it('anchors ordinary lore searches to the current POV location and parent setting', () => {
		const ctx = { story: { currentLocationId: 'home' }, sceneLocationId: 'market', entities: [{ id: 'home', name: 'Winterfell' }, { id: 'market', name: 'Fish Market' }], locationLore: { chain: [{ name: 'Fish Market' }, { name: 'Volantis' }] } } as any;
		expect(buildSceneLoreQuery(ctx, 'I walk through the market.')).toBe('I walk through the market.\nScene setting: Fish Market; Volantis');
		expect(buildSceneLoreQuery({ ...ctx, sceneLocationId: null, locationLore: { chain: [] } }, 'I wait.')).not.toContain('Winterfell');
		expect(buildAutomaticWikiQuery(ctx, 'I wait.')).toBe('Scene setting: Fish Market; Volantis');
		expect(buildAutomaticWikiQuery(ctx, 'I talk to the merchant.')).toBe(buildAutomaticWikiQuery(ctx, 'I wait.'));
		expect(buildAutomaticWikiQuery(ctx, 'I examine the seal.')).toContain('I examine the seal.');
		expect(buildAutomaticWikiQuery(ctx, 'I travel to Asshai.')).toContain('I travel to Asshai.');
		expect(buildAutomaticWikiQuery({ ...ctx, entities: [...ctx.entities, { id: 'seal', type: 'item', name: 'Obsidian Seal' }] }, 'I touch the Obsidian Seal.')).toContain('I touch the Obsidian Seal.');
		expect(buildAutomaticWikiQuery({ ...ctx, sceneLocationId: null, locationLore: { chain: [] } }, 'I wait.')).toBe('I wait.');
	});

	it('can search lore and then read a discovered page without losing record types or paths', async () => {
		expect(shouldRunActiveRecallInvestigation({ request: { playerText: 'I study the customs of Volantis.' }, retrievedNodeCount: 3, contextSkipped: [] })).toBe(true);
		expect(shouldRunActiveRecallInvestigation({ request: { playerText: 'What can I discover about an unrecorded salt rite?' }, retrievedNodeCount: 3, contextSkipped: [] })).toBe(true);
		const calls = parseActiveRecallPlan(JSON.stringify({ status: 'investigate', reason: 'Need governing lore.', calls: [
			{ command: 'world.record.get', args: { type: 'locations', recordId: 'volantis' } },
			{ command: 'wiki.page', args: { path: 'wiki/locations/volantis.md', vaultPath: 'another-campaign', storyId: 'other' } },
		] }), 2).calls;
		expect(calls[0].args).toEqual({ type: 'locations', recordId: 'volantis' });
		expect(calls[1].args).toEqual({ path: 'wiki/locations/volantis.md' });
		const body = 'Volantis customs. '.repeat(420) + 'Foreign visitors require sponsorship.';
		const observations = await runGmExplorationLoop({
			choose: async round => ({ readyToNarrate: false, calls: round === 1 ? [{ command: 'wiki.search', args: { query: 'Volantis' } }] : [calls[1]] }),
			runTool: async call => call.command === 'wiki.search' ? { results: [{ path: 'wiki/locations/volantis.md' }] } : { path: 'wiki/locations/volantis.md', body, markdown: body, text: body },
			maxRounds: 2,
		});
		expect(observations).toHaveLength(2);
		expect(observations[1].result).toContain('Foreign visitors require sponsorship.');
		expect(observations[1].sourceIds).toContain('wiki/locations/volantis.md');
		expect(observations[1].omissionReason).toBeNull();
	});

	it('counts a campaign-only extraction as an operation rather than discarding it as empty', () => {
		const result = parseStateExtractionResult(JSON.stringify({ update: { campaign_state: [{ key: 'royal_betrothal', kind: 'current', statement: 'The royal betrothal was annulled.', evidence: 'The royal betrothal was annulled.', expected_source_entry_id: null }] } }));
		expect(result.operationCount).toBe(1);
		expect(result.update.campaign_state).toHaveLength(1);
	});
	it('drops an entire location rule when the global prompt budget would cut its qualifier', () => {
		const rule = `Inherited rule: ${'Visitors need sponsorship; '.repeat(240)}except invited guests.`;
		const final = 'Return only GM narration prose for the player action. Do not include JSON, ending choices, numbered options, menus, or OOC notes in this response.';
		const prompt = `<context_data>\n${rule}\n${'Later supporting context. '.repeat(300)}\n</context_data>\n\n${final}`;
		const start = prompt.indexOf(rule);
		const end = start + rule.length;
		let ranges: Array<{ start: number; end: number }> = [];
		const result = applyPromptContextBudget(prompt, 350, retained => { ranges = retained; }, [{ start, end }]);
		expect(result.truncated).toBe(true);
		expect(result.value).not.toContain('Visitors need sponsorship');
		expect(ranges.every(range => Math.min(range.end, end) <= Math.max(range.start, start))).toBe(true);
		expect(countTokens(result.value)).toBeLessThanOrEqual(350);
	});
	it('does not treat a partial or blank persisted turn as a completed generation', () => {
		expect(isCompletePersistedTurnPair({ content: 'I enter.' }, null)).toBe(false);
		expect(isCompletePersistedTurnPair({ content: 'I enter.' }, { content: '   ' })).toBe(false);
		expect(isCompletePersistedTurnPair({ content: 'I enter.' }, { content: 'The hall goes quiet.' })).toBe(true);
	});

	it('recognizes structured and legacy OOC turns without matching ordinary words', () => {
		expect(isOutOfCharacterTurn({ playerText: 'Please correct this.', actionType: 'ooc' })).toBe(true);
		expect(isOutOfCharacterTurn({ playerText: '> I OOC: we are not in Leng.' })).toBe(true);
		expect(isOutOfCharacterTurn({ playerText: 'My OOC: skip this harbor loop.' })).toBe(true);
		expect(isOutOfCharacterTurn({ playerText: 'GM: reset to the emperor\'s offer.' })).toBe(true);
		expect(isOutOfCharacterTurn({ playerText: 'Gm Valarr is about two years old.' })).toBe(true);
		expect(isOutOfCharacterTurn({ playerText: '/pov GM research the necklace.' })).toBe(true);
		expect(isOutOfCharacterTurn({ playerText: '> Game Master: Leng and Yi Ti are separate.' })).toBe(true);
		expect(isOutOfCharacterTurn({ playerText: 'Narrator: correct the location.' })).toBe(true);
		expect(isOutOfCharacterTurn({ playerText: 'I examine the oocyte sample.' })).toBe(false);
		expect(isOutOfCharacterTurn({ playerText: 'I tell the GM of the merchant guild that the levy is late.' })).toBe(false);
	});

	it('prefetches setting lore for ordinary scenes but not OOC controls', () => {
		expect(shouldPrefetchWikiContext({ playerText: 'What do I know about Asshai customs?' })).toBe(true);
		expect(shouldPrefetchWikiContext({ playerText: 'OOC: what do I know about Asshai customs?' })).toBe(false);
		expect(shouldPrefetchWikiContext({ playerText: '> I open the door.', actionType: 'do' })).toBe(true);
		expect(shouldPrefetchWikiContext({ playerText: 'I examine the obsidian seal for maker marks.' }, {
			retrievedNodeCount: 1,
			retrievalTrace: [{ included: true, signals: ['keyword 2.00 (obsidian, seal)'] }],
			mentionedWorldEntityCount: 1,
		})).toBe(true);
	});
	it('keeps ordinary setting lore compact while allowing explicit research more room', () => {
		expect(wikiContextMaxChars({ playerText: 'I enter the harbor.' })).toBe(8_000);
		expect(wikiContextMaxChars({ playerText: 'What do I know about the harbor customs?' })).toBe(24_000);
	});

	it('skips GM exploration for OOC, private thought, routine, and status turns', () => {
		expect(shouldRunGmExploration({ playerText: 'OOC: make the port practical.' })).toBe(false);
		expect(shouldRunGmExploration({ playerText: '> I think to myself: "This is a trap."', actionType: 'think' })).toBe(false);
		expect(shouldRunGmExploration({ playerText: '> I walk back to the ships.', actionType: 'do' })).toBe(false);
		expect(shouldRunGmExploration({ playerText: 'What progress has unloading made?', actionType: 'say' })).toBe(false);
		expect(shouldRunGmExploration({ playerText: '> I negotiate a secret alliance with the harbor master.', actionType: 'do' })).toBe(true);
	});

	it('only requests active recall for a concrete historical gap', () => {
		expect(shouldRunActiveRecallInvestigation({
			request: { playerText: 'I nod to Mira.', actionType: 'do' },
			retrievedNodeCount: 0,
			contextSkipped: [],
		})).toBe(false);
		expect(shouldRunActiveRecallInvestigation({
			request: { playerText: 'Remind Mira what she promised at the docks.', actionType: 'say' },
			retrievedNodeCount: 2,
			contextSkipped: [],
		})).toBe(true);
		expect(shouldRunActiveRecallInvestigation({
			request: { playerText: 'What do I know about the docks?', actionType: 'say' },
			retrievedNodeCount: 0,
			contextSkipped: [{ source: 'memory_retrieval', reason: 'unavailable' }],
		})).toBe(true);
	});

	it('rejects write commands and clamps active recall planner arguments', () => {
		const plan = parseActiveRecallPlan(JSON.stringify({
			status: 'investigate',
			reason: 'The promise condition is absent from prepared memory.',
			calls: [{ command: 'memory.retrieve', args: { query: 'docks promise', limit: 999, includeSecret: false } }],
		}), 1);
		expect(plan.calls).toEqual([{
			command: 'memory.retrieve',
			args: { query: 'docks promise', limit: 12, includeSecret: true },
		}]);
		const history = parseActiveRecallPlan(JSON.stringify({ status: 'investigate', reason: 'Read the old scene.', calls: [
			{ command: 'campaign.entriesAround', args: { position: 417, radius: 99, storyId: 'foreign' } },
			{ command: 'campaign.transcriptPage', args: { cursor: 404, limit: 500 } },
		] }), 2).calls;
		expect(history).toEqual([
			{ command: 'campaign.entriesAround', args: { position: 417, radius: 8 } },
			{ command: 'campaign.transcriptPage', args: { beforePosition: 404, limit: 12 } },
		]);
		expect(() => parseActiveRecallPlan(JSON.stringify({ status: 'investigate', reason: 'Invalid position', calls: [{ command: 'campaign.entriesAround', args: { position: '417' } }] }), 1)).toThrow();
		expect(() => parseActiveRecallPlan(JSON.stringify({
			status: 'investigate', reason: 'write', calls: [{ command: 'world.record.patch', args: {} }],
		}), 1)).toThrow();
	});

	it('isolates actor-decision candidates to pivotal social stakes and validates cited evidence', () => {
		const entities = [
			{ id: 'pc_aurion', type: 'character', name: 'Aurion', state: { isProtagonist: true } },
			{ id: 'npc_mira', type: 'character', name: 'Mira', state: {} },
			{ id: 'npc_lord', type: 'character', name: 'Harbor Lord', state: {} },
		];
		expect(actorDecisionCandidates({ request: { playerText: 'I negotiate with Mira.', actionType: 'say', clientContext: { presentNpcIds: ['npc_lord'], sceneEntityIds: [], threadIds: [] } }, entities }))
			.toEqual([{ id: 'npc_mira', name: 'Mira' }]);
		expect(actorDecisionCandidates({ request: { playerText: 'I negotiate with both of them.', actionType: 'say', clientContext: { presentNpcIds: ['npc_mira', 'npc_lord'], sceneEntityIds: [], threadIds: [] } }, entities }))
			.toEqual([{ id: 'npc_mira', name: 'Mira' }, { id: 'npc_lord', name: 'Harbor Lord' }]);
		expect(actorDecisionCandidates({ request: { playerText: 'I nod to Mira.', actionType: 'do' }, entities })).toEqual([]);
		const accept = { playerText: 'I accept.', actionType: 'do' as const, clientContext: { presentNpcIds: ['npc_mira', 'npc_lord'], sceneEntityIds: [], threadIds: [] } };
		expect(actorDecisionCandidates({ request: accept, entities, recentEntries: [
			{ id: 'offer', type: 'narration', content: 'Mira says “I offer you passage at dawn.” Harbor Lord watches.' },
		] })).toEqual([{ id: 'npc_mira', name: 'Mira', recentOffer: { sourceEntryId: 'offer', speech: 'I offer you passage at dawn.' } }]);
		expect(actorDecisionCandidates({ request: accept, entities, recentEntries: [
			{ id: 'question', type: 'narration', content: 'Mira asks “Will you consider passage?”' },
		] })).toEqual([]);
		expect(actorDecisionCandidates({ request: accept, entities, recentEntries: [
			{ id: 'offers', type: 'narration', content: 'Mira says “I offer passage.” Harbor Lord says “I offer a different ship.”' },
		] })).toEqual([]);
		expect(actorDecisionCandidates({ request: accept, entities, recentEntries: [
			{ id: 'two_terms', type: 'narration', content: 'Mira says “I offer passage.” Mira says “I offer a different ship.”' },
		] })).toEqual([]);
		expect(actorDecisionCandidates({ request: accept, entities, recentEntries: [
			{ id: 'unknown_offer', type: 'narration', content: 'Mira says “I offer passage.” From behind the curtain: “I offer a different ship.”' },
		] })).toEqual([]);
		expect(actorDecisionCandidates({ request: accept, entities, recentEntries: [
			{ id: 'parallel', type: 'narration', content: 'Mira says “I offer passage.”', metadata: { narrativeMode: 'parallel_pov' } },
		] })).toEqual([]);
		expect(parseActorDecisionProposal(JSON.stringify({ status: 'propose', immediateAction: 'Mira names a price.', objective: 'Protect her brother.', condition: 'Only if the ledger is safe.', rationale: 'Her belief and commitment conflict.', knowledgeSourceIds: ['event_ledger'] }), ['event_ledger']).immediateAction)
			.toContain('names a price');
		expect(() => parseActorDecisionProposal(JSON.stringify({ status: 'propose', immediateAction: 'Mira agrees.', objective: 'Win trust.', condition: null, rationale: 'Secret source.', knowledgeSourceIds: ['event_hidden'] }), ['event_ledger'])).toThrow(/outside its isolated actor view/);
	});
});

describe('GM exploration harness', () => {
	const context = (overrides: Record<string, unknown> = {}) => ({
		sceneEntityIds: [],
		presentNpcIds: [],
		threadIds: [],
		...overrides,
	});
	const mira = {
		id: 'npc_mira',
		type: 'character',
		name: 'Mira',
		state: { aliases: ['Harbor Envoy'] },
	};

	it('routes only warranted deterministic reads and never needs an LLM router', async () => {
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I nod to Mira.', actionType: 'do', clientContext: context({ presentNpcIds: ['npc_mira'] }) },
			entities: [mira],
		})).toEqual([]);

		const social = buildDeterministicGmToolCalls({
			request: { playerText: 'I negotiate a secret alliance with Mira.', actionType: 'say', clientContext: context({ presentNpcIds: ['npc_mira'] }) },
			entities: [mira],
			currentTurn: 42,
			retrievedNodeCount: 2,
			wikiPageCount: 1,
		});
		expect(social).toEqual([
			{ command: 'world.affinity.read', args: { actorIds: ['npc_mira'], historyLimit: 6 } },
		]);

		const runTool = vi.fn(async () => ({ affinity: 42 }));
		const choose = vi.fn(async () => ({ readyToNarrate: true, calls: [] }));
		const observations = await runGmExplorationLoop({
			initialCalls: social,
			runTool,
			choose,
			maxRounds: 0,
		});
		expect(observations).toEqual([expect.objectContaining({ command: 'world.affinity.read', round: 0, ok: true })]);
		expect(runTool).toHaveBeenCalledTimes(1);
		expect(choose).not.toHaveBeenCalled();
	});
	it('bounds routine terminal observations before adding them to narration', async () => {
		const observations = await runGmExplorationLoop({
			initialCalls: [{ command: 'world.actor.brief', args: { actorId: 'npc_mira' } }],
			runTool: async () => ({ actor: 'Mira', history: 'old detail '.repeat(2_000) }),
			choose: async () => ({ readyToNarrate: true, calls: [] }),
			maxRounds: 0,
			maxObservationChars: 600,
		});
		expect(observations[0].result.length).toBeLessThanOrEqual(600);
		expect(observations[0].result).toContain('Mira');
	});
	it('reads one transcript neighborhood after a missing-context memory hit without a planner request', async () => {
		const runTool = vi.fn(async (call: { command: string }) => call.command === 'memory.retrieve'
			? { nodes: [{ id: 'transcript_oath', metadata: { sourcePosition: 47 }, content: 'Mira spoke the oath.' }] }
			: { entries: [{ id: 'oath_entry', content: 'Mira spoke the oath beside the river.' }] });
		const observations = await runGmExplorationLoop({
			initialCalls: [{ command: 'memory.retrieve', args: { query: 'earlier oath' } }],
			runTool, choose: async (_round, rows) => chooseDeterministicEvidenceFollowUp(rows), maxRounds: 1, maxCalls: 3,
		});
		expect(observations.map((row) => row.command)).toEqual(['memory.retrieve', 'campaign.entriesAround']);
		expect(observations[1].sourceIds).toContain('oath_entry');
		expect(runTool).toHaveBeenCalledTimes(2);
		expect(chooseDeterministicEvidenceFollowUp([{ command: 'memory.retrieve', args: {}, ok: false, result: 'unavailable', round: 0 }])).toEqual({ readyToNarrate: true, calls: [] });
	});
	it('reads the opening transcript directly for an explicit story-start question', async () => {
		const request = { playerText: 'What happened at the start of the story?', actionType: 'say' as const, clientContext: context() };
		const calls = buildDeterministicGmToolCalls({ request, entities: [], retrievedNodeCount: 0,
			wikiPageCount: 1, researchEnabled: true });
		expect(calls).toEqual([{ command: 'campaign.entriesAround', args: { position: 0, radius: 8 } }]);
		const observations = await runGmExplorationLoop({ initialCalls: calls,
			runTool: async () => ({ entries: [{ id: 'opening_entry', position: 0, content: 'The journey began at the gate.' }] }),
			choose: async () => ({ readyToNarrate: true, calls: [] }), maxRounds: 1 });
		expect(observations[0]).toMatchObject({ command: 'campaign.entriesAround', ok: true, sourceIds: ['opening_entry'] });
		expect(buildDeterministicGmToolCalls({ request, entities: [], retrievedNodeCount: 0,
			wikiPageCount: 1, researchEnabled: false }).some(call => call.command === 'campaign.entriesAround')).toBe(false);
		expect(buildDeterministicGmToolCalls({ request: { ...request,
			playerText: '/pov Mira: What happened at the start of the story?' }, entities: [mira],
			retrievedNodeCount: 0, wikiPageCount: 1, researchEnabled: true })
			.some(call => call.command === 'campaign.entriesAround')).toBe(false);
	});
	it('reads one exact canonical record after a bounded world search', async () => {
		const runTool = vi.fn(async (call: { command: string; args: Record<string, unknown> }) => call.command === 'world.search'
			? { results: [{ recordType: 'factions', recordId: 'ash_court', title: 'Ash Court' }] }
			: { record: { id: 'ash_court', name: 'Ash Court', goal: 'Control the levy.' } });
		const observations = await runGmExplorationLoop({
			initialCalls: [{ command: 'world.search', args: { q: 'Ash Court', limit: 6, includeSemantic: false } }],
			runTool, choose: async (_round, rows) => chooseDeterministicEvidenceFollowUp(rows), maxRounds: 1, maxCalls: 3,
		});
		expect(observations.map((row) => row.command)).toEqual(['world.search', 'world.record.get']);
		expect(runTool.mock.calls[1][0].args).toEqual({ type: 'factions', recordId: 'ash_court' });
		expect(observations[1].result).toContain('Control the levy.');
	});
	it('does not open an arbitrary canonical hit when a search is ambiguous', async () => {
		const runTool = vi.fn(async () => ({ results: [
			{ recordType: 'factions', recordId: 'old_court', title: 'Old Court' },
			{ recordType: 'factions', recordId: 'new_court', title: 'New Court' },
		] }));
		const observations = await runGmExplorationLoop({
			initialCalls: [{ command: 'world.search', args: { q: 'Court', limit: 6 } }],
			runTool, choose: async (_round, rows) => chooseDeterministicEvidenceFollowUp(rows), maxRounds: 1, maxCalls: 3,
		});
		expect(observations.map((row) => row.command)).toEqual(['world.search']);
		expect(runTool).toHaveBeenCalledTimes(1);
	});
	it('opens a unique exact title when related canonical hits also appear', async () => {
		const runTool = vi.fn(async (call: { command: string }) => call.command === 'world.search'
			? { results: [
				{ recordType: 'factions', recordId: 'ash_branch', title: 'Ash Court Branch' },
				{ recordType: 'factions', recordId: 'ash_court', title: 'Ash Court' },
			] }
			: { record: { id: 'ash_court', name: 'Ash Court' } });
		await runGmExplorationLoop({
			initialCalls: [{ command: 'world.search', args: { q: 'Ash Court', limit: 6 } }],
			runTool, choose: async (_round, rows) => chooseDeterministicEvidenceFollowUp(rows), maxRounds: 1, maxCalls: 3,
		});
		expect(runTool.mock.calls[1][0]).toMatchObject({ command: 'world.record.get', args: { type: 'factions', recordId: 'ash_court' } });
	});
	it('reads a named wiki page from a bounded context result', async () => {
		const pagePath = 'wiki/deities/maiden-of-light--1234abcd.md';
		const runTool = vi.fn(async (call: { command: string; args: Record<string, unknown> }) => call.command === 'wiki.context'
			? { contextMarkdown: 'The Maiden of Light appears in a short summary.', pages: [{ path: pagePath }] }
			: { path: pagePath, body: 'The full page names her temple and its festival.' });
		const observations = await runGmExplorationLoop({
			initialCalls: [{ command: 'wiki.context', args: { query: 'Maiden of Light' } }],
			runTool, choose: async (_round, rows) => chooseDeterministicEvidenceFollowUp(rows, 'I study the Maiden of Light.'),
			maxRounds: 1, maxCalls: 3,
		});
		expect(observations.map((row) => row.command)).toEqual(['wiki.context', 'wiki.page']);
		expect(runTool.mock.calls[1][0].args).toEqual({ path: pagePath });
		expect(observations[1].result).toContain('The full page names her temple');
		const saltPath = 'memory/memory-salt-rite--1234abcd.md';
		const saltCalls = buildDeterministicGmToolCalls({
			request: { playerText: 'I study the lore of the Salt Rite.', actionType: 'do', clientContext: context() },
			entities: [], retrievedNodeCount: 1, wikiPageCount: 3,
			wikiPagePaths: ['wiki/locations/great-hall--1234abcd.md'], researchEnabled: true,
		});
		expect(saltCalls).toEqual([{ command: 'wiki.search', args: { query: 'I study the lore of the Salt Rite.', limit: 6, exact: true } }]);
		const saltObservations = await runGmExplorationLoop({ initialCalls: saltCalls,
			runTool: async call => call.command === 'wiki.search' ? { results: [{ path: saltPath }] }
				: { path: saltPath, body: 'The Salt Rite uses brine.' },
			choose: async (_round, rows) => chooseDeterministicEvidenceFollowUp(rows, 'I study the lore of the Salt Rite.'),
			maxRounds: 1, maxCalls: 2,
		});
		expect(saltObservations.map(row => row.command)).toEqual(['wiki.search', 'wiki.page']);
	});
	it('keeps an NPC brief and explicitly named lore page inside the direct read budget', () => {
		const calls = buildDeterministicGmToolCalls({
			request: { playerText: 'I ask Mira about the Salt Rite and offer a deal.', actionType: 'say',
				clientContext: context({ presentNpcIds: ['npc_mira'] }) },
			entities: [mira], currentTurn: 43, beliefActorIds: [], retrievedNodeCount: 1,
			wikiPageCount: 2, wikiPagePaths: ['Characters/Mira.md', 'Lore/Salt_Rite.md'], researchEnabled: true,
		});
		expect(calls.map((call) => call.command)).toEqual(['world.actor.brief', 'wiki.page']);
		expect(calls[1].args).toEqual({ path: 'Lore/Salt_Rite.md' });
		const missingPage = buildDeterministicGmToolCalls({
			request: { playerText: 'I ask Mira about the lore of the Salt Rite and offer a deal.', actionType: 'say',
				clientContext: context({ presentNpcIds: ['npc_mira'] }) },
			entities: [mira], currentTurn: 43, beliefActorIds: [], retrievedNodeCount: 1,
			wikiPageCount: 1, wikiPagePaths: ['Characters/Mira.md'], researchEnabled: true,
		});
		expect(missingPage.map((call) => call.command)).toEqual(['world.actor.brief', 'wiki.search']);
		expect(chooseDeterministicEvidenceFollowUp([{ command: 'wiki.search', args: {}, ok: true,
			result: '', round: 0, wikiPagePaths: ['Characters/Mira.md', 'Lore/Salt_Rite.md'] }],
			'I ask Mira about the Salt Rite.').calls).toEqual([{ command: 'wiki.page', args: { path: 'Lore/Salt_Rite.md' } }]);
	});

	it('selects actor, scene, memory, and wiki tools from concrete context gaps', async () => {
		expect(shouldRunGmExploration({ playerText: 'I call for Mira.' })).toBe(true);
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I call for Mira.', actionType: 'say', clientContext: context() },
			entities: [mira], currentTurn: 43, beliefActorIds: [],
		})[0]).toMatchObject({ command: 'world.actor.brief', args: { actorId: 'npc_mira' } });
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I question Mira about what she believes.', actionType: 'say', clientContext: context({ presentNpcIds: ['npc_mira'] }) },
			entities: [mira],
			currentTurn: 43,
			retrievedNodeCount: 1,
			wikiPageCount: 1,
		})[0]).toMatchObject({ command: 'world.actor.brief', args: { actorId: 'npc_mira' } });

		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I sail across the strait with Mira.', actionType: 'do', clientContext: context({ locationId: 'loc_harbor', presentNpcIds: ['npc_mira'] }) },
			entities: [mira],
			currentLocationId: 'loc_harbor',
		})[0]).toMatchObject({ command: 'world.scene.check', args: { locationId: 'loc_harbor', actorIds: ['npc_mira'] } });

		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'Who told me about the earlier oath?', actionType: 'say', clientContext: context() },
			entities: [],
			retrievedNodeCount: 0,
			wikiPageCount: 1,
			researchEnabled: true,
		})[0]).toMatchObject({ command: 'memory.retrieve' });
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'Who told me about the earlier oath?', actionType: 'say', clientContext: context() },
			entities: [],
			retrievedNodeCount: 2,
			wikiPageCount: 1,
		})).toEqual([]);
		const historyCalls = buildDeterministicGmToolCalls({
			request: { playerText: 'Who told me about the earlier oath?', actionType: 'say', clientContext: context() },
			entities: [], retrievedNodeCount: 2, retrievedTranscriptPosition: 47, wikiPageCount: 1, researchEnabled: true,
		});
		expect(historyCalls).toEqual([{ command: 'campaign.entriesAround', args: { position: 47, radius: 2 } }]);
		const history = await runGmExplorationLoop({ initialCalls: historyCalls,
			runTool: async () => ({ entries: [{ id: 'oath_entry', content: 'Mira spoke the oath.' }] }),
			choose: async () => ({ readyToNarrate: true, calls: [] }), maxRounds: 0 });
		expect(history[0]).toMatchObject({ ok: true, sourceIds: ['oath_entry'] });
		expect(history[0].result).toContain('Mira spoke the oath.');
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'Who told me about the earlier oath?', actionType: 'say', clientContext: context() },
			entities: [], retrievedNodeCount: 2, retrievedTranscriptPosition: 47, wikiPageCount: 1, researchEnabled: false,
		})).toEqual([]);
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'Who told me about the earlier oath?', actionType: 'say', clientContext: context() },
			entities: [], retrievedNodeCount: 0, wikiPageCount: 1, researchEnabled: false,
		})).toEqual([]);

		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I examine the Obsidian Seal for maker marks.', actionType: 'do', clientContext: context() },
			entities: [{ id: 'item_seal', type: 'item', name: 'Obsidian Seal' }],
			retrievedNodeCount: 1,
			researchEnabled: true,
			retrievalTrace: [{ included: true, signals: ['keyword 2.00 (obsidian, seal)'] }],
			wikiPageCount: 0,
		}).map((call) => call.command)).toEqual(['world.search', 'wiki.context']);
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I examine the Obsidian Seal for maker marks.', actionType: 'do', clientContext: context() },
			entities: [{ id: 'item_seal', type: 'item', name: 'Obsidian Seal' }],
			retrievedNodeCount: 1, wikiPageCount: 0, researchEnabled: false,
		}).map((call) => call.command)).toEqual([]);
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I study the lore of the Maiden of Light.', actionType: 'do', clientContext: context() },
			entities: [], retrievedNodeCount: 1, wikiPageCount: 1,
			wikiPagePaths: ['Deities/Maiden_of_Light.md'], researchEnabled: true,
		})).toEqual([{ command: 'wiki.page', args: { path: 'Deities/Maiden_of_Light.md' } }]);
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I study the lore of the Maiden of Light.', actionType: 'do', clientContext: context() },
			entities: [], retrievedNodeCount: 1, wikiPageCount: 1,
			wikiPagePaths: ['wiki/deities/maiden-of-light--1234abcd.md'], researchEnabled: true,
		})).toEqual([{ command: 'wiki.page', args: { path: 'wiki/deities/maiden-of-light--1234abcd.md' } }]);
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I study the lore of the Salt Rite.', actionType: 'do', clientContext: context() },
			entities: [], retrievedNodeCount: 1, wikiPageCount: 1,
			wikiPagePaths: ['memory/memory-salt-rite--1234abcd.md'], researchEnabled: true,
		})).toEqual([{ command: 'wiki.page', args: { path: 'memory/memory-salt-rite--1234abcd.md' } }]);
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I study the lore of the Great Hall.', actionType: 'do', clientContext: context() },
			entities: [{ id: 'hall', type: 'location', name: 'Great Hall' }], retrievedNodeCount: 1,
			wikiPageCount: 1, wikiPagePaths: ['wiki/locations/great-hall--1234abcd.md'], researchEnabled: true,
		})).toEqual([{ command: 'world.search', args: { q: 'Great Hall', limit: 6, includeSemantic: false } }]);
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I study the lore of the Maiden of Light.', actionType: 'do', clientContext: context() },
			entities: [], retrievedNodeCount: 1, wikiPageCount: 1,
			wikiPagePaths: ['Deities/Maiden_of_Light.md'], researchEnabled: false,
		})).toEqual([]);
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I read chapters/chapter-4.md.', actionType: 'do', clientContext: context() },
			entities: [], retrievedNodeCount: 1, wikiPageCount: 1, researchEnabled: true,
		})).toEqual([{ command: 'campaign.page.read', args: { kind: 'chapters', path: 'chapters/chapter-4.md' } }]);
		expect(buildDeterministicGmToolCalls({
			request: { playerText: 'I read raw/turns/old-oath.md.', actionType: 'do', clientContext: context() },
			entities: [], retrievedNodeCount: 1, wikiPageCount: 1, researchEnabled: false,
		})).toEqual([]);
	});

	it('always anchors a parallel POV with the requested actor brief', () => {
		const calls = buildDeterministicGmToolCalls({
			request: { playerText: '/pov Mira', actionType: 'pov', clientContext: context() },
			entities: [mira],
			currentTurn: 44, retrievedTranscriptPosition: 47,
		});
		expect(calls[0]).toEqual({ command: 'world.actor.brief', args: { actorId: 'npc_mira', currentTurn: 44, eventLimit: 10 } });
	});

	it('parses bounded GM tool decisions and keeps canon writes out of the harness', () => {
		expect(parseGmExplorationPlan(JSON.stringify({
			readyToNarrate: false,
			calls: [{ command: 'world.search', args: { q: 'Ash Harbor', limit: 6 } }],
		}))).toEqual({
			readyToNarrate: false,
			calls: [{ command: 'world.search', args: { q: 'Ash Harbor', limit: 6 } }],
		});
		expect(() => parseGmExplorationPlan(JSON.stringify({
			readyToNarrate: false,
			calls: [{ command: 'world.record.patch', args: {} }],
		}))).toThrow();
		expect(() => parseGmExplorationPlan(JSON.stringify({
			readyToNarrate: false,
			calls: [{ command: 'world.character.draftCreate', args: { name: 'Tala Venn' } }],
		}))).toThrow();
		const affinity = parseGmExplorationPlan(JSON.stringify({
			readyToNarrate: false,
			calls: [{ command: 'world.affinity.read', args: { actorNames: ['Mira'] } }],
		})).calls[0]!;
		expect(gmToolActivityLabel(affinity)).toBe('Checking affinity');
		expect(normalizeGmToolArgs({ command: 'campaign.bootstrap', args: { entryLimit: 20, includeSecret: false } })).toEqual({ entryLimit: 20, includeSecret: false });
		expect(normalizeGmToolArgs({ command: 'memory.retrieve', args: { query: 'seal', includeSecret: false } })).toEqual({ query: 'seal', includeSecret: false });
		expect(normalizeGmToolArgs({ command: 'timeline.brief', args: {} })).toEqual({ includeSecret: true });
	});

	it('treats canonical event pages as the full GM event log', () => {
		const plan = parseGmExplorationPlan(JSON.stringify({
			readyToNarrate: false,
			calls: [{ command: 'world.records', args: { type: 'events', q: 'adoption', cursor: null, limit: 50 } }],
		}));

		expect(plan.calls[0]).toEqual({ command: 'world.records', args: { type: 'events', q: 'adoption', cursor: null, limit: 50 } });
		expect(gmToolActivityLabel(plan.calls[0]!)).toBe('Reading the event log');
	});

	it('can choose one follow-up tool when a second round is explicitly allowed', async () => {
		const runTool = vi.fn(async (call: { command: string }) => ({ command: call.command, found: true }));
		const choose = vi.fn(async (round: number, observations: Array<{ command: string }>) => {
			if (round === 1) {
				return parseGmExplorationPlan('{"readyToNarrate":false,"calls":[{"command":"world.search","args":{"q":"Mira"}}]}');
			}
			if (observations[0]?.command === 'world.search') {
				return parseGmExplorationPlan('{"readyToNarrate":false,"calls":[{"command":"world.record.get","args":{"type":"entities","recordId":"mira"}}]}');
			}
			return parseGmExplorationPlan('{"readyToNarrate":true,"calls":[]}');
		});
		const activities: string[] = [];

		const observations = await runGmExplorationLoop({
			choose,
			runTool,
			onActivity: (activity) => { activities.push(activity.stage); },
			maxRounds: 2,
		});

		expect(observations.map((observation) => observation.command)).toEqual(['world.search', 'world.record.get']);
		expect(choose).toHaveBeenCalledTimes(2);
		expect(runTool).toHaveBeenCalledTimes(2);
		expect(activities).toEqual(['planning', 'tool', 'planning', 'tool', 'narrating']);
	});

	it('runs a required Parallel POV actor brief before optional planning and deduplicates it', async () => {
		const runTool = vi.fn(async (call: { command: string; round: number }) => ({ command: call.command, round: call.round, actor: 'Mira' }));
		const choose = vi.fn(async () => parseGmExplorationPlan(JSON.stringify({
			readyToNarrate: false,
			calls: [{ command: 'world.actor.brief', args: { name: 'Mira' } }],
		})));

		const observations = await runGmExplorationLoop({
			initialCalls: [{ command: 'world.actor.brief', args: { name: 'Mira' } }],
			choose,
			runTool,
		});

		expect(observations).toEqual([
			expect.objectContaining({ command: 'world.actor.brief', args: { name: 'Mira' }, ok: true, round: 0 }),
		]);
		expect(runTool).toHaveBeenCalledTimes(1);
		expect(runTool).toHaveBeenCalledWith(expect.objectContaining({ command: 'world.actor.brief', id: 'gm_0_1', round: 0 }));
	});

	it('builds a compact, user-visible receipt without exposing tool results', () => {
		const receipt = buildGmTurnReceipt({
			observations: [{ command: 'world.search', args: { q: 'Mira' }, ok: true, result: '{"secret":"omitted"}', round: 0 }],
			contextReceipt: buildTurnContextReceipt({
				turnId: 'turn_1',
				storyId: 'story_1',
				recentEntryCount: 8,
				memoryNodeCount: 3,
				wikiChunkCount: 2,
				timelineEventCount: 4,
				promptTokens: 2400,
			}),
			statePatchCount: 2,
			eventCount: 1,
			memoryNodeCount: 1,
			stateExtractionMode: 'sync',
			warningCount: 0,
		});

		expect(receipt).toMatchObject({
			tools: [{ command: 'world.search', label: 'Searching canonical world state: Mira', round: 0, ok: true }],
			context: { recentEntries: 8, memoryNodes: 3, wikiChunks: 2, timelineEvents: 4, totalTokens: 2400 },
			changes: { statePatches: 2, events: 1, memoryNodes: 1 },
		});
		expect(JSON.stringify(receipt)).not.toContain('secret');
		expect(receipt.steps.find(step => step.id === 'dialogue')?.status).toBe('skipped');
		expect(receipt.steps.find(step => step.id === 'plot')?.status).toBe('skipped');
		const voiced = buildGmTurnReceipt({ observations: [], contextReceipt: buildTurnContextReceipt({
			turnId: 'turn_2', storyId: 'story_1', recentEntryCount: 1, memoryNodeCount: 0,
			wikiChunkCount: 0, timelineEventCount: 2, promptTokens: 100,
		}),
			statePatchCount: 0, eventCount: 0, memoryNodeCount: 0, stateExtractionMode: 'none',
			dialoguePassStatus: 'fallback', situationSourceCount: 1, locationAnchored: true, plotSourceCount: 2, warningCount: 1 });
		expect(voiced.steps.find(step => step.id === 'dialogue')?.status).toBe('failed');
		expect(voiced.steps.find(step => step.id === 'plot')?.status).toBe('succeeded');
	});

	it('publishes the deferred receipt in the same transaction that makes its job visible', async () => {
		let visibleJob = false;
		let visibleReceipt: ReturnType<typeof buildGmTurnReceipt> | null = null;
		const contextReceipt = buildTurnContextReceipt({ turnId: 'turn_1', storyId: 'story_1' });

		const published = await publishDeferredGmReceipt({
			transaction: async (work) => {
				let stagedJob = false;
				let stagedReceipt: ReturnType<typeof buildGmTurnReceipt> | null = null;
				const result = await work({
					enqueue: async () => {
						stagedJob = true;
						return 'job_extract_1';
					},
					persist: async (receipt) => {
						stagedReceipt = receipt;
						return true;
					},
				});
				expect(visibleJob).toBe(false);
				expect(visibleReceipt).toBeNull();
				visibleJob = stagedJob;
				visibleReceipt = stagedReceipt;
				return result;
			},
			buildReceipt: (jobId) => buildGmTurnReceipt({
				observations: [], contextReceipt, statePatchCount: 0, eventCount: 0, memoryNodeCount: 0,
				stateExtractionMode: 'deferred', stateExtractionStatus: 'queued', stateExtractionJobId: jobId,
				warningCount: 0,
			}),
		});

		expect(visibleJob).toBe(true);
		expect(visibleReceipt).toMatchObject({ stateExtractionStatus: 'queued', stateExtractionJobId: 'job_extract_1' });
		expect(published.receipt).toBe(visibleReceipt);
	});

	it('persists degraded context sources in the GM receipt', () => {
		const contextReceipt = buildTurnContextReceipt({
			turnId: 'turn_1',
			storyId: 'story_1',
			recentEntryCount: 8,
			memoryNodeCount: 0,
			wikiChunkCount: 0,
			timelineEventCount: 0,
			promptTokens: 1200,
			skipped: [
				{ source: 'timeline', reason: 'budget_exceeded' },
				{ source: 'wiki_context', reason: 'unavailable' },
			],
		});
		const receipt = buildGmTurnReceipt({
			observations: [],
			contextReceipt,
			statePatchCount: 0,
			eventCount: 0,
			memoryNodeCount: 0,
			stateExtractionMode: 'none',
			warningCount: 2,
		});

		expect(receipt.steps.find((step) => step.id === 'context')).toMatchObject({
			status: 'failed',
			detail: 'timeline: budget exceeded; wiki context: unavailable',
		});
	});

	it('keeps broad world search results valid, compact, and individually addressable', async () => {
		const hits = Array.from({ length: 12 }, (_, index) => ({
			source: index % 2 ? 'semantic' : 'keyword',
			score: 1 - index / 100,
			recordType: index === 3 ? 'factionProjects' : 'events',
			recordId: `record_${index}`,
			title: `Result ${index}`,
			record: {
				id: `record_${index}`,
				project: index === 3 ? 'Recover the missing harbor ledger before dawn.' : undefined,
				body: index === 3 ? undefined : `Evidence ${index} ${'large raw body '.repeat(300)}`,
				metadata: { raw: 'never include this '.repeat(300) },
			},
		}));
		const observations = await runGmExplorationLoop({
			choose: async () => parseGmExplorationPlan('{"readyToNarrate":false,"calls":[{"command":"world.search","args":{"q":"harbor","limit":12}}]}'),
			runTool: async () => ({ storyId: 'story_1', query: 'harbor', results: hits }),
			maxRounds: 1,
		});
		const serialized = observations[0]!.result;
		const result = JSON.parse(serialized);

		expect(serialized.length).toBeLessThanOrEqual(12_000);
		expect(result).toMatchObject({ resultCount: 12, returnedResultCount: 12, omittedResultCount: 0 });
		expect(result.results.map((row: any) => row.recordId)).toEqual(hits.map((row) => row.recordId));
		expect(result.results[3].snippet).toContain('missing harbor ledger');
		expect(serialized).not.toContain('never include this');
		expect(observations[0]).toMatchObject({
			sourceIds: hits.map((row) => row.recordId),
			omissionReason: null,
			failureReason: null,
		});
	});

	it('reports world search omissions instead of silently chopping JSON', async () => {
		const hits = Array.from({ length: 50 }, (_, index) => ({
			source: 'keyword',
			score: 0.5,
			recordType: 'transcript',
			recordId: `entry_${index}`,
			title: `Transcript ${index}`,
			record: { id: `entry_${index}`, content: `${index} ${'scene evidence '.repeat(200)}` },
		}));
		const observations = await runGmExplorationLoop({
			choose: async () => parseGmExplorationPlan('{"readyToNarrate":false,"calls":[{"command":"world.search","args":{"q":"scene","limit":50}}]}'),
			runTool: async () => ({ storyId: 'story_1', query: 'scene', results: hits }),
			maxRounds: 1,
		});
		const result = JSON.parse(observations[0]!.result);

		expect(result.returnedResultCount + result.omittedResultCount).toBe(50);
		expect(result.omittedResultCount).toBeGreaterThan(0);
		expect(result.results.map((row: any) => row.recordId)).toEqual(hits.slice(0, result.returnedResultCount).map((row) => row.recordId));
	});

	it('stops before starting a bounded tool when the turn is cancelled', async () => {
		const controller = new AbortController();
		controller.abort(new Error('client disconnected'));
		const runTool = vi.fn(async () => ({ ok: true }));

		await expect(runGmExplorationLoop({
			initialCalls: [{ command: 'world.search', args: { q: 'harbor' } }],
			choose: async () => ({ readyToNarrate: true, calls: [] }),
			runTool,
			signal: controller.signal,
		})).rejects.toThrow('client disconnected');
		expect(runTool).not.toHaveBeenCalled();
	});
});

describe('turn orchestrator prompt budgeting', () => {
	it('uses the protagonist sheet instead of the first NPC sheet and supports imported stats', () => {
		const npc = { id: 'npc', type: 'character', status: 'active', state: { playerSheet: { abilities: { dex: 30 } } }, metadata: {} };
		const player = { id: 'player', type: 'character', status: 'active', state: { relationship: { status: 'self' } }, metadata: { originalMetadata: { playerSheet: { abilities: { dex: 16 } } } } };
		expect(playerSheetForTurn({ entities: [npc, player] as any })).toEqual({ abilities: { dex: 16 } });
		expect(playerSheetForTurn({ entities: [npc] as any })).toBeNull();
	});
	it('resolves a narrator roll request into the existing dice card format', () => {
		expect(resolveNarrationRoll('No check is needed.')).toBeNull();
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.95);
		try {
			const resolved = resolveNarrationRoll('The lock resists.\n\n{{roll:1d20+2:15:Dexterity:Pick the lock}}');

			expect(resolved).toMatchObject({
				preText: 'The lock resists.',
				rollSummary: expect.stringContaining('SUCCESS'),
			});
			expect(resolved?.diceMarker).toBe('{{dice:1d20+2|20|22|15|pass|Dexterity|Pick the lock|crit-success}}');
		} finally {
			random.mockRestore();
		}
	});

	it('uses the saved protagonist ability score instead of an AI-supplied modifier', () => {
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.95);
		try {
			const resolved = resolveNarrationRoll('{{roll:1d20+99:15:Stealth:Slip past the guard}}', { abilities: { dex: 16 } });
			expect(resolved?.diceMarker).toBe('{{dice:1d20+3|20|23|15|pass|Stealth|Slip past the guard|crit-success}}');
		} finally {
			random.mockRestore();
		}
	});

	it('keeps pre-roll prose and the resolved dice marker when continuation is unavailable', () => {
		const roll = {
			preText: 'The lock resists.',
			diceMarker: '{{dice:1d20+2|14|16|15|pass|Dexterity|Pick the lock|none}}',
		};
		expect(buildResolvedRollNarration(roll)).toBe([
			'The lock resists.',
			'{{dice:1d20+2|14|16|15|pass|Dexterity|Pick the lock|none}}',
		].join('\n\n'));
		expect(buildResolvedRollNarration(roll, 'The tumblers give way.')).toContain('The tumblers give way.');
	});

	it('keeps chapter cadence alive when a committed turn has no state patch', () => {
		expect(shouldQueueChapterSummaryWithoutState('none', { eventIds: 0, memoryNodeIds: 0, patchIds: 0 })).toBe(true);
		expect(shouldQueueChapterSummaryWithoutState('sync', { eventIds: 0, memoryNodeIds: 0, patchIds: 0 })).toBe(true);
		expect(shouldQueueChapterSummaryWithoutState('deferred', { eventIds: 0, memoryNodeIds: 0, patchIds: 0 })).toBe(false);
		expect(shouldQueueChapterSummaryWithoutState('sync', { eventIds: 1, memoryNodeIds: 0, patchIds: 0 })).toBe(false);
	});

	it('keeps only chapters not represented by an arc for prompt continuity', () => {
		const chapters = [
			{ id: 'chapter_1', title: 'Old Covered' },
			{ id: 'chapter_2', title: 'Recent Covered' },
			{ id: 'chapter_3', title: 'Newest Covered' },
			{ id: 'chapter_4', title: 'Current Loose Chapter' },
		];

		expect(chaptersForPromptContinuity(chapters, [
			{ chapterIds: ['chapter_1', 'chapter_2', 'chapter_3'] },
		])).toEqual([
			{ id: 'chapter_4', title: 'Current Loose Chapter' },
		]);
	});

	it('keeps complete chapter and arc accounts in the continuity cache payload', () => {
		const payload = buildCampaignContinuityCachePayload({
			chapters: [
				{
					id: 'chapter_1',
					number: 1,
					title: 'Covered',
					sceneOutcome: 'Covered chapter details should not be serialized.',
					openThreads: [],
					updatedAt: '2026-05-23T12:00:00.000Z',
				},
				{
					id: 'chapter_2',
					number: 2,
					title: 'Loose',
					sceneOutcome: 'Loose chapter fact survives.',
					openThreads: ['Loose thread survives.'],
					updatedAt: '2026-05-23T12:00:00.000Z',
				},
			],
			arcs: [
				{
					id: 'arc_1',
					number: 1,
					title: 'Covered Arc',
					summary: `Arc cache opening survives. ${'raw chapter wall '.repeat(5000)} Arc cache tail sentinel.`,
					chapterIds: ['chapter_1'],
					openThreadIds: [`thread opening ${'thread filler '.repeat(2000)} thread cache tail sentinel`],
					metadata: { giant: 'metadata should not enter cache payload'.repeat(1000) },
					updatedAt: '2026-05-23T12:00:00.000Z',
				},
			],
			sagas: [],
		} as any);
		const serialized = JSON.stringify(payload);

		expect(payload.chapters).toEqual([
			expect.objectContaining({ id: 'chapter_2', sceneOutcome: 'Loose chapter fact survives.' }),
		]);
		expect(serialized).toContain('Arc cache opening survives.');
		expect(serialized).not.toContain('Covered chapter details should not be serialized.');
		expect(serialized).toContain('Arc cache tail sentinel');
		expect(serialized).toContain('thread cache tail sentinel');
		expect(serialized).not.toContain('metadata should not enter cache payload');
	});

	it('keeps unbounded dynamic prompt text unchanged', () => {
		const prompt = 'A'.repeat(5000);

		expect(applyPromptContextBudget(prompt, 0)).toEqual({
			value: prompt,
			truncated: false,
			mappings: [{ sourceStart: 0, sourceEnd: prompt.length, targetStart: 0, targetEnd: prompt.length }],
		});
		expect(applyPromptContextBudget(prompt, 6000)).toEqual({
			value: prompt,
			truncated: false,
			mappings: [{ sourceStart: 0, sourceEnd: prompt.length, targetStart: 0, targetEnd: prompt.length }],
		});
	});

	it('bounds dynamic prompt text while preserving the final narration instruction', () => {
		const finalInstruction = 'Return only GM narration prose for the player action. Do not include JSON, ending choices, numbered options, menus, or OOC notes in this response.';
		const prompt = [
			'<context_data>',
			'Story: Long Campaign',
			'STRATEGIC WORLD PRESSURE: opening pressure survives.',
			'Faction canon:',
			'House detail. '.repeat(500),
			'GM TIMELINE: tail pressure survives.',
			'</context_data>',
			finalInstruction,
		].join('\n\n');

		const result = applyPromptContextBudget(prompt, 300);

		expect(result.truncated).toBe(true);
		expect(countTokens(result.value)).toBeLessThanOrEqual(300);
		expect(result.value).toContain('Backend context budget truncated');
		expect(result.value).toContain('</context_data>');
		expect(result.value).toContain('STRATEGIC WORLD PRESSURE: opening pressure survives.');
		expect(result.value).toContain('GM TIMELINE: tail pressure survives.');
		expect(result.value.endsWith(finalInstruction)).toBe(true);
	});

	it('reuses wiki context when cached source hashes still match', async () => {
		const repository = createMemoryEngineCacheRepository();
		let loadCount = 0;

		const first = await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			loadContext: async () => {
				loadCount += 1;
				return {
					contextMarkdown: '# Wiki Context\nMira knows the harbor.',
					citations: ['[1] Mira <wiki/mira.md>'],
					pageCount: 1,
					seedCount: 1,
					pages: [{ path: 'wiki/mira.md', updatedAt: '2026-06-06T00:00:00.000Z' }],
				};
			},
			sourceHash: async (sourcePaths) => sourcePaths.map((sourcePath) => `${sourcePath}:hash-a`),
		});
		const second = await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			loadContext: async () => {
				loadCount += 1;
				return {
					contextMarkdown: '# Wiki Context\nThis should not be loaded.',
					citations: [],
					pageCount: 0,
					seedCount: 0,
					pages: [],
				};
			},
			sourceHash: async (sourcePaths) => sourcePaths.map((sourcePath) => `${sourcePath}:hash-a`),
		});

		expect(loadCount).toBe(1);
		expect(first.cacheHit).toBe(false);
		expect(second.cacheHit).toBe(true);
		expect(second.markdown).toBe('# Wiki Context\nMira knows the harbor.');
		expect(second.citations).toEqual(['[1] Mira <wiki/mira.md>']);
	});

	it('reloads wiki context when cached source hashes change', async () => {
		const repository = createMemoryEngineCacheRepository();
		let loadCount = 0;
		let currentHash = 'hash-a';
		const loadContext = async () => {
			loadCount += 1;
			return {
				contextMarkdown: `# Wiki Context\nVersion ${loadCount}.`,
				citations: ['[1] Mira <wiki/mira.md>'],
				pageCount: 1,
				seedCount: 1,
				pages: [{ path: 'wiki/mira.md', updatedAt: `2026-06-06T00:00:0${loadCount}.000Z` }],
			};
		};
		const sourceHash = async (sourcePaths: string[]) => sourcePaths.map((sourcePath) => `${sourcePath}:${currentHash}`);

		await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			loadContext,
			sourceHash,
		});
		currentHash = 'hash-b';
		const second = await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			loadContext,
			sourceHash,
		});

		expect(loadCount).toBe(2);
		expect(second.cacheHit).toBe(false);
		expect(second.markdown).toBe('# Wiki Context\nVersion 2.');
	});

	it('returns cached wiki context without waiting for vault refresh', async () => {
		const repository = createMemoryEngineCacheRepository();
		const sourceHash = async (sourcePaths: string[]) => sourcePaths.map((sourcePath) => `${sourcePath}:hash-a`);
		await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			sourceHash,
			loadContext: async () => ({
				contextMarkdown: '# Wiki Context\nCached harbor context.',
				citations: [],
				pageCount: 1,
				seedCount: 1,
				pages: [{ path: 'wiki/mira.md' }],
			}),
		});
		let refreshStarted = false;

		const cached = await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			sourceHash,
			refreshVault: () => {
				refreshStarted = true;
				return new Promise(() => undefined);
			},
			loadContext: async () => { throw new Error('cache should be used'); },
		});

		expect(refreshStarted).toBe(true);
		expect(cached.cacheHit).toBe(true);
		expect(cached.markdown).toContain('Cached harbor context.');
	});

	it('keeps wiki inspection read-only when no cached pack exists', async () => {
		const repository = createMemoryEngineCacheRepository();
		let refreshed = false;
		const inspected = await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			inspection: true,
			refreshVault: async () => { refreshed = true; },
			loadContext: async () => ({
				contextMarkdown: '# Wiki Context\nRead-only inspection.',
				citations: ['[1] Mira <wiki/mira.md>'],
				pageCount: 1,
				seedCount: 1,
				pages: [{ path: 'wiki/mira.md' }],
			}),
		});

		expect(inspected.markdown).toContain('Read-only inspection.');
		expect(refreshed).toBe(false);
		expect(await repository.listByStory('story_alpha')).toEqual([]);
	});

	it('returns a fallback when optional turn context exceeds its budget', async () => {
		vi.useFakeTimers();
		try {
			const resultPromise = withBudget(
				() => new Promise<string>((resolve) => setTimeout(() => resolve('loaded'), 1_000)),
				25,
				'fallback',
			);

			await vi.advanceTimersByTimeAsync(25);

			await expect(resultPromise).resolves.toBe('fallback');
		} finally {
			vi.useRealTimers();
		}
	});

	it('builds a strict state extraction response schema', () => {
		const responseSchema = buildStateExtractionResponseSchema();

		expect(responseSchema).toMatchObject({
			name: 'mtherios_state_patch',
			strict: true,
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['update', 'dueEventFeedback'],
				properties: {
					dueEventFeedback: { type: 'array' },
					update: {
						type: 'object',
						properties: {
							characters: { type: 'array' },
							timeline_events: { type: 'array' },
						},
					},
				},
			},
		});
		expect(responseSchema.schema).not.toHaveProperty('$schema');
	});
	it('keeps a feedback-only classifier response even when there is no state patch', () => {
		const parsed = parseStateExtractionResult(JSON.stringify({ update: {}, dueEventFeedback: [
			{ id: 'event_harbor', outcome: 'realized', evidenceSpan: 'The harbor guard closes the gate.' },
		] }));
		expect(parsed.operationCount).toBe(0);
		expect(parsed.dueEventFeedback).toEqual([
			{ id: 'event_harbor', outcome: 'realized', evidenceSpan: 'The harbor guard closes the gate.' },
		]);
	});
	it('accepts spanless deferred feedback without relaxing surfaced evidence', () => {
		const parsed = parseStateExtractionResult(JSON.stringify({ update: { characters: [{ name: 'Mara', present: true }] }, dueEventFeedback: [
			{ id: 'event_later', outcome: 'deferred' },
			{ id: 'event_unclear', outcome: 'uncertain', evidenceSpan: null },
		] }));
		expect(parsed.dueEventFeedback).toEqual([
			{ id: 'event_later', outcome: 'deferred', evidenceSpan: '' },
			{ id: 'event_unclear', outcome: 'uncertain', evidenceSpan: '' },
		]);
		expect(parsed.update.characters?.[0]).toMatchObject({ name: 'Mara', present: true });
		expect(() => parseStateExtractionResult(JSON.stringify({ update: {}, dueEventFeedback: [
			{ id: 'event_now', outcome: 'realized' },
		] }))).toThrow(/evidenceSpan/);
		expect(() => parseStateExtractionResult(JSON.stringify({ update: {}, dueEventFeedback: [
			{ id: 'cue_now', outcome: 'signal' },
		] }))).toThrow(/evidenceSpan/);
	});
	it('normalizes exact feedback aliases while rejecting unknown outcomes', () => {
		const parsed = parseStateExtractionResult(JSON.stringify({ update: {}, dueEventFeedback: [
			{ eventId: 'event_later', status: 'deferred' },
		] }));
		expect(parsed.dueEventFeedback).toEqual([{ id: 'event_later', outcome: 'deferred', evidenceSpan: '' }]);
		expect(() => parseStateExtractionResult(JSON.stringify({ update: {}, dueEventFeedback: [
			{ eventId: 'event_later', status: 'done' },
		] }))).toThrow(/outcome/);
	});
	it('normalizes identifiable singleton and keyed feedback without accepting unlinked realization', () => {
		expect(parseStateExtractionResult(JSON.stringify({ update: {}, dueEventFeedback: {
			eventId: 'event_later', status: 'deferred',
		} })).dueEventFeedback).toEqual([{ id: 'event_later', outcome: 'deferred', evidenceSpan: '' }]);
		expect(parseStateExtractionResult(JSON.stringify({ update: {}, dueEventFeedback: {
			event_later: { status: 'deferred' }, event_soon: { status: 'uncertain' },
		} })).dueEventFeedback).toEqual([
			{ id: 'event_later', outcome: 'deferred', evidenceSpan: '' },
			{ id: 'event_soon', outcome: 'uncertain', evidenceSpan: '' },
		]);
		expect(parseStateExtractionResult(JSON.stringify({ update: {}, dueEventFeedback: { status: 'uncertain', evidenceSpan: '' } })).dueEventFeedback).toEqual([]);
		expect(() => parseStateExtractionResult(JSON.stringify({ update: {}, dueEventFeedback: { status: 'realized', evidenceSpan: 'The gate closed.' } }))).toThrow(/dueEventFeedback/);
		expect(() => parseStateExtractionResult(JSON.stringify({ update: {}, dueEventFeedback: {
			event_later: { status: 'realized' },
		} }))).toThrow(/evidenceSpan/);
	});

	it('rejects empty or malformed classifier output before it can be logged as success', () => {
		expect(() => parseStateExtractionResult('')).toThrow(/empty state extraction response/i);
		expect(() => parseStateExtractionResult('{')).toThrow();
		expect(() => parseStateExtractionResult('{"update":{"characters":"not-an-array"}}'))
			.toThrow(/invalid state extraction response/i);

		expect(parseStateExtractionResult('{"update":{"characters":[]}}')).toMatchObject({
			operationCount: 0,
			warnings: [],
		});
	});

	it('uses one lower-reasoning repair when extraction exhausts its output limit', () => {
		expect(classifierRepairGeneration({ maxTokens: 4096, reasoningEffort: 'high' }, { finishReason: 'length' }))
			.toEqual({ maxTokens: 8192, reasoningEffort: 'low' });
	});

	it('builds a compact classifier repair and accepts common safe provider variants', () => {
		const prompt = buildStateExtractionRepairPrompt({
			playerText: 'I hand Mira the seal.',
			narration: 'Mira accepts it.',
			attemptedOutput: '',
			validationError: 'empty response',
		});
		expect(prompt).toContain('Prior output:\n(empty)');
		expect(prompt).toContain('Validation error: empty response');
		expect(prompt).not.toContain('exact JSON Schema');
		expect(parseStateExtractionResult('{"update":{"update":{"characters":[{"name":"Mira","status":"dead"}]}}}').update.characters)
			.toEqual([expect.objectContaining({ name: 'Mira', status: 'deceased' })]);
	});

	it('keeps authoritative story time in an empty timeline fallback', () => {
		expect(emptyGmTimelineBrief('story_alpha', 151, 'Second bell')).toMatchObject({
			storyId: 'story_alpha',
			currentTurn: 151,
			currentWorldTime: 'Second bell',
			dueEvents: [],
		});
	});

	it('normalizes safe provider variants of the characters collection', () => {
		expect(parseStateExtractionResult('{"update":{"characters":{"name":"Amaterasu","present":true,"eventMemory":{"did":"Amaterasu refused the demand."}}}}').update.characters)
			.toEqual([expect.objectContaining({ name: 'Amaterasu', present: true, eventMemory: expect.objectContaining({ did: ['Amaterasu refused the demand.'] }) })]);
		expect(parseStateExtractionResult('{"update":{"characters":{"Amaterasu":{"present":true},"Vael":{"present":false}}}}').update.characters)
			.toEqual([
				expect.objectContaining({ name: 'Amaterasu', present: true }),
				expect.objectContaining({ name: 'Vael', present: false }),
			]);
		expect(parseStateExtractionResult('{"update":{"characters":{}}}')).toMatchObject({ operationCount: 0 });
		expect(() => parseStateExtractionResult('{"update":{"characters":{"Amaterasu":"present"}}}'))
			.toThrow(/invalid state extraction response/i);
		expect(parseStateExtractionResult('{"update":{"locations":{"name":"Inner Residence","current":true},"relationships":{"from":"Vael","to":"Amaterasu","type":"intimate"}}}').update)
			.toMatchObject({
				locations: [expect.objectContaining({ name: 'Inner Residence', current: true })],
				relationships: [expect.objectContaining({ sourceName: 'Vael', targetName: 'Amaterasu', type: 'related-to', label: 'intimate' })],
			});
		expect(parseStateExtractionResult('{"update":{"location":{"name":"Inner Residence","current":true}}}').update.locations)
			.toEqual([expect.objectContaining({ name: 'Inner Residence', current: true })]);
	});

	it('uses configured classifier tokens', () => {
		expect(classifierGenerationMaxTokens({ maxTokens: 4096 })).toBe(4096);
		expect(classifierGenerationMaxTokens({})).toBe(2048);
	});

	it('reserves provider output and framing before allocating dynamic context', () => {
		expect(calculateDynamicContextBudget({
			contextWindowTokens: 8_192,
			fixedInputTokens: 2_000,
			outputReserveTokens: 2_000,
		})).toEqual({ maxDynamicContextTokens: 3_680, availableTokens: 3_680, clamped: false });
		expect(calculateDynamicContextBudget({
			contextWindowTokens: 8_192,
			configuredContextBudget: 12_000,
			fixedInputTokens: 2_000,
			outputReserveTokens: 2_000,
		})).toEqual({ maxDynamicContextTokens: 3_680, availableTokens: 3_680, clamped: true });
	});

	it('skips extraction only for explicit durable no-op turns', () => {
		expect(shouldExtractDurableState(
			'I wait and watch.',
			'Nothing lasting changes; the hall remains as it was.',
		)).toBe(false);
		expect(shouldExtractDurableState(
			'I hand Mara the sealed letter.',
			'Mara accepts the letter and promises to carry it to the harbor.',
		)).toBe(true);
	});

	it('builds turn waterfall diagnostics for generation speed debugging', () => {
		const summary = buildTurnPerformanceSummary({
			turnId: 'turn-1',
			storyId: 'story-alpha',
			totalMs: 1962,
			model: 'gpt-test',
			profile: 'openai',
			stateExtractionMode: 'deferred',
			stablePromptHash: 'stable-hash',
			dynamicContextHash: 'dynamic-hash',
			recentMessageCount: 8,
			wikiChunkCount: 2,
			memoryItemCount: 3,
			preparedCacheHit: true,
			prompt: {
				tokenEstimate: 1663,
				totalChars: 6652,
				messageCount: 12,
			},
			cache: {
				hitCount: 3,
				missCount: 1,
				tokenEstimate: 2400,
				segments: [
					{ kind: 'prompt_system', cacheKey: 'cache-system', hit: true, invalidated: false, tokenEstimate: 800, contentHash: 'hash-a' },
					{ kind: 'retrieved_memory', cacheKey: 'cache-memory', hit: false, invalidated: false, tokenEstimate: 1600, contentHash: 'hash-b' },
				],
			},
			generationTimings: [
				{ operation: 'turn.narration', serviceId: 'narrative', model: 'gpt-test', status: 'success', durationMs: 900, timeToFirstTokenMs: 123, retryCount: 2, requestTokens: 1000, responseTokens: 150, totalTokens: 1150, providerCostUsd: 0.012 },
				{ operation: 'turn.state_extraction', serviceId: 'classifier', model: 'gpt-test-mini', status: 'success', durationMs: 320, timeToFirstTokenMs: null, retryCount: 0, requestTokens: 300, responseTokens: 40, totalTokens: 340, providerCostUsd: 0.003 },
			],
			timings: [
				{ phase: 'turn.service_config.narrative', durationMs: 40 },
				{ phase: 'turn.context_assembly', durationMs: 410, metadata: { parallel: true } },
				{ phase: 'turn.memory_retrieval', durationMs: 120 },
				{ phase: 'turn.context_load', durationMs: 80 },
				{ phase: 'turn.gm_timeline_brief', durationMs: 260 },
				{ phase: 'turn.wiki_context', durationMs: 700 },
				{ phase: 'turn.prompt_assembly', durationMs: 12 },
				{ phase: 'turn.persistence.allocate_position_version', durationMs: 20 },
				{ phase: 'turn.persistence.entries', durationMs: 60 },
				{ phase: 'turn.state_extraction.enqueue', durationMs: 15 },
				{ phase: 'turn.campaign_vault.append_evidence', durationMs: 180 },
				{ phase: 'turn.final_response.readback', durationMs: 275 },
			],
			slowTimingThresholdMs: 250,
		});

		expect(summary).toEqual({
			preparedCacheHit: true,
			prompt: {
				tokenEstimate: 1663,
				totalChars: 6652,
				messageCount: 12,
			},
			cache: {
				hitCount: 3,
				missCount: 1,
				tokenEstimate: 2400,
				segmentCount: 2,
			},
			generation: {
				operationCount: 2,
				durationMs: 1220,
				requestTokens: 1300,
				responseTokens: 190,
				totalTokens: 1490,
				cachedInputTokens: null,
				cacheWriteTokens: null,
				providerCostUsd: 0.015,
			},
			waterfall: {
				turnId: 'turn-1',
				storyId: 'story-alpha',
				model: 'gpt-test',
				profile: 'openai',
				totalMs: 1962,
				frontendOutboxFlushMs: null,
				commandRouterMs: null,
				resolveNarrativeMs: 40,
				retrieveMemoryPacketMs: 120,
				loadDbContextMs: 80,
				loadTimelineBriefMs: 260,
				loadWikiContextMs: 700,
				buildPromptMs: 12,
				inputTokens: 1300,
				outputTokens: 190,
				promptBytes: 6652,
				recentMessageCount: 8,
				wikiChunkCount: 2,
				memoryItemCount: 3,
				providerTimeToFirstTokenMs: 123,
				providerTotalMs: 900,
				providerRetries: 2,
				providerTimeoutHit: false,
				persistMs: 80,
				stateExtractionMode: 'deferred',
				stateExtractionMs: 15,
				vaultAppendMs: 180,
				projectionBuildMs: 275,
				cacheHit: true,
				stablePromptHash: 'stable-hash',
				dynamicContextHash: 'dynamic-hash',
			},
			topSpans: [
				{ operation: 'turn.wiki_context', durationMs: 700 },
				{ operation: 'turn.context_assembly', durationMs: 410 },
				{ operation: 'turn.final_response.readback', durationMs: 275 },
				{ operation: 'turn.gm_timeline_brief', durationMs: 260 },
				{ operation: 'turn.campaign_vault.append_evidence', durationMs: 180 },
				{ operation: 'turn.memory_retrieval', durationMs: 120 },
				{ operation: 'turn.context_load', durationMs: 80 },
				{ operation: 'turn.persistence.entries', durationMs: 60 },
			],
			slowTimings: [
				{ operation: 'turn.wiki_context', durationMs: 700 },
				{ operation: 'turn.context_assembly', durationMs: 410 },
				{ operation: 'turn.final_response.readback', durationMs: 275 },
				{ operation: 'turn.gm_timeline_brief', durationMs: 260 },
			],
		});
	});

	it('builds context receipts that show included, skipped, and budgeted turn inputs', () => {
		const receipt = buildTurnContextReceipt({
			turnId: 'turn-1',
			storyId: 'story-alpha',
			truncated: true,
			recentEntryCount: 12,
			memoryNodeCount: 8,
			wikiChunkCount: 3,
			timelineEventCount: 5,
			chapterCount: 4,
			arcCount: 2,
			chaptersSuppressedByArcs: 9,
			promptChars: 62000,
			promptTokens: 15500,
			factCount: 4,
			patchProposalCount: 7,
			unresolvedCharacterReferenceCount: 2,
			continuityWarningCount: 1,
			factionIds: ['faction_red_sails'],
			skipped: [
				{ source: 'wiki', reason: 'budget_exceeded' },
				{ source: 'recent_transcript', reason: 'entry_limit' },
			],
			unresolvedCharacterReferences: [
				{
					proposalId: 'proposal_hooded_envoy',
					name: 'Hooded Envoy',
					contextLabel: 'faction_member/Red Sails',
					reason: 'Faction member named in "Red Sails".',
					sourceEntryIds: ['entry_12'],
				},
			],
			continuityLedger: {
				facts: [
					{
						id: 'fact_red_sails_oath',
						statement: 'The Red Sails swore to blockade the harbor.',
						sourceEntryIds: ['entry_10'],
						sourcePatchIds: ['patch_fact_1'],
					},
				],
				patchProposals: [
					{
						id: 'proposal_harbor_blockade',
						status: 'pending',
						proposalType: 'turn_event',
						targetTable: 'events',
						targetRecordId: 'event_harbor_blockade',
						reason: 'Narration introduced a delayed blockade consequence.',
						sourceEntryIds: ['entry_11'],
						sourcePatchIds: ['patch_event_1'],
					},
				],
				warnings: [
					{
						id: 'warning_timeline_overlap',
						level: 'warning',
						status: 'open',
						title: 'Timeline overlap',
						sourceEntryIds: ['entry_12'],
						sourcePatchIds: ['patch_warning_1'],
					},
				],
			},
			cacheSegments: [
				{
					kind: 'prompt_system',
					cacheKey: 'engine-cache:story-alpha:prompt_system:stable',
					contentHash: 'hash-system',
					hit: true,
					invalidated: false,
					tokenEstimate: 640,
					dependencyCount: 2,
				},
			],
			budgets: {
				memoryTokensUsed: 780,
				memoryTokensMax: 800,
				wikiCharsUsed: 3900,
				wikiCharsMax: 4000,
			},
		});

		expect(receipt).toEqual({
			turnId: 'turn-1',
			storyId: 'story-alpha',
			truncated: true,
			included: {
				recentEntries: 12,
				memoryNodes: 8,
				wikiChunks: 3,
				timelineEvents: 5,
				chapters: 4,
				arcs: 2,
				chaptersSuppressedByArcs: 9,
				chaptersSent: 4,
				arcsSent: 2,
				chaptersSuppressedByArc: 9,
				memoryNodesSent: 8,
				totalChars: 62000,
				totalTokens: 15500,
				facts: 4,
				patchProposals: 7,
				unresolvedCharacterReferences: 2,
				continuityWarnings: 1,
				factionSheets: ['faction_red_sails'],
			},
			skipped: [
				{ source: 'wiki', reason: 'budget_exceeded' },
				{ source: 'recent_transcript', reason: 'entry_limit' },
			],
			unresolvedCharacterReferences: [
				{
					proposalId: 'proposal_hooded_envoy',
					name: 'Hooded Envoy',
					contextLabel: 'faction_member/Red Sails',
					reason: 'Faction member named in "Red Sails".',
					sourceEntryIds: ['entry_12'],
				},
			],
			continuityLedger: {
				facts: [
					{
						id: 'fact_red_sails_oath',
						statement: 'The Red Sails swore to blockade the harbor.',
						sourceEntryIds: ['entry_10'],
						sourcePatchIds: ['patch_fact_1'],
					},
				],
				patchProposals: [
					{
						id: 'proposal_harbor_blockade',
						status: 'pending',
						proposalType: 'turn_event',
						targetTable: 'events',
						targetRecordId: 'event_harbor_blockade',
						reason: 'Narration introduced a delayed blockade consequence.',
						sourceEntryIds: ['entry_11'],
						sourcePatchIds: ['patch_event_1'],
					},
				],
				warnings: [
					{
						id: 'warning_timeline_overlap',
						level: 'warning',
						status: 'open',
						title: 'Timeline overlap',
						sourceEntryIds: ['entry_12'],
						sourcePatchIds: ['patch_warning_1'],
					},
				],
			},
			cacheSegments: [
				{
					kind: 'prompt_system',
					cacheKey: 'engine-cache:story-alpha:prompt_system:stable',
					contentHash: 'hash-system',
					hit: true,
					invalidated: false,
					tokenEstimate: 640,
					dependencyCount: 2,
				},
			],
			budgets: {
				memoryTokensUsed: 780,
				memoryTokensMax: 800,
				wikiCharsUsed: 3900,
				wikiCharsMax: 4000,
			},
		});
	});

	it('logs compact slow-turn summaries above the configured threshold', () => {
		const summary = buildTurnPerformanceSummary({
			turnId: 'turn-2',
			storyId: 'story-beta',
			totalMs: 9_200,
			model: 'gpt-test',
			profile: 'openai',
			preparedCacheHit: false,
			prompt: {
				tokenEstimate: 1000,
				totalChars: 4000,
				messageCount: 6,
			},
			cache: null,
			generationTimings: [
				{ operation: 'turn.narration', serviceId: 'narrative', model: 'gpt-test', status: 'success', durationMs: 5_100, timeToFirstTokenMs: null, retryCount: 0, requestTokens: 800, responseTokens: 200, totalTokens: 1000, providerCostUsd: null },
			],
			timings: [
				{ phase: 'turn.wiki_context', durationMs: 700 },
				{ phase: 'turn.final_response.readback', durationMs: 650 },
			],
		});
		const warn = vi.fn();

		logSlowTurn(summary, 8_000, warn);

		expect(warn).toHaveBeenCalledWith('[slow-turn]', {
			turnId: 'turn-2',
			storyId: 'story-beta',
			totalMs: 9200,
			model: 'gpt-test',
			topSpans: [
				{ operation: 'turn.wiki_context', durationMs: 700 },
				{ operation: 'turn.final_response.readback', durationMs: 650 },
			],
		});
	});
});


describe('reused narration performance diagnostics', () => {
	it.each(['turn.pi.investigation', 'turn.pi.narration'])('retains the known source cost once when %s supplied the already-accounted text', operation => {
		const result = reuseGenerationResult({ text: 'Saved scene', model: 'fixture', endpoint: 'fixture', durationMs: 20, promptChars: 10, responseChars: 11,
			usage: { ...emptyServerGenerationUsage(), requestTokens: 100, responseTokens: 20, totalTokens: 120, providerCostUsd: 0.03 } }, { operation });
		const summary = buildTurnPerformanceSummary({ preparedCacheHit: false, prompt: { tokenEstimate: 100, totalChars: 10, messageCount: 1 }, cache: null,
			generationTimings: [timingFromResult('turn.narration', 'narrative', result, 'success')], timings: [] });
		expect(summary.generation).toMatchObject({ operationCount: 1, totalTokens: 120, providerCostUsd: 0.03 });
	});
});

describe('actor psychology proposal validation',()=>{
 it('retains advisory psychology but rejects an applied affinity claim',()=>{
  const proposal={status:'propose',immediateAction:'Ask for clarification.',objective:'Protect established boundaries.',condition:null,rationale:'Supported by the actor.',knowledgeSourceIds:['fact-1'],psychology:{judgment:'threatened',emotionalIntensity:3,relationshipDelta:-1,actionTriage:'controlled',confidence:0.9,advisory:true,affinityApplied:false}};
  expect(parseActorDecisionProposal(JSON.stringify(proposal),['fact-1']).psychology).toEqual(proposal.psychology);
  expect(()=>parseActorDecisionProposal(JSON.stringify({...proposal,psychology:{...proposal.psychology,affinityApplied:true}}),['fact-1'])).toThrow();
 });
});
