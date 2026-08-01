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
		mocks.parseJsonFromGeneratedText.mockReturnValue({ arcNumber: 1, publicSummary: 'Pressure rises.', mainPlots: [{}] });
		mocks.recordApiCallLog.mockResolvedValue(null);
	});

	it('uses terminal settings, validates JSON, and records the provider call', async () => {
		const frame = await planStrategicWorldFrameWithTerminal(input);

		expect(mocks.resolveServiceGeneration).toHaveBeenCalledWith('strategicWorldBrain');
		expect(mocks.generateServerTextWithMetrics).toHaveBeenCalledWith(expect.objectContaining({
			profile,
			model: 'plot-model',
			reasoningEffort: 'off',
			timeoutMs: 240_000,
			responseFormat: 'json_object',
			responseSchema: expect.objectContaining({ name: 'mtherios_strategic_world_frame' }),
			system: expect.stringMatching(/Custom strategic prompt[\s\S]+"plotCards"/),
		}));
		expect(frame).toEqual(expect.objectContaining({ storyId: 'story_alpha', arcNumber: 1 }));
		expect(mocks.recordApiCallLog).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_alpha', serviceId: 'strategicWorldBrain', status: 'success',
		}));
	});

	it('rejects an empty frame instead of applying it as a successful plan', async () => {
		mocks.parseJsonFromGeneratedText.mockReturnValue({});

		await expect(planStrategicWorldFrameWithTerminal(input)).rejects.toThrow('without usable plot content');
		expect(mocks.recordApiCallLog).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
	});
});
