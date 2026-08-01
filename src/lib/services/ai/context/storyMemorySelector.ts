import { countTokens, truncateToTokenBudget } from '$lib/utils/tokens';

export interface StoryMemorySelectorOptions {
	query?: string;
	sceneEntityNames?: string[];
	currentLocationName?: string | null;
	threadHints?: string[];
	tokenBudget?: number;
	recentCount?: number;
	relevantCount?: number;
	resurfacedCount?: number;
	perItemTokenBudget?: number;
	seed?: string;
}

export interface StoryMemoryBucket {
	label: 'pinned' | 'recent' | 'relevant' | 'resurfaced';
	items: SelectedStoryMemoryItem[];
}

export interface SelectedStoryMemoryItem {
	id: string;
	sourceId: string;
	kind: 'chapter' | 'arc';
	label: string;
	score: number;
	text: string;
}

export interface StoryMemorySelection {
	block: string;
	buckets: StoryMemoryBucket[];
	debug: string[];
	tokenEstimate: number;
	selectedIds: string[];
}

interface NormalizedMemoryCandidate {
	id: string;
	sourceId: string;
	kind: 'chapter' | 'arc';
	number: number;
	label: string;
	title: string;
	body: string;
	keywords: string[];
	characters: string[];
	locations: string[];
	threads: string[];
	pinned: boolean;
	score: number;
}

const STOPWORDS = new Set([
	'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'when', 'where',
	'there', 'their', 'about', 'into', 'then', 'than', 'they', 'them', 'your',
	'you', 'for', 'are', 'was', 'were', 'will', 'would', 'could', 'should',
	'after', 'before', 'again', 'just', 'like', 'tell', 'ask', 'said', 'says',
	'chapter', 'story', 'memory', 'current', 'recent',
]);

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function normalizeText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenizeQuery(value: string): string[] {
	return [...new Set(
		normalizeText(value)
			.split(/\s+/)
			.filter(token => token.length > 2 && !STOPWORDS.has(token)),
	)].slice(0, 64);
}

function includesTerm(value: string, term: string): boolean {
	return normalizeText(value).includes(term);
}

function scoreText(value: string, terms: string[], weight: number): number {
	if (!value || terms.length === 0) return 0;
	return terms.reduce((score, term) => score + (includesTerm(value, term) ? weight : 0), 0);
}

function stableHash(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function relationList(record: Record<string, unknown>, keys: string[]): string[] {
	return keys.flatMap(key => asStringArray(record[key]));
}

function objectListSummary(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => {
			if (typeof item === 'string') return item;
			const record = asRecord(item);
			return [
				asString(record.character),
				asString(record.name),
				asString(record.npc),
				asString(record.fact),
				asString(record.change),
				asString(record.summary),
			].filter(Boolean).join(': ');
		})
		.filter(Boolean);
}

function normalizeChapter(value: unknown): NormalizedMemoryCandidate {
	const record = asRecord(value);
	const metadata = asRecord(record.metadata);
	const sourceId = asString(record.id) || `chapter-${asNumber(record.number)}`;
	const number = asNumber(record.number);
	const title = asString(record.title) || `Chapter ${number || '?'}`;
	const sceneOutcome = asString(record.sceneOutcome);
	const summary = asString(record.summary) || sceneOutcome;
	const irreversible = relationList(record, ['irreversibleChanges', 'promisesDebtsOaths', 'discoveredClues']);
	const relationship = relationList(record, ['relationshipChanges', 'factionChanges']);
	const knowledge = objectListSummary(record.npcKnowledgeChanges);
	const threads = relationList(record, ['plotThreads', 'openThreads', 'threadIds']);
	const bodyParts = [
		summary,
		irreversible.length ? `Changes: ${irreversible.join('; ')}` : '',
		relationship.length ? `Relations: ${relationship.join('; ')}` : '',
		knowledge.length ? `Knowledge: ${knowledge.join('; ')}` : '',
		threads.length ? `Threads: ${threads.join('; ')}` : '',
	].filter(Boolean);

	return {
		id: `chapter:${sourceId}`,
		sourceId,
		kind: 'chapter',
		number,
		label: `Ch.${number || '?'}`,
		title,
		body: bodyParts.join(' '),
		keywords: [
			...asStringArray(record.keywords),
			...asStringArray(metadata.keywords),
		],
		characters: [...new Set([
			...asStringArray(record.characters),
			...relationList(metadata, ['trackedEntityIds', 'legacyCharacters', 'characters']),
		])],
		locations: [
			...asStringArray(record.locations),
			...asStringArray(metadata.locations),
		],
		threads,
		pinned: Boolean(record.pinned ?? metadata.pinned),
		score: 0,
	};
}

