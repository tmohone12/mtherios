export interface TerminalWikiSearchResult {
	path: string;
	title: string;
	score?: number;
	semanticScore?: number;
	exactScore?: number;
	layer?: string;
	links?: string[];
	backlinks?: string[];
	neighbors?: Array<{
		path: string;
		title: string;
		distance: number;
	}>;
	text?: string;
}

export interface TerminalWikiSearchResponse {
	query: string;
	semanticError?: string | null;
	results: TerminalWikiSearchResult[];
}

export interface TerminalWikiContextPage {
	citationId: number;
	path: string;
	title: string;
	layer?: string;
	distance: number;
	sourceSeedPaths: string[];
	links: string[];
	backlinks: string[];
	headings: string[];
	updatedAt?: string;
	text: string;
}

export interface TerminalWikiContextResponse {
	query: string;
	generatedAt: string;
	semanticError?: string | null;
	seedCount: number;
	pageCount: number;
	seeds: TerminalWikiSearchResult[];
	pages: TerminalWikiContextPage[];
	edges: Array<{ from: string; to: string }>;
	citations: string[];
	contextMarkdown: string;
}

export interface TerminalWikiBriefResponse {
	ok: boolean;
	task: string;
	mode: string;
	root: string;
	generatedAt: string;
	search: {
		query: string;
		semanticError?: string | null;
		seedCount: number;
		pageCount: number;
		seeds: TerminalWikiSearchResult[];
	};
	lint: {
		ok: boolean;
		summary: Record<string, number>;
		missingCoreFiles: unknown[];
		brokenLinks: unknown[];
		orphanPages: unknown[];
		thinPages: unknown[];
		emptyPages: unknown[];
		duplicateTitles: unknown[];
	};
	corePages: Array<{
		path: string;
		title: string;
		layer?: string;
		type?: string | null;
		headings: string[];
		links: string[];
		backlinks: string[];
		text: string;
	}>;
	inventory: {
		pageCount: number;
		layers: Record<string, number>;
		types: Record<string, number>;
		hubs: Array<Record<string, unknown>>;
		recent: Array<Record<string, unknown>>;
		rawSources: Array<Record<string, unknown>>;
		derivedCandidates: Array<Record<string, unknown>>;
	};
	context: TerminalWikiContextResponse;
	runbook: string[];
	nextCommands: string[];
	briefMarkdown: string;
}

export interface TerminalWikiSearchInput {
	query: string;
	storyId?: string | null;
	limit?: number;
	followDepth?: number;
	exact?: boolean;
	vaultPath?: string | null;
}

export interface TerminalWikiContextInput extends TerminalWikiSearchInput {
	pageLimit?: number;
	pageChars?: number;
	maxChars?: number;
}

export interface TerminalWikiBriefInput extends TerminalWikiContextInput {
	mode?: string | null;
	inventoryLimit?: number;
	thinChars?: number;
	orphanLayer?: 'derived' | 'all';
}

type EngineCommandResponse = {
	status: 'queued' | 'running' | 'succeeded' | 'failed';
	result?: unknown;
	error?: string | null;
};

function commandStoryId(input: { storyId?: string | null }): string {
	const storyId = typeof input.storyId === 'string' ? input.storyId.trim() : '';
	return storyId || '__wiki__';
}

async function runWikiCommand<T>(command: string, input: Record<string, unknown>): Promise<T> {
	const response = await fetch('/api/engine/command', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			storyId: commandStoryId(input),
			command,
			args: input,
		}),
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(typeof body.error === 'string' ? body.error : `Terminal wiki command failed: ${response.status}`);
	}
	const envelope = await response.json() as EngineCommandResponse;
	if (envelope.status !== 'succeeded') {
		throw new Error(envelope.error ?? `Terminal wiki command failed: ${command}`);
	}
	return envelope.result as T;
}

export async function searchTerminalWiki(input: TerminalWikiSearchInput): Promise<TerminalWikiSearchResponse> {
	return await runWikiCommand<TerminalWikiSearchResponse>('wiki.search', { ...input });
}

export async function contextTerminalWiki(input: TerminalWikiContextInput): Promise<TerminalWikiContextResponse> {
	return await runWikiCommand<TerminalWikiContextResponse>('wiki.context', { ...input });
}

export async function briefTerminalWiki(input: TerminalWikiBriefInput): Promise<TerminalWikiBriefResponse> {
	return await runWikiCommand<TerminalWikiBriefResponse>('wiki.brief', { ...input });
}
