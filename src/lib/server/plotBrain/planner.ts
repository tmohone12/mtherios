import { resolveServiceGeneration, requireResolvedServiceProfile } from '$lib/server/engine/llmSettings';
import { z } from 'zod';
import { recordApiCallLog } from '$lib/server/engine/apiCallLogs';
import {
	generateServerTextWithMetrics,
	parseJsonFromGeneratedText,
	ServerGenerationError,
	type ServerGenerationResult,
} from '$lib/server/turn/provider';
import {
	buildStrategicWorldBrainUserPrompt,
	type StrategicWorldBrainInput,
} from '$lib/services/ai/context/strategicWorldBrainInput';
import {
	plotBrainActivationPlanSchema,
	plotBrainAntagonistCandidateSchema,
	plotBrainClueSchema,
	plotBrainPlotCardSchema,
	plotBrainPressureBeatSchema,
	strategicEvidenceRefSchema,
	strategicPlotLineSchema,
	strategicWorldFrameSchema,
} from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import { finalizeStrategicWorldFrame } from '$lib/services/ai/generation/strategicWorldFrame';
import type { StrategicWorldFrame } from '$lib/types';

const shortText = (max: number) => z.preprocess(
	value => typeof value === 'string' ? value.trim().slice(0, max) : value,
	z.string().max(max),
);
const fastEvidenceRefSchema = strategicEvidenceRefSchema.pick({
	sourceType: true,
	sourceId: true,
	label: true,
}).extend({
	sourceId: shortText(320).nullable().optional(),
	label: shortText(120).default('Unspecified evidence'),
});
const fastPlotLineSchema = strategicPlotLineSchema.pick({
	title: true,
	summary: true,
	linkedThreadIds: true,
}).extend({
	title: shortText(120),
	summary: shortText(240),
	linkedThreadIds: z.array(shortText(320)).max(2).default([]),
});
const fastAntagonistSchema = plotBrainAntagonistCandidateSchema.pick({
	id: true,
	actorEntityId: true,
	actorFactionId: true,
	name: true,
	role: true,
	motive: true,
	method: true,
	plausibilityScore: true,
	dramaticScore: true,
	agencyRisk: true,
	evidenceRefs: true,
}).extend({
	id: shortText(320).default(''),
	actorEntityId: shortText(320).nullable().optional(),
	actorFactionId: shortText(320).nullable().optional(),
	name: shortText(120),
	motive: shortText(160).default(''),
	method: shortText(160).default(''),
	evidenceRefs: z.array(fastEvidenceRefSchema).max(2).default([]),
});
const fastClueSchema = plotBrainClueSchema.pick({
	clue: true,
	delivery: true,
	truth: true,
	visibility: true,
}).extend({ clue: shortText(180), truth: shortText(180).default('') });
const fastPressureBeatSchema = plotBrainPressureBeatSchema.pick({
	delayTurns: true,
	title: true,
	body: true,
	urgency: true,
	visibility: true,
	actorEntityIds: true,
	targetEntityIds: true,
	locationIds: true,
	factionIds: true,
}).extend({
	title: shortText(120),
	body: shortText(180),
	actorEntityIds: z.array(shortText(320)).max(3).default([]),
	targetEntityIds: z.array(shortText(320)).max(3).default([]),
	locationIds: z.array(shortText(320)).max(2).default([]),
	factionIds: z.array(shortText(320)).max(3).default([]),
});
const fastPlotCardSchema = plotBrainPlotCardSchema.pick({
	id: true,
	storyThreadId: true,
	title: true,
	logline: true,
	kind: true,
	lifecycleStage: true,
	pressure: true,
	urgency: true,
	visibility: true,
	actorEntityIds: true,
	actorFactionIds: true,
	antagonistCandidateIds: true,
	targetEntityIds: true,
	targetFactionIds: true,
	locationIds: true,
	goal: true,
	motive: true,
	method: true,
	stakes: true,
	playerTouchpoints: true,
	clueTrail: true,
	pressureBeats: true,
	ignoredOutcome: true,
	sourceRefs: true,
	antiRailroadNotes: true,
}).extend({
	id: shortText(320).default(''),
	storyThreadId: shortText(320).nullable().optional(),
	title: shortText(120),
	logline: shortText(180).default(''),
	goal: shortText(160).default(''),
	motive: shortText(160).default(''),
	method: shortText(160).default(''),
	stakes: shortText(160).default(''),
	ignoredOutcome: shortText(160).default(''),
	actorEntityIds: z.array(shortText(320)).max(3).default([]),
	actorFactionIds: z.array(shortText(320)).max(3).default([]),
	antagonistCandidateIds: z.array(shortText(320)).max(2).default([]),
	targetEntityIds: z.array(shortText(320)).max(3).default([]),
	targetFactionIds: z.array(shortText(320)).max(3).default([]),
	locationIds: z.array(shortText(320)).max(2).default([]),
	playerTouchpoints: z.array(shortText(120)).max(2).default([]),
	clueTrail: z.array(fastClueSchema).max(1).default([]),
	pressureBeats: z.array(fastPressureBeatSchema).max(1).default([]),
	sourceRefs: z.array(fastEvidenceRefSchema).max(3).default([]),
	antiRailroadNotes: z.array(shortText(120)).max(1).default([]),
});
const fastStoryThreadUpdateSchema = z.object({
	threadId: shortText(320),
	status: z.enum(['open', 'imminent', 'stalled', 'closed', 'abandoned']).optional(),
	significance: z.enum(['minor', 'moderate', 'major', 'critical']).optional(),
	description: shortText(360).optional(),
	reason: shortText(240).default('Strategic plot brain update.'),
});
const strategicWorldDraftSchema = z.object({
	publicSummary: shortText(360),
	hiddenStrategicSummary: shortText(420),
	mainPlots: z.array(fastPlotLineSchema).max(1),
	subplots: z.array(fastPlotLineSchema).max(1),
	antagonistCandidates: z.array(fastAntagonistSchema).max(2),
	plotCards: z.array(fastPlotCardSchema).max(2),
	activationPlan: plotBrainActivationPlanSchema.unwrap().extend({
		activateNow: z.array(shortText(320)).max(2).default([]),
		keepDormant: z.array(shortText(320)).max(6).default([]),
		retireOrMerge: z.array(shortText(320)).max(6).default([]),
		rationale: shortText(180).default(''),
	}),
	plotBrainWritePlan: z.object({
		storyThreadUpdates: z.array(fastStoryThreadUpdateSchema).max(6).default([]),
	}).default({ storyThreadUpdates: [] }),
});
const { $schema: _schema, ...strategicWorldJsonSchema } = z.toJSONSchema(strategicWorldDraftSchema, { io: 'input' });
const strategicWorldResponseSchema = {
	name: 'mtherios_strategic_world_frame',
	strict: false,
	schema: strategicWorldJsonSchema,
};
const FAST_DRAFT_TOKENS = 4000;
const PLANNER_OUTPUT_TOKENS = 8192;

