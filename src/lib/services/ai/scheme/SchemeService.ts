/**
 * Player-declared plan authoring (the /plan command and the Declare Plan dialog).
 *
 * A single browser model call, using the saved Classifier settings, turns free-text
 * intent ("I'll poison Lord Frey at the wedding") into staged obstacles. The plan
 * is saved through the canonical scheme write; it is intent, not an outcome.
 * There is no server command for the structuring step yet.
 */

import { uuid } from '$lib/utils/uuid';
import { story } from '$lib/stores/story.svelte';
import { settings } from '$lib/stores/settings.svelte';
import { generateStructuredWithTools } from '$lib/services/ai/sdk/generate';
import { getChapters } from '$lib/services/database';
import { saveCanonicalScheme } from '$lib/services/canonicalWrites';
import type { Scheme, SchemeStage } from '$lib/types';
import {
	playerSchemeDeclareSchema,
	DECLARE_PLAYER_SCHEME_TOOL,
	type PlayerSchemeDeclareArgs,
	type SchemeStageInput,
} from '$lib/services/ai/sdk/schemas/scheme';
import { buildWarSchemeRulesBlock } from '$lib/services/ai/context/warDoctrine';

// ── Tunables ──
const TIME_STAGE_DEFAULT_DAYS = 3;

function applyCurrentStoryServerVersion(serverVersion: number | null): void {
	if (!serverVersion || !story.currentStory) return;
	story.currentStory = { ...story.currentStory, serverVersion, syncStatus: 'synced' };
}

// ══════════════════════════════════════════════════════════════
// declarePlayerScheme — /plan command or modal entry point
// ══════════════════════════════════════════════════════════════

export async function declarePlayerScheme(
	freeText: string,
	signal?: AbortSignal,
): Promise<{ scheme: Scheme | null; error: string | null }> {
	if (!story.currentStory) return { scheme: null, error: 'no active story' };
	if (!freeText.trim()) return { scheme: null, error: 'empty plan' };

	const classifierConfig = settings.getServiceConfig('classifier');

	const systemPrompt =
		`You structure free-text player plans into multi-stage schemes for an interactive ` +
		`fiction game. The player describes what they want to do; you break it into 2-6 ` +
		`concrete stages, each with an obstacle or prerequisite the player must work through. ` +
		`Faction goals define why a faction fights; schemes define how they try to win; ` +
		`story threads define how the war becomes player-facing plot; world events record ` +
		`what actually happened. ` +
		`${buildWarSchemeRulesBlock()} ` +
		`Stages should be ACTIONABLE — things the player will do in-fiction. The narrator ` +
		`will surface each stage as an opportunity or obstacle, not as guaranteed success.`;

	const userPrompt =
		`Player's plan:\n\n"${freeText.trim()}"\n\n` +
		`Call declare_player_scheme with structured stages.`;

	let result: { toolCalls: Array<{ name: string; arguments: Record<string, any> }> };
	try {
		result = await generateStructuredWithTools({
			system: systemPrompt,
			prompt: userPrompt,
			model: classifierConfig.model || undefined,
			temperature: classifierConfig.temperature,
			maxTokens: classifierConfig.maxTokens,
			signal,
			tools: [DECLARE_PLAYER_SCHEME_TOOL],
			forceTool: 'declare_player_scheme',
			profileId: classifierConfig.profileId || undefined,
			_service: 'scheme-player-declare',
		} as any);
	} catch (e) {
		return { scheme: null, error: e instanceof Error ? e.message : String(e) };
	}

	const call = result.toolCalls.find(tc => tc.name === 'declare_player_scheme');
	if (!call) return { scheme: null, error: 'no tool call returned' };

	const parsed = playerSchemeDeclareSchema.safeParse(call.arguments);
	if (!parsed.success) {
		return { scheme: null, error: parsed.error.issues.map(i => i.message).join('; ') };
	}

	const scheme = await persistPlayerScheme(parsed.data, freeText);
	return { scheme, error: null };
}

async function persistPlayerScheme(
	args: PlayerSchemeDeclareArgs,
	originalText: string,
): Promise<Scheme | null> {
	if (!story.currentStory) return null;
	const storyId = story.currentStory.id;
	const branchId = story.currentStory.currentBranchId ?? null;
	const chapterNumber = await currentChapterNumber(storyId);
	const protag = story.protagonist;
	const now = Date.now();

	const stages = args.stages.map((s, i) => buildStage(s, i));
	const firstStage = stages[0];
	const totalDays = currentTotalDays();

	const scheme: Scheme = {
		id: uuid(),
		storyId,
		ownerType: 'player',
		ownerEntryId: null,
		ownerName: protag?.name ?? 'Player',
		goal: args.goal,
		trigger: `Player declared: "${originalText.trim().slice(0, 200)}"`,
		triggerChapter: chapterNumber,
		triggerEntryId: latestEntryId(),
		stages,
		currentStageIndex: 0,
		pressure: clamp(args.initial_pressure, 0, 100),
		status: 'active',
		secrecy: 'known', // player knows their own plan
		nextTickAtDay: firstStage?.condition === 'time'
			? totalDays + timeStageGapDays(firstStage)
			: null,
		branchId,
		createdAt: now,
		updatedAt: now,
	};
	try {
		applyCurrentStoryServerVersion(await saveCanonicalScheme(scheme));
		story.schemes = [...story.schemes, scheme];
		return scheme;
	} catch (e) {
		console.error('[SchemeService] persistPlayerScheme failed:', e);
		return null;
	}
}

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function buildStage(input: SchemeStageInput, index: number): SchemeStage {
	return {
		index,
		label: input.label,
		hook: input.hook,
		condition: input.condition,
		conditionPayload: input.condition_payload ?? {},
		completed: false,
		completedAt: null,
	};
}

function timeStageGapDays(stage: SchemeStage): number {
	const payload = stage.conditionPayload as { days_after_prev?: number };
	const days = payload?.days_after_prev;
	if (typeof days === 'number' && Number.isFinite(days) && days >= 0) return days;
	return TIME_STAGE_DEFAULT_DAYS;
}

function currentTotalDays(): number {
	const t = story.currentStory?.timeTracker;
	if (!t) return 0;
	return t.years * 365 + t.days;
}

async function currentChapterNumber(storyId: string): Promise<number | null> {
	try {
		const chapters = await getChapters(storyId);
		if (chapters.length === 0) return null;
		return Math.max(...chapters.map(c => c.number));
	} catch {
		return null;
	}
}

function latestEntryId(): string | null {
	const entries = story.entries;
	return entries.length > 0 ? entries[entries.length - 1].id : null;
}
