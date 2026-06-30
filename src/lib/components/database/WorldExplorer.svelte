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
		Sparkles,
		Check,
		X,
		Plus,
	} from 'lucide-svelte';
	import { formatProposalDescription, formatProposalSummary } from '$lib/services/canonProposalDisplay';

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

	let { storyId: fixedStoryId = null, title = 'World Database' } = $props<{
		storyId?: string | null;
		title?: string;
	}>();

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
		{ id: 'npcCandidates', label: 'NPC Candidates' },
		{ id: 'patchProposals', label: 'Reviews' },
		{ id: 'patches', label: 'Patch Log', isAdvanced: true },
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
	let draftingCharacter = $state(false);
	let reviewingProposal = $state(false);
	let newDatabaseTitle = $state('');
	let creatingDatabase = $state(false);
	let characterDraftInstructions = $state('Update this NPC from recent story context.');

	const visibleSections = $derived.by(() => {
		return sections.filter((section) => !section.isAdvanced || showDiagnostics);
	});

	const selectedStory = $derived(stories.find((story) => story.id === selectedStoryId) ?? null);
	const isStoryLocked = $derived(Boolean(fixedStoryId));
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
		if (isNpcCandidateSection()) return ['candidate', 'confidence', 'status', 'reason', 'source'];
		if (isReviewSection()) return ['summary', 'status', 'proposalType', 'targetRecordId', 'reason'];
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
	const editorRecord = $derived.by(() => {
		try {
			return asRecord(JSON.parse(editorText));
		} catch {
			return null;
		}
	});
	const characterState = $derived.by(() => asRecord(editorRecord?.state) ?? {});
	const characterRelationship = $derived.by(() => asRecord(characterState.relationship) ?? {});
	const isReviewablePatch = $derived(isReviewSection()
		&& Boolean(selectedRecord?.id)
		&& ['pending', 'needs_review'].includes(String((editorRecord?.status ?? selectedRecord?.status) ?? '')));

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

	function stringArrayValue(value: unknown): string[] {
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	}

	function textValue(event: Event): string {
		return (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
	}

	function linesValue(value: unknown): string {
		return Array.isArray(value) ? value.filter((item) => typeof item === 'string').join('\n') : stringValue(value);
	}

	function lineArray(value: string): string[] {
		return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	}

	function nullableTextValue(value: string): string | null {
		const clean = value.trim();
		return clean ? clean : null;
	}

	function numberInputValue(event: Event, fallback: number, min: number, max: number, integer = false): number {
		const parsed = Number(textValue(event));
		const bounded = Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
		return integer ? Math.round(bounded) : bounded;
	}

	function nullableNumberInputValue(event: Event, min: number, max: number, integer = false): number | null {
		const text = textValue(event).trim();
		if (!text) return null;
		const parsed = Number(text);
		if (!Number.isFinite(parsed)) return null;
		const bounded = Math.min(max, Math.max(min, parsed));
		return integer ? Math.round(bounded) : bounded;
	}

	function updateLlmSetting(index: number, key: string, value: unknown) {
		const next = llmSettings.map((setting, itemIndex) => itemIndex === index ? { ...setting, [key]: value } : setting);
		llmSettings = next;
		records = next;
		selectedRecord = next[index] ?? selectedRecord;
		detail = selectedRecord;
		editorText = JSON.stringify(next, null, 2);
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

	function recordCommandType(sectionId = activeSection): string {
		return sectionId === 'npcCandidates' ? 'patchProposals' : sectionId;
	}

	function isNpcCandidateSection(sectionId = activeSection): boolean {
		return sectionId === 'npcCandidates';
	}

	function isReviewSection(sectionId = activeSection): boolean {
		return sectionId === 'patchProposals' || isNpcCandidateSection(sectionId);
	}

	function proposalOperationValue(row: JsonRecord): JsonRecord | null {
		for (const rawOperation of Array.isArray(row.operations) ? row.operations : []) {
			const operation = asRecord(rawOperation);
			const value = asRecord(operation?.value);
			if (value) return value;
		}
		return null;
	}

	function npcCandidateName(row: JsonRecord | null): string {
		if (!row) return '';
		const metadata = asRecord(row.metadata);
		const value = proposalOperationValue(row);
		return stringValue(metadata?.sourceName || value?.name || row.targetRecordId);
	}

	function npcCandidateSource(row: JsonRecord): string {
		const metadata = asRecord(row.metadata);
		const chapterNumber = metadata?.chapterNumber;
		if (typeof chapterNumber === 'number' || typeof chapterNumber === 'string') return `Chapter ${chapterNumber}`;
		return stringValue(metadata?.sourceType || row.proposedBy);
	}

	function isNpcCandidateProposal(row: JsonRecord): boolean {
		const status = String(row.status ?? '');
		return row.proposalType === 'character_reference_review' && ['pending', 'needs_review'].includes(status);
	}

	function cellValue(row: JsonRecord, column: string): unknown {
		if (isNpcCandidateSection()) {
			if (column === 'candidate') return npcCandidateName(row);
			if (column === 'source') return npcCandidateSource(row);
		}
		if (isReviewSection()) {
			if (column === 'summary') return formatProposalSummary(row);
			if (column === 'reason') return formatProposalDescription(row);
		}
		return row[column];
	}

	function recordSubtitle(row: JsonRecord): string {
		if (isNpcCandidateSection()) return formatProposalDescription(row);
		return isReviewSection() ? formatProposalDescription(row) : preview(row.id);
	}

	function recordTitle(row: JsonRecord): string {
		if (isNpcCandidateSection()) return npcCandidateName(row) || formatProposalSummary(row);
		if (isReviewSection() || row.proposalType) return formatProposalSummary(row);
		for (const key of ['title', 'name', 'goal', 'terms', 'description', 'type', 'id']) {
			const value = row[key];
			if (typeof value === 'string' && value.trim()) return value.trim();
		}
		return 'Record';
	}

	function updateEditor(mutator: (record: JsonRecord) => void) {
		const record = editorRecord ? { ...editorRecord } : {};
		const state = asRecord(record.state) ?? {};
		record.state = { ...state };
		mutator(record);
		editorText = JSON.stringify(record, null, 2);
	}

	function updateCharacterState(key: string, value: unknown) {
		updateEditor((record) => {
			const state = asRecord(record.state) ?? {};
			record.state = { ...state, [key]: value };
		});
	}

	function updateCharacterRelationship(key: string, value: unknown) {
		updateEditor((record) => {
			const state = asRecord(record.state) ?? {};
			const relationship = asRecord(state.relationship) ?? {};
			record.state = {
				...state,
				relationship: { level: 0, status: 'unknown', history: [], ...relationship, [key]: value },
			};
		});
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
		if (fixedStoryId) selectedStoryId = fixedStoryId;
		else if (!selectedStoryId && stories[0]) selectedStoryId = stories[0].id;
	}

	async function createDatabase() {
		const title = newDatabaseTitle.trim();
		if (!title || creatingDatabase || isStoryLocked) return;
		creatingDatabase = true;
		status = '';
		try {
			const body = await runEngineCommand('__app__', 'story.create', {
				title,
				mode: 'adventure',
			});
			const storyId = typeof body.storyId === 'string' ? body.storyId : '';
			newDatabaseTitle = '';
			await loadStories();
			if (storyId) selectedStoryId = storyId;
			await loadSection();
			status = `Created database ${title}.`;
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			creatingDatabase = false;
		}
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
			} else if (activeSection === 'npcCandidates') {
				const args: JsonRecord = {
					type: 'patchProposals',
					q: query,
					limit: 100,
				};
				if (cursor) args.cursor = cursor;
				const body = await runEngineCommand(selectedStoryId, 'world.records', args);
				const pageRecords = (Array.isArray(body.records) ? body.records as JsonRecord[] : []).filter(isNpcCandidateProposal);
				records = cursor ? [...records, ...pageRecords] : pageRecords;
				nextCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
				selectedRecord = records[0] ?? null;
				if (selectedRecord) await selectRecord(selectedRecord);
				else {
					detail = null;
					editorText = '';
				}
			} else {
				const args: JsonRecord = {
					type: recordCommandType(),
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
		if (activeSection === 'llmSettings') {
			detail = row;
			editorText = JSON.stringify(llmSettings, null, 2);
			return;
		}
		if (!isRecordSection || !row.id) {
			detail = row;
			editorText = JSON.stringify(row, null, 2);
			return;
		}
		try {
			const body = await runEngineCommand(selectedStoryId || '__app__', 'world.record.get', {
				type: recordCommandType(),
				recordId: String(row.id),
			});
			detail = body;
			editorText = JSON.stringify(body.record ?? row, null, 2);
		} catch {
			detail = row;
			editorText = JSON.stringify(row, null, 2);
		}
	}

	async function openRecord(sectionId: string, recordId: string, fallback: JsonRecord = {}) {
		activeSection = sectionId;
		searchResults = [];
		query = '';
		const body = await runEngineCommand(selectedStoryId || '__app__', 'world.record.get', {
			type: recordCommandType(sectionId),
			recordId,
		});
		const record = asRecord(body.record) ?? { ...fallback, id: recordId };
		records = [record];
		selectedRecord = record;
		detail = body;
		editorText = JSON.stringify(record, null, 2);
		nextCursor = null;
	}

	async function openSearchResult(result: JsonRecord) {
		const sectionId = String(result.recordType ?? activeSection);
		const recordId = String(result.recordId ?? '');
		if (!recordId) {
			setActiveSection(sectionId);
			return;
		}
		try {
			await openRecord(sectionId, recordId, { id: recordId, title: result.title });
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		}
	}

	async function saveRecord() {
		if (!selectedRecord?.id || !isRecordSection) return;
		saving = true;
		status = '';
		try {
			const parsed = JSON.parse(editorText) as JsonRecord;
			const body = await runEngineCommand(selectedStoryId || '__app__', 'world.record.patch', {
				type: recordCommandType(),
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

	async function draftCharacterUpdate() {
		if (!selectedStoryId || !selectedRecord?.id) return;
		draftingCharacter = true;
		status = '';
		try {
			const body = await runEngineCommand(selectedStoryId, 'world.character.draftUpdate', {
				recordId: String(selectedRecord.id),
				instructions: characterDraftInstructions,
				recentLimit: 30,
			});
			if (body.status === 'skipped') {
				status = stringValue(body.reason) || 'No supported character changes found.';
				return;
			}
			if (typeof body.proposalId === 'string') {
				status = `Draft proposal ${body.proposalId} created.`;
				await openRecord('patchProposals', body.proposalId);
			} else {
				status = 'No draft proposal was returned.';
			}
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			draftingCharacter = false;
		}
	}

	async function reviewPatchProposal(decision: 'approved' | 'rejected') {
		if (!selectedStoryId || !selectedRecord?.id) return;
		reviewingProposal = true;
		status = '';
		try {
			const body = await runEngineCommand(selectedStoryId, 'patchProposal.review', {
				proposalId: String(selectedRecord.id),
				decision,
				reviewer: 'human',
			});
			status = `Proposal ${decision}.`;
			const application = asRecord(body.application);
			const affectedEntityIds = Array.isArray(application?.affectedEntityIds) ? application.affectedEntityIds : [];
			const firstEntityId = affectedEntityIds.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
			if (decision === 'approved' && firstEntityId) await openRecord('characters', firstEntityId);
			else await loadSection();
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			reviewingProposal = false;
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
			selectedRecord = llmSettings.find((setting) => setting.serviceId === selectedRecord?.serviceId) ?? llmSettings[0] ?? null;
			detail = selectedRecord;
			editorText = JSON.stringify(llmSettings, null, 2);
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
			if (isRecordSection && activeSection !== 'apiCallLogs') args.type = recordCommandType();
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

	$effect(() => {
		if (!fixedStoryId || selectedStoryId === fixedStoryId) return;
		selectedStoryId = fixedStoryId;
		void loadSection();
	});
</script>

<div class="flex h-full min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
	<header class="flex flex-col gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-3 sm:flex-row sm:items-center sm:gap-3">
		<div class="flex min-w-0 items-center gap-2">
			<Database class="h-5 w-5 text-[var(--text-accent)]" />
			<div class="min-w-0">
				<div class="font-display text-sm tracking-wide text-[var(--text-accent)]">{title}</div>
				<div class="truncate text-xs text-[var(--text-muted)]">{selectedStory?.title ?? 'No story selected'}</div>
			</div>
		</div>

		{#if !isStoryLocked}
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
			<div class="flex w-full min-w-0 gap-2 sm:w-64">
				<input
					bind:value={newDatabaseTitle}
					onkeydown={(event) => event.key === 'Enter' && createDatabase()}
					disabled={creatingDatabase}
					class="h-9 min-w-0 flex-1 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
					placeholder="New database"
				/>
				<button
					class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--border-primary)] text-[var(--text-muted)] hover:text-[var(--text-accent)] disabled:opacity-40"
					onclick={createDatabase}
					disabled={!newDatabaseTitle.trim() || creatingDatabase}
					title="Create database"
				>
					<Plus class="h-4 w-4" />
				</button>
			</div>
		{/if}

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
										onclick={() => openSearchResult(result)}
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
												<div class="mt-1 text-xs text-[var(--text-muted)]">{recordSubtitle(row)}</div>
											</div>
											<div class="font-mono text-[9px] uppercase tracking-wide text-[var(--text-muted)]">{preview(row.type)}</div>
										</div>
										<div class="mt-2 grid grid-cols-2 gap-2">
											{#each visibleColumns as column}
												<div class="text-[10px]">
													<div class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{column}</div>
													<div class="truncate text-[var(--text-secondary)]">{preview(cellValue(row, column))}</div>
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
										<div class="truncate px-3 py-2 text-[var(--text-secondary)]" title={preview(cellValue(row, column))}>{preview(cellValue(row, column))}</div>
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
										{#if asRecordArray(retrievedMemory?.retrievalTrace).length > 0}
											<div class="space-y-1">
												<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Retrieval Trace</div>
												<div class="max-h-72 space-y-2 overflow-auto rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2">
													{#each asRecordArray(retrievedMemory?.retrievalTrace) as trace}
														{@const entityIds = stringArrayValue(trace.entityIds)}
														{@const factionIds = stringArrayValue(trace.factionIds)}
														{@const threadIds = stringArrayValue(trace.threadIds)}
														{@const signals = stringArrayValue(trace.signals)}
														{@const included = Boolean(trace.included)}
														{@const sourceRefs = [
															...stringArrayValue(trace.sourceEventIds).map((id) => `event:${id}`),
															...stringArrayValue(trace.sourceEntryIds).map((id) => `entry:${id}`),
															...stringArrayValue(trace.sourcePatchIds).map((id) => `patch:${id}`),
														]}
														<div class="rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] p-2 text-[11px]">
															<div class="flex items-start justify-between gap-2">
																<div class="min-w-0">
																	<div class="truncate text-[var(--text-accent)]">#{stringValue(trace.rank)} {stringValue(trace.title)}</div>
																	<div class="truncate text-[var(--text-muted)]">{stringValue(trace.id)}</div>
																</div>
																<div class="shrink-0 text-right">
																	<div class={included ? 'text-emerald-400' : 'text-amber-300'}>{included ? 'included' : 'dropped'} / {stringValue(trace.reason)}</div>
																	<div class="text-[var(--text-muted)]">score {stringValue(trace.score)} / {stringValue(trace.tokenEstimate)} tokens</div>
																</div>
															</div>
															<div class="mt-1 flex flex-wrap gap-1">
																<span class="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[var(--text-muted)]">{stringValue(trace.type)}</span>
																<span class="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[var(--text-muted)]">age {stringValue(trace.ageDays)}d</span>
																<span class="rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[var(--text-muted)]">importance {stringValue(trace.importance)}</span>
																{#each entityIds as id}
																	<span class="rounded border border-cyan-700/50 px-1.5 py-0.5 text-cyan-300">entity:{id}</span>
																{/each}
																{#each factionIds as id}
																	<span class="rounded border border-violet-700/50 px-1.5 py-0.5 text-violet-300">faction:{id}</span>
																{/each}
																{#each threadIds as id}
																	<span class="rounded border border-amber-700/50 px-1.5 py-0.5 text-amber-200">thread:{id}</span>
																{/each}
															</div>
															{#if signals.length > 0}
																<div class="mt-1 flex flex-wrap gap-1">
																	{#each signals as signal}
																		<span class="rounded bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[var(--text-secondary)]">{signal}</span>
																	{/each}
																</div>
															{/if}
															{#if sourceRefs.length > 0}
																<div class="mt-1 truncate text-[var(--text-muted)]">{sourceRefs.join(' ')}</div>
															{/if}
														</div>
													{/each}
												</div>
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

						{#if activeSection === 'llmSettings'}
							<div class="space-y-3">
								<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">LLM Service Settings</div>
								{#if llmSettings.length === 0}
									<div class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 text-xs text-[var(--text-muted)]">No LLM settings</div>
								{:else}
									{#each llmSettings as setting, index (setting.serviceId ?? index)}
										<div class="space-y-3 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
											<div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
												<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
													<span>serviceId</span>
													<input value={stringValue(setting.serviceId)} readonly class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 font-mono text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
												</label>
												<label class="flex h-9 items-center gap-2 rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-3 text-xs text-[var(--text-secondary)]">
													<input type="checkbox" checked={setting.enabled !== false} onchange={(event) => updateLlmSetting(index, 'enabled', (event.currentTarget as HTMLInputElement).checked)} />
													<span>Enabled</span>
												</label>
											</div>

											<div class="grid gap-2 sm:grid-cols-2">
												<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
													<span>providerType</span>
													<input value={stringValue(setting.providerType)} oninput={(event) => updateLlmSetting(index, 'providerType', textValue(event).trim())} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
												</label>
												<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
													<span>model</span>
													<input value={stringValue(setting.model)} oninput={(event) => updateLlmSetting(index, 'model', nullableTextValue(textValue(event)))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
												</label>
												<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
													<span>baseUrl</span>
													<input value={stringValue(setting.baseUrl)} oninput={(event) => updateLlmSetting(index, 'baseUrl', nullableTextValue(textValue(event)))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
												</label>
												<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
													<span>apiKeyRef</span>
													<input value={stringValue(setting.apiKeyRef)} oninput={(event) => updateLlmSetting(index, 'apiKeyRef', nullableTextValue(textValue(event)))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
												</label>
											</div>

											<div class="grid gap-2 sm:grid-cols-4">
												<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
													<span>temperature</span>
													<input type="number" min="0" max="2" step="0.1" value={Number(setting.temperature ?? 1)} oninput={(event) => updateLlmSetting(index, 'temperature', numberInputValue(event, Number(setting.temperature ?? 1), 0, 2))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
												</label>
												<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
													<span>maxTokens</span>
													<input type="number" min="128" max="65536" step="256" value={Number(setting.maxTokens ?? 4096)} oninput={(event) => updateLlmSetting(index, 'maxTokens', numberInputValue(event, Number(setting.maxTokens ?? 4096), 128, 65536, true))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
												</label>
												<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
													<span>topP</span>
													<input type="number" min="0" max="1" step="0.05" value={stringValue(setting.topP)} oninput={(event) => updateLlmSetting(index, 'topP', nullableNumberInputValue(event, 0, 1))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
												</label>
												<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
													<span>contextBudget</span>
													<input type="number" min="1" step="1024" value={stringValue(setting.contextBudget)} oninput={(event) => updateLlmSetting(index, 'contextBudget', nullableNumberInputValue(event, 1, 1_000_000, true))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
												</label>
											</div>

											<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
												<span>reasoningEffort</span>
												<input value={stringValue(setting.reasoningEffort)} oninput={(event) => updateLlmSetting(index, 'reasoningEffort', nullableTextValue(textValue(event)))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
											</label>

											<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
												<span>systemPromptOverride</span>
												<textarea value={stringValue(setting.systemPromptOverride)} oninput={(event) => updateLlmSetting(index, 'systemPromptOverride', nullableTextValue(textValue(event)))} class="h-32 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 font-mono text-[11px] normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
											</label>
										</div>
									{/each}
								{/if}
							</div>
						{/if}

						{#if activeSection === 'npcCandidates'}
							<div class="space-y-3 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
								<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Important NPC Candidates</div>
								{#if selectedRecord}
									<div class="grid gap-2 sm:grid-cols-3">
										<div class="rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-2 py-1.5">
											<div class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Candidate</div>
											<div class="truncate text-xs text-[var(--text-accent)]">{npcCandidateName(selectedRecord)}</div>
										</div>
										<div class="rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-2 py-1.5">
											<div class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Confidence</div>
											<div class="text-xs tabular-nums text-[var(--text-secondary)]">{stringValue(selectedRecord.confidence)}</div>
										</div>
										<div class="rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-2 py-1.5">
											<div class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Source</div>
											<div class="truncate text-xs text-[var(--text-secondary)]">{npcCandidateSource(selectedRecord)}</div>
										</div>
									</div>
									<div class="text-xs leading-relaxed text-[var(--text-secondary)]">{formatProposalDescription(selectedRecord)}</div>
								{:else}
									<div class="text-xs text-[var(--text-muted)]">No pending NPC candidates</div>
								{/if}
							</div>
						{/if}

						{#if isReviewablePatch}
							<div class="space-y-3 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
								<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Review Proposal</div>
								<div class="flex gap-2">
									<button class="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50" onclick={() => reviewPatchProposal('approved')} disabled={reviewingProposal}>
										<Check class="h-4 w-4" />
										Approve
									</button>
									<button class="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/15 disabled:opacity-50" onclick={() => reviewPatchProposal('rejected')} disabled={reviewingProposal}>
										<X class="h-4 w-4" />
										Reject
									</button>
								</div>
							</div>
						{/if}

						{#if editorRecord?.type === 'character' || selectedRecord?.type === 'character'}
							<div class="space-y-3 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
								<div class="flex items-center justify-between gap-3">
									<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Character State</div>
									<button
										class="rounded-md border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-accent)] disabled:opacity-50"
										onclick={draftCharacterUpdate}
										disabled={draftingCharacter}
										title="AI refinement"
									>
										<Sparkles class="h-4 w-4" />
									</button>
								</div>

								<div class="grid gap-2 sm:grid-cols-2">
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Bio</span>
										<textarea value={stringValue(characterState.bio)} oninput={(event) => updateCharacterState('bio', nullableTextValue(textValue(event)))} class="h-24 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
									</label>
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Appearance</span>
										<textarea value={stringValue(characterState.appearance)} oninput={(event) => updateCharacterState('appearance', nullableTextValue(textValue(event)))} class="h-24 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
									</label>
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Personality</span>
										<textarea value={stringValue(characterState.personality)} oninput={(event) => updateCharacterState('personality', nullableTextValue(textValue(event)))} class="h-24 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
									</label>
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Known Facts</span>
										<textarea value={linesValue(characterState.knownFacts)} oninput={(event) => updateCharacterState('knownFacts', lineArray(textValue(event)))} class="h-24 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
									</label>
								</div>

								<div class="grid gap-2 sm:grid-cols-3">
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Rank</span>
										<input value={stringValue(characterState.rank)} oninput={(event) => updateCharacterState('rank', nullableTextValue(textValue(event)))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
									</label>
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Disposition</span>
										<input value={stringValue(characterState.currentDisposition)} oninput={(event) => updateCharacterState('currentDisposition', nullableTextValue(textValue(event)))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
									</label>
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Affinity</span>
										<input type="number" min="-100" max="100" step="1" value={Number(characterRelationship.level ?? 0)} oninput={(event) => updateCharacterRelationship('level', numberInputValue(event, Number(characterRelationship.level ?? 0), -100, 100, true))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
									</label>
								</div>

								<div class="grid gap-2 sm:grid-cols-2">
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Goals</span>
										<textarea value={linesValue(characterState.motivations)} oninput={(event) => updateCharacterState('motivations', lineArray(textValue(event)))} class="h-24 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
									</label>
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Faction Tags</span>
										<textarea value={linesValue(characterState.factionTags)} oninput={(event) => updateCharacterState('factionTags', lineArray(textValue(event)))} class="h-24 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
									</label>
								</div>

								<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
									<span>AI Refinement</span>
									<textarea bind:value={characterDraftInstructions} class="h-16 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
								</label>
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