export class StrategicPlannerOutputError extends Error {
	readonly retryable = false;
}

function fastDraftInstructions(maxTokens: number): string {
	return `FAST PLOT DIRECTOR DRAFT:
- Return only the fields in the supplied JSON Schema. Omitted world-simulation fields receive safe defaults.
- Fit the complete JSON response within ${maxTokens} output tokens; omit optional detail before expanding prose.
- Write publicSummary and plot-card loglines as forward developments, not a recap of what the court already discussed.
- Prefer one main plot and at most one subplot, with matching plotCards, when canon supports meaningful development, opportunity, or conflict.
- Read CURRENT STORY FRONT first. It is newer evidence than the previous frame, chapters, and stored thread descriptions.
- Open threads are continuity records, not orders to activate. Continue a previous card only when its next concrete consequence remains unresolved and relevant to the newest scene.
- When recent entries complete a beat, resolve or retire it. When play simply moves elsewhere, hold, stall, or leave it dormant. Never rename and replay it to pull the scene backward.
- A pending choice already spoken at the table is scene state, not a new plot beat. Do not make a card that only repeats that choice, warning, or deadline; propose a next independent NPC or faction action grounded in its own goal and means, or leave the frame quiet.
- Prefer a new consequence of a sourced independent NPC move in the current city over another card about the player's announced trip, inspection, or decision. Preparations are not outcomes; show the next observable change they could cause.
- A short player trip does not by itself create a regency crisis, coup, betrayal, or new obstacle. Such pressure needs specific current evidence for the actor and motive.
- Treat recent typed faction actions and active faction projects as developing off-screen pressure; promote at most one consequential move into a continuing thread or plot card instead of merely recapping it.
- A quiet frame with empty plots, antagonists, cards, and activation lists is valid when the player vetoed prior direction or canon offers no earned pressure.
- Produce no more than two antagonistCandidates, one clue, and one observable pressure beat per card.
- Treat supplied story-thread ids as durable identities. A continuing plotCard must copy the exact id into storyThreadId even when its title changes.
- For each relevant existing thread, choose advance, hold, stall, resolve, abandon, or merge. Express that choice through activationPlan plus no more than six dormant ids, six retirement ids, and six storyThreadUpdates.
- Advance with an updated description/status and an observable pressure beat; hold by leaving the thread unchanged; stall with status stalled; resolve or merge with status closed; abandon with status abandoned.
- Put resolved, abandoned, or merged cards in retireOrMerge. Never close a thread merely because it is dormant or absent from this two-card spotlight.
- Update only threads whose state actually changed; omission preserves every other thread.
- Keep every summary, motive, method, outcome, clue, and beat to one short sentence. Do not repeat the canon recap or emit fields outside the schema.
- Spend output on forward pressure that can guide upcoming narration, not analysis or explanation.`;
}
const fastPlotDirectorSystemPrompt = `You are the Plot Director for a living-world roleplay engine.
Build meaningful plot development and potential payoffs from supplied canon; do not write scenes or recap the story.
The next plot development must change the situation after the latest scene. Repeating a report already delivered in recent dialogue does not count as development.
Maintain the supplied campaign threads across drafts instead of replacing them with renamed plots.
Treat the latest scene as newer evidence than the prior frame. Continuity does not require keeping old pressure active.
Use antagonists only when established motives or actions create actual opposition; an antagonist is optional.
Each plot card should offer a consequential next development and a possible resolution. Cooperation, discovery, and earned success can advance a plot; escalation is not required.
Never force player actions, feelings, travel, capture, loyalty, or outcomes.
Use supplied source ids when available and keep secret information secret.`;

