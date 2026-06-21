import type { MemoryNode, MemoryRetrievalTraceItem, MemoryRetrieveRequest } from '$lib/contracts/memory';
import { summarizeMtheriosMemoryForRollup } from '$lib/services/ai/context/mtheriosSummaryFormat';

const MEMORY_PACKET_HEADER = [
	'## Retrieved Memory Packet',
	'Use these as durable evidence-linked facts for this turn. Do not reveal secret belief facts to NPCs unless the scene gives them a source.',
];
const MEMORY_LINE_BODY_CHAR_LIMIT = 1200;
const MEMORY_LINE_MIN_BODY_CHAR_LIMIT = 160;
const RETRIEVAL_TRACE_LIMIT = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
const BM25_K1 = 1.2;
const BM25_B = 0.65;

type ScoredMemoryNode = MemoryNode & { score: number };
type RetrievalTraceReason = 'selected' | 'low_score' | 'over_budget' | 'budget_exhausted' | 'max_nodes';
type JsonRecord = Record<string, unknown>;
type MemoryNodeScoreExplanation = {
	total: number;
	signals: string[];
};

const UNSAFE_DURABLE_MEMORY_PATTERNS = [
	/\*\*ooc:\*\*/i,
	/\booc\b.{0,80}\b(overreached|correction|context|deleted|poisoned)\b/i,
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
]);

