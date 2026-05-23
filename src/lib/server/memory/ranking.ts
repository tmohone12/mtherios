import type { MemoryNode, MemoryRetrieveRequest } from '$lib/contracts/memory';

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

function overlaps(left: string[] = [], right: string[] = []): boolean {
	if (left.length === 0 || right.length === 0) return false;
	const set = new Set(left);
	return right.some((value) => set.has(value));
}

export function scoreMemoryNode(node: MemoryNode, request: MemoryRetrieveRequest): number {
	const tokens = memoryQueryTokens(request.query);
	const haystack = normalizeLookup([
		node.title,
		node.summary ?? '',
		node.content,
		...(node.keywords ?? []),
	].join(' '));

	let score = node.importance * 4;
	for (const token of tokens) {
		if (haystack.includes(token)) score += node.title.toLowerCase().includes(token) ? 2.5 : 1;
	}

	if (request.locationId && node.locationId === request.locationId) score += 2;
	if (overlaps(node.entityIds, request.sceneEntityIds)) score += 2.5;
	if (overlaps(node.threadIds, request.threadIds)) score += 2;
	if (request.currentFactionId && node.factionIds.includes(request.currentFactionId)) score += 2;
	if (node.type === 'plot_ledger') score += 0.75;
	if (node.type === 'npc_belief' && overlaps(node.entityIds, request.presentNpcIds)) score += 3;
	if (node.visibility === 'secret' && !request.includeSecret) score -= 100;

	return score;
}

export function buildMemoryPacket(
	nodes: MemoryNode[],
	request: MemoryRetrieveRequest,
): { packet: string; nodes: MemoryNode[]; tokenEstimate: number; retrievalDebug: string[] } {
	const scored = nodes
		.map((node) => ({ ...node, score: node.score ?? scoreMemoryNode(node, request) }))
		.filter((node) => (node.score ?? 0) > 0)
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

	const selected: MemoryNode[] = [];
	let tokenEstimate = 0;
	const maxNodes = Math.min(10, Math.max(6, Math.ceil(request.tokenBudget / 160)));

	for (const node of scored) {
		const line = renderMemoryLine(node);
		const lineTokens = estimateTokens(line);
		if (selected.length >= maxNodes) break;
		if (tokenEstimate + lineTokens > request.tokenBudget && selected.length >= 3) continue;
		selected.push(node);
		tokenEstimate += lineTokens;
	}

	const packet = selected.length > 0
		? [
			'## Retrieved Memory Packet',
			'Use these as durable evidence-linked facts for this turn. Do not reveal secret belief facts to NPCs unless the scene gives them a source.',
			...selected.map(renderMemoryLine),
		].join('\n')
		: '';

	return {
		packet,
		nodes: selected,
		tokenEstimate: estimateTokens(packet),
		retrievalDebug: [
			`candidates=${nodes.length}`,
			`selected=${selected.length}`,
			`budget=${request.tokenBudget}`,
		],
	};
}

export function renderMemoryLine(node: MemoryNode): string {
	const refs = [
		node.sourceEventIds.length ? `events:${node.sourceEventIds.slice(0, 4).join(',')}` : '',
		node.sourceEntryIds.length ? `entries:${node.sourceEntryIds.slice(0, 4).join(',')}` : '',
		node.sourcePatchIds.length ? `patches:${node.sourcePatchIds.slice(0, 4).join(',')}` : '',
	].filter(Boolean).join(' ');
	const source = refs ? ` [${refs}]` : '';
	const label = node.type.replace(/_/g, ' ');
	const body = node.summary?.trim() || node.content.trim();
	return `- (${label}) ${node.title}: ${body}${source}`;
}
