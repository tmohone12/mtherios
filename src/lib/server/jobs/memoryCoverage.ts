export type MemoryCoverageEntry = {
	id: string;
	type: string;
	content: string;
	position: number;
	parentId: string | null;
	metadata: Record<string, unknown> | null;
	serverVersion?: number;
};

export type MemoryCoverageJob = {
	status: string;
	createdAt: string;
	updatedAt: string;
	lastError: string | null;
	payload: Record<string, unknown>;
};

export type MemoryCoverage = {
	status: 'current' | 'updating' | 'attention';
	stage: 'extraction' | null;
	eligibleSources: number;
	completeSources: number;
	missingSources: number;
	failedSources: number;
	outdatedSources: number;
	waitingSources: number;
	runningSources: number;
	recentUnresolvedSources: number;
	lastContiguousPosition: number | null;
	oldestUnresolvedPosition: number | null;
	oldestUnresolvedEntryId: string | null;
	oldestUnresolvedReason: 'missing' | 'failed' | 'outdated' | 'waiting' | 'running' | null;
};

export type MemoryCoverageGap = {
	assistant: MemoryCoverageEntry;
	player: MemoryCoverageEntry | null;
	job: MemoryCoverageJob | null;
	reason: NonNullable<MemoryCoverage['oldestUnresolvedReason']>;
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isNonCanon(entry: Pick<MemoryCoverageEntry, 'metadata'>): boolean {
	const metadata = asRecord(entry.metadata);
	return metadata.nonCanon === true || metadata.actionType === 'ooc' || metadata.narrativeMode === 'ooc';
}

function isEligibleNarration(entry: MemoryCoverageEntry, byId: Map<string, MemoryCoverageEntry>): boolean {
	if (entry.type !== 'narration' || !entry.parentId || isNonCanon(entry)) return false;
	const parent = byId.get(entry.parentId);
	return Boolean(parent && parent.type === 'user_action' && !isNonCanon(parent));
}

function latestJobByAssistant(jobs: MemoryCoverageJob[]): Map<string, MemoryCoverageJob> {
	const latest = new Map<string, MemoryCoverageJob>();
	for (const job of jobs) {
		const assistantEntryId = typeof job.payload.assistantEntryId === 'string' ? job.payload.assistantEntryId : '';
		if (!assistantEntryId) continue;
		const previous = latest.get(assistantEntryId);
		if (!previous || job.createdAt.localeCompare(previous.createdAt) > 0) latest.set(assistantEntryId, job);
	}
	return latest;
}

function jobMatchesSource(job: MemoryCoverageJob, assistant: MemoryCoverageEntry, player: MemoryCoverageEntry): boolean {
	return job.payload.narration === assistant.content && job.payload.playerText === player.content;
}

export function findMemoryCoverageGaps(entries: MemoryCoverageEntry[], jobs: MemoryCoverageJob[]): MemoryCoverageGap[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const eligible = entries
		.filter((entry) => isEligibleNarration(entry, byId))
		.sort((a, b) => a.position - b.position);
	const latestJobs = latestJobByAssistant(jobs);
	const gaps: MemoryCoverageGap[] = [];
	for (const assistant of eligible) {
		const player = assistant.parentId ? byId.get(assistant.parentId) ?? null : null;
		const job = player ? latestJobs.get(assistant.id) ?? null : null;
		let reason: MemoryCoverageGap['reason'] | null = null;
		if (!job) reason = 'missing';
		else if (job.status === 'running') reason = 'running';
		else if (job.status === 'queued' || job.status === 'retry') reason = 'waiting';
		else if (!player || !jobMatchesSource(job, assistant, player)) reason = 'outdated';
		else if (job.status === 'failed') reason = 'failed';
		else if (job.status !== 'complete') reason = 'outdated';
		if (reason) gaps.push({ assistant, player, job, reason });
	}
	return gaps;
}

export function deriveMemoryCoverage(entries: MemoryCoverageEntry[], jobs: MemoryCoverageJob[]): MemoryCoverage {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const eligible = entries
		.filter((entry) => isEligibleNarration(entry, byId))
		.sort((a, b) => a.position - b.position);
	const gaps = findMemoryCoverageGaps(entries, jobs);
	const gapByAssistant = new Map(gaps.map((gap) => [gap.assistant.id, gap]));
	const unresolved: Array<{ entry: MemoryCoverageEntry; reason: MemoryCoverageGap['reason'] }> = [];
	let completeSources = 0;
	let missingSources = 0;
	let failedSources = 0;
	let outdatedSources = 0;
	let waitingSources = 0;
	let runningSources = 0;

	for (const assistant of eligible) {
		const gap = gapByAssistant.get(assistant.id);
		if (!gap) {
			completeSources++;
			continue;
		}
		const reason = gap.reason;
		unresolved.push({ entry: assistant, reason });
		if (reason === 'missing') missingSources++;
		else if (reason === 'failed') failedSources++;
		else if (reason === 'outdated') outdatedSources++;
		else if (reason === 'waiting') waitingSources++;
		else if (reason === 'running') runningSources++;
	}

	const firstUnresolvedPosition = unresolved[0]?.entry.position ?? null;
	const recentIds = new Set(eligible.slice(-5).map(entry => entry.id));
	const recentUnresolvedSources = unresolved.filter(({ entry }) => recentIds.has(entry.id)).length;
	let lastContiguousPosition: number | null = null;
	for (const entry of eligible) {
		if (gapByAssistant.has(entry.id)) break;
		lastContiguousPosition = entry.position;
	}
	const status = unresolved.some(({ reason }) => ['missing', 'failed', 'outdated'].includes(reason ?? ''))
		? 'attention'
		: unresolved.length > 0 ? 'updating' : 'current';

	return {
		status,
		stage: unresolved.length > 0 ? 'extraction' : null,
		eligibleSources: eligible.length,
		completeSources,
		missingSources,
		failedSources,
		outdatedSources,
		waitingSources,
		runningSources,
		recentUnresolvedSources,
		lastContiguousPosition,
		oldestUnresolvedPosition: firstUnresolvedPosition,
		oldestUnresolvedEntryId: unresolved[0]?.entry.id ?? null,
		oldestUnresolvedReason: unresolved[0]?.reason ?? null,
	};
}
