import type { MemoryNode, MemoryRetrievalTraceItem, MemoryRetrieveRequest } from '$lib/contracts/memory';
import { isNarrativeCommandInput, isNarrativeControlInput } from '$lib/services/ai/context/controlInput';
import { summarizeMtheriosMemoryForContext } from '$lib/services/ai/context/mtheriosSummaryFormat';

const MEMORY_PACKET_HEADER = [
	'## Retrieved Memory Packet',
	'Evidence for recall: current canon wins over past events and summaries. Historical records are not current duties. NPC beliefs may be false; only their owner knows them without a source.',
];
const MEMORY_LINE_BODY_CHAR_LIMIT = 1200;
const MEMORY_LINE_MIN_BODY_CHAR_LIMIT = 160;
const RETRIEVAL_TRACE_LIMIT = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
const BM25_K1 = 1.2;
const BM25_B = 0.65;
const KEYWORD_RARITY_WEIGHT = 0.85;
const HISTORICAL_QUERY_PATTERN = /\b(?:before|earlier|old|previous|withdrawn|replaced)\b/i;
const REVISION_QUERY_PATTERN = /\b(?:after|before|earlier|old|previous|current|replaced|replace|correction|corrected|withdrawn|instead|now|valid)\b/i;

type ScoredMemoryNode = MemoryNode & { score: number };
type RetrievalTraceReason = 'selected' | 'low_score' | 'over_budget' | 'budget_exhausted' | 'max_nodes' | 'redundant_cluster';
type JsonRecord = Record<string, unknown>;
type MemoryNodeScoreExplanation = {
	total: number;
	signals: string[];
};