async function logCall(
	input: StrategicWorldBrainInput,
	profile: Parameters<typeof generateServerTextWithMetrics>[0]['profile'],
	result: ServerGenerationResult | ServerGenerationError['result'],
	status: 'success' | 'error',
	error?: unknown,
	phase = 'generation',
): Promise<void> {
	const usage = result.usage;
	await recordApiCallLog({
		storyId: input.story.id,
		serviceId: 'strategicWorldBrain',
		operation: 'plotBrain.plan',
		providerType: profile.providerType,
		providerName: profile.name ?? null,
		profileId: profile.id ?? null,
		model: result.model,
		endpoint: result.endpoint,
		status,
		durationMs: result.durationMs,
		requestTokens: usage?.requestTokens ?? null,
		responseTokens: usage?.responseTokens ?? null,
		totalTokens: usage?.totalTokens ?? null,
		promptChars: result.promptChars,
		responseChars: result.responseChars ?? null,
		error: error instanceof Error ? error.message : error ? String(error) : null,
		metadata: { trigger: input.trigger, phase, finishReason: result.finishReason ?? null, reasoningTokens: usage?.reasoningTokens ?? null },
	});
}

export async function planStrategicWorldFrameWithTerminal(input: StrategicWorldBrainInput): Promise<StrategicWorldFrame> {
	const resolved = await resolveServiceGeneration('strategicWorldBrain');
	const profile = requireResolvedServiceProfile('strategicWorldBrain', resolved);
	const promptInput = {
		...input,
		contextBudget: input.contextBudget ?? resolved.setting?.contextBudget ?? undefined,
	};
	// The provider allowance includes reasoning; keep the JSON draft itself compact.
	const maxTokens = resolved.generation.maxTokens ?? PLANNER_OUTPUT_TOKENS;
	// Gemini through OpenRouter rejects this Zod JSON Schema with INVALID_ARGUMENT.
	// Keep the schema in the instruction and validate the JSON locally instead.
	const useResponseSchema = !(profile.providerType === 'openrouter'
		&& /^google\//i.test(resolved.generation.model ?? ''));
	let generated: ServerGenerationResult;
	try {
		generated = await generateServerTextWithMetrics({
			profile,
			model: resolved.generation.model,
			temperature: resolved.generation.temperature ?? 0.45,
			maxTokens,
			reasoningEffort: resolved.generation.reasoningEffort ?? 'off',
			timeoutMs: 240_000,
			system: `${resolved.systemPromptOverride?.trim() || fastPlotDirectorSystemPrompt}\n\n${fastDraftInstructions(Math.min(maxTokens, FAST_DRAFT_TOKENS))}\n\nRespond ONLY with valid JSON matching this JSON Schema. No markdown, code fences, or explanation.\n\n${JSON.stringify(strategicWorldJsonSchema)}`,
			prompt: buildStrategicWorldBrainUserPrompt(promptInput, { fastDraft: true }),
			responseFormat: 'json_object',
			responseSchema: useResponseSchema ? strategicWorldResponseSchema : undefined,
		});
	} catch (error) {
		if (error instanceof ServerGenerationError) await logCall(input, profile, error.result, 'error', error);
		throw error;
	}

	try {
		if (generated.finishReason === 'length') {
			throw new StrategicPlannerOutputError('Strategic planner hit its output limit before completing the plot frame.');
		}
		if (!generated.text.trim()) {
			throw new StrategicPlannerOutputError('Strategic planner returned no structured object.');
		}
		const raw = parseJsonFromGeneratedText(generated.text);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			throw new StrategicPlannerOutputError('Strategic planner returned no structured object.');
		}
		const draft = strategicWorldDraftSchema.parse(raw);
		const parsed = strategicWorldFrameSchema.parse(draft);
		const frame = finalizeStrategicWorldFrame(promptInput, parsed as unknown as StrategicWorldFrame);
		await logCall(input, profile, generated, 'success');
		return frame;
	} catch (error) {
		const outputError = error instanceof StrategicPlannerOutputError
			? error
			: new StrategicPlannerOutputError(error instanceof Error ? error.message : String(error), { cause: error });
		await logCall(input, profile, generated, 'error', outputError, 'parse');
		throw outputError;
	}
}
