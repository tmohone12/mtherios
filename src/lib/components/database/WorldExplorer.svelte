<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Database,
		RefreshCw,
		Save,
		Search,
		ServerCog,
		Rows3,
		Braces,
		History,
		Play,
	} from 'lucide-svelte';

	type JsonRecord = Record<string, unknown>;
	type SectionEntry = {
		id: string;
		label: string;
		isAdvanced?: boolean;
	};
	type StorySummary = {
		id: string;
		title?: string | null;
		serverVersion?: number | null;
		updatedAt?: string | null;
	};

	const sections: SectionEntry[] = [
		{ id: 'transcript', label: 'Transcript' },
		{ id: 'characters', label: 'Characters' },
		{ id: 'locations', label: 'Locations' },
		{ id: 'items', label: 'Items' },
		{ id: 'entities', label: 'Entities' },
		{ id: 'factions', label: 'Factions' },
		{ id: 'factionGoals', label: 'Goals' },
		{ id: 'factionResources', label: 'Resources' },
		{ id: 'factionMemberships', label: 'Members' },
		{ id: 'agreements', label: 'Agreements' },
		{ id: 'threads', label: 'Threads' },
		{ id: 'events', label: 'Events' },
		{ id: 'chapters', label: 'Chapters' },
		{ id: 'arcs', label: 'Arcs' },
		{ id: 'memoryNodes', label: 'Memory' },
		{ id: 'patches', label: 'Patches', isAdvanced: true },
		{ id: 'searchIndex', label: 'Index', isAdvanced: true },
		{ id: 'jobs', label: 'Jobs', isAdvanced: true },
		{ id: 'apiCallLogs', label: 'API Calls', isAdvanced: true },
		{ id: 'llmSettings', label: 'LLM', isAdvanced: true },
	];

	let stories = $state<StorySummary[]>([]);
	let selectedStoryId = $state('');
	let activeSection = $state('entities');
	let query = $state('');
	let records = $state<JsonRecord[]>([]);
	let selectedRecord = $state<JsonRecord | null>(null);
	let detail = $state<JsonRecord | null>(null);
	let editorText = $state('');
	let status = $state('');
	let loading = $state(false);
	let saving = $state(false);
	let nextCursor = $state<string | null>(null);
	let llmSettings = $state<JsonRecord[]>([]);
	let searchResults = $state<JsonRecord[]>([]);
	let showDiagnostics = $state(false);
	let isMobile = $state(false);

	const visibleSections = $derived.by(() => {
		return sections.filter((section) => !section.isAdvanced || showDiagnostics);
	});

	const selectedStory = $derived(stories.find((story) => story.id === selectedStoryId) ?? null);
	const isRecordSection = $derived(activeSection !== 'jobs' && activeSection !== 'llmSettings');
	const isReadOnlySection = $derived(activeSection === 'apiCallLogs');
	const selectedApiCallRecord = $derived.by(() => {
		if (activeSection !== 'apiCallLogs') return null;
		const record = asRecord(detail)?.record;
		return asRecord(record) ?? selectedRecord;
	});
	const apiDebugSnapshot = $derived.by(() => {
		const metadata = asRecord(selectedApiCallRecord?.metadata);
		return asRecord(metadata?.debugSnapshot);
	});
	const columns = $derived.by(() => {
		const keys = new Set<string>();
		for (const row of records.slice(0, 8)) {
			for (const key of Object.keys(row)) {
				if (keys.size >= 8) break;
				keys.add(key);
			}
		}
		return [...keys];
	});
	const visibleColumns = $derived.by(() => isMobile ? columns.slice(0, 4) : columns);

	function asRecord(value: unknown): JsonRecord | null {
		return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
	}

	function asRecordArray(value: unknown): JsonRecord[] {
		return Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonRecord => Boolean(item)) : [];
	}

	function stringValue(value: unknown): string {
		if (typeof value === 'string') return value;
		if (value == null) return '';
		return JSON.stringify(value, null, 2);
	}

	function preview(value: unknown): string {
		if (value == null) return '';
		if (typeof value === 'string') return value.length > 140 ? `${value.slice(0, 137)}...` : value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		const text = JSON.stringify(value);
		return text.length > 140 ? `${text.slice(0, 137)}...` : text;
	}

	function cacheStatusClass(value: unknown): string {
		return value === true ? 'text-emerald-400' : 'text-amber-400';
	}

	function recordTitle(row: JsonRecord): string {
		for (const key of ['title', 'name', 'goal', 'terms', 'description', 'type', 'id']) {
			const value = row[key];
			if (typeof value === 'string' && value.trim()) return value.trim();
		}
		return 'Record';
	}

	function setActiveSection(sectionId: string) {
		activeSection = sectionId;
		searchResults = [];
		loadSection();
	}

	function ensureActiveSectionVisible() {
		if (!visibleSections.some((section) => section.id === activeSection)) {
			activeSection = visibleSections[0]?.id ?? 'entities';
		}
	}

	async function runEngineCommand(storyId: string, command: string, args: JsonRecord = {}): Promise<JsonRecord> {
		const response = await fetch('/api/engine/command', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ storyId, command, args }),
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Request failed: ${response.status}`);
		const envelope = body as JsonRecord;
		if (envelope.status !== 'succeeded') {
			throw new Error(typeof envelope.error === 'string' ? envelope.error : `Engine command failed: ${command}`);
		}
		return asRecord(envelope.result) ?? {};
	}

	async function loadStories() {
		status = '';
		const body = await runEngineCommand('__app__', 'story.list');
		stories = Array.isArray(body.stories) ? body.stories as StorySummary[] : [];
		if (!selectedStoryId && stories[0]) selectedStoryId = stories[0].id;
	}

	async function loadSection(cursor: string | null = null) {
		if (!selectedStoryId && activeSection !== 'llmSettings') return;
		loading = true;
		status = '';
		try {
			if (activeSection === 'jobs') {
				const body = await runEngineCommand(selectedStoryId, 'jobs.status', { limit: 100 });
				records = Array.isArray(body.jobs) ? body.jobs as JsonRecord[] : [];
				selectedRecord = records[0] ?? null;
				detail = selectedRecord;
				editorText = selectedRecord ? JSON.stringify(selectedRecord, null, 2) : '';
				nextCursor = null;
			} else if (activeSection === 'llmSettings') {
				const body = await runEngineCommand('__app__', 'settings.llm.list');
				llmSettings = Array.isArray(body.settings) ? body.settings as JsonRecord[] : [];
				records = llmSettings;
				selectedRecord = records[0] ?? null;
				detail = selectedRecord;
				editorText = JSON.stringify(llmSettings, null, 2);
				nextCursor = null;
			} else if (activeSection === 'apiCallLogs') {
				const body = await runEngineCommand(selectedStoryId, 'apiCallLogs.list', { limit: 60 });
				records = Array.isArray(body.logs) ? body.logs as JsonRecord[] : [];
				selectedRecord = records[0] ?? null;
				detail = selectedRecord;
				editorText = selectedRecord ? JSON.stringify(selectedRecord, null, 2) : '';
				nextCursor = null;
			} else {
				const args: JsonRecord = {
					type: activeSection,
					q: query,
					limit: 60,
				};
				if (cursor) args.cursor = cursor;
				const body = await runEngineCommand(selectedStoryId, 'world.records', args);
				const pageRecords = Array.isArray(body.records) ? body.records as JsonRecord[] : [];
				records = cursor ? [...records, ...pageRecords] : pageRecords;
				nextCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
				selectedRecord = records[0] ?? null;
				if (selectedRecord) await selectRecord(selectedRecord);
				else {
					detail = null;
					editorText = '';
				}
			}
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			loading = false;
		}
	}

	async function selectRecord(row: JsonRecord) {
		selectedRecord = row;
		if (!isRecordSection || !row.id) {
			detail = row;
			editorText = JSON.stringify(row, null, 2);
			return;
		}
		try {
			const body = await runEngineCommand(selectedStoryId || '__app__', 'world.record.get', {
				type: activeSection,
				recordId: String(row.id),
			});
			detail = body;
			editorText = JSON.stringify(body.record ?? row, null, 2);
		} catch {
			detail = row;
			editorText = JSON.stringify(row, null, 2);
		}
	}

	async function saveRecord() {
		if (!selectedRecord?.id || !isRecordSection) return;
		saving = true;
		status = '';
		try {
			const parsed = JSON.parse(editorText) as JsonRecord;
			const body = await runEngineCommand(selectedStoryId || '__app__', 'world.record.patch', {
				type: activeSection,
				recordId: String(selectedRecord.id),
				updates: parsed,
				reason: 'Manual explorer edit.',
			});
			status = `Saved patch ${body.patchId ?? ''}`;
			await loadSection();
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			saving = false;
		}
	}

	async function saveLlmSettings() {
		saving = true;
		status = '';
		try {
			const parsed = JSON.parse(editorText);
			const settings = Array.isArray(parsed) ? parsed : [];
			const body = await runEngineCommand('__app__', 'settings.llm.save', { settings });
			llmSettings = Array.isArray(body.settings) ? body.settings as JsonRecord[] : [];
			records = llmSettings;
			status = 'LLM settings saved.';
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			saving = false;
		}
	}

	async function reindexStory(runNow = false) {
		if (!selectedStoryId) return;
		status = '';
		try {
			const body = await runEngineCommand(selectedStoryId, 'jobs.reindexStory', { runNow });
			const job = body.job as { completed?: boolean } | undefined;
			status = runNow
				? `Index job ${body.jobId ?? ''} ${job?.completed ? 'completed' : 'queued'}`
				: `Queued index job ${body.jobId ?? ''}`;
			if (activeSection === 'jobs' || activeSection === 'searchIndex') await loadSection();
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		}
	}

	async function searchStory() {
		if (!selectedStoryId) return;
		status = '';
		try {
			const args: JsonRecord = { q: query, limit: 12 };
			if (isRecordSection && activeSection !== 'apiCallLogs') args.type = activeSection;
			const body = await runEngineCommand(selectedStoryId, 'world.search', args);
			searchResults = Array.isArray(body.results) ? body.results as JsonRecord[] : [];
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		}
	}

	onMount(() => {
		const mediaQuery = window.matchMedia('(max-width: 768px)');
		const syncViewport = () => {
			isMobile = mediaQuery.matches;
		};
		syncViewport();
		mediaQuery.addEventListener('change', syncViewport);

		(async () => {
			await loadStories();
			ensureActiveSectionVisible();
			await loadSection();
		})();

		return () => mediaQuery.removeEventListener('change', syncViewport);
	});
</script>

<div class="flex h-full min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
	<header class="flex flex-col gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-3 sm:flex-row sm:items-center sm:gap-3">
		<div class="flex min-w-0 items-center gap-2">
			<Database class="h-5 w-5 text-[var(--text-accent)]" />
			<div class="min-w-0">
				<div class="font-display text-sm tracking-wide text-[var(--text-accent)]">World Database</div>
				<div class="truncate text-xs text-[var(--text-muted)]">{selectedStory?.title ?? 'No story selected'}</div>
			</div>
		</div>

		<select
			bind:value={selectedStoryId}
			onchange={() => {
				ensureActiveSectionVisible();
				loadSection();
			}}
			class="w-full min-w-0 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)] sm:min-w-48 sm:w-auto"
		>
			{#each stories as item}
				<option value={item.id}>{item.title ?? item.id}</option>
			{/each}
		</select>

		<div class="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:flex-1 sm:items-center">
			<div class="relative min-w-40 flex-1">
				<Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
				<input
					bind:value={query}
					onkeydown={(event) => event.key === 'Enter' && loadSection()}
					class="h-9 w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 pl-7 pr-2 text-xs text-[var(--text-primary)]"
					placeholder="Search"
				/>
			</div>
			<div class="grid flex-1 grid-cols-2 gap-2 sm:flex sm:flex-nowrap sm:gap-2">
				<button class="rounded-md border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={() => loadSection()} title="Refresh">
					<RefreshCw class="h-4 w-4" />
				</button>
				<button class="rounded-md border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={searchStory} title="Hybrid search">
					<Search class="h-4 w-4" />
				</button>
				<button class="rounded-md border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={() => reindexStory(false)} title="Queue reindex">
					<History class="h-4 w-4" />
				</button>
				<button class="rounded-md border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={() => reindexStory(true)} title="Run reindex now">
					<Play class="h-4 w-4" />
				</button>
			</div>
			<button
				class="rounded-md border border-[var(--border-primary)] px-2 py-2 text-[9px] uppercase tracking-[0.14em] text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-accent)] sm:w-auto sm:px-3 sm:py-1.5"
				onclick={() => {
					showDiagnostics = !showDiagnostics;
					ensureActiveSectionVisible();
					loadSection();
				}}
			>
				{showDiagnostics ? 'Core + Debug' : 'Show Debug'}
			</button>
		</div>
	</header>

	<nav class="border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 py-2 sm:hidden">
		<div class="flex min-w-0 items-center gap-2 overflow-x-auto">
			{#each visibleSections as item}
				<button
					class="shrink-0 rounded-md border border-[var(--border-primary)] px-2.5 py-1.5 text-xs transition-colors {activeSection === item.id ? 'bg-[rgba(212,168,83,0.14)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]'}"
					onclick={() => setActiveSection(item.id)}
				>
					{item.label}
				</button>
			{/each}
		</div>
	</nav>

	<div class="flex min-h-0 flex-1 overflow-hidden">
		<aside class="hidden w-52 shrink-0 overflow-y-auto border-r border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 md:block">
			{#each visibleSections as item}
				<button
					class="mb-1 flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs transition-colors {activeSection === item.id ? 'bg-[rgba(212,168,83,0.14)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]'}"
					onclick={() => setActiveSection(item.id)}
				>
					<span>{item.label}</span>
				</button>
			{/each}
		</aside>

		<section class="flex min-w-0 flex-1 flex-col overflow-hidden">
			{#if status}
				<div class="border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-2 text-xs text-[var(--text-accent)]">{status}</div>
			{/if}

			<div class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)]">
				<div class="min-h-0 overflow-auto border-r border-[var(--border-primary)]">
					<div class="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-2">
						<div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
							<Rows3 class="h-4 w-4" />
							<span>{records.length} rows</span>
							{#if loading}<span>Loading</span>{/if}
						</div>
						{#if nextCursor}
							<button class="text-xs text-[var(--text-accent)]" onclick={() => loadSection(nextCursor)}>Load More</button>
						{/if}
					</div>

					{#if searchResults.length > 0}
						<div class="border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
							<div class="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Search Results</div>
							<div class="space-y-1">
								{#each searchResults as result}
									<button
										class="block w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-left text-xs hover:border-[var(--color-gold-600)]"
										onclick={() => {
											setActiveSection(String(result.recordType ?? activeSection));
											query = '';
										}}
									>
										<span class="text-[var(--text-accent)]">{result.title ?? result.recordId}</span>
										<span class="ml-2 text-[var(--text-muted)]">{result.source} {Number(result.score ?? 0).toFixed(2)}</span>
									</button>
								{/each}
							</div>
						</div>
					{/if}

					{#if isMobile}
						<div class="space-y-1.5 p-2">
							{#if records.length === 0}
								<div class="py-8 text-center text-xs text-[var(--text-muted)]">No records</div>
							{:else}
								{#each records as row}
									<button
										class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-tertiary)] p-2 text-left transition-colors {selectedRecord?.id === row.id ? 'border-[var(--color-gold-600)] bg-[rgba(212,168,83,0.08)]' : 'hover:bg-[rgba(212,168,83,0.06)]'}"
										onclick={() => selectRecord(row)}
									>
										<div class="flex items-start justify-between gap-2">
											<div class="min-w-0">
												<div class="text-xs uppercase tracking-wide text-[var(--text-accent)]">{recordTitle(row)}</div>
												<div class="mt-1 text-xs text-[var(--text-muted)]">{preview(row.id)}</div>
											</div>
											<div class="font-mono text-[9px] uppercase tracking-wide text-[var(--text-muted)]">{preview(row.type)}</div>
										</div>
										<div class="mt-2 grid grid-cols-2 gap-2">
											{#each visibleColumns as column}
												<div class="text-[10px]">
													<div class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{column}</div>
													<div class="truncate text-[var(--text-secondary)]">{preview(row[column])}</div>
												</div>
											{/each}
										</div>
									</button>
								{/each}
							{/if}
						</div>
					{:else}
						<div class="min-w-[760px]">
							<div class="grid border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[10px] uppercase tracking-wide text-[var(--text-muted)]" style={`grid-template-columns: repeat(${Math.max(visibleColumns.length, 1)}, minmax(120px, 1fr));`}>
								{#each visibleColumns as column}
									<div class="px-3 py-2">{column}</div>
								{/each}
							</div>
							{#each records as row}
								<button
									class="grid w-full border-b border-[var(--border-secondary)] text-left text-xs hover:bg-[rgba(212,168,83,0.06)] {selectedRecord?.id === row.id ? 'bg-[rgba(212,168,83,0.1)]' : ''}"
									style={`grid-template-columns: repeat(${Math.max(visibleColumns.length, 1)}, minmax(120px, 1fr));`}
									onclick={() => selectRecord(row)}
								>
									{#each visibleColumns as column}
										<div class="truncate px-3 py-2 text-[var(--text-secondary)]" title={preview(row[column])}>{preview(row[column])}</div>
									{/each}
								</button>
							{/each}
						</div>
					{/if}
				</div>

				<aside class="min-h-0 overflow-y-auto bg-[var(--bg-secondary)] {isMobile ? 'max-h-[48dvh]' : ''}">
					<div class="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3">
						<div class="min-w-0">
							<div class="truncate text-sm text-[var(--text-primary)]">{selectedRecord ? recordTitle(selectedRecord) : 'No record'}</div>
							<div class="truncate text-xs text-[var(--text-muted)]">{activeSection}</div>
						</div>
						{#if activeSection === 'llmSettings'}
							<button class="rounded-md border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={saveLlmSettings} disabled={saving} title="Save LLM settings">
								<ServerCog class="h-4 w-4" />
							</button>
						{:else if isRecordSection && selectedRecord && !isReadOnlySection}
							<button class="rounded-md border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={saveRecord} disabled={saving} title="Save record">
								<Save class="h-4 w-4" />
							</button>
						{/if}
					</div>

					<div class="space-y-4 p-4">
						{#if activeSection === 'apiCallLogs' && apiDebugSnapshot}
							<div class="space-y-3 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
								<div class="flex items-center justify-between gap-3">
									<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Prompt Audit</div>
									<div class="truncate text-xs text-[var(--text-accent)]">{stringValue(apiDebugSnapshot.kind)}</div>
								</div>

								{#if apiDebugSnapshot.contextCounts}
									<div class="grid grid-cols-2 gap-2 text-[11px] text-[var(--text-muted)]">
										{#each Object.entries(asRecord(apiDebugSnapshot.contextCounts) ?? {}) as [key, value]}
											<div class="flex items-center justify-between gap-2 rounded border border-[var(--border-secondary)] px-2 py-1">
												<span class="truncate">{key}</span>
												<span class="tabular-nums text-[var(--text-secondary)]">{stringValue(value)}</span>
											</div>
										{/each}
									</div>
								{/if}

								{#if asRecord(apiDebugSnapshot.engineCache)}
									{@const engineCache = asRecord(apiDebugSnapshot.engineCache)}
									{@const cacheSegments = asRecordArray(engineCache?.segments)}
									<div class="space-y-2 rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2">
										<div class="flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
											<span>Engine Cache</span>
											<span>
												{stringValue(engineCache?.hitCount)} hits /
												{stringValue(engineCache?.missCount)} misses /
												{stringValue(engineCache?.tokenEstimate)} tokens
											</span>
										</div>
										{#if cacheSegments.length > 0}
											<div class="max-h-56 space-y-1 overflow-auto">
												{#each cacheSegments as segment}
													<div class="rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1.5 text-[11px]">
														<div class="flex items-center justify-between gap-2">
															<span class="truncate text-[var(--text-accent)]">{stringValue(segment.kind).replaceAll('_', ' ')}</span>
															<span class="shrink-0 tabular-nums text-[var(--text-muted)]">{stringValue(segment.tokenEstimate)} tokens</span>
														</div>
														<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)]">
															<span class={cacheStatusClass(segment.hit)}>hit {stringValue(segment.hit)}</span>
															<span class={cacheStatusClass(!segment.invalidated)}>invalidated {stringValue(segment.invalidated)}</span>
															<span>hits {stringValue(segment.hitCount)}</span>
															<span>misses {stringValue(segment.missCount)}</span>
															<span>deps {stringValue(segment.dependencyCount)}</span>
															<span>hash {stringValue(segment.contentHash).slice(0, 8) || 'none'}</span>
														</div>
														<div class="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]" title={stringValue(segment.cacheKey)}>
															{stringValue(segment.cacheKey)}
														</div>
													</div>
												{/each}
											</div>
										{/if}
									</div>
								{/if}

								{#if apiDebugSnapshot.playerText}
									<div class="space-y-1">
										<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Player Action</div>
										<pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs text-[var(--text-secondary)]">{stringValue(apiDebugSnapshot.playerText)}</pre>
									</div>
								{/if}

								{#if apiDebugSnapshot.system}
									<div class="space-y-1">
										<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">System Prompt</div>
										<pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{stringValue(apiDebugSnapshot.system)}</pre>
									</div>
								{/if}

								{#if apiDebugSnapshot.prompt}
									<div class="space-y-1">
										<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">User Prompt</div>
										<pre class="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{stringValue(apiDebugSnapshot.prompt)}</pre>
									</div>
								{/if}

								{#if asRecordArray(apiDebugSnapshot.messages).length > 0}
									<div class="space-y-1">
										<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Prior Messages</div>
										<div class="max-h-72 space-y-2 overflow-auto rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2">
											{#each asRecordArray(apiDebugSnapshot.messages) as message}
												<div class="text-[11px]">
													<div class="mb-1 uppercase tracking-wide text-[var(--text-muted)]">{stringValue(message.role)}</div>
													<pre class="whitespace-pre-wrap text-[var(--text-secondary)]">{stringValue(message.content)}</pre>
												</div>
											{/each}
										</div>
									</div>
								{/if}

								{#if asRecord(apiDebugSnapshot.retrievedMemory)}
									{@const retrievedMemory = asRecord(apiDebugSnapshot.retrievedMemory)}
									<div class="space-y-1">
										<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Retrieved Memory</div>
										{#if asRecordArray(retrievedMemory?.nodes).length > 0}
											<div class="max-h-52 overflow-auto rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)]">
												{#each asRecordArray(retrievedMemory?.nodes) as node}
													<div class="border-b border-[var(--border-secondary)] px-2 py-1.5 text-[11px] last:border-b-0">
														<div class="flex items-center justify-between gap-2">
															<span class="truncate text-[var(--text-accent)]">{stringValue(node.title)}</span>
															<span class="shrink-0 text-[var(--text-muted)]">{stringValue(node.type)} {stringValue(node.score)}</span>
														</div>
														<div class="truncate text-[var(--text-muted)]">{stringValue(node.id)}</div>
													</div>
												{/each}
											</div>
										{/if}
										<pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{stringValue(retrievedMemory?.packet)}</pre>
									</div>
								{/if}

								{#if asRecord(apiDebugSnapshot.wikiContext)}
									{@const wikiContext = asRecord(apiDebugSnapshot.wikiContext)}
									<div class="space-y-1">
										<div class="flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
											<span>Wiki Context</span>
											<span>{stringValue(wikiContext?.pageCount)} pages / {stringValue(wikiContext?.seedCount)} seeds</span>
										</div>
										{#if Array.isArray(wikiContext?.citations) && wikiContext.citations.length > 0}
											<div class="flex flex-wrap gap-1">
												{#each wikiContext.citations as citation}
													<span class="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{citation}</span>
												{/each}
											</div>
										{/if}
										<pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{stringValue(wikiContext?.markdown)}</pre>
									</div>
								{/if}

								{#if apiDebugSnapshot.output}
									<div class="space-y-1">
										<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Model Output</div>
										<pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs leading-relaxed text-[var(--text-secondary)]">{stringValue(apiDebugSnapshot.output)}</pre>
									</div>
								{/if}
							</div>
						{/if}

						<div class="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">
							<Braces class="h-4 w-4" />
							<span>JSON</span>
						</div>
						<textarea
							bind:value={editorText}
							spellcheck="false"
							readonly={isReadOnlySection}
							class="h-[34vh] w-full resize-y rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 font-mono text-xs leading-relaxed text-[var(--text-secondary)] outline-none focus:border-[var(--color-gold-600)] sm:h-[44vh]"
						></textarea>

						{#if detail && typeof detail === 'object' && !Array.isArray(detail) && (detail.sourceEntries || detail.sourceEvents || detail.sourcePatches)}
							<div class="space-y-2">
								<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Sources</div>
								<pre class="max-h-72 overflow-auto rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 text-xs text-[var(--text-secondary)]">{JSON.stringify({
									entries: detail.sourceEntries ?? [],
									events: detail.sourceEvents ?? [],
									patches: detail.sourcePatches ?? [],
								}, null, 2)}</pre>
							</div>
						{/if}
					</div>
				</aside>
			</div>
		</section>
	</div>
</div>