function normalizeArc(value: unknown): NormalizedMemoryCandidate {
	const record = asRecord(value);
	const metadata = asRecord(record.metadata);
	const sourceId = asString(record.id) || `arc-${asNumber(record.arcNumber ?? record.number)}`;
	const number = asNumber(record.arcNumber ?? record.number);
	const title = asString(record.title) || `Arc ${number || '?'}`;
	const keyPoints = relationList(record, ['keyPlotPoints']);
	const characterArcs = Array.isArray(record.characterArcs)
		? record.characterArcs.map((item) => {
			const arc = asRecord(item);
			const name = asString(arc.name);
			const development = asString(arc.development);
			return name && development ? `${name}: ${development}` : development || name;
		}).filter(Boolean)
		: [];
	const threads = relationList(record, ['unresolvedThreads', 'threadIds', 'openThreadIds']);
	const summary = asString(record.summary);
	const bodyParts = [
		summary,
		keyPoints.length ? `Key points: ${keyPoints.join('; ')}` : '',
		characterArcs.length ? `Character arcs: ${characterArcs.join('; ')}` : '',
		threads.length ? `Threads: ${threads.join('; ')}` : '',
	].filter(Boolean);

	return {
		id: `arc:${sourceId}`,
		sourceId,
		kind: 'arc',
		number,
		label: `Arc ${number || '?'}`,
		title,
		body: bodyParts.join(' '),
		keywords: asStringArray(metadata.keywords),
		characters: [...new Set([
			...asStringArray(record.characters),
			...relationList(metadata, ['trackedEntityIds', 'legacyCharacters', 'characters']),
		])],
		locations: asStringArray(metadata.locations),
		threads,
		pinned: Boolean(metadata.pinned),
		score: 0,
	};
}

function scoreCandidate(candidate: NormalizedMemoryCandidate, terms: string[], latestNumber: number): number {
	const titleScore = scoreText(candidate.title, terms, 6);
	const bodyScore = scoreText(candidate.body, terms, 3);
	const keywordScore = scoreText(candidate.keywords.join(' '), terms, 8);
	const characterScore = scoreText(candidate.characters.join(' '), terms, 9);
	const locationScore = scoreText(candidate.locations.join(' '), terms, 7);
	const threadScore = scoreText(candidate.threads.join(' '), terms, 8);
	const recency = candidate.number > 0 && latestNumber > 0
		? Math.max(0, 4 - Math.min(4, latestNumber - candidate.number))
		: 0;
	return titleScore + bodyScore + keywordScore + characterScore + locationScore + threadScore + recency;
}

function renderCandidate(candidate: NormalizedMemoryCandidate, maxTokens: number): SelectedStoryMemoryItem {
	const parts = [
		`- [${candidate.label}${candidate.title ? ` "${candidate.title}"` : ''}] ${candidate.body}`,
		candidate.characters.length ? `Characters: ${candidate.characters.slice(0, 6).join(', ')}` : '',
		candidate.locations.length ? `Locations: ${candidate.locations.slice(0, 4).join(', ')}` : '',
		candidate.threads.length ? `Threads: ${candidate.threads.slice(0, 4).join('; ')}` : '',
	].filter(Boolean);
	return {
		id: candidate.id,
		sourceId: candidate.sourceId,
		kind: candidate.kind,
		label: candidate.label,
		score: candidate.score,
		text: truncateToTokenBudget(parts.join(' '), maxTokens),
	};
}

function appendBucket(
	buckets: StoryMemoryBucket[],
	label: StoryMemoryBucket['label'],
	candidates: NormalizedMemoryCandidate[],
	selectedIds: Set<string>,
	state: { lines: string[]; tokenBudget: number; perItemTokenBudget: number; debug: string[] },
): void {
	const items: SelectedStoryMemoryItem[] = [];
	for (const candidate of candidates) {
		if (selectedIds.has(candidate.id)) continue;
		const item = renderCandidate(candidate, state.perItemTokenBudget);
		const nextLines = [
			...state.lines,
			items.length === 0 ? bucketHeading(label) : '',
			item.text,
		].filter(Boolean);
		const nextBlock = nextLines.join('\n');
		if (countTokens(nextBlock) > state.tokenBudget) {
			state.debug.push(`${label}: skipped ${candidate.id} over budget`);
			continue;
		}
		items.push(item);
		selectedIds.add(candidate.id);
		state.lines = nextLines;
	}
	if (items.length > 0) buckets.push({ label, items });
}