const UNSAFE_DURABLE_MEMORY_PATTERNS = [
	/\booc\b/i,
	/\bout[ -]of[ -]character\b/i,
	/\b(?:gm|narrator)\s+(?:note|correction|feedback|instruction)\b/i,
	/\b(?:ignore|disregard|forget)\s+(?:the\s+)?(?:previous|last|above)\s+(?:response|reply|context|instruction|turn)\b/i,
	/^\s*(?:you|the gm|the narrator)\s+(?:is|are|was|were|'re)\s+(?:playing|narrating|overcomplicating|ignoring)\b/im,
	/\bpoisoned context\b/i,
	/\bdeleted a poisoned context\b/i,
	/\bi overreached\b/i,
	/\bread all context\b/i,
	/\bdo not treat (this|that) as canon\b/i,
];

const STOPWORDS = new Set([
	'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'when', 'where',
	'there', 'their', 'about', 'into', 'then', 'than', 'they', 'them', 'your',
	'you', 'for', 'are', 'was', 'were', 'will', 'would', 'could', 'should',
	'after', 'before', 'again', 'just', 'like', 'tell', 'ask', 'said', 'says',
	'him', 'his', 'her', 'hers', 'its', 'who', 'whom', 'whose', 'did', 'does',
	'ooc', 'meta', 'not', 'never', 'no', 'dont', 'didnt', 'isnt', 'arent', 'wasnt', 'werent',
]);

const NEGATION_TOKENS = new Set(['not', 'never', 'no', 'dont', 'didnt', 'isnt', 'arent', 'wasnt', 'werent']);
const NEGATION_BRIDGE_TOKENS = new Set([
	...STOPWORDS,
	'in', 'at', 'on', 'from', 'currently', 'actually', 'still', 'anymore',
	'use', 'mention', 'include', 'recall', 'retrieve', 'search', 'treat', 'assume', 'set',
	'go', 'going', 'travel', 'traveling', 'return', 'returning', 'sail', 'sailing',
	'move', 'moving', 'head', 'heading', 'visit', 'visiting', 'located',
]);
const NEGATION_BOUNDARY_TOKENS = new Set([
	'but', 'however', 'instead', 'rather', 'except', 'yet', 'though', 'although', 'while', 'then',
	'i', 'we', 'you', 'he', 'she', 'they', 'it', 'this', 'that', 'currently', 'actually', 'anymore',
]);

export function normalizeLookup(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function lookupMentioned(query: string, candidate: string): boolean {
	const normalizedQuery = normalizeLookup(query);
	const normalizedCandidate = normalizeLookup(candidate);
	return normalizedCandidate.length >= 3
		&& ` ${normalizedQuery} `.includes(` ${normalizedCandidate} `);
}

export function isOocControlText(text: string): boolean {
	return isNarrativeControlInput(text)
		|| isNarrativeCommandInput(text)
		|| UNSAFE_DURABLE_MEMORY_PATTERNS.some((pattern) => pattern.test(text));
}

function repeatedWorldTickCluster(node: MemoryNode): string | null {
	const metadata = asRecord(node.metadata) ?? {};
	if (metadata.sourceType !== 'terminal_world_sim_tick' && !node.id.startsWith('mem_world_tick_')) return null;
	const factionId = typeof metadata.factionId === 'string' && metadata.factionId.trim()
		? metadata.factionId.trim()
		: node.factionIds[0]?.trim();
	const projectId = typeof metadata.projectId === 'string' && metadata.projectId.trim()
		? metadata.projectId.trim()
		: '';
	return `world_tick:${factionId || normalizeLookup(node.title)}:${projectId}`;
}

export function memoryQueryTokens(text: string, max = 36): string[] {
	const normalizedTokens = normalizeLookup(text).split(/\s+/).filter(Boolean);
	const negatedTokens = new Set<string>();
	for (const [index, token] of normalizedTokens.entries()) {
		if (!NEGATION_TOKENS.has(token)) continue;
		let foundSubject = false;
		let subjectTokens = 0;
		for (let offset = index + 1; offset < Math.min(normalizedTokens.length, index + 10); offset += 1) {
			const candidate = normalizedTokens[offset];
			if (foundSubject && NEGATION_BOUNDARY_TOKENS.has(candidate)) break;
			if (candidate.length <= 2) continue;
			if (NEGATION_BRIDGE_TOKENS.has(candidate)) {
				if (!STOPWORDS.has(candidate)) negatedTokens.add(candidate);
				continue;
			}
			negatedTokens.add(candidate);
			foundSubject = true;
			subjectTokens += 1;
			if (subjectTokens >= 3) break;
		}
	}
	return [...new Set(
		normalizedTokens
			.filter((token) => token.length > 2 && !STOPWORDS.has(token) && !negatedTokens.has(token)),
	)].slice(0, max);
}

export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function ageDays(value: string): number | null {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return null;
	return Math.max(0, Math.floor((Date.now() - timestamp) / DAY_MS));
}

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function integer(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function storyTurn(node: MemoryNode): number | null {
	const metadata = asRecord(node.metadata);
	return integer(metadata?.occurredTurn)
		?? integer(metadata?.validFromTurn)
		?? integer(metadata?.createdTurn)
		?? integer(metadata?.scheduledTurn)
		?? integer(metadata?.dueTurn)
		?? integer(metadata?.deadlineTurn);
}

function metadataStrings(metadata: JsonRecord, keys: string[]): string[] {
	return keys.flatMap((key) => {
		const value = metadata[key];
		if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
	});
}

export const MEMORY_REVISION_KEYS = ['correctionKey', 'supersessionKey', 'deadlineKey', 'temporalKey'] as const;
export const MEMORY_SUPERSESSION_KEYS = [
	'supersedesId', 'supersedesIds', 'supersedesMemoryNodeIds', 'supersedesMemoryNodeId',
	'supersedesEventIds', 'supersedesEventId', 'supersedesEntryIds', 'supersedesEntryId',
	'supersedesPatchIds', 'supersedesPatchId', 'replacesId', 'replacesIds', 'invalidatesIds',
] as const;

function memoryRevisionKey(node: MemoryNode): string | null {
	const metadata = asRecord(node.metadata) ?? {};
	for (const key of MEMORY_REVISION_KEYS) {
		const value = metadata[key];
		if (typeof value === 'string' && value.trim()) return `${key}:${value.trim()}`;
	}
	return null;
}

function hasRevisionMetadata(node: MemoryNode): boolean {
	const metadata = asRecord(node.metadata) ?? {};
	return metadata.supersessionMarker === true
		|| ['supersedesId', 'supersedesIds', 'replacesId', 'replacesIds', 'correctionKey', 'supersessionKey']
			.some((key) => metadataStrings(metadata, [key]).length > 0);
}

function keywordTerms(node: MemoryNode): Set<string> {
	return new Set(normalizedTokens([node.title, ...node.keywords, node.summary ?? '', node.content].join(' ')));
}

function buildKeywordRarityScores(corpus: MemoryNode[], queryTokens: string[]): Map<MemoryNode, number> {
	if (!queryTokens.length || !corpus.length) return new Map();
	const documentFrequency = new Map<string, number>();
	const termSets = corpus.map(keywordTerms);
	for (const terms of termSets) {
		for (const queryToken of queryTokens) {
			if (![...terms].some((term) => tokenMatchesQueryToken(term, queryToken))) continue;
			documentFrequency.set(queryToken, (documentFrequency.get(queryToken) ?? 0) + 1);
		}
	}
	return new Map(corpus.map((node, index) => {
		const terms = termSets[index];
		const score = queryTokens.reduce((total, queryToken) => {
			if (![...terms].some((term) => tokenMatchesQueryToken(term, queryToken))) return total;
			const frequency = documentFrequency.get(queryToken) ?? 0;
			return total + KEYWORD_RARITY_WEIGHT * Math.log((corpus.length + 1) / (frequency + 1));
		}, 0);
		return [node, score] as const;
	}));
}

function memoryOrder(node: MemoryNode): number {
	const metadata = asRecord(node.metadata);
	const turn = integer(metadata?.validFromTurn)
		?? integer(metadata?.createdTurn)
		?? integer(metadata?.occurredTurn)
		?? storyTurn(node);
	if (turn !== null) return turn * 1_000_000_000_000;
	const timestamp = Date.parse(node.updatedAt);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

export function activeMemoryCandidates(nodes: MemoryNode[], currentTurn?: number): MemoryNode[] {
	const flagged = (value: unknown) => value === true || value === 1
		|| (typeof value === 'string' && ['true', 'yes', '1'].includes(value.trim().toLowerCase()));
	const scope = (node: MemoryNode) => `${node.storyId}:${node.type === 'npc_belief' ? `belief:${asRecord(node.metadata)?.believerEntityId ?? node.entityIds[0] ?? node.id}` : 'canon'}`;
	const eligible = nodes.filter(node => {
		const metadata = asRecord(node.metadata) ?? {};
		return !flagged(metadata.invalidated) && !flagged(metadata.deleted)
			&& !['proposed', 'rejected', 'invalidated'].includes(String(metadata.status))
			&& (currentTurn === undefined || integer(metadata.validFromTurn) === null || (metadata.validFromTurn as number) <= currentTurn);
	});
	const initiallyActive = eligible.filter((node) => {
		const metadata = asRecord(node.metadata) ?? {};
		const status = normalizeLookup(typeof metadata.status === 'string' ? metadata.status : '');
		return !flagged(metadata.invalidated)
			&& !flagged(metadata.deleted)
			&& !flagged(metadata.superseded)
			&& !(typeof metadata.supersededById === 'string' && metadata.supersededById.trim())
			&& !(typeof metadata.superseded_by_id === 'string' && metadata.superseded_by_id.trim())
			&& !['proposed', 'cancelled', 'canceled', 'superseded', 'rejected', 'invalidated', 'archived'].includes(status)
			&& (currentTurn === undefined || integer(metadata.validFromTurn) === null || (metadata.validFromTurn as number) <= currentTurn)
			&& (currentTurn === undefined || integer(metadata.validToTurn) === null || (metadata.validToTurn as number) > currentTurn);
	});
	const supersededByNodeIds = new Map<string, Set<string>>();
	for (const node of eligible) {
		for (const targetId of metadataStrings(asRecord(node.metadata) ?? {}, [...MEMORY_SUPERSESSION_KEYS])) {
			const scopedTargetId = `${asRecord(node.metadata)?.supersessionMarker === true ? `${node.storyId}:removed` : scope(node)}:${targetId}`;
			const owners = supersededByNodeIds.get(scopedTargetId) ?? new Set<string>();
			owners.add(node.id);
			supersededByNodeIds.set(scopedTargetId, owners);
		}
	}
	const notSuperseded = initiallyActive.filter((node) => ![
		node.id,
		...node.sourceEventIds,
		...node.sourceEntryIds,
		...node.sourcePatchIds,
	].some((id) => {
		if (supersededByNodeIds.has(`${node.storyId}:removed:${id}`)) return true;
		const owners = supersededByNodeIds.get(`${scope(node)}:${id}`);
		return owners ? owners.size > 1 || !owners.has(node.id) : false;
	}));
	const newestRevision = new Map<string, MemoryNode>();
	for (const node of eligible) {
		const revisionKey = memoryRevisionKey(node);
		const key = revisionKey ? `${scope(node)}:${revisionKey}` : null;
		if (!key) continue;
		const previous = newestRevision.get(key);
		if (!previous || memoryOrder(node) > memoryOrder(previous)) newestRevision.set(key, node);
	}
	return notSuperseded.filter((node) => {
		const revisionKey = memoryRevisionKey(node);
		const key = revisionKey ? `${scope(node)}:${revisionKey}` : null;
		return (!key || newestRevision.get(key)?.id === node.id)
			&& asRecord(node.metadata)?.supersessionMarker !== true;
	});
}

function normalizedTokens(text: string): string[] {
	return normalizeLookup(text).split(/\s+/).filter(Boolean);
}

function tokenMatchesQueryToken(token: string, queryToken: string): boolean {
	return token === queryToken
		|| (Math.min(token.length, queryToken.length) >= 5 && token.slice(0, 5) === queryToken.slice(0, 5));
}

function tokenFrequency(tokens: string[], queryToken: string): number {
	return tokens.reduce((count, token) => count + Number(tokenMatchesQueryToken(token, queryToken)), 0);
}

function bm25TermScore(termFrequency: number, fieldLength: number, averageLength: number, weight: number): number {
	if (termFrequency <= 0) return 0;
	const lengthNorm = (1 - BM25_B) + (BM25_B * (fieldLength / Math.max(1, averageLength)));
	return weight * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + (BM25_K1 * lengthNorm)));
}

function keywordScore(node: MemoryNode, queryTokens: string[]): { score: number; matchedTokens: string[] } {
	if (queryTokens.length === 0) return { score: 0, matchedTokens: [] };
	const titleTokens = normalizedTokens(node.title);
	const keywordTokens = normalizedTokens(node.keywords.join(' '));
	const summaryTokens = normalizedTokens(node.summary ?? '');
	const contentTokens = normalizedTokens(node.content);
	const matchedTokens = new Set<string>();
	let score = 0;

	for (const token of queryTokens) {
		const titleFrequency = tokenFrequency(titleTokens, token);
		const keywordFrequency = tokenFrequency(keywordTokens, token);
		const summaryFrequency = tokenFrequency(summaryTokens, token);
		const contentFrequency = tokenFrequency(contentTokens, token);
		if (titleFrequency + keywordFrequency + summaryFrequency + contentFrequency > 0) matchedTokens.add(token);
		score += bm25TermScore(titleFrequency, titleTokens.length, 8, 2.4);
		score += bm25TermScore(keywordFrequency, Math.max(1, keywordTokens.length), 6, 1.7);
		score += bm25TermScore(summaryFrequency, Math.max(1, summaryTokens.length), 60, 1.15);
		score += bm25TermScore(contentFrequency, Math.max(1, contentTokens.length), 160, 0.65);
	}

	return { score: Math.min(10, score), matchedTokens: [...matchedTokens] };
}

function vectorSimilarityScore(node: MemoryNode): number {
	const metadata = asRecord(node.metadata);
	const retrieval = asRecord(metadata?.retrieval);
	const metadataScore = retrieval?.vectorScore;
	if (typeof metadataScore === 'number' && Number.isFinite(metadataScore)) return Math.max(0, Math.min(1, metadataScore));
	if (typeof node.score === 'number' && Number.isFinite(node.score) && node.score > 0 && node.score <= 1) return node.score;
	return 0;
}

function useHybridRanking(): boolean {
	return typeof process !== 'undefined' && process.env.MTHERIOS_MEMORY_RANKING_MODE === 'hybrid';
}

function isUnsafeDurableMemory(node: MemoryNode): boolean {
	const metadata = asRecord(node.metadata);
	const flagged = (value: unknown) => value === true
		|| value === 1
		|| (typeof value === 'string' && ['true', 'yes', '1'].includes(value.trim().toLowerCase()));
	if (flagged(metadata?.nonCanon) || flagged(metadata?.non_canon)) return true;
	if (['sourceType', 'source_type', 'actionType', 'action_type', 'narrativeMode', 'narrative_mode']
		.some((key) => ['ooc', 'out of character'].includes(normalizeLookup(typeof metadata?.[key] === 'string' ? metadata[key] as string : '')))) return true;
	const fields = [node.title, node.summary ?? '', node.content];
	const text = fields.join('\n');
	if (/\[(?:CHECKPOINT|RECENT STORY STATE|CHARACTER STATE|ACTIVE THREADS)\s*=/i.test(text)) return false;
	return fields.some(isOocControlText) || isOocControlText(text);
}

function scoreExplanation(node: MemoryNode, request: MemoryRetrieveRequest): MemoryNodeScoreExplanation {
	const queryTokens = memoryQueryTokens(request.query);
	const historicalQuery = request.includeHistorical === true && HISTORICAL_QUERY_PATTERN.test(request.query);
	const revisionQuery = REVISION_QUERY_PATTERN.test(request.query);
	const keyword = keywordScore(node, queryTokens);
	const vectorSimilarity = vectorSimilarityScore(node);
	// Content similarity and lexical relevance use the same bounded scale;
	// routine recency must not erase the gap between strong and weak matches.
	const vectorScore = vectorSimilarity * 10;
	const nodeStoryTurn = storyTurn(node);
	const metadata = asRecord(node.metadata) ?? {};
	const retrieval = asRecord(metadata.retrieval) ?? {};
	const scheduledTurn = integer(metadata.scheduledTurn)
		?? integer(metadata.dueTurn)
		?? integer(metadata.deadlineTurn)
		?? integer(metadata.nextActionTurn);
	const temporalStatus = normalizeLookup(typeof metadata.status === 'string' ? metadata.status : '');
	const turnDistance = request.currentTurn === undefined || nodeStoryTurn === null
		? null
		: request.currentTurn - nodeStoryTurn;
	const age = ageDays(node.updatedAt);
	const storyRecencyBoost = turnDistance === null || turnDistance < 0 ? 0 : 1.8 * Math.exp(-turnDistance / 20);
	const turnsUntilScheduled = request.currentTurn === undefined || scheduledTurn === null ? null : scheduledTurn - request.currentTurn;
	const dueSoonBoost = turnsUntilScheduled === null || turnsUntilScheduled < 0 || turnsUntilScheduled > 12 ? 0 : 2.5 * Math.exp(-turnsUntilScheduled / 8);
	const overdueBoost = turnsUntilScheduled === null || turnsUntilScheduled >= 0 || !['due', 'scheduled'].includes(temporalStatus)
		? 0
		: Math.min(2.25, 1.25 + (Math.abs(turnsUntilScheduled) / 20));
	const storyAgeDecay = turnDistance === null || turnDistance <= 80 ? 0 : Math.min(1.8, ((turnDistance - 80) / 160) * Math.max(0.25, 1 - node.importance));
	const recencyBoost = turnDistance === null && age != null ? 1.2 * Math.exp(-age / 45) : 0;
	const ageDecay = turnDistance === null && age != null && age > 180 ? Math.min(1.8, ((age - 180) / 365) * Math.max(0.25, 1 - node.importance)) : 0;
	const locationScore = request.locationId && node.locationId === request.locationId ? 2 : 0;
	const sceneEntityScore = overlaps(node.entityIds, request.sceneEntityIds) ? 2.5 : 0;
	const threadScore = overlaps(node.threadIds, request.threadIds) ? 2 : 0;
	const factionScore = request.currentFactionId && node.factionIds.includes(request.currentFactionId) ? 2 : 0;
	const plotScore = node.type === 'plot_ledger' ? 0.75 : 0;
	const presentNpcScore = node.type === 'npc_belief' && overlaps(node.entityIds, request.presentNpcIds) ? 3 : 0;
	const correctionScore = metadata.eventType === 'correction' || metadata.isCorrection === true ? 2.5 : 0;
	const historicalEvidenceScore = historicalQuery && metadata.temporalState === 'historical' ? 2.25 : 0;
	const revisionEvidenceScore = !request.includeHistorical && revisionQuery && hasRevisionMetadata(node) ? 2.5 : 0;
	const keywordRarity = Number(retrieval.keywordRarityScore ?? 0);
	const scratchPenalty = metadata.scratchSeed === true || retrieval.scratchEntityMatch === true ? 3.5 : 0;
	const secretPenalty = node.visibility === 'secret' && !request.includeSecret ? 100 : 0;
	const importanceScore = node.importance * 4;
	const keywordWeight = useHybridRanking() ? 1.75 : 1;
	const vectorWeight = useHybridRanking() ? 0.55 : 1;
	const keywordContribution = keyword.score * keywordWeight;
	const vectorContribution = vectorScore * vectorWeight;
	const total = importanceScore
		+ keywordContribution
		+ vectorContribution
		+ storyRecencyBoost
		+ dueSoonBoost
		+ overdueBoost
		+ recencyBoost
		- storyAgeDecay
		- ageDecay
		+ locationScore
		+ sceneEntityScore
		+ threadScore
		+ factionScore
		+ plotScore
		+ presentNpcScore
		+ correctionScore
		+ historicalEvidenceScore
		+ revisionEvidenceScore
		+ keywordRarity
		- scratchPenalty
		- secretPenalty;
	const sceneEntities = overlapValues(node.entityIds, request.sceneEntityIds);
	const openThreads = overlapValues(node.threadIds, request.threadIds);
	const presentNpcs = overlapValues(node.entityIds, request.presentNpcIds);
	const signals = [
		`importance ${importanceScore.toFixed(2)}`,
		keywordContribution > 0 ? `keyword ${keywordContribution.toFixed(2)} (${keyword.matchedTokens.slice(0, 6).join(', ')})` : '',
		vectorContribution > 0 ? `vector ${vectorContribution.toFixed(2)}` : '',
		storyRecencyBoost > 0.05 ? `story recency ${storyRecencyBoost.toFixed(2)} (${turnDistance} turns)` : '',
		dueSoonBoost > 0.05 ? `due soon ${dueSoonBoost.toFixed(2)} (+${turnsUntilScheduled} turns)` : '',
		overdueBoost > 0.05 ? `overdue ${overdueBoost.toFixed(2)} (${Math.abs(turnsUntilScheduled ?? 0)} turns)` : '',
		recencyBoost > 0.05 ? `recency ${recencyBoost.toFixed(2)}` : '',
		storyAgeDecay > 0 ? `story age decay -${storyAgeDecay.toFixed(2)} (${turnDistance} turns)` : '',
		ageDecay > 0 ? `age decay -${ageDecay.toFixed(2)}` : '',
		locationScore > 0 ? `same location ${request.locationId}` : '',
		sceneEntities.length > 0 ? `scene entity ${sceneEntities.slice(0, 4).join(', ')}` : '',
		openThreads.length > 0 ? `thread ${openThreads.slice(0, 4).join(', ')}` : '',
		factionScore > 0 ? `current faction ${request.currentFactionId}` : '',
		plotScore > 0 ? 'plot ledger' : '',
		presentNpcScore > 0 ? `present npc belief ${presentNpcs.slice(0, 4).join(', ')}` : '',
		correctionScore > 0 ? `correction ${correctionScore.toFixed(2)}` : '',
		historicalEvidenceScore > 0 ? `historical query ${historicalEvidenceScore.toFixed(2)}` : '',
		revisionEvidenceScore > 0 ? `revision query ${revisionEvidenceScore.toFixed(2)}` : '',
		keywordRarity > 0 ? `keyword rarity ${keywordRarity.toFixed(2)}` : '',
		scratchPenalty > 0 ? `scratch entity -${scratchPenalty.toFixed(2)}` : '',
		secretPenalty > 0 ? 'secret excluded' : '',
	].filter(Boolean);

	return { total, signals };
}

function overlaps(left: string[] = [], right: string[] = []): boolean {
	if (left.length === 0 || right.length === 0) return false;
	const set = new Set(left);
	return right.some((value) => set.has(value));
}

function overlapValues(left: string[] = [], right: string[] = []): string[] {
	if (left.length === 0 || right.length === 0) return [];
	const set = new Set(left);
	return right.filter((value) => set.has(value));
}

function traceTokenEstimate(node: MemoryNode): number {
	return estimateTokens(renderMemoryLine(node, MEMORY_LINE_BODY_CHAR_LIMIT));
}

function traceSignals(node: ScoredMemoryNode, request: MemoryRetrieveRequest, queryTokens: string[]): string[] {
	void queryTokens;
	return scoreExplanation(node, request).signals.slice(0, 10);
}

function retrievalTraceItem(
	node: ScoredMemoryNode,
	request: MemoryRetrieveRequest,
	queryTokens: string[],
	rank: number,
	included: boolean,
	reason: RetrievalTraceReason,
	tokenEstimate: number,
): MemoryRetrievalTraceItem {
	return {
		id: node.id,
		title: node.title,
		type: node.type,
		rank,
		score: Number(node.score.toFixed(3)),
		included,
		reason,
		tokenEstimate: Math.max(0, Math.trunc(tokenEstimate)),
		ageDays: ageDays(node.updatedAt),
		importance: node.importance,
		visibility: node.visibility,
		entityIds: node.entityIds,
		factionIds: node.factionIds,
		threadIds: node.threadIds,
		sourceEntryIds: node.sourceEntryIds,
		sourceEventIds: node.sourceEventIds,
		sourcePatchIds: node.sourcePatchIds,
		signals: traceSignals(node, request, queryTokens),
	};
}

export function scoreMemoryNode(node: MemoryNode, request: MemoryRetrieveRequest): number {
	return scoreExplanation(node, request).total;
}

function revisionRelevance(nodes: MemoryNode[], request: MemoryRetrieveRequest): Map<string, number> {
	const scores = new Map(nodes.map(node => [node.id, scoreMemoryNode(node, request)]));
	const scope = (node: MemoryNode) => `${node.storyId}:${node.type === 'npc_belief' ? `belief:${asRecord(node.metadata)?.believerEntityId ?? node.entityIds[0] ?? node.id}` : 'canon'}`;
	// Match the bounded correction closure in retrieval. Relevance follows explicit
	// provenance/topic links; it never crosses a believer or campaign boundary.
	for (let round = 0; round < 4; round++) {
		const sources = new Map<string, number>();
		const topics = new Map<string, number>();
		for (const node of nodes) {
			const score = scores.get(node.id) ?? 0;
			for (const id of [node.id, ...node.sourceEntryIds, ...node.sourceEventIds, ...node.sourcePatchIds]) {
				const key = `${scope(node)}:${id}`;
				sources.set(key, Math.max(sources.get(key) ?? 0, score));
			}
			const topic = memoryRevisionKey(node);
			if (topic) {
				const key = `${scope(node)}:${topic}`;
				topics.set(key, Math.max(topics.get(key) ?? 0, score));
			}
		}
		for (const node of nodes) {
			const linked = metadataStrings(asRecord(node.metadata) ?? {}, [...MEMORY_SUPERSESSION_KEYS]);
			scores.set(node.id, Math.max(scores.get(node.id) ?? 0,
				topics.get(`${scope(node)}:${memoryRevisionKey(node)}`) ?? 0,
				...linked.map(id => sources.get(`${scope(node)}:${id}`) ?? 0)));
		}
	}
	return scores;
}

export function buildMemoryPacket(
	nodes: MemoryNode[],
	request: MemoryRetrieveRequest,
): { packet: string; nodes: MemoryNode[]; renderedItems: Array<{ id: string; text: string }>; tokenEstimate: number; retrievalDebug: string[]; retrievalTrace: MemoryRetrievalTraceItem[] } {
	const queryTokens = memoryQueryTokens(request.query);
	const visibleNodes = nodes.filter(node => node.storyId === request.storyId && (request.includeSecret || node.visibility === 'public' || node.visibility === 'player_known'));
	const revisionScores = revisionRelevance(visibleNodes.filter(node => !isUnsafeDurableMemory(node)), request);
	const activeNodes = activeMemoryCandidates(visibleNodes, request.currentTurn);
	if (request.includeHistorical) {
		const activeIds = new Set(activeNodes.map(node => node.id));
		// Removing a transcript/control record is distinct from retaining a former fact.
		const removedIds = new Set(visibleNodes.filter(node => asRecord(node.metadata)?.supersessionMarker === true)
			.flatMap(node => metadataStrings(asRecord(node.metadata) ?? {}, ['supersedesId', 'supersedesIds', 'supersedesMemoryNodeId', 'supersedesMemoryNodeIds', 'supersedesEntryId', 'supersedesEntryIds', 'supersedesEventId', 'supersedesEventIds', 'supersedesPatchId', 'supersedesPatchIds', 'replacesId', 'replacesIds', 'invalidatesIds'])));
		for (const node of visibleNodes) {
			const metadata = asRecord(node.metadata) ?? {};
			if (activeIds.has(node.id) || metadata.supersessionMarker || metadata.deleted || metadata.invalidated
				|| ['proposed', 'rejected', 'invalidated'].includes(String(metadata.status))
				|| [node.id, ...node.sourceEntryIds, ...node.sourceEventIds, ...node.sourcePatchIds].some(id => removedIds.has(id))
				|| (request.currentTurn !== undefined && integer(metadata.validFromTurn) !== null && (metadata.validFromTurn as number) > request.currentTurn)) continue;
			activeNodes.push({ ...node, metadata: { ...metadata, temporalState: 'historical' } });
		}
	}
	const safeNodes = activeNodes.filter((node) => !isUnsafeDurableMemory(node));
	const rarityScores = buildKeywordRarityScores(safeNodes, queryTokens);
	const scored = safeNodes
		.map((node) => {
			const vectorScore = vectorSimilarityScore(node);
			const metadata = asRecord(node.metadata) ?? {};
			const retrieval = asRecord(metadata.retrieval) ?? {};
			const rarity = rarityScores.get(node) ?? 0;
			const rankedNode = {
				...node,
				metadata: vectorScore > 0 || rarity > 0
					? { ...metadata, retrieval: { ...retrieval, ...(vectorScore > 0 ? { vectorScore } : {}), ...(rarity > 0 ? { keywordRarityScore: rarity } : {}) } }
					: node.metadata,
			};
			return { ...rankedNode, score: Math.max(scoreMemoryNode(rankedNode, request), revisionScores.get(node.id) ?? 0) };
		})
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

	const selected: MemoryNode[] = [];
	const selectedLines: string[] = [];
	const retrievalTrace: MemoryRetrievalTraceItem[] = [];
	let tokenEstimate = estimateTokens(MEMORY_PACKET_HEADER.join('\n'));
	const topScore = scored.find((node) => (node.score ?? 0) > 0)?.score ?? 0;
	const strongScoreFloor = Math.max(3.5, topScore * 0.35);
	const maxNodes = Math.min(8, Math.max(4, Math.ceil(request.tokenBudget / 190)));
	let droppedLowScore = 0;
	let droppedOverBudget = 0;
	let droppedRedundant = 0;
	let budgetExhausted = false;
	const selectedClusterCounts = new Map<string, number>();

	for (const [index, node] of scored.entries()) {
		const score = node.score ?? 0;
		let included = false;
		let reason: RetrievalTraceReason = 'selected';
		let lineTokens = traceTokenEstimate(node);

		const cluster = repeatedWorldTickCluster(node);
		if (cluster && (selectedClusterCounts.get(cluster) ?? 0) >= 2) {
			reason = 'redundant_cluster';
			droppedRedundant += 1;
		} else if (selected.length >= maxNodes) {
			reason = 'max_nodes';
		} else if (budgetExhausted) {
			reason = 'budget_exhausted';
			droppedOverBudget += 1;
		} else if (score <= 0) {
			reason = 'low_score';
			droppedLowScore += 1;
		} else if (selected.length >= 4 && score < strongScoreFloor) {
			reason = 'low_score';
			droppedLowScore += 1;
		} else if (selected.length >= 5 && tokenEstimate > request.tokenBudget * 0.65 && score < topScore * 0.55) {
			reason = 'low_score';
			droppedLowScore += 1;
		} else {
			const remainingTokens = request.tokenBudget - tokenEstimate;
			if (remainingTokens <= 32) {
				reason = 'budget_exhausted';
				budgetExhausted = true;
				droppedOverBudget += 1;
			} else {
				const bodyCharLimit = Math.max(
					MEMORY_LINE_MIN_BODY_CHAR_LIMIT,
					Math.min(MEMORY_LINE_BODY_CHAR_LIMIT, (remainingTokens * 4) - 180),
				);
				let line = renderMemoryLine(node, bodyCharLimit, queryTokens);
				lineTokens = estimateTokens(line);
				if (tokenEstimate + lineTokens > request.tokenBudget) {
					const overflowChars = ((tokenEstimate + lineTokens) - request.tokenBudget) * 4;
					line = renderMemoryLine(node, Math.max(80, bodyCharLimit - overflowChars - 40), queryTokens);
					lineTokens = estimateTokens(line);
				}
				if (tokenEstimate + lineTokens > request.tokenBudget) {
					reason = 'over_budget';
					droppedOverBudget += 1;
				} else {
					selected.push(node);
					selectedLines.push(line);
					tokenEstimate += lineTokens;
					if (cluster) selectedClusterCounts.set(cluster, (selectedClusterCounts.get(cluster) ?? 0) + 1);
					included = true;
				}
			}
		}

		if (retrievalTrace.length < RETRIEVAL_TRACE_LIMIT) {
			retrievalTrace.push(retrievalTraceItem(
				node,
				request,
				queryTokens,
				index + 1,
				included,
				reason,
				lineTokens,
			));
		}
	}

	// Choose by relevance first, then present dated evidence in story order.
	// Undated evidence retains relevance order; import/update timestamps are not story time.
	const ordered = selected.map((node, index) => ({ node, line: selectedLines[index] }))
		.sort((a, b) => (storyTurn(a.node) ?? Infinity) - (storyTurn(b.node) ?? Infinity));
	const packet = selected.length > 0
		? [
			...MEMORY_PACKET_HEADER,
			...ordered.map(item => item.line),
		].join('\n')
		: '';

	return {
		packet,
		nodes: ordered.map(item => item.node),
		renderedItems: ordered.map(({ node, line }) => ({ id: node.id, text: line })),
		tokenEstimate: estimateTokens(packet),
		retrievalDebug: [
			`candidates=${nodes.length}`,
			`filteredInactive=${nodes.length - activeNodes.length}`,
			`filteredUnsafe=${activeNodes.length - safeNodes.length}`,
			`selected=${selected.length}`,
			`budget=${request.tokenBudget}`,
			`droppedLowScore=${droppedLowScore}`,
			`droppedOverBudget=${droppedOverBudget}`,
			`droppedRedundant=${droppedRedundant}`,
			`trace=${retrievalTrace.length}`,
		],
		retrievalTrace,
	};
}

function compactMemoryBody(value: string, max: number): string {
	const text = value.replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	const end = Math.max(0, max - 3);
	const wordEnd = text.lastIndexOf(' ', end);
	return `${text.slice(0, wordEnd > end / 2 ? wordEnd : end).trimEnd()}...`;
}

export function relevantMemoryExcerpt(value: string, queryTokens: string[], max: number): string {
	const text = value.replace(/\s+/g, ' ').trim();
	if (text.length <= max || !queryTokens.length) return compactMemoryBody(text, max);
	const hits = [...text.matchAll(/[a-z0-9]+/gi)].flatMap(match => {
		const word = match[0].toLowerCase();
		const token = queryTokens.find(token => word === token
			|| (Math.min(word.length, token.length) >= 5 && (word.startsWith(token) || token.startsWith(word))));
		return token ? [{ index: match.index!, token }] : [];
	});
	if (!hits.length) return compactMemoryBody(text, max);
	const width = Math.max(1, max - 8);
	let bestStart = 0;
	let bestDistinct = -1;
	let bestSpan = Number.POSITIVE_INFINITY;
	for (const hit of hits) {
		// Do not force an edge match to consume the whole remaining passage.
		// A shorter tail window can contain the answer sentence without the
		// repeated filler that preceded it.
		const start = Math.max(0, hit.index - Math.floor(width / 3));
		const windowHits = hits.filter((candidate) => candidate.index >= start && candidate.index < start + width);
		const distinct = new Set(windowHits.map((candidate) => candidate.token)).size;
		const span = windowHits.length > 1
			? windowHits.at(-1)!.index - windowHits[0].index
			: 0;
		// Prefer concentrated coverage of distinct query terms. This keeps a
		// repeated filler phrase from displacing a compact answer sentence at
		// the end of a long source passage.
		if (distinct > bestDistinct
			|| (distinct === bestDistinct && (span < bestSpan || (span === bestSpan && start > bestStart)))) {
			bestStart = start;
			bestDistinct = distinct;
			bestSpan = span;
		}
	}
	const rawEnd = Math.min(text.length, bestStart + width);
	const nextBoundary = text.indexOf(' ', Math.max(0, bestStart - 1));
	// A long unbroken token may have no usable boundary; never reset to the
	// beginning or skip beyond this bounded window while trying to trim it.
	const start = bestStart > 0 && nextBoundary >= 0 && nextBoundary < rawEnd
		? nextBoundary + 1 : bestStart;
	const wordEnd = text.lastIndexOf(' ', rawEnd);
	const end = rawEnd < text.length && wordEnd > start ? wordEnd : rawEnd;
	return `${start ? '... ' : ''}${text.slice(start, end).trim()}${end < text.length ? ' ...' : ''}`;
}

function memoryBody(node: MemoryNode, queryTokens: string[] = []): string {
	const content = node.content.trim();
	const contentTokens = new Set(normalizedTokens(content));
	const raw = queryTokens.some(token => contentTokens.has(token)) ? content : node.summary?.trim() || content;
	if (/\[(?:CHECKPOINT|RECENT STORY STATE|CHARACTER STATE|ACTIVE THREADS)\s*=/i.test(raw)) {
		return (summarizeMtheriosMemoryForContext(raw).match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
			.map((sentence) => sentence.trim())
			.filter((sentence) => sentence && !isOocControlText(sentence))
			.join(' ');
	}
	return raw;
}

export function renderMemoryLine(node: MemoryNode, maxBodyChars = MEMORY_LINE_BODY_CHAR_LIMIT, queryTokens: string[] = []): string {
	const refs = [
		node.sourceEventIds.length ? `events:${node.sourceEventIds.slice(0, 4).join(',')}` : '',
		node.sourceEntryIds.length ? `entries:${node.sourceEntryIds.slice(0, 4).join(',')}` : '',
		node.sourcePatchIds.length ? `patches:${node.sourcePatchIds.slice(0, 4).join(',')}` : '',
	].filter(Boolean).join(' ');
	const source = refs ? ` [${refs}]` : '';
	const metadata = asRecord(node.metadata) ?? {};
	const historical = metadata.temporalState === 'historical' || metadata.eventType === 'agreement' || Boolean(asRecord(metadata.agreement));
	const label = metadata.recordKind === 'agreement'
		? `${historical ? 'historical agreement; no current duty' : 'current agreement'}; ${metadata.agreementStatus}`
		: node.type === 'npc_belief' ? `NPC belief; may be false; owner:${metadata.believerEntityId ?? node.entityIds[0] ?? 'unknown'}${historical ? '; historical' : ''}`
		: `${historical ? 'historical evidence; ' : ''}${node.type.replace(/_/g, ' ')}`;
	const body = relevantMemoryExcerpt(memoryBody(node, queryTokens), queryTokens, maxBodyChars);
	return `- (${label}) ${node.title}: ${body}${source}`;
}
