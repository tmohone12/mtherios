<script lang="ts">
	import { characterStateView, editCharacterState } from '$lib/utils/characterState';
	import { NPC_AGENCY_FIELDS } from '$lib/contracts/npcAgency';
	import { onMount, onDestroy } from 'svelte';
	import LoreEntryPreview from './LoreEntryPreview.svelte';
	import CharacterContinuityReview from '$lib/components/canon/CharacterContinuityReview.svelte';
	import FactionProfileEditor from '$lib/components/content/FactionProfileEditor.svelte';
	import LocationWorkspace from './LocationWorkspace.svelte';
	import {
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
		BookOpen,
		Users,
		MapPin,
		Package,
		Lightbulb,
		Flag,
		ChevronRight,
		ArrowLeft,
		Pencil,
		Settings2,
	} from 'lucide-svelte';
	import { formatProposalDescription, formatProposalSummary, proposalRecordView } from '$lib/services/canonProposalDisplay';

	type JsonRecord = Record<string, unknown>;
	function stableJson(value: unknown): string {
		if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
		if (value && typeof value === 'object') {
			return `{${Object.entries(value as JsonRecord)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
				.join(',')}}`;
		}
		return JSON.stringify(value) ?? 'undefined';
	}

	// Sending the entire editor snapshot can re-apply stale fields from a detail
	// view when the user only changed one control. The engine already accepts a
	// partial record patch, so submit only the actual top-level changes.
	function changedRecordUpdates(baseline: JsonRecord, next: JsonRecord): JsonRecord {
		const updates: JsonRecord = {};
		for (const key of new Set([...Object.keys(baseline), ...Object.keys(next)])) {
			const before = baseline[key];
			const after = next[key];
			if (stableJson(before) !== stableJson(after)) updates[key] = key in next ? after : null;
		}
		return updates;
	}

	type SectionEntry = {
		id: string;
		label: string;
		isAdvanced?: boolean;
	};
	type StorySummary = {
		id: string;
		title?: string | null;
		shelfId?: string | null;
		serverVersion?: number | null;
		updatedAt?: string | null;
	};

	let { storyId: fixedStoryId = null, title = 'World Database', onDirtyChange } = $props<{
		storyId?: string | null;
		title?: string;
		onDirtyChange?: (dirty: boolean) => void;
	}>();

	const sections: SectionEntry[] = [
		{ id: 'transcript', label: 'Transcript' },
		{ id: 'characters', label: 'Characters' },
		{ id: 'locations', label: 'Locations' },
		{ id: 'items', label: 'Items' },
		{ id: 'concepts', label: 'Concepts' },
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
	let activeSection = $state('characters');
	let query = $state('');
	let records = $state<JsonRecord[]>([]);
	let selectedRecord = $state<JsonRecord | null>(null);
	let detail = $state<JsonRecord | null>(null);
	let editorText = $state('');
	let editorBaseline = $state('');
	let isDetailLoading = $state(false);
	let showMobileDetail = $state(false);
	let editMode = $state(false);
	let locationWorkspaceDirty = $state(false);
	let factionProfileDirty = $state(false);
	let factionProfileBusy = $state(false);
	const hasUnsavedChanges = $derived(editorText !== editorBaseline || locationWorkspaceDirty || factionProfileDirty || factionProfileBusy);
	let recordHistory = $state<Array<{ section: string; id: string; title: string }>>([]);
	let focusedRecord = $state(false);
	$effect(() => onDirtyChange?.(hasUnsavedChanges || saving));
	onDestroy(() => onDirtyChange?.(false));
	function protectDraft(event: BeforeUnloadEvent) {
		if (!hasUnsavedChanges && !saving) return;
		event.preventDefault();
		event.returnValue = '';
	}
	let listRequest = 0;
	let detailRequest = 0;
	let searchRequest = 0;
	let loadedStoryId = '';
	let loadedSection = '';
	let loadedQuery = '';
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
	let identityReviewNotes = $state('');
	$effect(() => { selectedRecord?.id; identityReviewNotes = ''; });
	let newDatabaseTitle = $state('');
	let creatingDatabase = $state(false);
	let characterDraftInstructions = $state('Update this NPC from recent story context.');
	let showGmToolkit = $state(false);
	let gmTool = $state<'actor' | 'scene' | 'relationships' | 'threads'>('actor');
	let gmTarget = $state('');
	let gmActors = $state('');
	let gmAvailableMinutes = $state('');
	let gmToolResult = $state<JsonRecord | null>(null);
	let gmToolBusy = $state(false);
	let newCharacterName = $state('');
	let newCharacterRole = $state('');
	let newCharacterBackstory = $state('');
	let newCharacterPurpose = $state('');
	let newCharacterDesire = $state('');
	let newCharacterFear = $state('');
	let newCharacterFaction = $state('');
	let newCharacterLocation = $state('');
	let creatingCharacterDraft = $state(false);
	let draftingCandidateId = $state('');
	let findingCandidates = $state(false);
	let jobStatusFilter = $state('failed');
	let retryingJobId = $state('');

	const visibleSections = $derived.by(() => {
		return sections.filter((section) => !section.isAdvanced || showDiagnostics);
	});
	const sectionGroups = [
		{ label: 'World', ids: ['characters', 'locations', 'items', 'concepts', 'entities'] },
		{ label: 'Powers & alliances', ids: ['factions', 'factionGoals', 'factionResources', 'factionMemberships', 'agreements'] },
		{ label: 'Chronicle', ids: ['threads', 'events', 'chapters', 'arcs', 'transcript', 'memoryNodes'] },
		{ label: 'Review', ids: ['npcCandidates', 'patchProposals'] },
		{ label: 'Diagnostics', ids: sections.filter((item) => item.isAdvanced).map((item) => item.id) },
	];
	const sectionIcons = { characters: Users, locations: MapPin, items: Package, concepts: Lightbulb, factions: Flag };
	const activeSectionLabel = $derived(sections.find((item) => item.id === activeSection)?.label ?? activeSection);
	let showTable = $state(false);

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
	const characterState = $derived.by(() => characterStateView(editorRecord?.state));
	const characterRelationship = $derived.by(() => asRecord(characterState.relationship) ?? {});
	const conceptState = $derived.by(() => asRecord(editorRecord?.state) ?? {});
	const conceptRelatedIds = $derived.by(() => stringArrayValue(conceptState.relatedEntries));
	const sourceLinks = $derived.by(() => {
		const current = asRecord(detail);
		return [
			...asRecordArray(current?.sourceEntries).map((record) => ({ section: 'transcript', id: stringValue(record.id), label: stringValue(record.content || record.id) })),
			...asRecordArray(current?.sourceEvents).map((record) => ({ section: 'events', id: stringValue(record.id), label: stringValue(record.title || record.id) })),
			...asRecordArray(current?.sourcePatches).map((record) => ({ section: 'patches', id: stringValue(record.id), label: stringValue(record.reason || record.id) })),
		].filter((link) => link.id);
	});
	const isReviewablePatch = $derived(isReviewSection()
		&& Boolean(selectedRecord?.id)
		&& ['pending', 'needs_review'].includes(String((editorRecord?.status ?? selectedRecord?.status) ?? '')));
	const isCharacterCreationProposal = $derived.by(() => {
		const proposal = proposalRecordView(editorRecord ?? selectedRecord ?? {});
		return isReviewSection() && proposal.proposalType === 'character_reference_review';
	});
	const characterCreationPreview = $derived(isCharacterCreationProposal && editorRecord ? proposalOperationValue(editorRecord) : null);
	const isSourceCharacterCandidate = $derived(isCharacterCreationProposal && proposalRecordView(editorRecord ?? selectedRecord ?? {}).proposedBy !== 'gm_character_draft');
	const characterSourceFacts = $derived(asRecordArray(asRecord(asRecord(editorRecord?.metadata)?.sourceDraft)?.evidence));
	const sourceCharacterBefore = $derived(asRecord(asRecord(asRecord(editorRecord?.metadata)?.sourceDraft)?.currentCharacter));
	const sourceDraftReady = $derived(Boolean(asRecord(asRecord(editorRecord?.metadata)?.sourceDraft)?.sourceSnapshot) && characterSourceFacts.some((fact) => {
		const value = fact.field === 'description' ? characterCreationPreview?.description : asRecord(characterCreationPreview?.state)?.[stringValue(fact.field)];
		return typeof value === 'string' ? Boolean(value.trim()) : Array.isArray(value) && value.some((item) => typeof item === 'string' && item.trim());
	}) && (Boolean(sourceCharacterBefore) || Boolean(stringValue(asRecord(characterCreationPreview?.state)?.bio).trim())
		&& stringValue(asRecord(characterCreationPreview?.state)?.bio).trim().toLowerCase() !== stringValue(characterCreationPreview?.name).trim().toLowerCase()));
	const candidateManuallyReady = $derived(asRecord(asRecord(editorRecord?.metadata)?.sourceDraft)?.mode === 'manual_review'
		&& (Boolean(sourceCharacterBefore) || Boolean(stringValue(asRecord(characterCreationPreview?.state)?.bio).trim())
			&& stringValue(asRecord(characterCreationPreview?.state)?.bio).trim().toLowerCase() !== stringValue(characterCreationPreview?.name).trim().toLowerCase()));
	const candidateAlreadyPopulated = $derived(isSourceCharacterCandidate
		&& !['evidence_only', 'manual_review'].includes(stringValue(asRecord(asRecord(editorRecord?.metadata)?.sourceDraft)?.mode))
		&& (stringArrayValue(editorRecord?.sourceEntryIds ?? editorRecord?.source_entry_ids).length > 0 || stringArrayValue(editorRecord?.sourceEventIds ?? editorRecord?.source_event_ids).length > 0)
		&& stringValue(characterCreationPreview?.description).trim().length >= 24
		&& !/\bis important in this chapter checkpoint\.?$/i.test(stringValue(characterCreationPreview?.description).trim()));
	const candidateReady = $derived(sourceDraftReady || candidateManuallyReady || candidateAlreadyPopulated);

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

	function commaArray(value: string): string[] {
		return value.split(',').map((item) => item.trim()).filter(Boolean);
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
		row = proposalRecordView(row);
		const metadata = asRecord(row.metadata);
		const value = proposalOperationValue(row);
		return stringValue(metadata?.sourceName || value?.name || row.targetRecordId);
	}

	function npcCandidateSource(row: JsonRecord): string {
		row = proposalRecordView(row);
		const metadata = asRecord(row.metadata);
		const chapterNumber = metadata?.chapterNumber;
		if (typeof chapterNumber === 'number' || typeof chapterNumber === 'string') return `Chapter ${chapterNumber}`;
		return stringValue(metadata?.sourceType || row.proposedBy);
	}

	function isNpcCandidateProposal(row: JsonRecord): boolean {
		row = proposalRecordView(row);
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
			return proposalRecordView(row)[column];
		}
		return row[column];
	}

	function recordSubtitle(row: JsonRecord): string {
		if (activeSection === 'jobs') return `${stringValue(row.status)} · ${stringValue(row.attemptCount)}/${stringValue(row.maxAttempts)} attempts${row.lastError ? ` · ${stringValue(row.lastError)}` : ''}`;
		if (isNpcCandidateSection()) return formatProposalDescription(row);
		if (isReviewSection()) return formatProposalDescription(row);
		const state = asRecord(row.state);
		return preview(state?.bio || row.description || row.summary || row.content || row.reason || state?.rank || '');
	}

	function recordTitle(row: JsonRecord): string {
		if (activeSection === 'jobs') return stringValue(row.type).replaceAll('_', ' ');
		if (isNpcCandidateSection()) return npcCandidateName(row) || formatProposalSummary(row);
		if (isReviewSection() || row.proposalType) return formatProposalSummary(row);
		for (const key of ['title', 'name', 'goal', 'terms', 'summary', 'content', 'description', 'serviceId', 'type', 'id']) {
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

	function updateCandidateDetail(field: 'bio' | 'rank' | 'appearance' | 'description', value: string) {
		updateEditor((record) => {
			const operations = asRecordArray(record.operations).map((operation) => ({ ...operation }));
			const index = operations.findIndex((operation) => operation.op === 'review' && operation.path === '/entities/character');
			if (index < 0) return;
			const payload = { ...asRecord(operations[index].value) };
			if (field === 'description') payload.description = value;
			else payload.state = { ...asRecord(payload.state), [field]: value };
			operations[index].value = payload;
			record.operations = operations;
			const metadata = { ...asRecord(record.metadata) };
			const sourceDraft = { ...asRecord(metadata.sourceDraft) };
			if (sourceDraft.mode === 'evidence_only') sourceDraft.evidence = asRecordArray(sourceDraft.evidence).filter((fact) => fact.field !== field);
			sourceDraft.mode = 'manual_review';
			metadata.sourceDraft = sourceDraft;
			record.metadata = metadata;
		});
	}

	function setEditor(value: unknown) {
		editorText = value == null ? '' : JSON.stringify(value, null, 2);
		editorBaseline = editorText;
	}

	function resetEditor() {
		if (saving) return;
		editorText = editorBaseline;
		if (activeSection === 'llmSettings') {
			llmSettings = JSON.parse(editorBaseline || '[]') as JsonRecord[];
			records = llmSettings;
			selectedRecord = llmSettings.find((setting) => setting.serviceId === selectedRecord?.serviceId) ?? llmSettings[0] ?? null;
			detail = selectedRecord;
		}
		editMode = false;
	}

	function clearSelection() {
		detailRequest += 1;
		selectedRecord = null;
		detail = null;
		setEditor(null);
		isDetailLoading = false;
		showMobileDetail = false;
		editMode = false;
	}

	function updateCharacterState(key: string, value: unknown) {
		updateEditor((record) => {
			const state = asRecord(record.state) ?? {};
			record.state = editCharacterState(state, key, value);
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

	function updateConceptState(key: string, value: unknown) {
		updateEditor((record) => {
			const state = asRecord(record.state) ?? {};
			record.state = { ...state, type: 'concept', [key]: value };
		});
	}

	function setActiveSection(sectionId: string) {
		if (hasUnsavedChanges || saving) return;
		if (activeSection === sectionId) {
			if (focusedRecord) void browseAllRecords();
			return;
		}
		recordHistory = [];
		activeSection = sectionId;
		query = '';
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

	async function loadSection(cursor: string | null = null): Promise<boolean> {
		const storyId = selectedStoryId;
		const sectionId = activeSection;
		const scopeChanged = storyId !== loadedStoryId || sectionId !== loadedSection;
		if (!cursor && !scopeChanged && hasUnsavedChanges) return false;
		if (storyId !== loadedStoryId) recordHistory = [];
		if (!cursor) focusedRecord = false;
		if (storyId !== loadedStoryId || sectionId === 'jobs') query = '';
		const searchQuery = query;
		const contextChanged = scopeChanged || searchQuery !== loadedQuery;
		const requestedJobStatus = jobStatusFilter;
		if (contextChanged) {
			cursor = null;
			records = [];
			nextCursor = null;
			clearSelection();
		}
		loadedStoryId = storyId;
		loadedSection = sectionId;
		loadedQuery = searchQuery;
		searchResults = [];
		searchRequest += 1;
		const requestId = ++listRequest;
		const isCurrent = () => requestId === listRequest && storyId === selectedStoryId && sectionId === activeSection && searchQuery === query
			&& (sectionId !== 'jobs' || requestedJobStatus === jobStatusFilter);
		if (!storyId && sectionId !== 'llmSettings') {
			loading = false;
			return false;
		}
		loading = true;
		status = '';
		try {
			let body: JsonRecord;
			if (sectionId === 'jobs') body = await runEngineCommand(storyId, 'jobs.status', { limit: 100, ...(requestedJobStatus ? { status: requestedJobStatus } : {}) });
			else if (sectionId === 'llmSettings') body = await runEngineCommand('__app__', 'settings.llm.list');
			else if (sectionId === 'apiCallLogs') body = await runEngineCommand(storyId, 'apiCallLogs.list', { limit: 60 });
			else {
				const args: JsonRecord = { type: recordCommandType(sectionId), q: searchQuery, limit: sectionId === 'npcCandidates' ? 100 : 60 };
				if (cursor) args.cursor = cursor;
				body = await runEngineCommand(storyId, 'world.records', args);
			}
			if (!isCurrent()) return false;
			const rawRecords = body.jobs ?? body.settings ?? body.logs ?? body.records;
			let pageRecords = Array.isArray(rawRecords) ? rawRecords as JsonRecord[] : [];
			if (sectionId === 'npcCandidates') pageRecords = pageRecords.filter(isNpcCandidateProposal);
			records = cursor ? [...records, ...pageRecords] : pageRecords;
			nextCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
			if (sectionId === 'llmSettings') llmSettings = records;
			// Paging must not replace the editor or discard an unfinished edit.
			const currentRecord = records.find((record) => sectionId === 'llmSettings'
				? record.serviceId === selectedRecord?.serviceId
				: record.id === selectedRecord?.id);
			if (currentRecord && (cursor || hasUnsavedChanges)) return true;
			const nextRecord = currentRecord ?? records[0];
			if (nextRecord) await selectRecord(nextRecord, false);
			else clearSelection();
			return isCurrent();
		} catch (error) {
			if (isCurrent()) status = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			if (requestId === listRequest) loading = false;
		}
	}

	async function selectRecord(row: JsonRecord, openDetail = true) {
		if (openDetail && (hasUnsavedChanges || saving)) return;
		const storyId = selectedStoryId;
		const sectionId = activeSection;
		const requestId = ++detailRequest;
		const isCurrent = () => requestId === detailRequest && storyId === selectedStoryId && sectionId === activeSection && selectedRecord?.id === row.id;
		selectedRecord = row;
		detail = null;
		setEditor(null);
		editMode = false;
		if (openDetail) showMobileDetail = true;
		if (sectionId === 'llmSettings' || sectionId === 'jobs' || !row.id) {
			detail = row;
			setEditor(sectionId === 'llmSettings' ? llmSettings : row);
			isDetailLoading = false;
			return;
		}
		isDetailLoading = true;
		try {
			const body = await runEngineCommand(storyId || '__app__', 'world.record.get', {
				type: recordCommandType(sectionId),
				recordId: String(row.id),
			});
			if (!isCurrent()) return;
			detail = body;
			setEditor(body.record ?? row);
		} catch (error) {
			if (isCurrent()) status = error instanceof Error ? error.message : String(error);
		} finally {
			if (isCurrent()) isDetailLoading = false;
		}
	}

	async function openRecord(sectionId: string, recordId: string, fallback: JsonRecord = {}, remember = true): Promise<boolean> {
		if (hasUnsavedChanges || saving) return false;
		const previous = selectedRecord?.id ? { section: activeSection, id: String(selectedRecord.id), title: recordTitle(selectedRecord) } : null;
		const storyId = selectedStoryId;
		const requestId = ++detailRequest;
		listRequest += 1;
		searchRequest += 1;
		loading = false;
		isDetailLoading = true;
		status = '';
		searchResults = [];
		query = '';
		try {
			const body = await runEngineCommand(storyId || '__app__', 'world.record.get', {
				type: recordCommandType(sectionId),
				recordId,
			});
			if (requestId !== detailRequest || storyId !== selectedStoryId) return false;
			const record = asRecord(body.record) ?? { ...fallback, id: recordId };
			if (remember && previous && (previous.section !== sectionId || previous.id !== recordId)) recordHistory = [...recordHistory.slice(-19), previous];
			focusedRecord = true;
			activeSection = sectionId === 'entities' && record.type === 'concept' ? 'concepts' : sectionId;
			loadedStoryId = storyId;
			loadedSection = activeSection;
			loadedQuery = '';
			records = [record];
			selectedRecord = record;
			detail = body;
			setEditor(record);
			editMode = false;
			showMobileDetail = true;
			nextCursor = null;
			return true;
		} catch (error) {
			if (requestId === detailRequest && storyId === selectedStoryId) status = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			if (requestId === detailRequest) isDetailLoading = false;
		}
	}

	async function openEntityReference(recordId: string) {
		try {
			await openRecord('entities', recordId);
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		}
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
		if (!selectedRecord?.id || !isRecordSection || isReadOnlySection || isDetailLoading || saving || editorRecord?.id !== selectedRecord.id) return;
		const storyId = selectedStoryId;
		const sectionId = activeSection;
		const recordId = String(selectedRecord.id);
		const submittedText = editorText;
		saving = true;
		status = '';
		try {
			const parsed = JSON.parse(submittedText) as JsonRecord;
			const baseline = JSON.parse(editorBaseline) as JsonRecord;
			const updates = changedRecordUpdates(baseline, parsed);
			if (Object.keys(updates).length === 0) {
				editorBaseline = submittedText;
				status = 'No record fields changed.';
				return;
			}
			await runEngineCommand(storyId || '__app__', 'world.record.patch', {
				type: recordCommandType(sectionId),
				recordId,
				updates,
				expectedVersion: typeof baseline.server_version === 'number' ? baseline.server_version : undefined,
				expectedUpdatedAt: baseline.updated_at,
				jsonMode: 'replace',
				reason: 'Manual explorer edit.',
			});
			if (storyId !== selectedStoryId || sectionId !== activeSection || selectedRecord?.id !== recordId) return;
			editorBaseline = submittedText;
			if (!hasUnsavedChanges) await loadSection();
			if (storyId === selectedStoryId && sectionId === activeSection) status = 'Changes saved.';
		} catch (error) {
			if (storyId === selectedStoryId && sectionId === activeSection) status = error instanceof Error ? error.message : String(error);
		} finally {
			saving = false;
		}
	}

	async function draftCharacterUpdate() {
		if (!selectedStoryId || !selectedRecord?.id || hasUnsavedChanges || saving || isDetailLoading || draftingCharacter) return;
		const storyId = selectedStoryId;
		const recordId = String(selectedRecord.id);
		draftingCharacter = true;
		status = '';
		try {
			const body = await runEngineCommand(storyId, 'world.character.draftUpdate', {
				recordId,
				instructions: characterDraftInstructions,
				recentLimit: 30,
			});
			if (storyId !== selectedStoryId || selectedRecord?.id !== recordId) return;
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

	async function runGmTool() {
		if (!selectedStoryId || gmToolBusy) return;
		gmToolBusy = true;
		gmToolResult = null;
		status = '';
		try {
			const actorNames = commaArray(gmActors);
			let command = 'world.actor.brief';
			let args: JsonRecord = { name: gmTarget.trim() };
			if (gmTool === 'scene') {
				command = 'world.scene.check';
				args = { locationName: gmTarget.trim(), actorNames };
				const availableMinutes = Number(gmAvailableMinutes);
				if (gmAvailableMinutes.trim() && Number.isFinite(availableMinutes) && availableMinutes >= 0) args.availableMinutes = Math.round(availableMinutes);
			} else if (gmTool === 'relationships') {
				command = 'world.relationship.web';
				args = { actorNames: commaArray(gmTarget || gmActors), depth: 2 };
			} else if (gmTool === 'threads') {
				command = 'plot.thread.board';
				args = { query: gmTarget.trim(), limit: 12 };
			}
			gmToolResult = await runEngineCommand(selectedStoryId, command, args);
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			gmToolBusy = false;
		}
	}

	async function createCharacterDraft() {
		if (!selectedStoryId || creatingCharacterDraft || hasUnsavedChanges || saving) return;
		if (![newCharacterName, newCharacterRole, newCharacterBackstory, newCharacterPurpose].every((value) => value.trim())) {
			status = 'Add a name, role, backstory, and narrative purpose before preparing the character.';
			return;
		}
		const storyId = selectedStoryId;
		creatingCharacterDraft = true;
		const characterName = newCharacterName.trim();
		status = '';
		try {
			const body = await runEngineCommand(storyId, 'world.character.draftCreate', {
				name: characterName,
				role: newCharacterRole.trim(),
				backstory: newCharacterBackstory.trim(),
				narrativePurpose: newCharacterPurpose.trim(),
				desire: newCharacterDesire.trim() || undefined,
				fear: newCharacterFear.trim() || undefined,
				faction: newCharacterFaction.trim() || undefined,
				location: newCharacterLocation.trim() || undefined,
			});
			if (storyId !== selectedStoryId) return;
			if (body.status === 'existing' && typeof body.recordId === 'string') {
				if (!await openRecord('characters', body.recordId)) return;
				showGmToolkit = false;
				status = stringValue(body.reason) || `${characterName} already exists.`;
				return;
			}
			const proposalId = typeof body.proposalId === 'string' ? body.proposalId : '';
			if (!proposalId) throw new Error('The character draft did not return a review proposal.');
			if (!await openRecord('patchProposals', proposalId)) return;
			showGmToolkit = false;
			if (storyId === selectedStoryId) status = `${characterName} is ready to preview. Choose Create character to add them to this story.`;
		} catch (error) {
			if (storyId === selectedStoryId) status = error instanceof Error ? error.message : String(error);
		} finally {
			creatingCharacterDraft = false;
		}
	}

	async function createCharacterDirect() {
		const storyId = selectedStoryId;
		const projectId = selectedStory?.shelfId;
		const name = newCharacterName.trim();
		if (!storyId || !projectId || !name || creatingCharacterDraft) {
			status = 'Select a story and enter a character name.';
			return;
		}
		creatingCharacterDraft = true;
		status = '';
		try {
			const state: JsonRecord = { type: 'character' };
			if (newCharacterBackstory.trim()) state.bio = newCharacterBackstory.trim();
			if (newCharacterRole.trim()) state.rank = newCharacterRole.trim();
			if (newCharacterDesire.trim() || newCharacterFear.trim()) state.motivations = [newCharacterDesire.trim(), newCharacterFear.trim() && `Fear: ${newCharacterFear.trim()}`].filter(Boolean);
			if (newCharacterFaction.trim()) state.factionTags = [newCharacterFaction.trim()];
			if (newCharacterLocation.trim()) state.currentLocation = newCharacterLocation.trim();
			const body = await runEngineCommand(storyId, 'content.canonical.create', {
				projectId, gameId: storyId, kind: 'characters',
				fields: { name, description: [newCharacterRole.trim(), newCharacterBackstory.trim()].filter(Boolean).join('. '), status: 'active', visibility: 'gm', state,
					metadata: newCharacterPurpose.trim() ? { narrativePurpose: newCharacterPurpose.trim() } : {} },
			});
			if (storyId !== selectedStoryId) return;
			const recordId = stringValue(asRecord(body.record)?.id);
			if (!recordId || !await openRecord('characters', recordId)) throw new Error('Character was saved, but its entry could not be opened.');
			showGmToolkit = false;
			status = `${name} is now a character in this story.`;
		} catch (error) {
			if (storyId === selectedStoryId) status = error instanceof Error ? error.message : String(error);
		} finally { creatingCharacterDraft = false; }
	}

	async function findCharacterCandidates() {
		if (!selectedStoryId || activeSection !== 'npcCandidates' || findingCandidates || hasUnsavedChanges || saving || draftingCandidateId || reviewingProposal) return;
		const storyId = selectedStoryId;
		findingCandidates = true;
		status = '';
		try {
			const body = await runEngineCommand(storyId, 'world.character.findCandidates', { chapterLimit: 8 });
			if (storyId !== selectedStoryId || activeSection !== 'npcCandidates') return;
			if (await loadSection()) status = stringValue(body.reason) || `Scanned ${stringValue(body.chaptersScanned)} chapters: ${stringValue(body.created)} new candidates, ${stringValue(body.updated)} refreshed. Review candidates before saving canon.`;
		} catch (error) {
			if (storyId === selectedStoryId && activeSection === 'npcCandidates') status = error instanceof Error ? error.message : String(error);
		} finally { findingCandidates = false; }
	}

	async function goBackToRecord() {
		const previous = recordHistory.at(-1);
		if (!previous || isDetailLoading) return;
		if (await openRecord(previous.section, previous.id, {}, false)) recordHistory = recordHistory.slice(0, -1);
	}

	async function browseAllRecords() {
		if (hasUnsavedChanges || saving) return;
		query = '';
		searchResults = [];
		if (await loadSection()) showMobileDetail = false;
	}

	async function draftCandidateFromSources() {
		if (!selectedStoryId || !selectedRecord?.id || !isSourceCharacterCandidate || !isReviewablePatch || draftingCandidateId || hasUnsavedChanges || saving || isDetailLoading || reviewingProposal) return;
		const storyId = selectedStoryId;
		const sectionId = activeSection;
		const proposalId = String(selectedRecord.id);
		const expectedProposalVersion = editorRecord?.serverVersion ?? editorRecord?.server_version ?? selectedRecord.serverVersion ?? selectedRecord.server_version;
		const isCurrent = () => storyId === selectedStoryId && selectedRecord?.id === proposalId && activeSection === sectionId;
		draftingCandidateId = proposalId;
		status = '';
		try {
			const body = await runEngineCommand(storyId, 'world.character.draftFromSources', {
				proposalId,
				...(typeof expectedProposalVersion === 'number' ? { expectedProposalVersion } : {}),
			});
			if (!isCurrent()) return;
			if (body.status === 'skipped') { status = stringValue(body.reason) || 'No supported character details found.'; return; }
			if (body.status === 'existing' && typeof body.recordId === 'string') {
				if (await openRecord('characters', body.recordId)) status = stringValue(body.reason) || 'This character already exists.';
				return;
			}
			if (body.status !== 'pending' || body.proposalId !== proposalId) throw new Error('The source draft did not return this review candidate.');
			if (await openRecord(sectionId, proposalId) && await loadSection()) status = 'Extracted details are ready for review. Check each source quotation, its context and who it describes before saving the character.';
		} catch (error) {
			if (isCurrent()) status = error instanceof Error ? error.message : String(error);
		} finally {
			if (draftingCandidateId === proposalId) draftingCandidateId = '';
		}
	}

	async function reviewPatchProposal(decision: 'approved' | 'rejected') {
		if (!selectedStoryId || !selectedRecord?.id || hasUnsavedChanges || saving || isDetailLoading || reviewingProposal || draftingCandidateId) return;
		if (decision === 'approved' && isSourceCharacterCandidate && !candidateReady) { status = 'Add a real biography and save the candidate, or build details from story sources first.'; return; }
		const storyId = selectedStoryId;
		const proposalId = String(selectedRecord.id);
		const creatingCharacter = isCharacterCreationProposal;
		const updatingCharacter = Boolean(sourceCharacterBefore);
		const characterName = stringValue(characterCreationPreview?.name) || 'Character';
		const expectedProposalVersion = editorRecord?.serverVersion ?? editorRecord?.server_version ?? selectedRecord.serverVersion ?? selectedRecord.server_version;
		reviewingProposal = true;
		status = '';
		try {
			const body = await runEngineCommand(storyId, 'patchProposal.review', {
				proposalId,
				decision,
				reviewer: 'human',
				notes: identityReviewNotes.trim() || undefined,
				...(typeof expectedProposalVersion === 'number' ? { expectedProposalVersion } : {}),
			});
			if (storyId !== selectedStoryId || selectedRecord?.id !== proposalId) return;
			const application = asRecord(body.application);
			const affectedEntityIds = Array.isArray(application?.affectedEntityIds) ? application.affectedEntityIds : [];
			const firstEntityId = affectedEntityIds.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
			const appliedCount = typeof application?.appliedCount === 'number' ? application.appliedCount : 0;
			if (decision === 'approved' && (body.status === 'rejected' || (creatingCharacter && (body.status !== 'applied' || appliedCount < 1 || !firstEntityId)))) {
				const reason = stringValue(asRecord(application?.metadata)?.rejectionReason || asRecord(asRecord(body.proposal)?.metadata)?.rejectionReason);
				await openRecord('patchProposals', proposalId);
				if (storyId === selectedStoryId) status = reason || (creatingCharacter ? 'Character was not created. The backend did not apply this draft.' : 'The backend rejected this proposal. No changes were applied.');
				return;
			}
			if (decision === 'approved' && firstEntityId) {
				if (!await openRecord('characters', firstEntityId)) return;
				if (!await loadSection()) return;
			} else if (!await loadSection()) return;
			if (storyId === selectedStoryId) status = creatingCharacter
				? decision === 'approved' ? updatingCharacter ? `${characterName} was updated in this story.` : `${characterName} is now a character in this story.` : 'Character draft discarded.'
				: `Proposal ${stringValue(body.status) || decision}.`;
		} catch (error) {
			if (storyId === selectedStoryId && selectedRecord?.id === proposalId) status = error instanceof Error ? error.message : String(error);
		} finally {
			reviewingProposal = false;
		}
	}

	async function retrySelectedJob() {
		if (activeSection !== 'jobs' || !selectedStoryId || !selectedRecord?.id || selectedRecord.retryAllowed !== true || retryingJobId || loading) return;
		const storyId = selectedStoryId;
		const jobId = stringValue(selectedRecord.id);
		const expectedUpdatedAt = stringValue(selectedRecord.updatedAt);
		const isCurrent = () => storyId === selectedStoryId && activeSection === 'jobs' && selectedRecord?.id === jobId;
		retryingJobId = jobId;
		status = '';
		try {
			await runEngineCommand(storyId, 'jobs.retry', { jobId, expectedUpdatedAt });
			if (!isCurrent()) return;
			const refreshed = await loadSection();
			if (refreshed && storyId === selectedStoryId && activeSection === 'jobs') status = 'Retry queued. The worker will resume this job.';
		} catch (error) {
			if (isCurrent()) status = error instanceof Error ? error.message : String(error);
		} finally {
			if (retryingJobId === jobId) retryingJobId = '';
		}
	}

	async function saveLlmSettings() {
		if (saving) return;
		saving = true;
		status = '';
		try {
			const parsed = JSON.parse(editorText);
			if (!Array.isArray(parsed)) throw new Error('LLM settings must be a JSON array. No settings were saved.');
			const settings = parsed;
			const body = await runEngineCommand('__app__', 'settings.llm.save', { settings });
			llmSettings = Array.isArray(body.settings) ? body.settings as JsonRecord[] : [];
			records = llmSettings;
			selectedRecord = llmSettings.find((setting) => setting.serviceId === selectedRecord?.serviceId) ?? llmSettings[0] ?? null;
			detail = selectedRecord;
			setEditor(llmSettings);
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
		if (!selectedStoryId || hasUnsavedChanges || saving) return;
		const storyId = selectedStoryId;
		const sectionId = activeSection;
		const searchQuery = query;
		const requestId = ++searchRequest;
		const isCurrent = () => requestId === searchRequest && storyId === selectedStoryId && sectionId === activeSection && searchQuery === query;
		status = '';
		try {
			const args: JsonRecord = { q: searchQuery, limit: 12 };
			if (isRecordSection && sectionId !== 'apiCallLogs') args.type = recordCommandType(sectionId);
			const body = await runEngineCommand(storyId, 'world.search', args);
			if (isCurrent()) searchResults = Array.isArray(body.results) ? body.results as JsonRecord[] : [];
		} catch (error) {
			if (isCurrent()) status = error instanceof Error ? error.message : String(error);
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
			try {
				await loadStories();
				ensureActiveSectionVisible();
				await loadSection();
			} catch (error) {
				status = error instanceof Error ? error.message : String(error);
			}
		})();

		return () => {
			listRequest += 1;
			detailRequest += 1;
			searchRequest += 1;
			mediaQuery.removeEventListener('change', syncViewport);
		};
	});

	$effect(() => {
		if (!fixedStoryId || selectedStoryId === fixedStoryId) return;
		selectedStoryId = fixedStoryId;
		void loadSection();
	});
</script>

<svelte:window onbeforeunload={protectDraft} />

<style>
	.lore-workspace { display: flex; flex-direction: column; container: lore / inline-size; height: 100%; min-height: 0; min-width: 0; background: var(--bg-primary); color: var(--text-primary); }
	.lore-header { display: flex; flex-shrink: 0; align-items: center; flex-wrap: wrap; gap: 16px; padding: 25px 30px; border-bottom: 1px solid var(--border-primary); background: var(--bg-primary); }
	.lore-brand { display: flex; gap: 12px; align-items: center; min-width: 0; }
	.lore-brand-icon { display: grid; place-items: center; flex-shrink: 0; width: 46px; height: 52px; border: 1px solid color-mix(in srgb, var(--text-accent) 25%, transparent); border-radius: 24px 24px 7px 7px; color: var(--text-accent); background: color-mix(in srgb, var(--text-accent) 5%, transparent); }
	.lore-kicker { display: block; margin-bottom: 5px; color: var(--text-accent); font-size: 9px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; }
	.lore-brand h2 { margin: 0; font-family: var(--font-display); font-size: 27px; line-height: 1.2; font-weight: 400; letter-spacing: -.025em; }
	.lore-brand p { margin: 4px 0 0; font-size: 12px; color: var(--text-muted); }
	.lore-header-actions { display: flex; gap: 8px; margin-left: auto; }
	.lore-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; flex-shrink: 0; min-height: 39px; padding: 9px 12px; border: 1px solid var(--border-primary); border-radius: 7px; color: var(--text-secondary); font-size: 12px; line-height: 1.3; background: var(--bg-secondary); cursor: pointer; transition: background .15s, border-color .15s; }
	.lore-button:hover { color: var(--text-accent); background: color-mix(in srgb, var(--text-accent) 5%, transparent); border-color: color-mix(in srgb, var(--text-accent) 30%, transparent); }
	.lore-button.primary { background: var(--text-accent); border-color: var(--text-accent); color: var(--bg-primary); font-weight: 600; }
	.lore-button.subtle { border-color: transparent; color: var(--text-muted); }
	.lore-workspace :global(button:disabled) { cursor: default; opacity: .4; }
	.lore-workspace :global(button:focus-visible), .lore-workspace :global(summary:focus-visible), .lore-workspace :global(input:focus-visible), .lore-workspace :global(select:focus-visible), .lore-workspace :global(textarea:focus-visible) { outline: 2px solid var(--text-accent); outline-offset: 3px; }
	.story-select { max-width: 220px; min-width: 0; min-height: 39px; border: 1px solid var(--border-primary); border-radius: 7px; background: var(--bg-secondary); padding: 9px 11px; color: var(--text-secondary); font-size: 12px; }
	.new-database { position: relative; font-size: 12px; color: var(--text-secondary); }
	.new-database summary { display: flex; align-items: center; gap: 6px; min-height: 39px; cursor: pointer; list-style: none; }
	.new-database summary::-webkit-details-marker { display: none; }
	.new-database > div { position: absolute; z-index: 20; display: flex; gap: 8px; padding: 14px; margin-top: 12px; background: var(--bg-elevated); border: 1px solid var(--border-primary); border-radius: 10px; box-shadow: 0 18px 45px #0004; }
	.new-database input { min-width: 0; width: 160px; border: 1px solid var(--border-primary); background: var(--bg-primary); border-radius: 5px; padding: 8px; }
	.lore-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }
	.lore-navigation { width: 172px; flex-shrink: 0; overflow-y: auto; padding: 25px 10px; border-right: 1px solid var(--border-primary); background: var(--bg-secondary); }
	.nav-group + .nav-group { margin-top: 24px; }
	.nav-group h3 { margin: 0 10px 9px; color: var(--text-muted); font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: .12em; }
	.nav-group button { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 38px; padding: 9px 10px; text-align: left; color: var(--text-secondary); font-size: 12px; border-radius: 6px; margin: 2px 0; cursor: pointer; }
	.nav-group button :global(svg) { opacity: .6; flex-shrink: 0; }
	.nav-group button:hover { background: var(--bg-tertiary); }
	.nav-group button.active { background: color-mix(in srgb, var(--text-accent) 11%, transparent); color: var(--text-accent); }
	.nav-group button.active :global(svg) { opacity: 1; }
	.lore-content { display: flex; flex: 1; flex-direction: column; overflow: hidden; min-width: 0; }
	.lore-search select { min-width: 0; width: 100%; border: 0; background: var(--bg-primary); color: var(--text-primary); font-size: 12px; padding: 8px; }
	.lore-status { padding: 10px 20px; font-size: 12px; line-height: 1.5; color: var(--text-accent); border-bottom: 1px solid var(--border-primary); background: var(--bg-secondary); }
	.lore-status.unsaved { background: color-mix(in srgb, var(--text-accent) 8%, transparent); }
	.lore-panes { display: grid; grid-template-columns: minmax(260px, 32%) minmax(0, 1fr); flex: 1; min-height: 0; }
	.lore-list-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--border-primary); }
	.lore-list-header { padding: 24px 20px 20px; background: var(--bg-primary); border-bottom: 1px solid var(--border-secondary); }
	.list-heading { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
	.list-heading h3 { font-family: var(--font-display); font-size: 21px; font-weight: 400; letter-spacing: -.02em; margin: 0; }
	.entry-count { font-size: 10px; color: var(--text-muted); border: 1px solid var(--border-primary); border-radius: 5px; padding: 1px 6px; font-variant-numeric: tabular-nums; }
	.lore-icon-button { display: grid; place-items: center; margin-left: auto; width: 30px; height: 30px; border-radius: 6px; color: var(--text-muted); cursor: pointer; }
	.lore-icon-button:hover { color: var(--text-accent); background: var(--bg-tertiary); }
	.lore-search { display: flex; align-items: center; gap: 8px; min-height: 42px; border: 1px solid var(--border-primary); background: var(--bg-secondary); border-radius: 7px; padding: 7px 10px; color: var(--text-muted); }
	.lore-search:focus-within { border-color: var(--text-accent); }
	.lore-search > :global(svg) { flex-shrink: 0; }
	.lore-search input { width: 100%; min-width: 0; height: 24px; background: transparent; color: var(--text-primary); font-size: 12px; outline: none; }
	.lore-search button { flex-shrink: 0; padding: 4px; cursor: pointer; }
	.lore-advanced-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
	.lore-advanced-actions button { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: var(--text-muted); cursor: pointer; }
	.lore-entry-list { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
	.lore-entry { display: flex; flex-direction: column; gap: 7px; width: 100%; min-width: 0; padding: 17px 14px; margin-bottom: 5px; border: 1px solid transparent; border-left: 2px solid transparent; border-radius: 8px; text-align: left; cursor: pointer; transition: background .15s; }
	.lore-entry:hover { background: var(--bg-secondary); }
	.lore-entry.selected { background: color-mix(in srgb, var(--text-accent) 7%, transparent); border-color: color-mix(in srgb, var(--text-accent) 15%, transparent); border-left-color: var(--text-accent); }
	.entry-kind { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .1em; }
	.lore-entry strong { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-family: var(--font-display); font-size: 19px; line-height: 1.3; font-weight: 400; color: var(--text-primary); overflow-wrap: anywhere; }
	.lore-entry.selected strong { color: var(--text-accent); }
	.entry-excerpt { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--text-muted); font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
	.current-location { color: var(--text-accent); font-size: 9px; }
	.load-more { display: flex; justify-content: center; padding: 16px 0; }
	.lore-detail { min-width: 0; min-height: 0; overflow-y: auto; background: var(--bg-secondary); }
	.detail-toolbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 24px; border-bottom: 1px solid var(--border-secondary); background: var(--bg-secondary); }
	.detail-breadcrumb { display: flex; align-items: center; gap: 8px; min-width: 0; margin-right: auto; color: var(--text-muted); font-size: 11px; }
	.detail-breadcrumb span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.detail-breadcrumb :global(svg) { flex-shrink: 0; }
	.detail-content { max-width: 920px; padding: 34px clamp(22px, 3vw, 46px) 64px; margin: 0 auto; }
	.detail-title { margin-bottom: 28px; padding-bottom: 24px; border-bottom: 1px solid var(--border-primary); }
	.detail-title h2 { font-family: var(--font-display); font-size: clamp(25px, 2.5vw, 36px); line-height: 1.25; font-weight: 400; margin: 10px 0 14px; overflow-wrap: anywhere; }
	.entry-meta { display: flex; flex-wrap: wrap; gap: 8px; }
	.entry-meta span { font-size: 10px; color: var(--text-secondary); border: 1px solid var(--border-primary); border-radius: 4px; padding: 3px 8px; text-transform: capitalize; }
	.lore-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; padding: 64px 16px; color: var(--text-muted); }
	.lore-empty :global(svg) { color: var(--text-accent); opacity: .6; }
	.lore-empty h4 { margin: 4px 0 0; color: var(--text-secondary); font-family: var(--font-display); font-size: 20px; font-weight: 400; }
	.lore-empty p { max-width: 260px; font-size: 12px; line-height: 1.7; margin: 0 0 8px; }
	.lore-editor { display: grid; gap: 20px; }
	.lore-editor.entry-basics { margin-bottom: 24px; }
	.new-character-action { width: 100%; margin-top: 12px; color: var(--text-accent); }
	.creation-review { margin-bottom: 28px; padding: 20px; border: 1px solid color-mix(in srgb, var(--text-accent) 25%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--text-accent) 5%, transparent); }
	.creation-review h3 { margin: 0 0 7px; font-family: var(--font-display); font-size: 21px; font-weight: 400; color: var(--text-primary); }
	.creation-review p { margin: 0; font-size: 12px; line-height: 1.7; color: var(--text-secondary); }
	.creation-review-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
	.lore-editor :global(label) { display: flex; flex-direction: column; gap: 7px; min-width: 0; font-size: 11px; line-height: 1.4; letter-spacing: .02em; text-transform: none; color: var(--text-secondary); }
	.lore-editor :global(input:not([type='checkbox'])), .lore-editor :global(textarea), .lore-editor :global(select) { width: 100%; min-width: 0; font-size: 13px; line-height: 1.7; color: var(--text-primary); background: var(--bg-primary); border: 1px solid var(--border-primary); border-radius: 6px; padding: 10px 12px; }
	.lore-editor :global(textarea) { resize: vertical; min-height: 96px; }
	.lore-editor :global(.grid) { gap: 16px; }
	.raw-record { margin-top: 28px; border: 1px solid var(--border-primary); border-radius: 8px; padding: 12px 14px; }
	.raw-record summary { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 12px; cursor: pointer; }
	.raw-record summary span { margin-left: auto; font-family: var(--font-mono); font-size: 10px; }
	.raw-record textarea { margin-top: 14px; font-size: 11px; }
	.raw-hint { font-size: 11px; color: var(--text-muted); margin: 12px 0 0; }
	.entry-sources { border-top: 1px solid var(--border-secondary); margin-top: 20px; padding-top: 18px; }
	.entry-sources summary { cursor: pointer; font-size: 12px; color: var(--text-muted); }
	.entry-sources summary span { margin-left: 8px; color: var(--text-accent); font-size: 10px; }
	.source-list { display: grid; gap: 8px; margin-top: 12px; }
	.source-list button { display: flex; align-items: center; gap: 10px; border: 1px solid var(--border-primary); border-radius: 7px; padding: 12px; color: var(--text-secondary); font-size: 12px; line-height: 1.6; text-align: left; cursor: pointer; }
	.source-list button span { color: var(--text-accent); font-size: 10px; }
	.source-list button :global(svg) { flex-shrink: 0; margin-left: auto; }
	.lore-table { min-width: 760px; }
	.table-head, .table-row { display: grid; width: 100%; text-align: left; border-bottom: 1px solid var(--border-secondary); }
	.table-head { color: var(--text-muted); font-size: 10px; text-transform: uppercase; }
	.table-row { color: var(--text-secondary); font-size: 12px; cursor: pointer; }
	.table-head span, .table-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 10px; }
	.search-results { border-bottom: 1px solid var(--border-primary); margin-bottom: 12px; }
	.search-results h4 { color: var(--text-muted); font-size: 10px; text-transform: uppercase; padding: 10px; }
	.back-to-entries { display: none; }
	@container lore (max-width: 840px) {
		.lore-panes { grid-template-columns: minmax(0, 1fr); }
		.lore-detail { display: none; }
		.detail-open .lore-detail { display: block; }
		.detail-open .lore-list-pane { display: none; }
		.lore-list-pane { border-right: 0; }
		.back-to-entries { display: inline-flex; }
		.detail-breadcrumb { visibility: hidden; font-size: 0; }
		.detail-breadcrumb :global(svg) { display: none; }
		.detail-toolbar { padding: 12px 16px; }
	}
	@container lore (max-width: 640px) {
		.lore-header { padding: 19px 20px; gap: 13px; }
		.lore-brand-icon { display: none; }
		.lore-brand h2 { font-size: 25px; }
		.lore-header-actions { gap: 2px; }
		.lore-header-actions .lore-button { padding: 8px; font-size: 11px; }
		.lore-header-actions .subtle span { display: none; }
		.lore-body { flex-direction: column; }
		.lore-navigation { display: flex; width: 100%; padding: 8px 10px; gap: 8px; overflow-x: auto; overflow-y: hidden; border-right: 0; border-bottom: 1px solid var(--border-primary); }
		.nav-group { display: flex; gap: 3px; flex-shrink: 0; }
		.nav-group + .nav-group { margin: 0; border-left: 1px solid var(--border-primary); padding-left: 8px; }
		.nav-group h3 { display: none; }
		.nav-group button { white-space: nowrap; gap: 6px; margin: 0; width: auto; min-height: 36px; }
		.detail-content { padding: 24px 20px 40px; }
		.lore-list-header { padding: 14px 16px; }
		.lore-entry-list { padding: 8px 12px; }
		.lore-entry { padding: 16px; }
		.lore-entry strong { font-size: 20px; }
		.lore-entry .entry-excerpt { font-size: 13px; }
		.story-select { max-width: 160px; }
		.new-database > div { left: auto; right: 0; }
	}
	@container lore (max-width: 420px) {
		.lore-brand { width: 100%; }
		.lore-header-actions { margin-left: 0; }
		.detail-toolbar { flex-wrap: wrap; gap: 7px; }
		.detail-breadcrumb { display: none; }
		.detail-toolbar .back-to-entries { margin-right: auto; }
		.new-database > div { position: fixed; left: 20px; right: 20px; }
		.new-database input { width: 100%; }
	}
	@media (prefers-reduced-motion: reduce) { .lore-button, .lore-entry { transition: none; } }
</style>

<div class="lore-workspace">
	<header class="lore-header">
		<div class="lore-brand">
			<div class="lore-brand-icon"><BookOpen size={22} strokeWidth={1.5} /></div>
			<div><span class="lore-kicker">The world behind the story</span><h2>{title}</h2><p>{selectedStory?.title ?? 'Your world, collected'}</p></div>
		</div>
		{#if !isStoryLocked}
			<select class="story-select" aria-label="Choose story" bind:value={selectedStoryId} disabled={hasUnsavedChanges || saving} onchange={() => { ensureActiveSectionVisible(); loadSection(); }}>
				{#each stories as item}<option value={item.id}>{item.title ?? item.id}</option>{/each}
			</select>
			<details class="new-database"><summary><Plus size={14} /> New database</summary><div>
				<input bind:value={newDatabaseTitle} aria-label="New database name" onkeydown={(event) => event.key === 'Enter' && createDatabase()} disabled={creatingDatabase} placeholder="Database name" />
				<button class="lore-button" onclick={createDatabase} disabled={!newDatabaseTitle.trim() || creatingDatabase || hasUnsavedChanges}>Create</button>
			</div></details>
		{/if}
		<div class="lore-header-actions">
			<button class="lore-button" onclick={() => { showGmToolkit = true; gmToolResult = null; }} disabled={!selectedStoryId || hasUnsavedChanges || saving}><Sparkles size={15} /> GM Toolkit</button>
			<button class="lore-button subtle" aria-label="Toggle advanced lore categories" aria-pressed={showDiagnostics} onclick={() => { showDiagnostics = !showDiagnostics; if (!visibleSections.some((item) => item.id === activeSection)) { ensureActiveSectionVisible(); loadSection(); } }} disabled={hasUnsavedChanges || saving}><Settings2 size={15} /><span>Advanced</span></button>
		</div>
	</header>
	<div class="lore-body">
		<nav class="lore-navigation" aria-label="Lore categories">
			{#each sectionGroups as group}
				{@const items = group.ids.map((id) => visibleSections.find((item) => item.id === id)).filter((item): item is SectionEntry => Boolean(item))}
				{#if items.length}
					<div class="nav-group"><h3>{group.label}</h3>
						{#each items as item}
							{@const Icon = sectionIcons[item.id as keyof typeof sectionIcons] ?? BookOpen}
							<button class:active={activeSection === item.id} aria-current={activeSection === item.id ? 'page' : undefined} onclick={() => setActiveSection(item.id)} disabled={hasUnsavedChanges || saving}><Icon size={15} strokeWidth={1.6} /><span>{item.label}</span></button>
						{/each}
					</div>
				{/if}
			{/each}
		</nav>
		<section class="lore-content" aria-label={activeSectionLabel}>
			{#if status}<div class="lore-status" role="status">{status}</div>{/if}
			{#if hasUnsavedChanges}<div class="lore-status unsaved" role="status">Unsaved changes. Save or discard before opening another entry.</div>{/if}
			<div class="lore-panes" class:detail-open={showMobileDetail}>
				<div class="lore-list-pane">
					<div class="lore-list-header">
						<div class="list-heading"><h3>{activeSectionLabel}</h3><span class="entry-count">{records.length}{nextCursor ? '+' : ''}</span>
							<button class="lore-icon-button" onclick={() => loadSection()} disabled={loading || hasUnsavedChanges || saving} title="Refresh entries" aria-label="Refresh entries"><RefreshCw size={15} class={loading ? 'animate-spin' : ''} /></button>
						</div>
						{#if activeSection === 'jobs'}
							<label class="lore-search"><span>Show</span><select aria-label="Job status" bind:value={jobStatusFilter} onchange={() => loadSection()}><option value="failed">Failed jobs</option><option value="">All jobs</option><option value="retry">Waiting to retry</option><option value="running">Running jobs</option></select></label>
						{:else}
						<form class="lore-search" onsubmit={(event) => { event.preventDefault(); loadSection(); }}>
							<Search size={16} />
							<input bind:value={query} aria-label={`Search ${activeSectionLabel.toLowerCase()}`} placeholder={`Search ${activeSectionLabel.toLowerCase()}…`} disabled={hasUnsavedChanges || saving} />
							{#if query}<button type="button" aria-label="Clear search" disabled={hasUnsavedChanges || saving} onclick={() => { query = ''; searchResults = []; loadSection(); }}><X size={14} /></button>{/if}
							<button type="submit" aria-label="Search entries" disabled={loading || hasUnsavedChanges || saving}><ChevronRight size={16} /></button>
						</form>
						{/if}
						{#if activeSection === 'characters'}
							<button class="lore-button new-character-action" onclick={() => { status = ''; showGmToolkit = true; gmToolResult = null; }} disabled={!selectedStoryId || hasUnsavedChanges || saving}><Plus size={15} /> New character</button>
						{/if}
						{#if activeSection === 'npcCandidates'}<button class="lore-button new-character-action" onclick={findCharacterCandidates} disabled={!selectedStoryId || findingCandidates || Boolean(draftingCandidateId) || reviewingProposal || hasUnsavedChanges || saving}><Search size={15} />{findingCandidates ? 'Reading chapters…' : 'Find from chapters'}</button>{/if}
						{#if showDiagnostics && activeSection !== 'jobs'}
							<div class="lore-advanced-actions">
								<button onclick={() => { showTable = !showTable; }} aria-pressed={showTable}><Rows3 size={13} /> {showTable ? 'Cards' : 'Table'}</button>
								<button onclick={searchStory} disabled={!query.trim() || hasUnsavedChanges || saving}><Search size={13} /> Hybrid search</button>
								<button onclick={() => reindexStory(false)} title="Queue reindex"><History size={13} /> Reindex</button>
								<button onclick={() => reindexStory(true)} title="Run reindex now"><Play size={13} /> Run now</button>
							</div>
						{/if}
					</div>
					<div class="lore-entry-list" aria-busy={loading}>
						{#if searchResults.length > 0}
							<div class="search-results"><h4>Search results</h4>{#each searchResults as result}<button class="lore-entry" disabled={hasUnsavedChanges || saving} onclick={() => openSearchResult(result)}><strong>{result.title ?? result.recordId}</strong><span>{result.source}</span></button>{/each}</div>
						{/if}
						{#if loading && records.length === 0}
							<div class="lore-empty"><RefreshCw size={22} class="animate-spin" /><h4>Opening the archive</h4><p>Loading {activeSectionLabel.toLowerCase()}…</p></div>
						{:else if records.length === 0}
							<div class="lore-empty"><BookOpen size={28} strokeWidth={1.3} /><h4>{query ? 'No matching entries' : 'Nothing here yet'}</h4><p>{query ? 'Try another name or clear your search.' : `Your story’s ${activeSectionLabel.toLowerCase()} will appear here.`}</p>{#if query}<button class="lore-button" onclick={() => { query = ''; loadSection(); }}>Clear search</button>{/if}</div>
						{:else if showTable && showDiagnostics}
							<div class="lore-table">
								<div class="table-head" style={`grid-template-columns: repeat(${Math.max(visibleColumns.length, 1)}, minmax(120px, 1fr));`}>{#each visibleColumns as column}<span>{column}</span>{/each}</div>
								{#each records as row}<button class="table-row" disabled={hasUnsavedChanges || saving} style={`grid-template-columns: repeat(${Math.max(visibleColumns.length, 1)}, minmax(120px, 1fr));`} onclick={() => selectRecord(row)}>{#each visibleColumns as column}<span title={preview(cellValue(row, column))}>{preview(cellValue(row, column))}</span>{/each}</button>{/each}
							</div>
						{:else}
							{#each records as row}
								<button class="lore-entry" class:selected={selectedRecord === row || Boolean(row.id && selectedRecord?.id === row.id)} aria-pressed={selectedRecord === row || Boolean(row.id && selectedRecord?.id === row.id)} disabled={hasUnsavedChanges || saving} onclick={() => selectRecord(row)}>
									<span class="entry-kind">{stringValue(row.type || row.status || activeSectionLabel).replaceAll('_', ' ')}{#if asRecord(row.state)?.current === true}<span class="current-location">Current</span>{/if}</span>
									<strong>{recordTitle(row)}</strong>
									{#if recordSubtitle(row)}<span class="entry-excerpt">{recordSubtitle(row)}</span>{/if}
								</button>
							{/each}
						{/if}
						{#if nextCursor}<div class="load-more"><button class="lore-button" onclick={() => loadSection(nextCursor)} disabled={loading || saving}>{loading ? 'Loading…' : 'Load more entries'}</button></div>{/if}
					</div>
				</div>
				<aside class="lore-detail" aria-label="Entry details" aria-busy={isDetailLoading}>
					<div class="detail-toolbar">
						{#if recordHistory.length > 0}<button class="lore-button" onclick={goBackToRecord} disabled={hasUnsavedChanges || saving || isDetailLoading} title={`Back to ${recordHistory.at(-1)?.title}`} aria-label={`Back to ${recordHistory.at(-1)?.title}`}><ArrowLeft size={15} /> Back</button>{/if}
						{#if focusedRecord}<button class="lore-button" onclick={browseAllRecords} disabled={hasUnsavedChanges || saving || isDetailLoading}>All entries</button>{/if}
						<button class="lore-button back-to-entries" disabled={hasUnsavedChanges || saving} onclick={() => { showMobileDetail = false; }}><ArrowLeft size={15} /> Entries</button>
						<div class="detail-breadcrumb">{activeSectionLabel}<ChevronRight size={12} /><span>{selectedRecord ? recordTitle(selectedRecord) : 'Select an entry'}</span></div>
						{#if activeSection === 'llmSettings'}
							{#if hasUnsavedChanges}<button class="lore-button subtle" onclick={resetEditor} disabled={saving}>Discard</button>{/if}
							<button class="lore-button primary" onclick={saveLlmSettings} disabled={saving || isDetailLoading}><ServerCog size={14} />{saving ? 'Saving…' : 'Save settings'}</button>
						{:else if isRecordSection && selectedRecord && !isReadOnlySection}
							{#if editMode}
								<button class="lore-button subtle" onclick={() => { resetEditor(); editMode = false; }} disabled={saving}>Discard</button>
								<button class="lore-button primary" onclick={saveRecord} disabled={saving || isDetailLoading || !hasUnsavedChanges || !editorRecord}><Save size={14} />{saving ? 'Saving…' : 'Save changes'}</button>
							{:else}
								<button class="lore-button" onclick={() => { editMode = true; }} disabled={isDetailLoading || !editorRecord || hasUnsavedChanges}><Pencil size={14} /> Edit entry</button>
							{/if}
						{/if}
					</div>
					<div class="detail-content">
						{#if isDetailLoading}
							<div class="lore-empty"><RefreshCw size={22} class="animate-spin" /><h4>Loading entry…</h4></div>
						{:else if !selectedRecord}
							<div class="lore-empty"><BookOpen size={36} strokeWidth={1} /><h4>Your world, one entry at a time</h4><p>Choose an entry to explore its story and details.</p></div>
						{:else}
							<div class="detail-title"><div class="entry-kind">{stringValue(selectedRecord.type || activeSectionLabel).replaceAll('_', ' ')}</div><h2>{recordTitle(selectedRecord)}</h2><div class="entry-meta">{#if selectedRecord.status}<span>{stringValue(selectedRecord.status).replaceAll('_', ' ')}</span>{/if}{#if selectedRecord.visibility}<span>{stringValue(selectedRecord.visibility).replaceAll('_', ' ')}</span>{/if}</div></div>
							{#if isReviewablePatch}
								<section class="creation-review" aria-label="Review Proposal">
									<div><h3>{isCharacterCreationProposal ? sourceCharacterBefore ? 'Review this character update' : 'Ready to create this character?' : 'Review Proposal'}</h3><p>{isSourceCharacterCandidate ? 'Add and save character details yourself, or build details from story evidence. Review the result before saving canon.' : isCharacterCreationProposal ? 'Review the biography and traits below. Create character saves this draft to your story’s characters.' : 'Review the proposed changes before applying them to this story.'}</p></div>
									<div class="creation-review-actions">
										<CharacterContinuityReview metadata={asRecord(selectedRecord.metadata)} bind:notes={identityReviewNotes} />
										{#if isSourceCharacterCandidate && !editMode}<button class="lore-button" onclick={() => { editMode = true; }} disabled={Boolean(draftingCandidateId) || reviewingProposal || saving}><Pencil size={15} /> Edit details</button>{/if}
										{#if isSourceCharacterCandidate}<button class="lore-button" onclick={draftCandidateFromSources} disabled={Boolean(draftingCandidateId) || reviewingProposal || hasUnsavedChanges || saving || isDetailLoading}><Sparkles size={15} />{draftingCandidateId ? 'Reading sources…' : 'Build from story'}</button>{/if}
										<button class="lore-button primary" onclick={() => reviewPatchProposal('approved')} disabled={(isSourceCharacterCandidate && !candidateReady) || Boolean(draftingCandidateId) || reviewingProposal || hasUnsavedChanges || saving || isDetailLoading}><Check size={15} />{reviewingProposal ? 'Applying…' : sourceCharacterBefore ? 'Update character' : isCharacterCreationProposal ? 'Create character' : 'Approve'}</button>
										<button class="lore-button subtle" onclick={() => reviewPatchProposal('rejected')} disabled={Boolean(draftingCandidateId) || reviewingProposal || hasUnsavedChanges || saving || isDetailLoading}><X size={15} />{isCharacterCreationProposal ? 'Discard draft' : 'Reject'}</button>
									</div>
								</section>
							{/if}
							{#if isSourceCharacterCandidate && editMode && characterCreationPreview}
								<section class="lore-editor entry-basics" aria-label="Character candidate details">
									<label><span>Biography *</span><textarea rows="5" value={stringValue(asRecord(characterCreationPreview.state)?.bio)} oninput={(event) => updateCandidateDetail('bio', textValue(event))}></textarea></label>
									<label><span>Role</span><input value={stringValue(asRecord(characterCreationPreview.state)?.rank)} oninput={(event) => updateCandidateDetail('rank', textValue(event))} /></label>
									<label><span>Appearance</span><textarea rows="3" value={stringValue(asRecord(characterCreationPreview.state)?.appearance)} oninput={(event) => updateCandidateDetail('appearance', textValue(event))}></textarea></label>
									<label><span>Description</span><textarea rows="3" value={stringValue(characterCreationPreview.description)} oninput={(event) => updateCandidateDetail('description', textValue(event))}></textarea></label>
									<p>Save changes, then choose Create character. These details are authored by you; Build from story is optional.</p>
								</section>
							{/if}
							{#if characterSourceFacts.length > 0}
								<details class="source-disclosure"><summary>Source quotations · {characterSourceFacts.length} extracted details</summary><div class="source-list">
									{#each characterSourceFacts as fact}<div><strong>{stringValue(fact.field)}</strong><p>{stringValue(fact.value)}</p><blockquote>{stringValue(fact.quote)}</blockquote><button class="lore-button subtle" onclick={() => openRecord(stringArrayValue(editorRecord?.sourceEventIds ?? editorRecord?.source_event_ids).includes(stringValue(fact.sourceId)) ? 'events' : 'transcript', stringValue(fact.sourceId))}>Open source</button></div>{/each}
								</div></details>
							{/if}
							{#if sourceCharacterBefore}<details class="source-disclosure"><summary>Current character · compare before applying</summary><LoreEntryPreview record={sourceCharacterBefore} /></details>{/if}
							{#if activeSection === 'jobs'}
								<section class="creation-review" aria-label="Job recovery">
									<div><h3>{stringValue(selectedRecord.type).replaceAll('_', ' ')}</h3><p>{stringValue(selectedRecord.attemptCount)} of {stringValue(selectedRecord.maxAttempts)} attempts used · {stringValue(selectedRecord.status)}</p>
										{#if selectedRecord.lastError}<p role="alert">{stringValue(selectedRecord.lastError)}</p>{/if}
										{#if asRecord(selectedRecord.metadata)?.lastFailure}<p>Failure: {stringValue(asRecord(asRecord(selectedRecord.metadata)?.lastFailure)?.kind).replaceAll('_', ' ')}</p>{/if}
										{#if selectedRecord.retryAllowed === true}<p>Retry keeps completed progress and queues up to {stringValue(selectedRecord.maxAttempts)} new attempts.</p>{:else if selectedRecord.status === 'failed'}<p>{stringValue(selectedRecord.retryReason)}</p>{/if}
									</div>
									{#if selectedRecord.retryAllowed === true}<button class="lore-button primary" onclick={retrySelectedJob} disabled={Boolean(retryingJobId) || loading}><RefreshCw size={15} />{retryingJobId ? 'Queuing…' : 'Retry job'}</button>{/if}
								</section>
							{/if}
							{#if editorRecord && !editMode && !['llmSettings', 'apiCallLogs', 'jobs'].includes(activeSection)}<LoreEntryPreview record={characterCreationPreview ?? editorRecord} />{/if}
							{#if activeSection === 'factions' && selectedStoryId && selectedRecord?.id && !editMode}
								{#key `${selectedStoryId}:${selectedRecord.id}`}
									<FactionProfileEditor gameId={selectedStoryId} factionId={String(selectedRecord.id)} onDirtyChange={value => factionProfileDirty = value} onBusyChange={value => factionProfileBusy = value} onSaved={() => selectRecord(selectedRecord!, false)} />
								{/key}
							{/if}
							{#if editorRecord?.type === 'location' && !editMode && selectedStoryId}
								{#key `${selectedStoryId}:${editorRecord.id}`}
									<LocationWorkspace locationId={String(editorRecord.id)} gameId={selectedStoryId} runCommand={(command, args) => runEngineCommand(selectedStoryId, command, args)} navigate={(id) => { void openRecord('locations', id); }} openSource={(type, id) => { void openRecord(type, id); }} onDirty={(dirty) => { locationWorkspaceDirty = dirty; }} />
								{/key}
							{/if}
							{#if editMode && editorRecord && ['character', 'location', 'item', 'concept', 'faction'].includes(stringValue(editorRecord.type))}
								<div class="lore-editor entry-basics">
									<label><span>Name</span><input value={stringValue(editorRecord.name)} oninput={(event) => updateEditor((record) => { record.name = textValue(event); })} /></label>
									{#if editorRecord.type !== 'character'}<label><span>Description</span><textarea rows="6" value={stringValue(editorRecord.description)} oninput={(event) => updateEditor((record) => { record.description = nullableTextValue(textValue(event)); })}></textarea></label>{/if}
								</div>
							{/if}
							<div class="lore-editor">
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
									<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">System Prompt Preview</div>
										<pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{stringValue(apiDebugSnapshot.system)}</pre>
									</div>
								{/if}

								{#if apiDebugSnapshot.prompt}
									<div class="space-y-1">
									<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Dynamic Context Preview</div>
										<pre class="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{stringValue(apiDebugSnapshot.prompt)}</pre>
									</div>
								{/if}

								{#if asRecordArray(apiDebugSnapshot.messages).length > 0}
									<div class="space-y-1">
									<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Prior Messages Preview</div>
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

							<div class="grid gap-2 sm:grid-cols-5">
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
								<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]" title="Use this only when the model registry does not describe the provider's real context window.">
									<span>contextWindowTokens</span>
									<input type="number" min="1024" step="1024" value={stringValue(setting.contextWindowTokens)} oninput={(event) => updateLlmSetting(index, 'contextWindowTokens', nullableNumberInputValue(event, 1024, 10_000_000, true))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]" />
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

{#if editMode && editorRecord?.type === 'character'}
							<div class="space-y-3 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
								<div class="flex items-center justify-between gap-3">
									<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Character State</div>
									<button
										class="rounded-md border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-accent)] disabled:opacity-50"
										onclick={draftCharacterUpdate}
										disabled={draftingCharacter || hasUnsavedChanges || saving}
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
										<span>Appearance (stable features)</span>
										<textarea value={stringValue(characterState.appearance)} oninput={(event) => updateCharacterState('appearance', nullableTextValue(textValue(event)))} class="h-24 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
									</label>
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Personality</span>
										<textarea value={stringValue(characterState.personality)} oninput={(event) => updateCharacterState('personality', nullableTextValue(textValue(event)))} class="h-24 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
									</label>
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Current presentation (clothing / injuries)</span>
										<textarea value={stringValue(characterState.presentation)} oninput={(event) => updateCharacterState('presentation', nullableTextValue(textValue(event)))} class="h-24 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
									</label>
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Voice / speech style</span>
										<textarea value={stringValue(characterState.speechStyle)} oninput={(event) => updateCharacterState('speechStyle', nullableTextValue(textValue(event)))} class="h-24 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
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

								<div class="space-y-2">
									<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Intent and initiative</div>
									<p class="text-xs text-[var(--text-muted)]">Private NPC context. Keep plans separate from completed moves; leave unknown details blank.</p>
									<div class="grid gap-2 sm:grid-cols-2">
										{#each NPC_AGENCY_FIELDS as field}
											<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
												<span>{field.label}</span>
												<textarea maxlength="600" value={stringValue(characterState[field.key])} oninput={(event) => updateCharacterState(field.key, nullableTextValue(textValue(event)))} class="h-20 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
											</label>
										{/each}
									</div>
								</div>

								<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
									<span>AI Refinement</span>
									<textarea bind:value={characterDraftInstructions} class="h-16 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
								</label>
							</div>
						{/if}

						{#if editMode && editorRecord?.type === 'concept'}
							<div class="space-y-3 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
								<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Concept State</div>
								<div class="grid gap-2 sm:grid-cols-2">
									<label class="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
										<input type="checkbox" checked={conceptState.revealed === true} onchange={(event) => updateConceptState('revealed', (event.currentTarget as HTMLInputElement).checked)} />
										Revealed to player
									</label>
									<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
										<span>Comprehension</span>
										<select value={stringValue(conceptState.comprehensionLevel || 'unknown')} onchange={(event) => updateConceptState('comprehensionLevel', textValue(event))} class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]">
											<option value="unknown">Unknown</option>
											<option value="basic">Basic</option>
											<option value="intermediate">Intermediate</option>
											<option value="advanced">Advanced</option>
										</select>
									</label>
								</div>
								<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
									<span>Related Entry IDs — one per line</span>
									<textarea value={linesValue(conceptState.relatedEntries)} oninput={(event) => updateConceptState('relatedEntries', lineArray(textValue(event)))} class="h-20 w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-xs normal-case tracking-normal text-[var(--text-secondary)]"></textarea>
								</label>
								{#if conceptRelatedIds.length > 0}
									<div class="flex flex-wrap gap-1.5">
										{#each conceptRelatedIds as entryId}
											<button class="rounded-full border border-[var(--color-gold-600)]/50 bg-[var(--text-accent)]/8 px-2 py-1 text-[11px] text-[var(--text-accent)] hover:bg-[var(--text-accent)]/16" onclick={() => openEntityReference(entryId)} title="Open linked lore entry">↗ {entryId}</button>
										{/each}
									</div>
								{/if}
							</div>
						{/if}

						<details class="raw-record" open={isReviewSection()}>
							<summary><Braces size={15} />{isReviewSection() ? 'Proposed changes & record' : 'Raw record'}<span>JSON</span></summary>
							{#if editMode}<p class="raw-hint">Advanced editing. Changes here are saved with this entry.</p>{/if}
						<textarea
							aria-label="Raw record JSON"
							bind:value={editorText}
							spellcheck="false"
							readonly={isReadOnlySection || (!editMode && activeSection !== 'llmSettings')}
							class="h-[34vh] w-full resize-y rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 font-mono text-xs leading-relaxed text-[var(--text-secondary)] outline-none focus:border-[var(--color-gold-600)] sm:h-[44vh]"
						></textarea>
						</details>
						</div>

						{#if sourceLinks.length > 0}
							<details class="entry-sources">
								<summary>Sources <span>{sourceLinks.length}</span></summary>
								<div class="source-list">
									{#each sourceLinks as link}
										<button disabled={hasUnsavedChanges || saving} onclick={() => openRecord(link.section, link.id).catch((error) => { status = error instanceof Error ? error.message : String(error); })} title="Open source record"><span>{link.section}</span>{preview(link.label)}<ChevronRight size={14} /></button>
									{/each}
								</div>
							</details>
						{/if}
						{/if}
					</div>
				</aside>
			</div>
		</section>
	</div>
</div>

{#if showGmToolkit}
	<div class="fixed inset-0 z-[80] flex items-end justify-center p-0 sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-label="GM Toolkit">
		<button class="absolute inset-0 bg-black/70 backdrop-blur-sm" onclick={() => { showGmToolkit = false; }} aria-label="Close GM Toolkit"></button>
		<div class="relative z-10 flex max-h-[92dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-2xl sm:rounded-2xl">
			<div class="flex items-start justify-between gap-3 border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3">
				<div>
					<div class="font-display text-sm tracking-wide text-[var(--text-accent)]">GM Toolkit</div>
					<div class="mt-0.5 text-xs text-[var(--text-muted)]">The AI GM registers named characters and supported factions after each turn. Inspect canon or prepare an extra character here.</div>
				</div>
				<button class="rounded-md border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]" onclick={() => { showGmToolkit = false; }} aria-label="Close GM Toolkit">
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-2">
				<section class="min-w-0 space-y-3 border-b border-[var(--border-primary)] p-4 lg:border-b-0 lg:border-r">
					<div>
						<div class="text-xs uppercase tracking-[0.14em] text-[var(--text-accent)]">Explore the world</div>
						<div class="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">Every result includes source IDs, warnings, and unresolved facts. These tools never write canon.</div>
					</div>

					<label class="block space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
						<span>Tool</span>
						<select bind:value={gmTool} onchange={() => { gmToolResult = null; }} class="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]">
							<option value="actor">Actor Brief</option>
							<option value="scene">Scene Check</option>
							<option value="relationships">Relationship Web</option>
							<option value="threads">Thread Board</option>
						</select>
					</label>

					<label class="block space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
						<span>{gmTool === 'actor' ? 'Actor name' : gmTool === 'scene' ? 'Scene location' : gmTool === 'relationships' ? 'Actor names, comma separated' : 'Thread search (optional)'}</span>
						<input bind:value={gmTarget} onkeydown={(event) => event.key === 'Enter' && runGmTool()} class="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" placeholder={gmTool === 'actor' ? 'Mira' : gmTool === 'scene' ? 'Harbor Court' : gmTool === 'relationships' ? 'Mira, Harbor Lord' : 'marriage, missing ledger'} />
					</label>

					{#if gmTool === 'scene'}
						<div class="grid gap-2 sm:grid-cols-2">
							<label class="block space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
								<span>Actors, comma separated</span>
								<input bind:value={gmActors} class="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" placeholder="Mira, Harbor Lord" />
							</label>
							<label class="block space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
								<span>Available minutes</span>
								<input bind:value={gmAvailableMinutes} type="number" min="0" step="1" class="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" placeholder="30" />
							</label>
						</div>
					{/if}

					<button
						class="inline-flex w-full items-center justify-center gap-2 rounded-md border border-[var(--color-gold-600)] bg-[var(--text-accent)]/12 px-3 py-2 text-xs text-[var(--text-accent)] hover:bg-[var(--text-accent)]/20 disabled:opacity-40"
						onclick={runGmTool}
						disabled={gmToolBusy || (gmTool === 'actor' && !gmTarget.trim()) || (gmTool === 'relationships' && !gmTarget.trim() && !gmActors.trim())}
					>
						{#if gmToolBusy}<RefreshCw class="h-4 w-4 animate-spin" />{:else}<Search class="h-4 w-4" />{/if}
						{gmToolBusy ? 'Inspecting canon' : 'Run tool'}
					</button>

					{#if gmToolResult}
						<div class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
							<div class="mb-2 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Evidence receipt</div>
							<pre class="max-h-72 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{JSON.stringify(gmToolResult, null, 2)}</pre>
						</div>
					{/if}
				</section>

				<section class="min-w-0 space-y-3 p-4">
					<div>
					<div class="text-xs uppercase tracking-[0.14em] text-[var(--text-accent)]">Create a character</div>
						<div class="mt-1 text-xs text-[var(--text-secondary)]">Enter a name and create directly, or ask for an optional story-based preview.</div>
						<div class="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">Direct creation saves the details you enter without a model call. Preview character uses story context to suggest more details for your review.</div>
					</div>

					<div class="grid gap-2 sm:grid-cols-2">
						<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]"><span>Name *</span><input bind:value={newCharacterName} class="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" placeholder="Tala Venn" /></label>
						<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]"><span>Role (preview required)</span><input bind:value={newCharacterRole} class="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" placeholder="Harbor courier" /></label>
					</div>
					<label class="block space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]"><span>Backstory seed (preview required)</span><textarea bind:value={newCharacterBackstory} class="h-20 w-full resize-y rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" placeholder="What shaped them before this story?"></textarea></label>
					<label class="block space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]"><span>Narrative purpose (preview required)</span><textarea bind:value={newCharacterPurpose} class="h-20 w-full resize-y rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" placeholder="What pressure, choice, or connection should they bring into this campaign?"></textarea></label>
					<div class="grid gap-2 sm:grid-cols-2">
						<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]"><span>Desire</span><input bind:value={newCharacterDesire} class="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" /></label>
						<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]"><span>Fear</span><input bind:value={newCharacterFear} class="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" /></label>
						<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]"><span>Faction hint</span><input bind:value={newCharacterFaction} class="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" /></label>
						<label class="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]"><span>Location hint</span><input bind:value={newCharacterLocation} class="w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs normal-case tracking-normal text-[var(--text-primary)]" /></label>
					</div>
					<button class="inline-flex w-full items-center justify-center gap-2 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-40" onclick={createCharacterDirect} disabled={creatingCharacterDraft || !newCharacterName.trim() || !selectedStory?.shelfId}><Plus class="h-4 w-4" />{creatingCharacterDraft ? 'Saving character…' : 'Create character'}</button>
					<button
						class="inline-flex w-full items-center justify-center gap-2 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-40"
						onclick={createCharacterDraft}
						disabled={creatingCharacterDraft || !newCharacterName.trim() || !newCharacterRole.trim() || !newCharacterBackstory.trim() || !newCharacterPurpose.trim()}
					>
						{#if creatingCharacterDraft}<RefreshCw class="h-4 w-4 animate-spin" />{:else}<Plus class="h-4 w-4" />{/if}
						{creatingCharacterDraft ? 'Preparing character preview…' : 'Preview character'}
					</button>
					{#if status}<p class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 text-xs leading-relaxed text-[var(--text-accent)]" role="status">{status}</p>{/if}
				</section>
			</div>
		</div>
	</div>
{/if}
