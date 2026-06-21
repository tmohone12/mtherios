import { and, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import {
	entities,
	entityAliases,
	relationships,
} from '$lib/server/db/schema';
import { searchCanonicalWorld } from '$lib/server/engine/canonicalSearch';

type EntityRow = typeof entities.$inferSelect;
type ResolverDb = Pick<ReturnType<typeof getDb>, 'select'>;

export type EntityResolutionDecision = 'update' | 'ask' | 'create' | 'merge';

export interface EntityResolutionCandidate {
	entityId: string;
	type: string;
	name: string;
	aliases: string[];
	status?: string;
	score: number;
	signals: string[];
	sourceEntryIds: string[];
	sourceEventIds: string[];
	sourcePatchIds: string[];
}

export interface EntityIdentityCandidate {
	id?: string | null;
	type: string;
	name: string;
	aliases?: string[];
	description?: string | null;
	sourceEntryIds?: string[];
	sourceEventIds?: string[];
	sourcePatchIds?: string[];
	relatedEntityIds?: string[];
}

export interface EntityResolution {
	decision: EntityResolutionDecision;
	entityId: string | null;
	confidence: number;
	reason: string;
	candidates: EntityResolutionCandidate[];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const clean = typeof value === 'string' ? value.trim() : '';
		if (!clean || seen.has(clean)) continue;
		seen.add(clean);
		out.push(clean);
	}
	return out;
}

export function normalizeEntityName(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/['']/g, '')
		.replace(/\b(the|a|an)\b/g, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

const CHARACTER_TITLE_ONLY_NAMES = new Set([
	'archon',
	'consort',
	'dragon',
	'emperor',
	'empress',
	'governor',
	'heir',
	'king',
	'lord',
	'minister',
	'phoenix',
	'prince',
	'princess',
	'queen',
	'regent',
	'servant',
	'slave',
	'triarch',
	'warrior',
]);

export function isCharacterTitleOnlyName(value: string): boolean {
	const normalized = normalizeEntityName(value);
	if (!normalized) return false;
	if (CHARACTER_TITLE_ONLY_NAMES.has(normalized)) return true;
	return /^(?:golden|vermillion|black|white|red)\s+(?:dragon|phoenix|empress|emperor|prince|princess|queen|king|consort)$/.test(normalized);
}

function tokens(value: string): string[] {
	return normalizeEntityName(value).split(/\s+/).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a) return b.length;
	if (!b) return a.length;
	const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 0; i < a.length; i += 1) {
		let last = i;
		previous[0] = i + 1;
		for (let j = 0; j < b.length; j += 1) {
			const old = previous[j + 1];
			previous[j + 1] = Math.min(
				previous[j + 1] + 1,
				previous[j] + 1,
				last + (a[i] === b[j] ? 0 : 1),
			);
			last = old;
		}
	}
	return previous[b.length];
}

export function scoreEntityNameSimilarity(left: string, right: string): number {
	const a = normalizeEntityName(left);
	const b = normalizeEntityName(right);
	if (!a || !b) return 0;
	if (a === b) return 1;

	const aTokens = tokens(a);
	const bTokens = tokens(b);
	const overlap = aTokens.filter((token) => bTokens.includes(token)).length;
	const minTokens = Math.min(aTokens.length, bTokens.length);
	const maxTokens = Math.max(aTokens.length, bTokens.length);
	const tokenContainment = minTokens > 0 ? overlap / minTokens : 0;
	const tokenJaccard = maxTokens > 0 ? overlap / new Set([...aTokens, ...bTokens]).size : 0;
	const editRatio = 1 - (levenshtein(a, b) / Math.max(a.length, b.length));

	const subsetScore = tokenContainment === 1
		? (minTokens === 1 ? 0.82 : 0.9)
		: 0;
	return Math.max(editRatio, tokenJaccard, subsetScore);
}

function sourceOverlap(a: string[] = [], b: string[] = []): boolean {
	const set = new Set(a);
	return b.some((value) => set.has(value));
}