export function normalizeLookup(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function memoryQueryTokens(text: string, max = 36): string[] {
	return [...new Set(
		normalizeLookup(text)
			.split(/\s+/)
			.filter((token) => token.length > 2 && !STOPWORDS.has(token)),
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

function normalizedTokens(text: string): string[] {
	return normalizeLookup(text).split(/\s+/).filter(Boolean);
}

function tokenFrequency(tokens: string[], queryToken: string): number {
	return tokens.reduce((count, token) => count + (token === queryToken ? 1 : 0), 0);
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

function isUnsafeDurableMemory(node: MemoryNode): boolean {
	const text = `${node.title}\n${node.summary ?? ''}\n${node.content}`;
	return UNSAFE_DURABLE_MEMORY_PATTERNS.some((pattern) => pattern.test(text));
}

function scoreExplanation(node: MemoryNode, request: MemoryRetrieveRequest): MemoryNodeScoreExplanation {
	const queryTokens = memoryQueryTokens(request.query);
	const keyword = keywordScore(node, queryTokens);
	const vectorSimilarity = vectorSimilarityScore(node);
	const vectorScore = vectorSimilarity > 0 ? Math.min(2.5, vectorSimilarity * 2.5) : 0;
	const age = ageDays(node.updatedAt);
	const recencyBoost = age == null ? 0 : 1.2 * Math.exp(-age / 45);
	const ageDecay = age == null || age <= 180 ? 0 : Math.min(1.8, ((age - 180) / 365) * Math.max(0.25, 1 - node.importance));
	const locationScore = request.locationId && node.locationId === request.locationId ? 2 : 0;
	const sceneEntityScore = overlaps(node.entityIds, request.sceneEntityIds) ? 2.5 : 0;
	const threadScore = overlaps(node.threadIds, request.threadIds) ? 2 : 0;
	const factionScore = request.currentFactionId && node.factionIds.includes(request.currentFactionId) ? 2 : 0;
	const plotScore = node.type === 'plot_ledger' ? 0.75 : 0;
	const presentNpcScore = node.type === 'npc_belief' && overlaps(node.entityIds, request.presentNpcIds) ? 3 : 0;
	const secretPenalty = node.visibility === 'secret' && !request.includeSecret ? 100 : 0;
	const importanceScore = node.importance * 4;
	const total = importanceScore
		+ keyword.score
		+ vectorScore
		+ recencyBoost
		- ageDecay
		+ locationScore
		+ sceneEntityScore
		+ threadScore
		+ factionScore
		+ plotScore
		+ presentNpcScore
		- secretPenalty;
	const sceneEntities = overlapValues(node.entityIds, request.sceneEntityIds);
	const openThreads = overlapValues(node.threadIds, request.threadIds);
	const presentNpcs = overlapValues(node.entityIds, request.presentNpcIds);
	const signals = [
		`importance ${importanceScore.toFixed(2)}`,
		keyword.score > 0 ? `keyword ${keyword.score.toFixed(2)} (${keyword.matchedTokens.slice(0, 6).join(', ')})` : '',
		vectorScore > 0 ? `vector ${vectorScore.toFixed(2)}` : '',
		recencyBoost > 0.05 ? `recency ${recencyBoost.toFixed(2)}` : '',
		ageDecay > 0 ? `age decay -${ageDecay.toFixed(2)}` : '',
		locationScore > 0 ? `same location ${request.locationId}` : '',
		sceneEntities.length > 0 ? `scene entity ${sceneEntities.slice(0, 4).join(', ')}` : '',
		openThreads.length > 0 ? `thread ${openThreads.slice(0, 4).join(', ')}` : '',
		factionScore > 0 ? `current faction ${request.currentFactionId}` : '',
		plotScore > 0 ? 'plot ledger' : '',
		presentNpcScore > 0 ? `present npc belief ${presentNpcs.slice(0, 4).join(', ')}` : '',
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

export function buildMemoryPacket(
	nodes: MemoryNode[],
	request: MemoryRetrieveRequest,
): { packet: string; nodes: MemoryNode[]; tokenEstimate: number; retrievalDebug: string[]; retrievalTrace: MemoryRetrievalTraceItem[] } {
	const queryTokens = memoryQueryTokens(request.query);
	const safeNodes = nodes.filter((node) => !isUnsafeDurableMemory(node));
	const scored = safeNodes
		.map((node) => {
			const vectorScore = vectorSimilarityScore(node);
			const metadata = asRecord(node.metadata) ?? {};
			const retrieval = asRecord(metadata.retrieval) ?? {};
			return {
				...node,
				metadata: vectorScore > 0 ? { ...metadata, retrieval: { ...retrieval, vectorScore } } : node.metadata,
				score: scoreMemoryNode(node, request),
			};
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
	let budgetExhausted = false;

	for (const [index, node] of scored.entries()) {
		const score = node.score ?? 0;
		let included = false;
		let reason: RetrievalTraceReason = 'selected';
		let lineTokens = traceTokenEstimate(node);

		if (selected.length >= maxNodes) {
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
				let line = renderMemoryLine(node, bodyCharLimit);
				lineTokens = estimateTokens(line);
				if (tokenEstimate + lineTokens > request.tokenBudget) {
					const overflowChars = ((tokenEstimate + lineTokens) - request.tokenBudget) * 4;
					line = renderMemoryLine(node, Math.max(80, bodyCharLimit - overflowChars - 40));
					lineTokens = estimateTokens(line);
				}
				if (tokenEstimate + lineTokens > request.tokenBudget) {
					reason = 'over_budget';
					droppedOverBudget += 1;
				} else {
					selected.push(node);
					selectedLines.push(line);
					tokenEstimate += lineTokens;
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

	const packet = selected.length > 0
		? [
			...MEMORY_PACKET_HEADER,
			...selectedLines,
		].join('\n')
		: '';

	return {
		packet,
		nodes: selected,
		tokenEstimate: estimateTokens(packet),
		retrievalDebug: [
			`candidates=${nodes.length}`,
			`filteredUnsafe=${nodes.length - safeNodes.length}`,
			`selected=${selected.length}`,
			`budget=${request.tokenBudget}`,
			`droppedLowScore=${droppedLowScore}`,
			`droppedOverBudget=${droppedOverBudget}`,
			`trace=${retrievalTrace.length}`,
		],
		retrievalTrace,
	};
}

function compactMemoryBody(value: string, max: number): string {
	const text = value.replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function memoryBody(node: MemoryNode): string {
	const raw = node.summary?.trim() || node.content.trim();
	if (/\[(?:CHECKPOINT|RECENT STORY STATE|CHARACTER STATE|ACTIVE THREADS)\s*=/i.test(raw)) {
		return summarizeMtheriosMemoryForRollup(raw);
	}
	return raw;
}

export function renderMemoryLine(node: MemoryNode, maxBodyChars = MEMORY_LINE_BODY_CHAR_LIMIT): string {
	const refs = [
		node.sourceEventIds.length ? `events:${node.sourceEventIds.slice(0, 4).join(',')}` : '',
		node.sourceEntryIds.length ? `entries:${node.sourceEntryIds.slice(0, 4).join(',')}` : '',
		node.sourcePatchIds.length ? `patches:${node.sourcePatchIds.slice(0, 4).join(',')}` : '',
	].filter(Boolean).join(' ');
	const source = refs ? ` [${refs}]` : '';
	const label = node.type.replace(/_/g, ' ');
	const body = compactMemoryBody(memoryBody(node), maxBodyChars);
	return `- (${label}) ${node.title}: ${body}${source}`;
}
