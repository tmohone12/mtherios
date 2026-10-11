import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), view: vi.fn(), fetch: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$lib/server/engine/llmSettings', async original => ({ ...await original<typeof import('$lib/server/engine/llmSettings')>(), resolveServiceGeneration: mocks.resolve }));
vi.mock('$lib/server/engine/gmTools', async original => ({ ...await original<typeof import('$lib/server/engine/gmTools')>(), getActorDecisionView: mocks.view }));

import { createHash } from 'node:crypto';
import { agentJevEvidenceHash, decideTurnActorResponses } from './orchestrator';
import { createTimingRecorder } from '$lib/server/performance/timing';

const profile = { id: 'decisions', name: 'Decisions', providerType: 'openrouter', apiKey: 'test-key', customModels: [], fetchedModels: [], reasoningModels: [], hiddenModels: [], favoriteModels: [] };
const provenance = (enabled: boolean, maxRequests = 4) => ({ taskId: 'actorDecision', role: 'decisions', source: 'role', profileId: 'p', profileRevision: 1, providerType: 'openrouter',
	model: 'typesafe/jev-1.13', enabled, enabledSource: 'task_override', overriddenParameters: [], fallbackProfileIds: [],
	limits: { maxTokens: 700, contextWindowTokens: 32000, maxRequests }, settingsRevision: 'r', status: enabled ? 'ready' : 'disabled', reason: null });
const service = (enabled: boolean, metadata: Record<string, unknown> = {}, maxRequests = 4) => ({ setting: { metadata }, profile: enabled ? profile : null,
	generation: { model: 'typesafe/jev-1.13' }, systemPromptOverride: null, missingReason: enabled ? null : 'Decisions is disabled.', provenance: provenance(enabled, maxRequests) });
const view = (actorId: string) => ({ data: { actor: { id: actorId }, personalKnowledge: { knownFacts: ['The gate is shut.'] } }, sourceIds: [actorId, `${actorId}_fact`], warnings: [], unresolved: [], truncated: false });
const reaction = (choice: string, confidence = 0.95) => ({ model: 'typesafe/jev-1.13', answers: { reaction: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } } });
const request = { storyId: 'story_d', clientTurnId: 'turn_1', playerText: 'Mira, open the gate for me.', actionType: 'say' } as never;
const decide = (candidates: Array<{ id: string; name: string }>, options: Record<string, unknown> = {}) => decideTurnActorResponses({
	request, actorCandidates: candidates, options, recorder: createTimingRecorder({ pipeline: 'test' }), warnings: [], generationTimings: [] });

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal('fetch', mocks.fetch);
	mocks.view.mockImplementation(async (_storyId: string, args: { actorId: string }) => view(args.actorId));
});

describe('turn Decisions', () => {
	it('makes no request when Decisions is disabled, so narration and classification proceed unchanged', async () => {
		mocks.resolve.mockResolvedValue(service(false));
		const result = await decide([{ id: 'npc_mira', name: 'Mira' }]);
		expect(result.actorDecisions).toEqual([expect.objectContaining({ actorId: 'npc_mira', status: 'disabled' })]);
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.view).not.toHaveBeenCalled();
		expect(result.provenance).toMatchObject({ enabled: false });
	});

	it('uses one bounded request per actor and records transport, validation and outcome separately', async () => {
		mocks.resolve.mockResolvedValue(service(true));
		mocks.fetch.mockImplementation(async () => Response.json(reaction('refuse')));
		const result = await decide([{ id: 'npc_mira', name: 'Mira' }]);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(result.actorDecisions[0]).toMatchObject({ status: 'proposed',
			decision: { mode: 'action', requestCount: 1, transport: 'completed', validation: 'valid', outcome: 'proposed', choice: 'refuse', modelConfidence: 0.95, applied: false } });
	});

	it('stops after unusable psychology without a second request in the explicit psychology mode', async () => {
		mocks.resolve.mockResolvedValue(service(true, { decisionMode: 'psychology_then_action' }));
		const uncertain = { type: 'choice', choice: 'uncertain', confidence: 0.9, probabilities: { uncertain: 0.9 } };
		mocks.fetch.mockImplementation(async () => Response.json({ model: 'typesafe/jev-1.13', answers: { internal_judgment: uncertain, emotional_intensity: uncertain, relationship_delta: uncertain, action_triage: uncertain } }));
		const result = await decide([{ id: 'npc_mira', name: 'Mira' }]);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(result.actorDecisions[0]).toMatchObject({ status: 'insufficient_evidence', decision: { mode: 'psychology_then_action', requestCount: 1, outcome: 'abstained', applied: false } });
	});

	it('reuses an equivalent planner decision without a request, but not when a cited offer changes the evidence', async () => {
		mocks.resolve.mockResolvedValue(service(true));
		const actorView = view('npc_mira');
		const planned = { status: 'proposed', purpose: 'immediate_response', actorId: 'npc_mira',
			playerActionHash: createHash('sha256').update('Mira, open the gate for me.').digest('hex'),
			evidenceHash: agentJevEvidenceHash(actorView.data, actorView.sourceIds), decisionTaskVersion: 'immediate_response_v1',
			candidateOptions: [{ id: 'open', description: 'Open the gate.' }, { id: 'refuse', description: 'Keep it shut.' }],
			optionId: 'open', selectedDescription: 'Open the gate.', confidence: 0.9, sourceIds: ['npc_mira'], model: 'typesafe/jev-1.13', configuredModel: 'typesafe/jev-1.13' };
		const reused = await decide([{ id: 'npc_mira', name: 'Mira' }], { agentJevDecisions: [planned] });
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(reused.actorDecisions[0]).toMatchObject({ status: 'proposed', immediateAction: 'Open the gate.',
			decision: { transport: 'reused', requestCount: 0, choice: 'open', applied: false } });

		mocks.fetch.mockImplementation(async () => Response.json(reaction('cooperate')));
		const offered = await decide([{ id: 'npc_mira', name: 'Mira', recentOffer: { sourceEntryId: 'entry_offer', speech: 'I will open it for a coin.' } } as never],
			{ agentJevDecisions: [planned] });
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(offered.actorDecisions[0].decision?.transport).toBe('completed');
	});

	it('enforces a turn-wide request budget across actors', async () => {
		mocks.resolve.mockResolvedValue(service(true, {}, 1));
		mocks.fetch.mockImplementation(async () => Response.json(reaction('defer')));
		const result = await decide([{ id: 'npc_mira', name: 'Mira' }, { id: 'npc_lord', name: 'Lord' }]);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(result.actorDecisions[1]).toMatchObject({ actorId: 'npc_lord', status: 'unavailable', reason: expect.stringContaining('budget of 1') });
	});

	it('reports a schema-invalid response as transport completed but validation invalid', async () => {
		mocks.resolve.mockResolvedValue(service(true));
		mocks.fetch.mockImplementation(async () => Response.json({ model: 'typesafe/jev-1.13', answers: { reaction: { type: 'choice' } } }));
		const result = await decide([{ id: 'npc_mira', name: 'Mira' }]);
		expect(result.actorDecisions[0]).toMatchObject({ status: 'invalid', decision: { transport: 'completed', validation: 'invalid', outcome: 'unavailable', applied: false } });
	});
});
