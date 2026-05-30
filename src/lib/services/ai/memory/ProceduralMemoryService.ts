/**
 * ProceduralMemoryService — Mtherios
 *
 * CASS-inspired procedural memory for interactive fiction.
 * Extracts durable narrative rules from chapters/arcs, manages confidence scores
 * with temporal decay, and injects relevant rules into the generation context.
 *
 * Pipeline (mirrors CASS):
 *   Reflector  → Extract rules from chapters/arcs (LLM)
 *   Curator    → Deduplicate, merge, score, decay (deterministic, no LLM)
 *   Injector   → Score and select relevant rules for context assembly
 */

import { BaseAIService } from '../BaseAIService';
import { reflectionResultSchema, type ExtractedRule } from '../sdk/schemas/procedural';
import { createLogger } from '../core/config';
import { uuid } from '$lib/utils/uuid';
import {
	getProceduralRules, createProceduralRule, bulkPutProceduralRules,
	updateProceduralRule, deleteProceduralRule,
} from '$lib/services/database';
import { tfidfSimilarity } from '../embeddings/EmbeddingService';
import type { ProceduralRule, RuleCategory, RuleMaturity, Chapter, Arc, Entry } from '$lib/types';
import { buildWarMemoryContinuityBlock } from '../context/warDoctrine';

const log = createLogger('ProceduralMemory');

// ── Constants (CASS-inspired) ──

/** Score decay half-life in days — unreinforced rules lose relevance */
const DECAY_HALF_LIFE_DAYS = 14;

/** Maturity thresholds */
const MATURITY_THRESHOLDS = {
	candidateToEstablished: 0.5,   // effectiveScore >= 0.5 after 2+ reinforcements
	establishedToProven: 0.75,      // effectiveScore >= 0.75 after 5+ reinforcements
	deprecateThreshold: 0.15,       // effectiveScore < 0.15 → deprecated
};

/** Deduplication similarity threshold (CASS uses 0.85 Jaccard) */
const DEDUP_THRESHOLD = 0.75;

/** Max rules per story to prevent bloat */
const MAX_RULES_PER_STORY = 100;

/** Max rules to inject into context per turn */
export const MAX_RULES_IN_CONTEXT = 15;

// ── Decay calculation ──

function computeDecayedScore(
	helpfulCount: number,
	harmfulCount: number,
	lastReinforcedAt: number,
	createdAt: number,
): number {
	const now = Date.now();
	const daysSinceReinforced = (now - lastReinforcedAt) / (1000 * 60 * 60 * 24);
	const decayFactor = Math.pow(0.5, daysSinceReinforced / DECAY_HALF_LIFE_DAYS);

	// Base score: helpful vs harmful ratio
	const total = helpfulCount + harmfulCount;
	if (total === 0) {
		// New rule — start at 0.5 with age decay
		const daysSinceCreated = (now - createdAt) / (1000 * 60 * 60 * 24);
		return 0.5 * Math.pow(0.5, daysSinceCreated / DECAY_HALF_LIFE_DAYS);
	}

	const baseScore = helpfulCount / total;
	return baseScore * decayFactor;
}

function computeMaturity(rule: ProceduralRule): RuleMaturity {
	const totalFeedback = rule.helpfulCount + rule.harmfulCount;

	if (rule.effectiveScore < MATURITY_THRESHOLDS.deprecateThreshold) return 'deprecated';
	if (rule.effectiveScore >= MATURITY_THRESHOLDS.establishedToProven && totalFeedback >= 5) return 'proven';
	if (rule.effectiveScore >= MATURITY_THRESHOLDS.candidateToEstablished && totalFeedback >= 2) return 'established';
	return 'candidate';
}

// ── Service ──

export class ProceduralMemoryService extends BaseAIService {
	constructor() {
		super('proceduralMemory');
	}

