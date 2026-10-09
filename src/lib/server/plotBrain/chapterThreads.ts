export type ChapterThreadAction = 'advance' | 'hold' | 'stall' | 'resolve' | 'abandon';

export interface ChapterThreadChange {
	threadId: string;
	action: ChapterThreadAction;
	currentState?: string;
	evidenceEventIds: string[];
}

export interface ChapterNewThread {
	title: string;
	currentState: string;
	significance: 'minor' | 'moderate' | 'major' | 'critical';
	evidenceEventIds: string[];
}

export interface ChapterThreadDirectives {
	threadChanges: ChapterThreadChange[];
	newThreads: ChapterNewThread[];
}

export interface ChapterCanonicalThread {
	id: string;
	description: string;
	status: string;
	significance: string;
	relatedFactionIds: string[];
	relatedEntityIds: string[];
	sourceEntryIds: string[];
	sourceEventIds: string[];
	sourcePatchIds: string[];
}

export interface ChapterThreadEvent {
	id: string;
	threadIds: string[];
}

export interface ChapterThreadPlan {
	updates: Array<{ threadId: string; values: Record<string, unknown> }>;
	inserts: Array<Record<string, unknown> & { id: string; description: string }>;
	eventUpdates: Array<{ eventId: string; threadIds: string[] }>;
	openThreadIds: string[];
}

const ACTIONS = new Set<ChapterThreadAction>(['advance', 'hold', 'stall', 'resolve', 'abandon']);
const SIGNIFICANCE = new Set<ChapterNewThread['significance']>(['minor', 'moderate', 'major', 'critical']);

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown, limit = 12): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