function summarizeCandidate(
	entity: EntityRow,
	aliases: string[],
	score: number,
	signals: string[],
): EntityResolutionCandidate {
	return {
		entityId: entity.id,
		type: entity.type,
		name: entity.name,
		aliases,
		status: entity.status,
		score: Number(score.toFixed(3)),
		signals: [...new Set(signals)],
		sourceEntryIds: entity.sourceEntryIds ?? [],
		sourceEventIds: entity.sourceEventIds ?? [],
		sourcePatchIds: entity.sourcePatchIds ?? [],
	};
}

export function chooseEntityResolution(input: {
	requestedId?: string | null;
	candidates: EntityResolutionCandidate[];
}): EntityResolution {
	const candidates = [...input.candidates].sort((a, b) => b.score - a.score);
	const best = candidates[0];
	if (!best || best.score < 0.66) {
		return {
			decision: 'create',
			entityId: null,
			confidence: 0,
			reason: 'No existing entity passed the resolver threshold.',
			candidates,
		};
	}

	const isExact = best.signals.some((signal) => signal.startsWith('exact:'));
	const close = candidates.filter((candidate) =>
		candidate.entityId !== best.entityId &&
		candidate.score >= 0.66 &&
		best.score - candidate.score < 0.08
	);
	const requestedDifferentExisting = Boolean(input.requestedId && input.requestedId !== best.entityId);
	if (requestedDifferentExisting && (isExact || best.score >= 0.86)) {
		return {
			decision: 'merge',
			entityId: best.entityId,
			confidence: best.score,
			reason: `Requested id differs from strong existing match ${best.entityId}.`,
			candidates,
		};
	}
	if (isExact || best.score >= 0.86) {
		return {
			decision: 'update',
			entityId: best.entityId,
			confidence: best.score,
			reason: `Strong resolver match for ${best.name}.`,
			candidates,
		};
	}
	if (close.length > 0 || best.score >= 0.66) {
		return {
			decision: 'ask',
			entityId: best.entityId,
			confidence: best.score,
			reason: close.length > 0
				? 'Multiple existing entities are too close to choose safely.'
				: 'One possible match exists, but confidence is below the automatic update threshold.',
			candidates,
		};
	}
	return {
		decision: 'create',
		entityId: null,
		confidence: 0,
		reason: 'No existing entity matched.',
		candidates,
	};
}

export function entityResolutionSummary(resolution: EntityResolution): Record<string, unknown> {
	return {
		decision: resolution.decision,
		confidence: Number(resolution.confidence.toFixed(3)),
		matchedEntityId: resolution.entityId,
		reason: resolution.reason,
		candidates: resolution.candidates.slice(0, 5).map((candidate) => ({
			entityId: candidate.entityId,
			type: candidate.type,
			name: candidate.name,
			score: candidate.score,
			signals: candidate.signals,
		})),
	};
}

export function shouldReuseResolvedEntity(resolution: EntityResolution): boolean {
	return resolution.decision === 'update' || resolution.decision === 'merge';
}

