/**
 * SchemeService — antagonist intent and player plans.
 *
 * Owns the lifecycle of `Scheme` records:
 *   - `evaluate()` — LLM pass after a story-beat-bearing turn. The model
 *     creates new schemes (player slighted Lord Frey → Frey schemes back),
 *     escalates existing ones, or resolves those the player neutralized.
 *     Gated by the caller — only runs when the turn produced something
 *     plot-worthy (story beat, death, agreement break). Cheap.
 *   - `tick()` — purely deterministic. No LLM. Advances time-gated stages
 *     whose `nextTickAtDay` reached the current world day. Runs from
 *     `tickWorld` alongside rumor aging.
 *   - `inject()` — returns a markdown section for the narrator system
 *     prompt. Active + non-secret (or pressure ≥ 70) schemes are exposed
 *     with their current stage hook, forcing the narrator to deliver
 *     instead of vibing past the beat.
 *   - `declarePlayerScheme()` — single-shot LLM call that turns free-text
 *     player intent ("I'll poison Lord Frey at the wedding") into staged
 *     obstacles. Owner is the protagonist.
 */

import { uuid } from '$lib/utils/uuid';
import { story } from '$lib/stores/story.svelte';
import { settings } from '$lib/stores/settings.svelte';
import { generateStructuredWithTools } from '$lib/services/ai/sdk/generate';
import { getChapters } from '$lib/services/database';
import { saveCanonicalScheme, saveCanonicalSchemes } from '$lib/services/canonicalWrites';
import type { Scheme, SchemeStage, Entry } from '$lib/types';
import {
	manageSchemesSchema,
	playerSchemeDeclareSchema,
	SCHEME_TOOL,
	DECLARE_PLAYER_SCHEME_TOOL,
	type ManageSchemesArgs,
	type PlayerSchemeDeclareArgs,
	type SchemeStageInput,
} from '$lib/services/ai/sdk/schemas/scheme';
import type { WorldStateUpdate } from '$lib/services/ai/tools/schemas';
import { buildWarSchemeRulesBlock } from '$lib/services/ai/context/warDoctrine';

// ── Tunables ──
const PRESSURE_PER_STAGE = 15; // climbs as schemes mature
const PRESSURE_CLIMAX_THRESHOLD = 70;
const PRESSURE_VISIBLE_OVERRIDE = 70; // pressure ≥ this leaks the scheme even when secret
const INJECT_CAP = 4; // narrator gets at most this many schemes
const TIME_STAGE_DEFAULT_DAYS = 3;
const SCHEME_RELEVANT_TIMELINE_EVENTS = new Set([
	'betrayal',
	'faction_move',
	'death',
	'agreement',
	'scheme',
	'marriage',
	'alliance',
]);

function applyCurrentStoryServerVersion(serverVersion: number | null): void {
	if (!serverVersion || !story.currentStory) return;
	story.currentStory = {
		...story.currentStory,
		serverVersion,
		syncStatus: 'synced',
	};
}

/**
 * Gate for when `evaluate()` should run. Cheap heuristic: only call the LLM
 * when something narratively significant happened this turn. Skipping quiet
 * turns saves 60-80% of evaluator calls.
 */
export function shouldEvaluate(args: WorldStateUpdate | null | undefined): boolean {
	if (!args) return false;
	if (args.story_beats && args.story_beats.length > 0) {
		const hasReal = args.story_beats.some(
			b => b.significance === 'moderate' || b.significance === 'major' || b.significance === 'critical',
		);
		if (hasReal) return true;
	}
	if (args.timeline_events && args.timeline_events.some(event => SCHEME_RELEVANT_TIMELINE_EVENTS.has(event.type ?? 'scheme'))) return true;
	if (args.characters && args.characters.some(c => c.status === 'deceased')) return true;
	if (args.agreements && args.agreements.some(a => a.action === 'break')) return true;
	return false;
}

export function findUniqueSchemeByIdOrPrefix(schemes: Scheme[], idOrPrefix: string): Scheme | null {
	if (!idOrPrefix || idOrPrefix.length < 8) return null;
	const matches = schemes.filter(scheme => scheme.id === idOrPrefix || scheme.id.startsWith(idOrPrefix));
	return matches.length === 1 ? matches[0] : null;
}

// ══════════════════════════════════════════════════════════════
// evaluate — reactive LLM pass after a plot-worthy turn
// ══════════════════════════════════════════════════════════════

