import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StrategicWorldBrainInput } from '$lib/services/ai/context/strategicWorldBrainInput';

const mocks = vi.hoisted(() => ({
	resolveServiceGeneration: vi.fn(),
	requireResolvedServiceProfile: vi.fn(),
	generateServerTextWithMetrics: vi.fn(),
	parseJsonFromGeneratedText: vi.fn(),
	recordApiCallLog: vi.fn(),
}));

vi.mock('$lib/server/engine/llmSettings', () => ({
	resolveServiceGeneration: mocks.resolveServiceGeneration,
	requireResolvedServiceProfile: mocks.requireResolvedServiceProfile,
}));
vi.mock('$lib/server/turn/provider', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/server/turn/provider')>(),
	generateServerTextWithMetrics: mocks.generateServerTextWithMetrics,
	parseJsonFromGeneratedText: mocks.parseJsonFromGeneratedText,
}));
vi.mock('$lib/server/engine/apiCallLogs', () => ({ recordApiCallLog: mocks.recordApiCallLog }));

import { planStrategicWorldFrameWithTerminal } from './planner';

const profile = { id: 'server-strategic', name: 'Strategic', providerType: 'openrouter', apiKey: 'key' };
const input = {
	story: { id: 'story_alpha', title: 'Ashen Crown' },
	trigger: 'manual',
	currentArc: null,
	recentArcs: [],
	relevantOlderArcs: [],
	currentArcChapters: [],
	recentChapters: [],
	recentEntries: [],
	factions: [],
	characters: [],
	activeSchemes: [],
	recentlyResolvedSchemes: [],
	storyThreads: [],
	worldEvents: [],
	rumors: [],
	agreements: [],
	factionActions: [],
	playerLedger: null,
	playerReputation: null,
	previousStrategicFrame: null,
	mode: 'adventure',
	pov: 'second',
	tense: 'present',
	timeTracker: null,
} as unknown as StrategicWorldBrainInput;