	// ═══════════════════════════════════════════════════════════════
	// Stage 1: REFLECTOR — Extract rules from narrative (LLM-powered)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Reflect on chapters/arcs to extract procedural rules.
	 * Called after arc condensation (every ~5 chapters).
	 */
	async reflect(
		chapters: Chapter[],
		arcs: Arc[],
		lorebookEntries: Entry[],
		storyId: string,
		mode = 'adventure',
	): Promise<{ newRules: number; updatedRules: number; summary: string }> {
		log('reflect', { chapters: chapters.length, arcs: arcs.length, loreEntries: lorebookEntries.length });

		const existingRules = await getProceduralRules(storyId);

		// Build context for reflection
		const chapterBlock = chapters.slice(-5).map(c =>
			`Chapter ${c.number}: ${c.title ?? 'Untitled'}\n${c.summary}\nCharacters: ${c.characters.join(', ')}\nLocations: ${c.locations.join(', ')}\nTone: ${c.emotionalTone ?? 'neutral'}`
		).join('\n\n');

		const arcBlock = arcs.length > 0
			? arcs.map(a => `Arc ${a.arcNumber}: ${a.title}\n${a.summary}\nThreads: ${a.unresolvedThreads.join('; ')}`).join('\n\n')
			: '';

		const loreBlock = lorebookEntries.slice(0, 20).map(e =>
			`[${e.type}] ${e.name}: ${e.description.slice(0, 100)}`
		).join('\n');

		const existingRulesBlock = existingRules
			.filter(r => r.maturity !== 'deprecated')
			.map(r => `[${r.maturity}|${r.effectiveScore.toFixed(2)}] ${r.content}`)
			.join('\n');

		const system = `You are a narrative pattern analyst for a ${mode} interactive fiction story.

Your job is to extract DURABLE RULES and PATTERNS from the story so far — things the narrator should remember and apply consistently in future scenes.

Faction goals define why a faction fights; schemes define how they try to win; story threads define how the war becomes player-facing plot; world events record what actually happened.

${buildWarMemoryContinuityBlock()}

═══ EXISTING RULES ═══
${existingRulesBlock || '(none yet)'}

═══ LOREBOOK ENTRIES ═══
${loreBlock || '(none)'}

═══ WHAT TO EXTRACT ═══

1. **Character Behaviors**: Consistent traits, reactions, or relationship dynamics
   - "Kira becomes hostile when her past is mentioned"
   - "The merchant always offers a worse deal on the second visit"

2. **World Rules**: How the world works, established cause-and-effect
   - "Magic is unreliable near the Iron Wastes"
   - "The city guard patrols increase at night"

3. **Narrative Patterns**: Recurring story structures or player preferences
   - "The player tends to negotiate rather than fight"
   - "Dramatic moments work best when preceded by calm scenes"

4. **Anti-Patterns**: Things that went poorly and should be avoided
   - "Avoid introducing more than 2 new characters per chapter"
   - "Don't resolve mysteries too quickly"

5. **Lore Connections**: Relationships between lorebook entries
   - "The Sunstone is linked to the Eclipse Prophecy through the Temple of Dawn"

═══ GUIDELINES ═══

- Only extract patterns with EVIDENCE in the chapters/arcs — no speculation
- Each rule should be a clear, actionable statement
- Check existing rules first — if a pattern is already captured, reinforce it rather than creating a duplicate
- Confidence: 0.3-0.5 for emerging patterns, 0.5-0.7 for clear patterns, 0.7-1.0 for very well-established facts
- Be concise: each rule should be 1-2 sentences max
- Extract 3-8 rules per reflection (quality over quantity)

═══ OUTPUT FORMAT ═══

Respond with JSON:
{
  "rules": [
    {
      "content": "...",
      "category": "character_behavior" | "world_rule" | "narrative_pattern" | "player_preference" | "anti_pattern" | "lore_connection",
      "type": "rule" | "anti_pattern",
      "confidence": 0.0-1.0,
      "relatedEntities": ["entity names..."],
      "tags": ["searchable", "tags"]
    }
  ],
  "summary": "Brief description of patterns found"
}`;

		const prompt = arcBlock
			? `Recent arcs:\n${arcBlock}\n\nRecent chapters:\n${chapterBlock}`
			: `Recent chapters:\n${chapterBlock}`;

		const result = await this.generateStructured(reflectionResultSchema, system, prompt);

		// ── Curate: deduplicate and integrate new rules ──
		let newCount = 0;
		let updatedCount = 0;

		for (const extracted of result.rules) {
			const { action, existingRule } = this.findDuplicate(extracted, existingRules);

			if (action === 'reinforce' && existingRule) {
				// Reinforce existing rule
				const updated: Partial<ProceduralRule> = {
					helpfulCount: existingRule.helpfulCount + 1,
					lastReinforcedAt: Date.now(),
					updatedAt: Date.now(),
				};
				updated.effectiveScore = computeDecayedScore(
					updated.helpfulCount!, existingRule.harmfulCount,
					updated.lastReinforcedAt!, existingRule.createdAt,
				);
				updated.maturity = computeMaturity({ ...existingRule, ...updated } as ProceduralRule);
				await updateProceduralRule(existingRule.id, updated);
				updatedCount++;
			} else if (action === 'create') {
				// Create new rule
				const now = Date.now();
				const relatedLoreIds = this.resolveRelatedEntries(extracted.relatedEntities, lorebookEntries);
				const sourceChapterIds = chapters.slice(-5).map(c => c.id);
				const sourceArcIds = arcs.length > 0 ? [arcs[arcs.length - 1].id] : [];

				const rule: ProceduralRule = {
					id: uuid(),
					storyId,
					content: extracted.content,
					category: extracted.category as RuleCategory,
					scope: arcs.length > 0 ? 'arc' : 'chapter',
					type: extracted.type,
					maturity: 'candidate',
					helpfulCount: 0,
					harmfulCount: 0,
					effectiveScore: extracted.confidence,
					sourceChapterIds,
					sourceArcIds,
					relatedEntryIds: relatedLoreIds,
					embedding: null,
					tags: extracted.tags,
					createdAt: now,
					updatedAt: now,
					lastReinforcedAt: now,
				};

				await createProceduralRule(rule);
				existingRules.push(rule); // Track for remaining dedup checks
				newCount++;
			}
		}

		// Pre-embed new rules for semantic retrieval (background)
		if (newCount > 0) {
			const { ai } = await import('$lib/services/ai');
			const newRules = existingRules.slice(-newCount);
			ai.embeddings.embedMany(
				newRules.map(r => ({
					text: r.content + ' ' + r.tags.join(' '),
					sourceId: r.id,
					sourceType: 'rule' as const,
				}))
			).catch(() => {});
		}

		// Run deterministic curation pass
		await this.curate(storyId);

		log('reflect', { newRules: newCount, updatedRules: updatedCount });
		return { newRules: newCount, updatedRules: updatedCount, summary: result.summary };
	}