export async function evaluate(
	narrative: string,
	stateSnapshot: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const errors: string[] = [];
	if (!narrative.trim() || !story.currentStory) return errors;

	const classifierConfig = settings.getServiceConfig('classifier');
	const activeSchemes = story.schemes.filter(
		s => s.status === 'active' || s.status === 'climaxing' || s.status === 'incubating',
	);

	const systemPrompt =
		`You manage antagonist schemes for an interactive fiction game. Your job is to ` +
		`look at what just happened and decide whether any antagonist would now plot against ` +
		`the player, escalate an existing plot, or abandon a foiled one. Be concrete and ` +
		`character-driven — only create schemes when the player did something that genuinely ` +
		`warrants response from a specific antagonist. Use the latest narrative and current ` +
		`state snapshot as evidence; do not create a scheme from genre vibes, outside canon, or ` +
		`a random desire for a twist. Faction goals define why a faction fights; schemes define ` +
		`how they try to win; story threads define how the war becomes player-facing plot; ` +
		`world events record what actually happened. Do not convert every faction goal or ` +
		`world event into a scheme; schemes are executable plans with an owner and trigger. ` +
		`${buildWarSchemeRulesBlock()} ` +
		`Escalate existing schemes only when this turn touches their ` +
		`owner, target, goal, or trigger. Quiet turns and positive-only developments warrant no ` +
		`action — return empty arrays and let the world breathe.`;

	const userPrompt =
		`Latest narrative:\n\n---\n${narrative}\n---\n\n` +
		`Current state:\n${stateSnapshot}\n\n` +
		(activeSchemes.length > 0
			? `Existing active schemes:\n${activeSchemes
					.map(
						s =>
							`- [id:${s.id.slice(0, 8)}] ${s.ownerName} (${s.ownerType}): ${s.goal} ` +
							`— stage ${s.currentStageIndex + 1}/${s.stages.length} "${s.stages[s.currentStageIndex]?.label ?? '?'}" ` +
							`— pressure ${s.pressure}, status ${s.status}`,
					)
					.join('\n')}\n\n`
			: 'No existing active schemes.\n\n') +
		`Call manage_schemes. Most turns warrant nothing. Only act when a named antagonist would actually react to evidence in the narrative or state snapshot.`;

	let result: { toolCalls: Array<{ name: string; arguments: Record<string, any> }> };
	try {
		result = await generateStructuredWithTools({
			system: systemPrompt,
			prompt: userPrompt,
			model: classifierConfig.model || undefined,
			temperature: classifierConfig.temperature,
			maxTokens: classifierConfig.maxTokens,
			signal,
			tools: [SCHEME_TOOL],
			forceTool: 'manage_schemes',
			profileId: classifierConfig.profileId || undefined,
			_service: 'scheme-evaluator',
		} as any);
	} catch (e) {
		errors.push(`scheme evaluate: ${e instanceof Error ? e.message : e}`);
		return errors;
	}

	const call = result.toolCalls.find(tc => tc.name === 'manage_schemes');
	if (!call) return errors;

	const parsed = manageSchemesSchema.safeParse(call.arguments);
	if (!parsed.success) {
		errors.push(`scheme args invalid: ${parsed.error.issues.map(i => i.message).join('; ')}`);
		return errors;
	}

	await applyManageSchemes(parsed.data, errors);
	return errors;
}