describe('planStrategicWorldFrameWithTerminal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.resolveServiceGeneration.mockResolvedValue({
			setting: { contextBudget: 32000 },
			profile,
			generation: { model: 'plot-model', temperature: 0.45, maxTokens: 9000 },
			systemPromptOverride: 'Custom strategic prompt.',
			missingReason: null,
		});
		mocks.requireResolvedServiceProfile.mockReturnValue(profile);
		mocks.generateServerTextWithMetrics.mockResolvedValue({
			text: '{}', model: 'plot-model', endpoint: 'https://example.test/chat', durationMs: 20,
			promptChars: 100, responseChars: 2,
			usage: { requestTokens: 25, responseTokens: 2, totalTokens: 27 },
		});
		mocks.parseJsonFromGeneratedText.mockReturnValue({
			publicSummary: 'Pressure rises.',
			hiddenStrategicSummary: 'A quiet threat remains off-screen.',
			mainPlots: [{ title: 'Ash at the Gate', summary: 'A blockade tightens.' }],
			subplots: [],
			antagonistCandidates: [],
			plotCards: [],
			activationPlan: { activateNow: [], keepDormant: [], retireOrMerge: [], rationale: 'Observe before escalating.' },
		});
		mocks.recordApiCallLog.mockResolvedValue(null);
	});

	it('uses terminal settings, validates JSON, and records the provider call', async () => {
		const frame = await planStrategicWorldFrameWithTerminal(input);

		expect(mocks.resolveServiceGeneration).toHaveBeenCalledWith('strategicWorldBrain');
		expect(mocks.generateServerTextWithMetrics).toHaveBeenCalledWith(expect.objectContaining({
			profile,
			model: 'plot-model',
			maxTokens: 9000,
			reasoningEffort: 'off',
			timeoutMs: 240_000,
			responseFormat: 'json_object',
			responseSchema: expect.objectContaining({ name: 'mtherios_strategic_world_frame' }),
			system: expect.stringMatching(/Custom strategic prompt[\s\S]+FAST PLOT DIRECTOR DRAFT[\s\S]+"plotCards"/),
		}));
		const responseSchema = mocks.generateServerTextWithMetrics.mock.calls[0][0].responseSchema;
		const prompt = mocks.generateServerTextWithMetrics.mock.calls[0][0].prompt;
		const lineSchema = responseSchema.schema.properties.mainPlots.items;
		const antagonistSchema = responseSchema.schema.properties.antagonistCandidates.items;
		const cardSchema = responseSchema.schema.properties.plotCards.items;
		const activationSchema = responseSchema.schema.properties.activationPlan;
		expect(Object.keys(responseSchema.schema.properties)).toEqual([
			'publicSummary', 'hiddenStrategicSummary', 'mainPlots', 'subplots',
			'antagonistCandidates', 'plotCards', 'activationPlan', 'plotBrainWritePlan',
		]);
		expect(JSON.stringify(responseSchema.schema)).not.toContain('factionOperations');
		expect(responseSchema.schema.properties.plotCards.maxItems).toBe(2);
		expect(responseSchema.schema.properties.plotCards.minItems).toBeUndefined();
		expect(Object.keys(lineSchema.properties)).toEqual(['title', 'summary', 'linkedThreadIds']);
		expect(antagonistSchema.properties).not.toHaveProperty('fear');
		expect(antagonistSchema.properties).not.toHaveProperty('lineTheyWillNotCross');
		expect(antagonistSchema.properties).not.toHaveProperty('escalationTrigger');
		expect(cardSchema.properties).not.toHaveProperty('successOutcome');
		expect(cardSchema.properties).not.toHaveProperty('failureOutcome');
		expect(cardSchema.properties).not.toHaveProperty('partialOutcome');
		expect(cardSchema.properties).not.toHaveProperty('continuityRisks');
		expect(cardSchema.properties.clueTrail.maxItems).toBe(1);
		expect(cardSchema.properties.pressureBeats.maxItems).toBe(1);
		expect(cardSchema.properties.playerTouchpoints.maxItems).toBe(2);
		expect(cardSchema.properties.antiRailroadNotes.maxItems).toBe(1);
		expect(activationSchema.properties.activateNow.maxItems).toBe(2);
		expect(activationSchema.properties.keepDormant.maxItems).toBe(6);
		expect(activationSchema.properties.retireOrMerge.maxItems).toBe(6);
		expect(responseSchema.schema.properties.plotBrainWritePlan.properties.storyThreadUpdates.maxItems).toBe(6);
		expect(responseSchema.schema.properties.plotBrainWritePlan.properties.storyThreadUpdates.items.properties.threadId.maxLength).toBe(320);
		expect(JSON.stringify(responseSchema.schema)).not.toContain('successOutcome');
		expect(mocks.generateServerTextWithMetrics.mock.calls[0][0].system).toContain('advance, hold, stall, resolve, abandon, or merge');
		expect(mocks.generateServerTextWithMetrics.mock.calls[0][0].system).toContain('Open threads are continuity records, not orders to activate');
		expect(mocks.generateServerTextWithMetrics.mock.calls[0][0].system).toContain('Never rename and replay it to pull the scene backward');
		expect(prompt).toContain('FAST DRAFT OUTPUT');
		expect(prompt).toContain('CURRENT STORY FRONT');
		expect(prompt).toContain('An open thread is continuity, not an order to activate it');
		expect(prompt).not.toContain('Create factionOperations');
		expect(frame).toEqual(expect.objectContaining({ storyId: 'story_alpha', arcNumber: 0 }));
		expect(mocks.recordApiCallLog).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_alpha', serviceId: 'strategicWorldBrain', status: 'success',
		}));
	});

	it('honors configured reasoning for models that require thinking', async () => {
		mocks.resolveServiceGeneration.mockResolvedValueOnce({
			setting: { contextBudget: 32000 },
			profile,
			generation: { model: 'z-ai/glm-5.3-flash', temperature: 0.45, maxTokens: 4096, reasoningEffort: 'high' },
			systemPromptOverride: 'Custom strategic prompt.',
			missingReason: null,
		});

		await planStrategicWorldFrameWithTerminal(input);

		expect(mocks.generateServerTextWithMetrics).toHaveBeenCalledWith(expect.objectContaining({
			model: 'z-ai/glm-5.3-flash',
			reasoningEffort: 'high',
		}));
	});

	it('uses JSON mode without provider schema for Gemini through OpenRouter', async () => {
		mocks.resolveServiceGeneration.mockResolvedValueOnce({
			setting: { contextBudget: 32000 },
			profile,
			generation: { model: 'google/gemini-3.8-flash', maxTokens: 4000, reasoningEffort: 'high' },
			systemPromptOverride: null,
			missingReason: null,
		});

		await planStrategicWorldFrameWithTerminal(input);

		expect(mocks.generateServerTextWithMetrics).toHaveBeenCalledWith(expect.objectContaining({
			responseFormat: 'json_object',
			responseSchema: undefined,
			system: expect.stringContaining('"plotCards"'),
		}));
	});

	it('respects a smaller configured output allowance', async () => {
		mocks.resolveServiceGeneration.mockResolvedValueOnce({
			setting: { contextBudget: 32000 },
			profile,
			generation: { model: 'plot-model', temperature: 0.45, maxTokens: 2500 },
			systemPromptOverride: 'Custom strategic prompt.',
			missingReason: null,
		});

		await planStrategicWorldFrameWithTerminal(input);

		expect(mocks.generateServerTextWithMetrics).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 2500, system: expect.stringContaining('within 2500 output tokens') }));
	});

	it('allows reasoning headroom while keeping the JSON draft compact', async () => {
		mocks.resolveServiceGeneration.mockResolvedValueOnce({
			setting: { contextBudget: 32000 },
			profile,
			generation: { model: 'plot-model', temperature: 0.45, maxTokens: 16384, reasoningEffort: 'high' },
			systemPromptOverride: 'Custom strategic prompt.',
			missingReason: null,
		});

		await planStrategicWorldFrameWithTerminal(input);

		expect(mocks.generateServerTextWithMetrics).toHaveBeenCalledWith(expect.objectContaining({
			maxTokens: 16384,
			reasoningEffort: 'high',
			system: expect.stringContaining('within 4000 output tokens'),
		}));
	});

	it('fills omitted full-frame properties after parsing the compact wire card', async () => {
		mocks.parseJsonFromGeneratedText.mockReturnValue({
			publicSummary: 'Ash gathers at the gate.',
			hiddenStrategicSummary: 'The old thread changes direction.',
			mainPlots: [{ title: 'Ash at the Gate', summary: 'The blockade becomes a negotiation.', linkedThreadIds: ['thread_ash'] }],
			subplots: [],
			antagonistCandidates: [],
			plotCards: [{
				id: 'plot_ash',
				storyThreadId: 'thread_ash',
				title: 'Ash at the Gate',
				sourceRefs: [{ sourceType: 'thread', sourceId: 'thread_ash' }],
			}],
			activationPlan: { activateNow: ['plot_ash'], keepDormant: [], retireOrMerge: [], rationale: 'Continue canon.' },
			plotBrainWritePlan: { storyThreadUpdates: [] },
		});

		const frame = await planStrategicWorldFrameWithTerminal({ ...input, knownThreadIds: ['thread_ash'] });

		expect(frame.plotCards[0]).toMatchObject({
			storyThreadId: 'thread_ash',
			successOutcome: '',
			failureOutcome: '',
			partialOutcome: '',
			continuityRisks: [],
		});
	});

	it('retains the bounded existing-thread development updates', async () => {
		const storyThreadUpdates = Array.from({ length: 6 }, (_, index) => ({
			threadId: `thread_${index + 1}`,
			status: index === 5 ? 'stalled' : 'open',
			description: `Development ${index + 1}.`,
			reason: 'Chapter evidence advances this thread.',
		}));
		mocks.parseJsonFromGeneratedText.mockReturnValue({
			publicSummary: 'Several campaign threads continue.',
			hiddenStrategicSummary: 'Only two need the immediate spotlight.',
			mainPlots: [],
			subplots: [],
			antagonistCandidates: [],
			plotCards: [],
			activationPlan: { activateNow: [], keepDormant: [], retireOrMerge: [], rationale: 'Preserve the wider board.' },
			plotBrainWritePlan: { storyThreadUpdates },
		});

		const frame = await planStrategicWorldFrameWithTerminal({
			...input,
			knownThreadIds: storyThreadUpdates.map(update => update.threadId),
		});

		expect(frame.plotBrainWritePlan.storyThreadUpdates).toEqual(storyThreadUpdates);
	});

	it('clips overlong model prose instead of discarding an otherwise valid frame', async () => {
		mocks.parseJsonFromGeneratedText.mockReturnValue({
			publicSummary: ` ${'p'.repeat(500)} `,
			hiddenStrategicSummary: 'h'.repeat(600),
			mainPlots: [],
			subplots: [],
			antagonistCandidates: [],
			plotCards: [],
			activationPlan: { activateNow: [], keepDormant: [], retireOrMerge: [], rationale: 'r'.repeat(300) },
		});

		const frame = await planStrategicWorldFrameWithTerminal(input);

		expect(frame.publicSummary).toHaveLength(360);
		expect(frame.hiddenStrategicSummary).toHaveLength(420);
		expect(frame.activationPlan.rationale).toHaveLength(180);
	});

	it('rejects an object that does not satisfy the bounded draft contract', async () => {
		mocks.parseJsonFromGeneratedText.mockReturnValue({});

		await expect(planStrategicWorldFrameWithTerminal(input)).rejects.toThrow('Invalid input');
		expect(mocks.recordApiCallLog).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
	});

	it('accepts an intentional quiet frame without inventing a replacement plot', async () => {
		mocks.parseJsonFromGeneratedText.mockReturnValue({
			publicSummary: 'No new plot pressure is introduced.',
			hiddenStrategicSummary: 'The world continues through existing faction projects.',
			mainPlots: [],
			subplots: [],
			antagonistCandidates: [],
			plotCards: [],
			activationPlan: { activateNow: [], keepDormant: [], retireOrMerge: [], rationale: 'Honor the player veto.' },
		});

		const frame = await planStrategicWorldFrameWithTerminal({
			...input,
			retiredPlotDirectives: ['The Ashen Crown blockade'],
		});

		expect(frame.plotCards).toEqual([]);
		expect(frame.activationPlan.activateNow).toEqual([]);
		expect(mocks.generateServerTextWithMetrics.mock.calls[0][0].prompt).toContain('RETIRED BY PLAYER');
		expect(mocks.generateServerTextWithMetrics.mock.calls[0][0].prompt).toContain('The Ashen Crown blockade');
	});

	it('normalizes a null structured response into a retryable planner failure', async () => {
		mocks.parseJsonFromGeneratedText.mockReturnValue(null);

		await expect(planStrategicWorldFrameWithTerminal(input)).rejects.toThrow('returned no structured object');
		expect(mocks.recordApiCallLog).toHaveBeenCalledWith(expect.objectContaining({
			status: 'error',
			error: 'Strategic planner returned no structured object.',
			metadata: expect.objectContaining({ phase: 'parse' }),
		}));
	});

	it('rejects a truncated response before attempting to parse partial JSON', async () => {
		mocks.generateServerTextWithMetrics.mockResolvedValue({
			text: '{"mainPlots":[', model: 'plot-model', endpoint: 'https://example.test/chat', durationMs: 20,
			promptChars: 100, responseChars: 14, finishReason: 'length',
			usage: { requestTokens: 25, responseTokens: 9000, totalTokens: 9025 },
		});

		await expect(planStrategicWorldFrameWithTerminal(input)).rejects.toMatchObject({
			message: expect.stringContaining('hit its output limit'),
			retryable: false,
		});
		expect(mocks.parseJsonFromGeneratedText).not.toHaveBeenCalled();
		expect(mocks.recordApiCallLog).toHaveBeenCalledWith(expect.objectContaining({
			status: 'error',
			metadata: expect.objectContaining({ finishReason: 'length' }),
		}));
	});
});