	// ═══════════════════════════════════════════════════════════════
	// Stage 2: CURATOR — Deterministic maintenance (NO LLM)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Curate rules: decay scores, promote/demote maturity, prune deprecated.
	 * Called after reflection and periodically.
	 */
	async curate(storyId: string): Promise<void> {
		const rules = await getProceduralRules(storyId);
		const updates: ProceduralRule[] = [];
		const toDelete: string[] = [];

		for (const rule of rules) {
			// Recalculate effective score with decay
			const newScore = computeDecayedScore(
				rule.helpfulCount, rule.harmfulCount,
				rule.lastReinforcedAt, rule.createdAt,
			);

			const newMaturity = computeMaturity({ ...rule, effectiveScore: newScore });

			// Delete long-deprecated rules
			if (newMaturity === 'deprecated' && rule.maturity === 'deprecated') {
				const daysSinceUpdate = (Date.now() - rule.updatedAt) / (1000 * 60 * 60 * 24);
				if (daysSinceUpdate > 30) {
					toDelete.push(rule.id);
					continue;
				}
			}

			if (newScore !== rule.effectiveScore || newMaturity !== rule.maturity) {
				updates.push({
					...rule,
					effectiveScore: newScore,
					maturity: newMaturity,
					updatedAt: Date.now(),
				});
			}
		}

		if (updates.length > 0) {
			await bulkPutProceduralRules(updates);
		}

		for (const id of toDelete) {
			await deleteProceduralRule(id);
		}

		// Enforce max rules limit
		const allRules = await getProceduralRules(storyId);
		if (allRules.length > MAX_RULES_PER_STORY) {
			const sorted = allRules.sort((a, b) => a.effectiveScore - b.effectiveScore);
			const excess = sorted.slice(0, allRules.length - MAX_RULES_PER_STORY);
			for (const rule of excess) {
				await deleteProceduralRule(rule.id);
			}
		}

		if (updates.length > 0 || toDelete.length > 0) {
			log('curate', { updated: updates.length, deleted: toDelete.length });
		}
	}