export async function resolveEntityIdentity(input: {
	storyId: string;
	candidate: EntityIdentityCandidate;
	db?: ResolverDb;
	includeSemantic?: boolean;
	maxCandidates?: number;
}): Promise<EntityResolution> {
	const db = input.db ?? getDb();
	const maxCandidates = Math.max(20, Math.min(5000, Math.trunc(input.maxCandidates ?? 2000)));
	const candidateAliases = uniqueStrings([input.candidate.name, ...(input.candidate.aliases ?? [])]);
	const candidateNames = candidateAliases.map(normalizeEntityName).filter(Boolean);
	const sourceEntryIds = input.candidate.sourceEntryIds ?? [];
	const sourceEventIds = input.candidate.sourceEventIds ?? [];
	const sourcePatchIds = input.candidate.sourcePatchIds ?? [];
	const relatedEntityIds = input.candidate.relatedEntityIds ?? [];

	const [entityRows, aliasRows, relationshipRows] = await Promise.all([
		db.select().from(entities).where(and(eq(entities.storyId, input.storyId))).limit(maxCandidates),
		db.select().from(entityAliases).where(eq(entityAliases.storyId, input.storyId)).limit(maxCandidates * 3),
		relatedEntityIds.length
			? db.select().from(relationships).where(eq(relationships.storyId, input.storyId)).limit(maxCandidates)
			: Promise.resolve([]),
	]);

	const aliasesByEntity = new Map<string, string[]>();
	for (const alias of aliasRows) {
		const list = aliasesByEntity.get(alias.entityId) ?? [];
		list.push(alias.alias);
		aliasesByEntity.set(alias.entityId, list);
	}

	const semanticScores = new Map<string, number>();
	if (input.includeSemantic !== false && (input.candidate.name || input.candidate.description)) {
		try {
			const query = [input.candidate.name, input.candidate.description, candidateAliases.join(', ')].filter(Boolean).join('\n');
			const semantic = await searchCanonicalWorld({
				storyId: input.storyId,
				query,
				type: 'entities',
				limit: 8,
				includeSemantic: true,
			});
			for (const row of semantic.results) {
				const recordId = typeof row.recordId === 'string' ? row.recordId : '';
				if (!recordId) continue;
				semanticScores.set(recordId, Math.min(0.84, Math.max(0, Number(row.score ?? 0))));
			}
		} catch {
			// Semantic search is a resolver hint, not a write-path dependency.
		}
	}

	const candidates: EntityResolutionCandidate[] = [];
	for (const entity of entityRows) {
		const metadata = entity.metadata && typeof entity.metadata === 'object' && !Array.isArray(entity.metadata)
			? entity.metadata as Record<string, unknown>
			: {};
		const mergedInto = typeof metadata.mergedInto === 'string' ? metadata.mergedInto : null;
		const inactive = String(entity.status ?? '').toLowerCase() === 'inactive';
		if ((inactive || mergedInto) && input.candidate.id !== entity.id) continue;
		const aliases = uniqueStrings([entity.name, ...(aliasesByEntity.get(entity.id) ?? [])]);
		const signals: string[] = [];
		let score = 0;

		if (input.candidate.id && input.candidate.id === entity.id) {
			score = Math.max(score, 1);
			signals.push('exact:id');
		}
		for (const name of candidateNames) {
			for (const alias of aliases) {
				const normalizedAlias = normalizeEntityName(alias);
				if (!normalizedAlias) continue;
				if (name === normalizedAlias) {
					score = Math.max(score, alias === entity.name ? 0.96 : 0.94);
					signals.push(alias === entity.name ? 'exact:name' : 'exact:alias');
				} else {
					const fuzzy = scoreEntityNameSimilarity(name, normalizedAlias);
					if (fuzzy >= 0.72) {
						score = Math.max(score, fuzzy);
						signals.push('fuzzy:name');
					}
				}
			}
		}
		const semanticScore = semanticScores.get(entity.id);
		if (semanticScore) {
			score = Math.max(score, semanticScore);
			signals.push('semantic');
		}
		if (entity.type === input.candidate.type) {
			score += 0.04;
			signals.push('same:type');
		} else if (input.candidate.type === 'faction' && entity.type === 'organization') {
			score += 0.02;
			signals.push('compatible:type');
		} else {
			score -= 0.12;
			signals.push('different:type');
		}
		if (sourceOverlap(entity.sourceEntryIds, sourceEntryIds)) {
			score += 0.06;
			signals.push('evidence:entry');
		}
		if (sourceOverlap(entity.sourceEventIds, sourceEventIds)) {
			score += 0.06;
			signals.push('evidence:event');
		}
		if (sourceOverlap(entity.sourcePatchIds, sourcePatchIds)) {
			score += 0.04;
			signals.push('evidence:patch');
		}
		if (relatedEntityIds.length > 0 && relationshipRows.some((relationship) =>
			(relationship.sourceEntityId === entity.id && relatedEntityIds.includes(relationship.targetEntityId)) ||
			(relationship.targetEntityId === entity.id && relatedEntityIds.includes(relationship.sourceEntityId))
		)) {
			score += 0.05;
			signals.push('graph:neighbor');
		}

		score = Math.max(0, Math.min(1, score));
		if (score >= 0.55) candidates.push(summarizeCandidate(entity, aliases, score, signals));
	}

	return chooseEntityResolution({ requestedId: input.candidate.id, candidates });
}