async function applyManageSchemes(args: ManageSchemesArgs, errors: string[]): Promise<void> {
	if (!story.currentStory) return;
	const storyId = story.currentStory.id;
	const branchId = story.currentStory.currentBranchId ?? null;
	const chapterNumber = await currentChapterNumber(storyId);
	const totalDays = currentTotalDays();
	const now = Date.now();

	const created: Scheme[] = [];
	for (const c of args.create) {
		const owner = resolveOwnerEntry(c.owner_name, c.owner_type);
		if (!owner) {
			errors.push(`scheme.create owner not found: ${c.owner_name} (${c.owner_type})`);
			continue;
		}
		const stages = c.stages.map((s, i) => buildStage(s, i));
		const firstStage = stages[0];
		const scheme: Scheme = {
			id: uuid(),
			storyId,
			ownerType: c.owner_type,
			ownerEntryId: owner.id,
			ownerName: owner.name,
			goal: c.goal,
			trigger: c.trigger,
			triggerChapter: chapterNumber,
			triggerEntryId: latestEntryId(),
			stages,
			currentStageIndex: 0,
			pressure: clamp(c.initial_pressure, 0, 100),
			status: 'active',
			secrecy: c.secrecy,
			nextTickAtDay: firstStage?.condition === 'time'
				? totalDays + timeStageGapDays(firstStage)
				: null,
			branchId,
			createdAt: now,
			updatedAt: now,
		};
		try {
			applyCurrentStoryServerVersion(await saveCanonicalScheme(scheme));
			created.push(scheme);
		} catch (e) {
			errors.push(`scheme.create persist: ${e instanceof Error ? e.message : e}`);
		}
	}
	if (created.length > 0) story.schemes = [...story.schemes, ...created];

	for (const e of args.escalate) {
		const target = findUniqueSchemeByIdOrPrefix(story.schemes, e.id);
		if (!target) {
			errors.push(`scheme.escalate id missing or ambiguous: ${e.id}`);
			continue;
		}
		const next: Partial<Scheme> = { updatedAt: now };
		if (typeof e.pressure_delta === 'number') {
			next.pressure = clamp(target.pressure + e.pressure_delta, 0, 100);
		}
		if (e.advance_stage && target.currentStageIndex < target.stages.length - 1) {
			const newStages = target.stages.map((s, i) =>
				i === target.currentStageIndex ? { ...s, completed: true, completedAt: now } : s,
			);
			next.stages = newStages;
			next.currentStageIndex = target.currentStageIndex + 1;
			const newCurrent = newStages[next.currentStageIndex];
			next.nextTickAtDay = newCurrent?.condition === 'time'
				? currentTotalDays() + timeStageGapDays(newCurrent)
				: null;
			next.pressure = clamp((next.pressure ?? target.pressure) + PRESSURE_PER_STAGE, 0, 100);
		}
		if (e.status) next.status = e.status;
		if ((next.pressure ?? target.pressure) >= PRESSURE_CLIMAX_THRESHOLD && target.status === 'active') {
			next.status = 'climaxing';
		}
		try {
			const updated = { ...target, ...next };
			applyCurrentStoryServerVersion(await saveCanonicalScheme(updated));
			story.schemes = story.schemes.map(s => (s.id === target.id ? updated : s));
		} catch (err) {
			errors.push(`scheme.escalate persist: ${err instanceof Error ? err.message : err}`);
		}
	}

	for (const r of args.resolve) {
		const target = findUniqueSchemeByIdOrPrefix(story.schemes, r.id);
		if (!target) {
			errors.push(`scheme.resolve id missing or ambiguous: ${r.id}`);
			continue;
		}
		const next: Partial<Scheme> = { status: r.outcome, updatedAt: now };
		try {
			const updated = { ...target, ...next };
			applyCurrentStoryServerVersion(await saveCanonicalScheme(updated));
			story.schemes = story.schemes.map(s => (s.id === target.id ? updated : s));
		} catch (err) {
			errors.push(`scheme.resolve persist: ${err instanceof Error ? err.message : err}`);
		}
	}
}

// ══════════════════════════════════════════════════════════════
// tick — deterministic stage advancement on the world clock
// ══════════════════════════════════════════════════════════════

export async function tick(_deltaMinutes: number): Promise<void> {
	if (!story.currentStory) return;
	const totalDays = currentTotalDays();
	const updates: Scheme[] = [];
	const now = Date.now();

	for (const scheme of story.schemes) {
		if (scheme.status !== 'active' && scheme.status !== 'climaxing') continue;
		if (scheme.currentStageIndex >= scheme.stages.length - 1) continue;

		const currentStage = scheme.stages[scheme.currentStageIndex];
		if (currentStage.condition !== 'time') continue;
		if (scheme.nextTickAtDay == null || totalDays < scheme.nextTickAtDay) continue;

		const newStages = scheme.stages.map((s, i) =>
			i === scheme.currentStageIndex ? { ...s, completed: true, completedAt: now } : s,
		);
		const newIndex = scheme.currentStageIndex + 1;
		const newCurrent = newStages[newIndex];
		const newPressure = clamp(scheme.pressure + PRESSURE_PER_STAGE, 0, 100);
		const next: Scheme = {
			...scheme,
			stages: newStages,
			currentStageIndex: newIndex,
			pressure: newPressure,
			nextTickAtDay: newCurrent?.condition === 'time'
				? totalDays + timeStageGapDays(newCurrent)
				: null,
			status: newPressure >= PRESSURE_CLIMAX_THRESHOLD ? 'climaxing' : scheme.status,
			updatedAt: now,
		};
		updates.push(next);
	}

	if (updates.length === 0) return;
	try {
		applyCurrentStoryServerVersion(await saveCanonicalSchemes(updates));
		const byId = new Map(updates.map(u => [u.id, u]));
		story.schemes = story.schemes.map(s => byId.get(s.id) ?? s);
	} catch (e) {
		console.warn('[SchemeService] tick persist failed:', e);
	}
}