function bucketHeading(label: StoryMemoryBucket['label']): string {
	switch (label) {
		case 'pinned':
			return '[PINNED CANON]';
		case 'recent':
			return '[RECENT CONSEQUENCE CHAIN]';
		case 'relevant':
			return '[RELEVANT CALLBACKS]';
		case 'resurfaced':
			return '[RESURFACED OLD CONSEQUENCES]';
	}
}

export function selectStoryMemory(
	chapters: unknown[],
	arcs: unknown[],
	options: StoryMemorySelectorOptions = {},
): StoryMemorySelection {
	const tokenBudget = Math.max(160, options.tokenBudget ?? 1600);
	const perItemTokenBudget = Math.max(48, options.perItemTokenBudget ?? 150);
	const recentCount = Math.max(0, options.recentCount ?? 4);
	const relevantCount = Math.max(0, options.relevantCount ?? 6);
	const resurfacedCount = Math.max(0, options.resurfacedCount ?? 2);
	const query = [
		options.query ?? '',
		...(options.sceneEntityNames ?? []),
		options.currentLocationName ?? '',
		...(options.threadHints ?? []),
	].join(' ');
	const terms = tokenizeQuery(query);
	const normalizedChapters = chapters.map(normalizeChapter).filter(candidate => candidate.body.trim().length > 0);
	const normalizedArcs = arcs.map(normalizeArc).filter(candidate => candidate.body.trim().length > 0);
	const candidates = [...normalizedChapters, ...normalizedArcs];
	const latestNumber = Math.max(0, ...normalizedChapters.map(candidate => candidate.number));

	for (const candidate of candidates) {
		candidate.score = scoreCandidate(candidate, terms, latestNumber);
	}

	const pinned = normalizedChapters
		.filter(candidate => candidate.pinned)
		.sort((a, b) => a.number - b.number);
	const recentChapters = normalizedChapters
		.filter(candidate => !candidate.pinned)
		.sort((a, b) => b.number - a.number)
		.slice(0, recentCount);
	const recentArcs = normalizedArcs
		.filter(candidate => !candidate.pinned)
		.sort((a, b) => b.number - a.number)
		.slice(0, recentCount > 0 ? Math.max(1, Math.floor(recentCount / 2)) : 0);
	const recent = [...recentChapters, ...recentArcs]
		.sort((a, b) => b.number - a.number || (a.kind === 'chapter' ? -1 : 1));
	const alreadyPlannedIds = new Set([...pinned, ...recent].map(candidate => candidate.id));
	const relevant = candidates
		.filter(candidate => !alreadyPlannedIds.has(candidate.id) && !candidate.pinned && candidate.score > 0)
		.sort((a, b) => b.score - a.score || b.number - a.number)
		.slice(0, relevantCount);
	const selectedCandidateIds = new Set([...alreadyPlannedIds, ...relevant.map(candidate => candidate.id)]);
	const seed = options.seed ?? (query || 'story-memory');
	const resurfaced = candidates
		.filter(candidate => !selectedCandidateIds.has(candidate.id) && !candidate.pinned && candidate.number < latestNumber - Math.max(2, recentCount))
		.sort((a, b) => stableHash(`${seed}:${a.id}`) - stableHash(`${seed}:${b.id}`))
		.slice(0, resurfacedCount);

	const header = [
		'=== SELECTED STORY MEMORY ===',
		'Use these source-linked memories for continuity. Trace rewards, consequences, and twists to one of these sources unless the current scene creates a stronger cause.',
	];
	const buckets: StoryMemoryBucket[] = [];
	const selectedIds = new Set<string>();
	const state = {
		lines: header,
		tokenBudget,
		perItemTokenBudget,
		debug: [
			`storyMemory terms=${terms.slice(0, 12).join(',') || 'none'}`,
			`storyMemory candidates=${candidates.length} budget=${tokenBudget}`,
		],
	};

	appendBucket(buckets, 'pinned', pinned, selectedIds, state);
	appendBucket(buckets, 'recent', recent, selectedIds, state);
	appendBucket(buckets, 'relevant', relevant, selectedIds, state);
	appendBucket(buckets, 'resurfaced', resurfaced, selectedIds, state);

	if (selectedIds.size === 0) {
		return {
			block: '',
			buckets: [],
			debug: [...state.debug, 'storyMemory selected=0'],
			tokenEstimate: 0,
			selectedIds: [],
		};
	}

	const block = state.lines.join('\n');
	return {
		block,
		buckets,
		debug: [...state.debug, `storyMemory selected=${selectedIds.size}`],
		tokenEstimate: countTokens(block),
		selectedIds: [...selectedIds],
	};
}
