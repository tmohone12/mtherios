/**
 * ContextAssembler — Mtherios
 *
 * Pre-generation context assembly with dynamic, model-aware token budgets.
 * Runs BEFORE the narrator generates, not after.
 *
 * Tiers (in prompt order):
 *   1. Scene      — current location, present characters, equipped items
 *   2. Recent     — ALL uncovered chapter summaries (not yet condensed into arcs)
 *   3. World      — arc summaries, unresolved threads, DM plot injection
 *   4. Procedural — CASS-inspired narrative rules (decay-scored, relevance-matched)
 *   5. Retrieved  — AI-selected chapters + agentic lore search (single unified lore path)
 *
 * Budget scaling:
 *   Budgets scale with the model's context window. A 128k model gets ~16x
 *   the context of an 8k model. The ratio table defines what fraction of
 *   total context budget each tier receives.
 */

import { settings } from '$lib/stores/settings.svelte';
import { getChapters, getArcs, getNpcConversationMemory } from '$lib/services/database';
import type { Character, Location, Item, StoryEntry, Entry, Chapter, Arc, EntryRelationship, WorldEvent, CharacterEntryState } from '$lib/types';
import type { PlotInjection, Rumor, WorldSimulationResult } from '../sdk/schemas/worldsim';
import type { SeasonEffect } from '../generation/WorldSimulationService';

// ── Token helpers ──

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, budget: number): string {
	const charLimit = budget * 4;
	if (text.length <= charLimit) return text;
	return text.slice(0, charLimit - 3) + '...';
}

// ── Types ──

export interface TierBudget {
	scene: number;
	recent: number;
	world: number;
	procedural: number;
	retrieved: number;
}

export interface TierUsage {
	scene: number;
	recent: number;
	world: number;
	procedural: number;
	retrieved: number;
}

export interface AssembledContext {
	contextBlock: string;
	tierUsage: TierUsage;
	totalTokens: number;
}

export interface AssembleParams {
	storyId: string;
	userAction: string;
	entries: StoryEntry[];
	characters: Character[];
	locations: Location[];
	items: Item[];
	lorebookEntries: Entry[];
	lastWorldSimResult: (WorldSimulationResult & { seasonEffect?: SeasonEffect }) | null;
	pendingFactionReactions?: import('../sdk/schemas/microfaction').MicroFactionResult[];
	entryRelationships: EntryRelationship[];
	worldEvents: WorldEvent[];
	storyMode: string;
	pov: string;
	tense: string;
	maxChaptersPerRetrieval?: number;
}

// ── Budget ratios (fraction of total context budget per tier) ──
// These define the relative importance of each tier.
// Total must equal 1.0.

const TIER_RATIOS = {
	scene: 0.10,
	recent: 0.35,
	world: 0.20,
	procedural: 0.05,
	retrieved: 0.30,
};

// ── Context window estimation ──
// We reserve only for output generation. Everything else fills the model's context.
// The model's context window is the only real limit.

const RESERVED_FOR_OUTPUT = 4096;  // generation output buffer
const MIN_CONTEXT_BUDGET = 8000;   // floor: never go below this
const DEFAULT_MODEL_CONTEXT = 128000; // fallback when we can't determine model context