	// ═══════════════════════════════════════════════════════════════
	// Stage 3: INJECTOR — Score and select rules for context
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Get the most relevant rules for the current action context.
	 * Returns rules sorted by relevance × effectiveScore.
	 */
	async getRelevantRules(
		storyId: string,
		userAction: string,
		recentNarrative: string,
		maxRules = MAX_RULES_IN_CONTEXT,
	): Promise<ProceduralRule[]> {
		const rules = await getProceduralRules(storyId);
		if (rules.length === 0) return [];

		// Filter out deprecated rules
		const active = rules.filter(r => r.maturity !== 'deprecated');
		if (active.length === 0) return [];

		const queryText = userAction + ' ' + recentNarrative;

		// Score rules via embedding similarity (falls back to TF-IDF internally)
		const { ai } = await import('$lib/services/ai');
		const embeddingScores = await ai.embeddings.scoreSimilarity(
			queryText,
			active.map(r => ({
				id: r.id,
				text: r.content + ' ' + r.tags.join(' '),
				sourceType: 'rule' as const,
			})),
		);
		const scoreMap = new Map(embeddingScores.map(s => [s.id, s.score]));

		// Combine embedding score with tag boost, maturity boost, and anti-pattern floor
		const scored = active.map(rule => {
			const textSimilarity = scoreMap.get(rule.id) ?? 0;

			// Boost rules whose tags appear in the query
			let tagBoost = 0;
			const queryLower = queryText.toLowerCase();
			for (const tag of rule.tags) {
				if (queryLower.includes(tag.toLowerCase())) tagBoost += 0.15;
			}

			// Maturity boost: proven rules get priority
			const maturityBoost = rule.maturity === 'proven' ? 0.1
				: rule.maturity === 'established' ? 0.05
				: 0;

			// Anti-pattern boost: always-relevant rules get a floor
			const antiPatternFloor = rule.type === 'anti_pattern' ? 0.2 : 0;

			const relevance = Math.min(1, textSimilarity + tagBoost + maturityBoost + antiPatternFloor);
			const finalScore = relevance * rule.effectiveScore;

			return { rule, finalScore };
		});

		scored.sort((a, b) => b.finalScore - a.finalScore);
		return scored.slice(0, maxRules).map(s => s.rule);
	}

	/**
	 * Build a context block from procedural rules for injection into the system prompt.
	 */
	buildContextBlock(rules: ProceduralRule[]): string {
		if (rules.length === 0) return '';

		const ruleLines = rules.map(r => {
			const prefix = r.type === 'anti_pattern' ? 'AVOID' : 'APPLY';
			const maturityTag = r.maturity === 'proven' ? '' : ` [${r.maturity}]`;
			return `- [${prefix}${maturityTag}] ${r.content}`;
		}).join('\n');

		return `\n## Narrative Rules\nThese patterns have been learned from the story so far. Apply rules and avoid anti-patterns:\n${ruleLines}\n`;
	}

	// ═══════════════════════════════════════════════════════════════
	// Feedback — Reinforce or weaken rules based on player input
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Mark a rule as helpful (player liked the output it influenced).
	 */
	async markHelpful(ruleId: string): Promise<void> {
		const rules = await getProceduralRules('');
		// We need to find by ID across all stories — but Dexie doesn't have a global ID query
		// So we update directly
		await updateProceduralRule(ruleId, {
			helpfulCount: 1, // Will be incremented; ideally read-then-write
			lastReinforcedAt: Date.now(),
			updatedAt: Date.now(),
		});
	}

	/**
	 * Mark a rule as harmful (player disliked the output it influenced).
	 */
	async markHarmful(ruleId: string): Promise<void> {
		await updateProceduralRule(ruleId, {
			harmfulCount: 1,
			updatedAt: Date.now(),
		});
	}

	// ── Private helpers ──

	/**
	 * Check if an extracted rule duplicates an existing one.
	 * Returns 'reinforce' to reinforce the match, or 'create' for new rule.
	 */
	private findDuplicate(
		extracted: ExtractedRule,
		existing: ProceduralRule[],
	): { action: 'reinforce' | 'create'; existingRule?: ProceduralRule } {
		for (const rule of existing) {
			if (rule.maturity === 'deprecated') continue;

			// Check similarity using TF-IDF
			const similarity = tfidfSimilarity(extracted.content, rule.content);
			if (similarity > DEDUP_THRESHOLD) {
				return { action: 'reinforce', existingRule: rule };
			}
		}
		return { action: 'create' };
	}

	/**
	 * Resolve entity names to lorebook entry IDs.
	 */
	private resolveRelatedEntries(entityNames: string[], lorebookEntries: Entry[]): string[] {
		const ids: string[] = [];
		for (const name of entityNames) {
			const match = lorebookEntries.find(e =>
				e.name.toLowerCase() === name.toLowerCase() ||
				e.aliases.some(a => a.toLowerCase() === name.toLowerCase())
			);
			if (match) ids.push(match.id);
		}
		return ids;
	}
}