function concise(value: unknown, limit = 600): string {
	if (typeof value !== 'string') return '';
	const clean = value.replace(/\s+/g, ' ').trim();
	return clean.length <= limit ? clean : `${clean.slice(0, limit - 3).trimEnd()}...`;
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'plot';
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function threadTitle(description: string): string {
	const firstLine = description.split(/\r?\n/, 1)[0]?.trim() ?? '';
	return (firstLine.match(/^([^:]{1,160}):\s+/)?.[1] ?? firstLine).trim();
}

function normalizedTitle(value: string): string {
	return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function descriptionWithCurrentState(description: string, currentState: string): string {
	if (!currentState) return description;
	const withoutOldState = description.split(/\r?\n/).filter((line) => !/^Current state:/i.test(line.trim())).join('\n').trim();
	return `${withoutOldState}\nCurrent state: ${currentState}`.trim();
}

export function coerceChapterThreadDirectives(raw: unknown): ChapterThreadDirectives {
	const record = asRecord(raw);
	const threadChanges = (Array.isArray(record.threadChanges) ? record.threadChanges : [])
		.slice(0, 8)
		.map(asRecord)
		.flatMap((change): ChapterThreadChange[] => {
			const threadId = concise(change.threadId, 220);
			const action = change.action;
			if (!threadId || typeof action !== 'string' || !ACTIONS.has(action as ChapterThreadAction)) return [];
			const currentState = concise(change.currentState);
			return [{
				threadId,
				action: action as ChapterThreadAction,
				...(currentState ? { currentState } : {}),
				evidenceEventIds: strings(change.evidenceEventIds),
			}];
		});
	const newThreads = (Array.isArray(record.newThreads) ? record.newThreads : [])
		.slice(0, 3)
		.map(asRecord)
		.flatMap((thread): ChapterNewThread[] => {
			const title = concise(thread.title, 160);
			const currentState = concise(thread.currentState);
			if (!title || !currentState) return [];
			const significance = typeof thread.significance === 'string' && SIGNIFICANCE.has(thread.significance as ChapterNewThread['significance'])
				? thread.significance as ChapterNewThread['significance']
				: 'moderate';
			return [{ title, currentState, significance, evidenceEventIds: strings(thread.evidenceEventIds) }];
		});
	return { threadChanges, newThreads };
}

export function formatChapterThreadCatalog(threads: ChapterCanonicalThread[]): string {
	return JSON.stringify(threads.slice(0, 32).map((thread) => ({
		id: thread.id,
		status: thread.status,
		significance: thread.significance,
		description: concise(thread.description, 320),
	})));
}

export function chapterThreadMetadata(openThreadIds: string[]): { openThreadIds: string[] } {
	return { openThreadIds: unique(openThreadIds) };
}

export function humanizeChapterOpenThreads(values: string[], threads: Array<Pick<ChapterCanonicalThread, 'id' | 'description'>>): string[] {
	const byId = new Map(threads.map((thread) => [thread.id, thread.description]));
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		const canonical = byId.get(value);
		const text = concise(canonical ? canonical.split(/\r?\n/, 1)[0] : value, 300);
		const key = normalizedTitle(threadTitle(text));
		if (!text || !key || seen.has(key)) continue;
		seen.add(key);
		output.push(text);
		if (output.length >= 8) break;
	}
	return output;
}

export function buildChapterThreadPlan(input: {
	storyId: string;
	chapterId: string;
	existingThreads: ChapterCanonicalThread[];
	events: ChapterThreadEvent[];
	directives: ChapterThreadDirectives;
	sourceEntryIds: string[];
	serverVersion: number;
	now: string;
}): ChapterThreadPlan {
	const existingById = new Map(input.existingThreads.map((thread) => [thread.id, thread]));
	const titleToId = new Map(input.existingThreads.map((thread) => [normalizedTitle(threadTitle(thread.description)), thread.id]));
	const eventById = new Map(input.events.map((event) => [event.id, event]));
	const openIds: string[] = [];
	const closedIds = new Set<string>();
	const updates = new Map<string, Record<string, unknown>>();
	const eventThreadIds = new Map(input.events.map((event) => [event.id, unique(event.threadIds)]));

	const attachEvidence = (threadId: string, evidenceEventIds: string[]) => {
		for (const eventId of evidenceEventIds) {
			const linked = eventThreadIds.get(eventId);
			if (linked) eventThreadIds.set(eventId, unique([...linked, threadId]));
		}
	};
	const planExistingUpdate = (thread: ChapterCanonicalThread, change: ChapterThreadChange) => {
		if (closedIds.has(thread.id)) return;
		const evidenceEventIds = change.evidenceEventIds.filter((eventId) => eventById.has(eventId));
		if ((change.action === 'resolve' || change.action === 'abandon') && evidenceEventIds.length === 0) return;
		if ((thread.status === 'closed' || thread.status === 'abandoned')
			&& change.action !== 'resolve'
			&& change.action !== 'abandon') return;
		const prior = updates.get(thread.id);
		const values: Record<string, unknown> = {
			sourceEntryIds: unique([...thread.sourceEntryIds, ...strings(prior?.sourceEntryIds, 500), ...input.sourceEntryIds]),
			sourceEventIds: unique([...thread.sourceEventIds, ...strings(prior?.sourceEventIds, 500), ...evidenceEventIds]),
			serverVersion: input.serverVersion,
			updatedAt: input.now,
		};
		if (change.currentState) values.description = descriptionWithCurrentState(thread.description, change.currentState);
		if (change.action === 'stall') values.status = 'stalled';
		if (change.action === 'advance') values.status = thread.status === 'imminent' ? 'imminent' : 'open';
		if (change.action === 'resolve' || change.action === 'abandon') {
			values.status = 'closed';
			values.closedAt = input.now;
			values.closureReason = `${change.action === 'resolve' ? 'Resolved' : 'Abandoned'} by chapter ${input.chapterId}.`;
			closedIds.add(thread.id);
		} else {
			openIds.push(thread.id);
		}
		updates.set(thread.id, { ...prior, ...values });
		attachEvidence(thread.id, evidenceEventIds);
	};

	for (const event of input.events) {
		for (const threadId of event.threadIds) {
			const thread = existingById.get(threadId);
			if (!thread) continue;
			planExistingUpdate(thread, { threadId, action: 'hold', evidenceEventIds: [event.id] });
		}
	}
	for (const change of input.directives.threadChanges) {
		const thread = existingById.get(change.threadId);
		if (thread) planExistingUpdate(thread, change);
	}

	const inserts: ChapterThreadPlan['inserts'] = [];
	const insertedByTitle = new Map<string, number>();
	for (const thread of input.directives.newThreads) {
		const titleKey = normalizedTitle(thread.title);
		if (!titleKey) continue;
		const evidenceEventIds = thread.evidenceEventIds.filter((eventId) => eventById.has(eventId));
		const existingId = titleToId.get(titleKey);
		if (existingId) {
			const existing = existingById.get(existingId);
			if (existing && existing.status !== 'closed' && existing.status !== 'abandoned') planExistingUpdate(existing, {
				threadId: existingId,
				action: 'advance',
				currentState: thread.currentState,
				evidenceEventIds,
			});
			continue;
		}
		const duplicateIndex = insertedByTitle.get(titleKey);
		if (duplicateIndex !== undefined) {
			const existingInsert = inserts[duplicateIndex];
			existingInsert.sourceEventIds = unique([...(existingInsert.sourceEventIds as string[]), ...evidenceEventIds]);
			attachEvidence(existingInsert.id, evidenceEventIds);
			continue;
		}
		const id = `plot_thread_${slug(input.storyId)}_${slug(thread.title)}`;
		const idCollision = existingById.get(id);
		if (idCollision) {
			if (idCollision.status !== 'closed' && idCollision.status !== 'abandoned') planExistingUpdate(idCollision, {
				threadId: id,
				action: 'advance',
				currentState: thread.currentState,
				evidenceEventIds,
			});
			continue;
		}
		insertedByTitle.set(titleKey, inserts.length);
		inserts.push({
			id,
			storyId: input.storyId,
			description: `${thread.title}: ${thread.currentState}`,
			status: 'open',
			significance: thread.significance,
			relatedFactionIds: [],
			relatedEntityIds: [],
			sourceEntryIds: unique(input.sourceEntryIds),
			sourceEventIds: evidenceEventIds,
			sourcePatchIds: [],
			closedAt: null,
			closureReason: null,
			serverVersion: input.serverVersion,
			createdAt: input.now,
			updatedAt: input.now,
		});
		openIds.push(id);
		attachEvidence(id, evidenceEventIds);
	}

	return {
		updates: [...updates].map(([threadId, values]) => ({ threadId, values })),
		inserts,
		eventUpdates: input.events.flatMap((event) => {
			const threadIds = eventThreadIds.get(event.id) ?? [];
			return threadIds.length === event.threadIds.length && threadIds.every((id, index) => id === event.threadIds[index])
				? []
				: [{ eventId: event.id, threadIds }];
		}),
		openThreadIds: unique(openIds).filter((id) => !closedIds.has(id)),
	};
}
