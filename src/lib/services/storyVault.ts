export interface StoryVaultManifestIndex {
	collection: string;
	serverVersion: number;
	indexedAt: string;
	provider?: string | null;
	model?: string | null;
	recreate?: boolean;
	outputTail?: string;
}

export interface StoryVaultManifest {
	schemaVersion: number;
	storyId: string;
	storyTitle: string;
	serverVersion: number;
	generatedAt: string;
	vaultPath: string;
	collection: string;
	counts: Record<string, number>;
	index?: StoryVaultManifestIndex | null;
}

export interface StoryVaultLintStatus {
	exists: boolean;
	fresh: boolean;
	ok: boolean | null;
	issueCount: number | null;
	lintedAt: string | null;
	path: string;
	summary: Record<string, unknown> | null;
}

export interface StoryVaultStatus {
	storyId: string;
	storyTitle: string;
	vaultPath: string;
	collection: string;
	serverVersion: number;
	exists: boolean;
	vaultFresh: boolean;
	indexFresh: boolean;
	manifestVersion: number | null;
	indexedVersion: number | null;
	manifest: StoryVaultManifest | null;
	lint: StoryVaultLintStatus;
}

export interface StoryVaultJobResult {
	job: Record<string, unknown>;
	status: StoryVaultStatus;
}

interface EngineCommandResponse<T> {
	status?: string;
	result?: T;
	error?: string | null;
}

async function readJson(response: Response): Promise<unknown> {
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(typeof (body as { error?: unknown }).error === 'string'
			? (body as { error: string }).error
			: `Story vault request failed: ${response.status}`);
	}
	return body;
}

async function runEngineCommand<T>(
	storyId: string,
	command: string,
	args: Record<string, unknown>,
): Promise<T> {
	const raw = await readJson(await fetch('/api/engine/command', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ storyId, command, args }),
	})) as EngineCommandResponse<T>;
	if (raw.status !== 'succeeded') {
		throw new Error(raw.error ?? `Engine command failed: ${command}`);
	}
	return raw.result as T;
}

export async function fetchStoryVaultStatus(storyId: string): Promise<StoryVaultStatus> {
	return runEngineCommand<StoryVaultStatus>(storyId, 'wiki.storyVault.status', { storyId });
}

export async function downloadStoryVaultArchive(storyId: string): Promise<void> {
	const params = new URLSearchParams({ storyId });
	const response = await fetch(`/api/wiki/story-vault/archive?${params.toString()}`);
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(typeof (body as { error?: unknown }).error === 'string'
			? (body as { error: string }).error
			: `Story vault archive failed: ${response.status}`);
	}
	const blob = await response.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = archiveFilename(response.headers.get('Content-Disposition')) || `${storyId}.wiki.zip`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

export async function runStoryVaultJob(input: {
	storyId: string;
	index?: boolean;
	recreate?: boolean;
	clean?: boolean;
	lint?: boolean;
	thinChars?: number;
	orphanLayer?: 'derived' | 'all';
	runNow?: boolean;
}): Promise<StoryVaultJobResult> {
	const job = await runEngineCommand<Record<string, unknown>>(input.storyId, 'jobs.storyVaultSync', {
		storyId: input.storyId,
		index: input.index === true,
		recreate: input.recreate === true,
		clean: input.clean !== false,
		lint: input.lint === true,
		thinChars: input.thinChars,
		orphanLayer: input.orphanLayer,
		runNow: input.runNow !== false,
	});
	if (job.ok === false) {
		const run = job.job && typeof job.job === 'object' ? job.job as Record<string, unknown> : null;
		throw new Error(typeof run?.error === 'string' ? run.error : 'Story vault job failed.');
	}
	return {
		job,
		status: await fetchStoryVaultStatus(input.storyId),
	};
}

function archiveFilename(contentDisposition: string | null): string | null {
	if (!contentDisposition) return null;
	const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition);
	if (!match?.[1]) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}