// ══════════════════════════════════════════════════════════════
// inject — narrator system prompt section
// ══════════════════════════════════════════════════════════════

/**
 * Build the "Active Schemes" section for the narrator system prompt.
 *
 * Antagonist schemes that are `known` OR `rumored` (or pressure ≥ 70 regardless
 * of secrecy — fate closes in) are surfaced with their current stage hook. The
 * narrator is instructed to deliver the beat. Player schemes are framed as
 * opportunities and obstacles for the GM to complicate.
 *
 * Returns empty string when there's nothing to inject (the most common case
 * outside ASOIAF/political stories).
 *
 * NOTE: Takes the scheme list as an argument rather than reading from the
 * `story` store. Lets `story.svelte.ts` import this function without creating
 * a circular module dependency (story → SchemeService → story).
 */
export function injectSchemes(allSchemes: Scheme[]): string {
	const schemes = allSchemes
		.filter(s => s.status === 'active' || s.status === 'climaxing')
		.filter(s =>
			s.ownerType === 'player'
			|| s.secrecy === 'known'
			|| s.secrecy === 'rumored'
			|| s.pressure >= PRESSURE_VISIBLE_OVERRIDE,
		)
		.sort((a, b) => b.pressure - a.pressure)
		.slice(0, INJECT_CAP);

	if (schemes.length === 0) return '';

	const antagonist = schemes.filter(s => s.ownerType !== 'player');
	const player = schemes.filter(s => s.ownerType === 'player');
	const out: string[] = ['## Active Schemes'];

	if (antagonist.length > 0) {
		out.push('');
		out.push('### Moving Against the Player');
		out.push(
			'These are pre-decided antagonist plots in motion. The current stage hook is ' +
			'happening THIS chapter — weave it into your narration. Do not soften, foreshadow, ' +
			'or delay; the plot is already underway. Use the stage hook as a beat that lands.',
		);
		for (const s of antagonist) {
			const stage = s.stages[s.currentStageIndex];
			const climax = s.status === 'climaxing' ? ' [CLIMAXING]' : '';
			const stageNum = `${s.currentStageIndex + 1}/${s.stages.length}`;
			out.push(
				`- **${s.ownerName}** (${s.ownerType}, pressure ${s.pressure}/100${climax}) — goal: ${s.goal}`,
			);
			out.push(`  Stage ${stageNum} "${stage.label}": ${stage.hook}`);
		}
	}

	if (player.length > 0) {
		out.push('');
		out.push('### Player Plans In Motion');
		out.push(
			'The player has declared these plans. Surface the current stage as an ' +
			'OPPORTUNITY OR OBSTACLE, not an inevitable outcome. Make the player work for it: ' +
			'add complications, guards, hesitating allies, forewarned targets. The plan is ' +
			'their intent, not their guarantee.',
		);
		for (const s of player) {
			const stage = s.stages[s.currentStageIndex];
			const stageNum = `${s.currentStageIndex + 1}/${s.stages.length}`;
			out.push(`- Goal: ${s.goal}`);
			out.push(`  Stage ${stageNum} "${stage.label}": ${stage.hook}`);
		}
	}

	return out.join('\n');
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

function resolveOwnerEntry(name: string, type: 'faction' | 'character'): Entry | null {
	const needle = name.toLowerCase();
	const match = story.lorebookEntries.find(e => {
		if (e.type !== type) return false;
		if (e.name.toLowerCase() === needle) return true;
		return (e.aliases ?? []).some(a => a?.toLowerCase() === needle);
	});
	return match ?? null;
}

function latestEntryId(): string | null {
	const entries = story.entries;
	return entries.length > 0 ? entries[entries.length - 1].id : null;
}