/**
 * Known context window sizes for common models.
 * Used as a lookup when the provider doesn't report context size.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	// OpenAI
	'gpt-4o': 128000,
	'gpt-4o-mini': 128000,
	'gpt-4-turbo': 128000,
	'gpt-4': 8192,
	'gpt-3.5-turbo': 16385,
	'o1': 200000,
	'o1-mini': 128000,
	// Anthropic
	'claude-opus-4-5-20251101': 200000,
	'claude-sonnet-4-5-20250929': 200000,
	'claude-haiku-4-5-20251001': 200000,
	'claude-opus-4-1-20250805': 200000,
	'claude-sonnet-4-20250514': 200000,
	'claude-opus-4-20250514': 200000,
	// Google
	'gemini-3-pro-preview': 1048576,
	'gemini-3-flash-preview': 1048576,
	'gemini-2.5-pro': 1048576,
	'gemini-2.5-flash': 1048576,
	'gemini-2.5-flash-lite': 1048576,
	// DeepSeek
	'deepseek-chat': 64000,
	'deepseek-reasoner': 64000,
	// xAI
	'grok-3': 131072,
	'grok-3-fast': 131072,
	'grok-2': 131072,
	// Groq
	'llama-3.3-70b-versatile': 128000,
	'mixtral-8x7b-32768': 32768,
	// Mistral
	'mistral-large-latest': 128000,
	'mistral-small-latest': 128000,
	// OpenRouter common
	'z-ai/glm-5': 128000,
	'x-ai/grok-4.1-fast': 131072,
	'google/gemini-3-flash-preview': 1048576,
	'deepseek/deepseek-v3.2': 64000,
	'stepfun/step-3.5-flash:free': 128000,
	// NanoGPT common
	'zai-org/glm-5:thinking': 128000,
	'stepfun-ai/step-3.5-flash:thinking': 128000,
	'openai/gpt-oss-120b': 128000,
};

export function getModelContextWindow(model: string): number {
	// Exact match
	if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];

	// Partial match (e.g. "gpt-4o-2024-05-13" → "gpt-4o")
	for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (model.startsWith(key)) return value;
	}

	// Heuristic: if model name contains common patterns
	if (model.includes('gemini')) return 1048576;
	if (model.includes('claude')) return 200000;
	if (model.includes('gpt-4o')) return 128000;
	if (model.includes('grok')) return 131072;

	return DEFAULT_MODEL_CONTEXT;
}

// ── Assembler ──

export class ContextAssembler {
	private budgetOverrides?: Partial<TierBudget>;

	constructor(budgets?: Partial<TierBudget>) {
		this.budgetOverrides = budgets;
	}

	/**
	 * Compute dynamic tier budgets based on the active model's context window.
	 * Each tier gets the full context budget — they include everything they have.
	 * Only the combined total is bounded by the model's context window.
	 */
	private computeBudgets(): TierBudget {
		const narrativeConfig = settings.narrativeSettings;
		const model = narrativeConfig.model || '';
		const contextWindow = getModelContextWindow(model);
		const userBudget = settings.contextBudget;
		// Total context budget = model context minus output reserve
		const totalBudget = userBudget > 0
			? Math.max(Math.min(userBudget, contextWindow - RESERVED_FOR_OUTPUT), MIN_CONTEXT_BUDGET)
			: Math.max(contextWindow - RESERVED_FOR_OUTPUT, MIN_CONTEXT_BUDGET);

		// Each tier gets the full budget — include everything available.
		// The assembler will truncate the combined block if it exceeds the total.
		const budgets: TierBudget = {
			scene: totalBudget,
			recent: totalBudget,
			world: totalBudget,
			procedural: Math.floor(totalBudget * 0.10), // procedural rules stay bounded
			retrieved: totalBudget,
		};

		if (this.budgetOverrides) {
			Object.assign(budgets, this.budgetOverrides);
		}

		return budgets;
	}

	async assemble(params: AssembleParams): Promise<AssembledContext> {
		const { storyId } = params;
		const budgets = this.computeBudgets();

		// Fetch persistent data once
		const [chapters, arcs] = await Promise.all([
			getChapters(storyId),
			getArcs(storyId),
		]);

		// Build each tier (scene, procedural and retrieved are async)
		const recentTier = this.buildRecentTier(chapters, arcs, budgets);
		const worldTier = this.buildWorldTier(arcs, params.lastWorldSimResult, params.pendingFactionReactions ?? [], params.locations, params.worldEvents ?? [], budgets);

		const [sceneTier, proceduralTier, retrievedTier] = await Promise.all([
			this.buildSceneTier(params, budgets),
			this.buildProceduralTier(params, budgets),
			this.buildRetrievedTier(params, chapters, arcs, budgets),
		]);

		// Measure usage
		const tierUsage: TierUsage = {
			scene: estimateTokens(sceneTier),
			recent: estimateTokens(recentTier),
			world: estimateTokens(worldTier),
			procedural: estimateTokens(proceduralTier),
			retrieved: estimateTokens(retrievedTier),
		};

		// Assemble in order — include everything, truncate only the combined total
		let contextBlock = '';
		if (sceneTier) contextBlock += sceneTier + '\n';
		if (recentTier) contextBlock += recentTier + '\n';
		if (worldTier) contextBlock += worldTier + '\n';
		if (proceduralTier) contextBlock += proceduralTier + '\n';
		if (retrievedTier) contextBlock += retrievedTier + '\n';

		// Truncate combined context to 40% of model context (rest goes to history + system + output)
		const narrativeConfig = settings.narrativeSettings;
		const model = narrativeConfig.model || '';
		const contextWindow = getModelContextWindow(model);
		const maxContextTokens = Math.floor(contextWindow * 0.40);
		contextBlock = truncateToTokens(contextBlock, maxContextTokens);

		const totalTokens = Object.values(tierUsage).reduce((a, b) => a + b, 0);

		return { contextBlock, tierUsage, totalTokens };
	}

	// ── Tier 1: Scene ──

	private async buildSceneTier(params: AssembleParams, budgets: TierBudget): Promise<string> {
		const { characters, locations, items } = params;
		let block = '';

		// Current location
		const currentLoc = locations.find(l => l.current);
		if (currentLoc) {
			block += `\n## Current Scene\n`;
			block += `**Location: ${currentLoc.name}**`;
			if (currentLoc.description) block += ` — ${currentLoc.description}`;
			block += '\n';
		}

		// Characters present at current location (departed/deceased are already cleared from metadata)
		const presentChars = currentLoc
			? characters.filter(c =>
				c.status === 'active' &&
				c.relationship !== 'self' &&
				(c.metadata as Record<string, unknown>)?.lastSeenLocation === currentLoc.name
			)
			: [];

		if (presentChars.length > 0) {
			block += `\n**Present:**\n`;
			for (const c of presentChars) {
				const desc = c.description
					? c.description.slice(0, 100) + (c.description.length > 100 ? '...' : '')
					: '';
				block += `- ${c.name}${c.relationship ? ` (${c.relationship})` : ''}${desc ? ': ' + desc : ''}\n`;

				// NPC conversation memory — what this character remembers
				const charEntry = params.lorebookEntries.find(e =>
					e.type === 'character' && e.name.toLowerCase() === c.name.toLowerCase()
				);
				if (charEntry) {
					const cState = charEntry.state as CharacterEntryState;
					if (cState?.knownFacts?.length) {
						block += `  [Remembers: ${cState.knownFacts.slice(-3).join('; ')}]\n`;
					}
					if (cState?.personalOpinion) {
						block += `  [Attitude: ${cState.personalOpinion}]\n`;
					}

					// Relationships for this character
					const rels = params.entryRelationships.filter(r =>
						r.sourceEntryId === charEntry.id || (r.bidirectional && r.targetEntryId === charEntry.id)
					);
					if (rels.length > 0) {
						const relLabels = rels.slice(0, 4).map(r => {
							const otherId = r.sourceEntryId === charEntry.id ? r.targetEntryId : r.sourceEntryId;
							const other = params.lorebookEntries.find(e => e.id === otherId);
							return other ? `${r.type} ${other.name}` : null;
						}).filter(Boolean);
						if (relLabels.length > 0) {
							block += `  [Ties: ${relLabels.join(', ')}]\n`;
						}
					}

					// Character enrichment fields
					if (cState?.bio) {
						block += `  [Bio: ${cState.bio}]\n`;
					}
					if (cState?.personality) {
						block += `  [Personality: ${cState.personality}]\n`;
					}
					if (cState?.motivations?.length) {
						block += `  [Drives: ${cState.motivations.join('; ')}]\n`;
					}

					// Conversation memory records from DB (presence-based)
					const convMemories = await getNpcConversationMemory(params.storyId, charEntry.id);
					if (convMemories.length > 0) {
						const importanceRank: Record<string, number> = { critical: 4, significant: 3, minor: 2, trivial: 1 };
						const ranked = convMemories
							.sort((a, b) => {
								const diff = (importanceRank[b.importance] ?? 0) - (importanceRank[a.importance] ?? 0);
								return diff !== 0 ? diff : b.storyPosition - a.storyPosition;
							})
							.slice(0, 5);
						block += `  [Past exchanges:\n`;
						for (const mem of ranked) {
							block += `    - (${mem.importance}) ${mem.topic}`;
							if (mem.npcLearned?.length) block += ` [learned: ${mem.npcLearned.join(', ')}]`;
							block += `\n`;
						}
						block += `  ]\n`;
					}
				}
			}
		}

		// Location exits (spatial graph)
		if (currentLoc) {
			const locEntry = params.lorebookEntries.find(e =>
				e.type === 'location' && e.name.toLowerCase() === currentLoc.name.toLowerCase()
			);
			if (locEntry) {
				const locState = locEntry.state as import('$lib/types').LocationEntryState;
				if (locState?.connections?.length) {
					block += `\n**Exits:**\n`;
					for (const conn of locState.connections) {
						const dir = conn.direction ? `${conn.direction}: ` : '';
						const blocked = conn.blocked ? ` [BLOCKED: ${conn.blockedReason}]` : '';
						block += `- ${dir}${conn.targetLocationName}${blocked}\n`;
					}
				}
			}
		}

		// Equipped items
		const equipped = items.filter(i => i.equipped);
		if (equipped.length > 0) {
			block += `\n**Equipped:** ${equipped.map(i => i.name).join(', ')}\n`;
		}

		return truncateToTokens(block, budgets.scene);
	}

	// ── Tier 2: Recent chapters (ALL uncovered) ──

	private buildRecentTier(chapters: Chapter[], arcs: Arc[], budgets: TierBudget): string {
		if (chapters.length === 0) return '';

		const coveredIds = new Set(arcs.flatMap(a => a.chapterIds));
		const uncovered = chapters
			.filter(c => !coveredIds.has(c.id))
			.sort((a, b) => a.number - b.number); // chronological

		if (uncovered.length === 0) return '';

		let block = '\n## Recent Story\n';
		let tokensSoFar = estimateTokens(block);

		// Include ALL uncovered chapters, budget permitting.
		// Start from newest and work backwards so the most recent context
		// is preserved if we hit the budget limit.
		const newest = [...uncovered].reverse();
		const included: Chapter[] = [];

		for (const ch of newest) {
			const summary = ch.summary.length > 600
				? ch.summary.slice(0, 597) + '...'
				: ch.summary;
			const chBlock = `\n**Ch.${ch.number}: ${ch.title ?? 'Untitled'}**\n${summary}\n`;
			const chTokens = estimateTokens(chBlock);

			if (tokensSoFar + chTokens > budgets.recent) break;
			included.push(ch);
			tokensSoFar += chTokens;
		}

		// Reverse back to chronological for reading
		included.sort((a, b) => a.number - b.number);
		for (const ch of included) {
			const summary = ch.summary.length > 600
				? ch.summary.slice(0, 597) + '...'
				: ch.summary;
			block += `\n**Ch.${ch.number}: ${ch.title ?? 'Untitled'}**\n${summary}\n`;
		}

		return block;
	}

	// ── Tier 3: World (arcs + threads + DM injection + faction rumors) ──

	private buildWorldTier(
		arcs: Arc[],
		ws: (WorldSimulationResult & { seasonEffect?: SeasonEffect }) | null,
		factionReactions: import('../sdk/schemas/microfaction').MicroFactionResult[],
		locations: Location[],
		worldEvents: WorldEvent[],
		budgets: TierBudget,
	): string {
		let block = '';

		// Arc summaries (compressed long-term history)
		if (arcs.length > 0) {
			block += '\n## Story History\n';
			for (const arc of arcs) {
				block += `\n**Arc ${arc.arcNumber}: ${arc.title}** (Ch.${arc.chapterRange})\n`;
				block += arc.summary.slice(0, 400) + (arc.summary.length > 400 ? '...' : '') + '\n';
			}
		}

		// Unresolved threads from all arcs
		const threads = arcs.flatMap(a => a.unresolvedThreads).filter(Boolean);
		if (threads.length > 0) {
			block += `\n**Open threads:** ${threads.join('; ')}\n`;
		}

		if (!ws) return truncateToTokens(block, budgets.world);

		// World narrative
		if (ws.worldNarrative) {
			block += `\n[WORLD STATE] ${ws.worldNarrative}\n`;
		}

		// Plot injection
		if (ws.plotInjection) {
			const pi = ws.plotInjection;
			const urgencyLabel = pi.urgency === 'immediate' ? 'WEAVE THIS INTO THE NEXT RESPONSE'
				: pi.urgency === 'emerging' ? 'INTRODUCE THIS SOON'
				: 'SUBTLY HINT AT THIS';
			block += `\n[DM PLOT INJECTION — ${urgencyLabel}]\n`;
			block += pi.prose + '\n';
			if (pi.narratorDirective) block += `[How: ${pi.narratorDirective}]\n`;
		}

		// Rumors — filtered by player location
		if (ws.rumors && ws.rumors.length > 0) {
			const currentLocName = (locations.find(l => l.current)?.name ?? '').toLowerCase();
			const reachable = this.filterRumorsByLocation(ws.rumors, currentLocName);

			if (reachable.length > 0) {
				block += '\n[RUMORS & WHISPERS — weave as NPC dialogue, tavern gossip, overheard conversation]\n';
				for (const rumor of reachable) {
					const tag = rumor.truthfulness >= 0.7 ? 'reliable'
						: rumor.truthfulness >= 0.4 ? 'uncertain' : 'dubious';
					block += `- (${tag}, via ${rumor.sourceType}) ${rumor.content}\n`;
				}
			}
		}

		// World tension
		if (ws.worldTension >= 7) {
			block += `\n[WORLD TENSION: HIGH (${ws.worldTension}/10) — unease, nervous NPCs, doubled guards]\n`;
		} else if (ws.worldTension >= 4) {
			block += `\n[WORLD TENSION: MODERATE (${ws.worldTension}/10) — undercurrents of unrest, hushed talk]\n`;
		}

		// Season (deterministic, from service)
		if (ws.seasonEffect?.narrativeNote) {
			block += `\n[SEASON] ${ws.seasonEffect.narrativeNote}\n`;
		}

		// Plot seeds from faction actions
		if (ws.plotSeeds && ws.plotSeeds.length > 0) {
			block += `\n[FACTION PLOT SEEDS — plant subtly, do not force]\n`;
			for (const seed of ws.plotSeeds) block += `- ${seed}\n`;
		}

		// Micro-faction reactions (event-driven, from classifier signals)
		if (factionReactions.length > 0) {
			const visible = factionReactions.filter(r => r.reaction.visible || r.reaction.rumor);
			if (visible.length > 0) {
				block += '\n[RECENT FACTION MOVES — weave naturally, not all at once]\n';
				for (const r of visible) {
					if (r.reaction.rumor) {
						block += `- (rumor) ${r.reaction.rumor}\n`;
					} else if (r.reaction.visible) {
						block += `- ${r.factionName}: ${r.reaction.action}\n`;
					}
					if (r.reaction.consequence) {
						block += `  → ${r.reaction.consequence}\n`;
					}
				}
			}
		}

		// Recent world events (Tier 2 consequence system)
		const recentEvents = worldEvents
			.filter(e => e.appliedAt != null)
			.sort((a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0))
			.slice(0, 5);
		if (recentEvents.length > 0) {
			block += '\n**Recent World Events:**\n';
			for (const event of recentEvents) {
				block += `- ${event.name}: ${event.description}\n`;
				const applied = event.consequences.filter(c => c.status === 'applied');
				for (const c of applied) {
					block += `  → ${c.description}\n`;
				}
			}
		}

		return truncateToTokens(block, budgets.world);
	}

	/**
	 * Filter rumors by what could plausibly reach the player's current location.
	 * Continental = always. Regional = always (until geography system exists). Local = location match.
	 */
	private filterRumorsByLocation(rumors: Rumor[], currentLocName: string): Rumor[] {
		return rumors.filter(rumor => {
			if (rumor.spreadRadius === 'continental' || rumor.spreadRadius === 'regional') return true;
			if (rumor.spreadRadius === 'local') {
				const origin = rumor.originRegion.toLowerCase();
				return currentLocName.includes(origin) || origin.includes(currentLocName);
			}
			return false;
		});
	}

	// ── Tier 4: Procedural rules (CASS-inspired) ──

	private async buildProceduralTier(params: AssembleParams, budgets: TierBudget): Promise<string> {
		const procConfig = settings.getServiceConfig('proceduralMemory');
		if (!procConfig.enabled) return '';

		try {
			const { ai } = await import('$lib/services/ai');
			const recentNarrative = params.entries.slice(-3).map(e => e.content).join('\n');

			const rules = await ai.proceduralMemory.getRelevantRules(
				params.storyId,
				params.userAction,
				recentNarrative,
			);

			return truncateToTokens(
				ai.proceduralMemory.buildContextBlock(rules),
				budgets.procedural,
			);
		} catch (e) {
			console.error('Procedural rules tier failed:', e);
			return '';
		}
	}

	// ── Tier 5: Retrieved context (unified: chapters + lore via AgenticRetrieval) ──

	private async buildRetrievedTier(
		params: AssembleParams,
		chapters: Chapter[],
		arcs: Arc[],
		budgets: TierBudget,
	): Promise<string> {
		// Lazy import to avoid circular dependency (ai/index.ts registers ContextAssembler)
		const { ai } = await import('$lib/services/ai');

		let block = '';

		// Memory retrieval — embedding-based chapter similarity (replaces LLM call)
		// Skip chapters already in the Recent tier (uncovered) to avoid double-injection
		const memConfig = settings.getServiceConfig('memory');
		if (memConfig.enabled && chapters.length > 0) {
			try {
				const coveredIds = new Set(arcs.flatMap(a => a.chapterIds));
				const coveredChapters = chapters.filter(c => coveredIds.has(c.id));

				// Only offer covered (arc'd) chapters for retrieval — uncovered ones
				// are already fully present in the Recent tier
				if (coveredChapters.length > 0) {
					const queryText = params.userAction + ' ' + params.entries.slice(-3).map(e => e.content).join('\n');
					const scored = await ai.embeddings.scoreSimilarity(
						queryText,
						coveredChapters.map(c => ({
							id: c.id,
							text: `${c.title ?? 'Chapter ' + c.number}: ${c.summary}`,
							sourceType: 'chapter' as const,
						})),
					);

					// Take top N above 0.3 threshold (respects maxChaptersPerRetrieval config)
					const maxRetrieve = params.maxChaptersPerRetrieval ?? 5;
					const relevant = scored.filter(s => s.score >= 0.3).slice(0, maxRetrieve);
					if (relevant.length > 0) {
						block += '\n## Retrieved Memory\n';
						for (const { id } of relevant) {
							const ch = coveredChapters.find(c => c.id === id);
							if (!ch) continue;
							const summary = ch.summary.length > 400
								? ch.summary.slice(0, 397) + '...'
								: ch.summary;
							block += `\n**Ch.${ch.number}: ${ch.title ?? 'Untitled'}**\n${summary}\n`;
						}
					}
				}
			} catch (e) {
				console.error('Pre-gen memory retrieval failed:', e);
			}
		}

		// Agentic retrieval — single unified lore path (replaces old separate lore tier)
		const agenticConfig = settings.getServiceConfig('agenticRetrieval');
		if (agenticConfig.enabled) {
			try {
				const result = await ai.agenticRetrieval.retrieve(
					params.userAction,
					params.entries.slice(-5),
					params.lorebookEntries,
					chapters,
					2, // cap at 2 iterations for pre-gen (faster)
				);
				if (result.chapterContext) {
					block += result.chapterContext;
				}
				// External Lore RAG — deep world knowledge from vector DB
				if (result.ragContext) {
					block += result.ragContext;
				}
			} catch (e) {
				console.error('Pre-gen agentic retrieval failed:', e);
			}

			// Standalone RAG fallback — if agentic retrieval is disabled but RAG is enabled
			if (!agenticConfig.enabled) {
				try {
					const ragResult = await ai.loreRAG.retrieve(params.userAction);
					if (ragResult.contextBlock) {
						block += ragResult.contextBlock;
					}
				} catch (e) {
					console.error('Standalone RAG retrieval failed:', e);
				}
			}
		}

		return truncateToTokens(block, budgets.retrieved);
	}
}
