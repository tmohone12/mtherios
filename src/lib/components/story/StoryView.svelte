<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { ai } from '$lib/services/ai';
	import { uuid } from '$lib/utils/uuid';
	import { imageUsageCostLabel } from '$lib/utils/imageUsage';
	import ActionInput from './ActionInput.svelte';
	import SettingsModal from '$lib/components/settings/SettingsModal.svelte';
	import AssistantPanel from '$lib/components/content/AssistantPanel.svelte';
	import PrivateImagePreview from '$lib/components/content/PrivateImagePreview.svelte';
	import DiceRollCard from './DiceRollCard.svelte';
	import ResearchEvidenceCard from './ResearchEvidenceCard.svelte';
	import { agentHistoryNarrationEntries, getBackendAgentHistory, narrationTurnId, readBackendDiceRoll, requestBackendSceneImage, visibleRollPortrait, type BackendAgentHistory, type BackendDiceRoll, type BackendImageJob, type BackendResearchTool } from '$lib/services/backendAgentRuns';
	import ContextSelection from './ContextSelection.svelte';
	import WorldDrawer from './WorldDrawer.svelte';
	import WorldSheet from './WorldSheet.svelte';
	import StoryMemoryPanel from '$lib/components/memory/StoryMemoryPanel.svelte';
	import WorldExplorer from '$lib/components/database/WorldExplorer.svelte';
	import { downloadStoryAsJson } from '$lib/services/storySync';
	import { deleteStoryEverywhere } from '$lib/services/serverStories';
	import { formatNarrative } from '$lib/utils/narrativeHtml';
	import { gmTurnReceiptSchema, turnContextReceiptSchema, type GmTurnReceipt } from '$lib/contracts/memory';
	import { ArrowLeft, ArrowDown, Database, Loader2, Users, BookOpen, Image, AlertTriangle, Download, Trash2, MoreVertical, X, ScrollText, Scissors, Wifi, WifiOff, MapPin, Feather, Settings, PanelLeftClose, PanelLeftOpen } from 'lucide-svelte';
	import { tick, onMount } from 'svelte';
	import type { Suggestion } from '$lib/services/ai/sdk/schemas/suggestions';
	import type { StoryEntry } from '$lib/types';


	let scrollContainer = $state<HTMLDivElement | null>(null);
	/** A turn request is in flight; the composer shows run progress once the server accepts it. */
	let turnStarting = $state(false);
	let readerNearBottom = $state(true);
	let showLatestButton = $state(false);
	let suggestions = $state<Suggestion[]>([]);
	let suggestionsLoading = $state(false);
	let suggestionRequestId = 0;
	let enrichmentRequestId = 0;
	let imageRequestId = 0;
	let enrichmentStoryId = '';
	let activeTurnStoryId = '';
	let agentHistory = $state<BackendAgentHistory>({ interactions: [], rolls: [], images: [], research: [] });
	let agentHistoryRequest = 0;
	let initialScrollStoryId = '';
	const SCROLL_FOLLOW_THRESHOLD = 96;

	// Service output states
	let sceneImageUrl = $state<string | null>(null);
	let loadingImage = $state(false);
	let imageError = $state<string | null>(null);
	let enrichmentErrors = $state<string[]>([]);

	// World drawer & floating menu
	let drawerOpen = $state(false);
	let playerMenuOpen = $state(false);
	let exporting = $state(false);
	let storyActionError = $state('');
	let headerSaving = $state(false);
	let headerError = $state('');
	let loreDirty = $state(false);
	let navigationNotice = $state('');
	let fabOpen = $state(false);
	let assistantOpen = $state(false);
	let settingsOpen = $state(false);
	let focusMode = $state(false);
	let actionsTrigger = $state<HTMLButtonElement>();
	let actionsMenu = $state<HTMLDivElement>();
	let confirmingDelete = $state(false);
	let headerEditorOpen = $state(false);
	let headerDraft = $state('');
	let titleDraft = $state('');
	let descriptionDraft = $state('');
	let editorTab = $state<'story' | 'character'>('story');
	let characterNameDraft = $state('');
	let characterDescriptionDraft = $state('');
	let characterTraitsDraft = $state('');
	let reputationDraft = $state('');
	const transcriptDeleteNotice = 'This only removes transcript text. World state, memories, and plot plans are not rewound. Use a saved context checkpoint to restore earlier state.';
	let messageControlError = $state<string | null>(null);
	let workspaceTab = $derived(app.storyTab);
	async function focusStorySource(entryId: string) {
		const gameId = story.currentStory?.serverStoryId;
		if (!app.selectStoryTab('play')) return;
		while (gameId && story.currentStory?.serverStoryId === gameId && !story.entries.some(entry => entry.id === entryId) && story.hasOlderEntries) {
			const oldestPosition = story.entries[0]?.position;
			await story.loadOlderEntries();
			if (story.entries[0]?.position === oldestPosition) break;
		}
		if (story.currentStory?.serverStoryId !== gameId) return;
		requestAnimationFrame(() => {
			const target = document.getElementById(`story-entry-${entryId}`);
			if (!target) {
				storyActionError = 'The cited entry is not in the loaded transcript.';
				return;
			}
			target.scrollIntoView({ block: 'center', behavior: 'smooth' });
			target.focus({ preventScroll: true });
		});
	}
	function openAssistantStorySource(entryId: string) {
		assistantOpen = false;
		void focusStorySource(entryId);
	}
	let online = $state(true);
	let headerTitleInput = $state<HTMLInputElement | null>(null);
	let headerReturnFocus: HTMLElement | null = null;
	function openStorySettings() { assistantOpen = false; settingsOpen = true; }
	function openPlayerMenu() { assistantOpen = false; playerMenuOpen = true; }
	function openGmTools() { assistantOpen = false; drawerOpen = true; }
	function closeActions() {
		fabOpen = false;
		confirmingDelete = false;
		actionsTrigger?.focus();
	}
	function dismissActions(event: PointerEvent) {
		if (fabOpen && event.target instanceof Node && !actionsMenu?.contains(event.target) && !actionsTrigger?.contains(event.target)) fabOpen = false;
	}
	function handleHeaderKeys(event: KeyboardEvent) {
		if (event.key === 'Escape' && fabOpen) { event.preventDefault(); closeActions(); }
	}
	function handleEditorKeys(event: KeyboardEvent) {
		if (event.key === 'Escape') { event.stopPropagation(); closeHeaderEditor(); }
		if (event.key !== 'Tab') return;
		const nodes = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, [tabindex="0"]')].filter(node => node.getClientRects().length);
		if (!nodes.length) return;
		if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
		else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
	}

	function invalidateEnrichments(): void {
		enrichmentRequestId += 1;
		imageRequestId += 1;
		suggestionRequestId += 1;
		suggestions = [];
		suggestionsLoading = false;
		sceneImageUrl = null;
		loadingImage = false;
		imageError = null;
		enrichmentErrors = [];
	}

	async function handleExport() {
		if (!story.currentStory || exporting) return;
		exporting = true;
		storyActionError = '';
		try {
			await downloadStoryAsJson(story.currentStory.id);
		} catch (e) {
			console.error('Export failed:', e);
			storyActionError = `Export failed: ${e instanceof Error ? e.message : 'Please try again.'}`;
		}
		exporting = false;
	}

	function openHeaderEditor() {
		assistantOpen = false;
		headerError = '';
		headerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		titleDraft = story.currentStory?.title ?? '';
		headerDraft = story.currentStory?.headerPrompt ?? '';
		descriptionDraft = story.currentStory?.description ?? '';
		editorTab = 'story';
		headerEditorOpen = true;
		requestAnimationFrame(() => headerTitleInput?.focus());
	}

	function closeHeaderEditor() {
		if (headerSaving) return;
		headerEditorOpen = false;
		requestAnimationFrame(() => {
			const fallback = document.querySelector<HTMLButtonElement>('button[aria-label="Open story actions"]');
			(headerReturnFocus?.isConnected ? headerReturnFocus : fallback)?.focus();
		});
	}

	function closeWorldDrawer() {
		drawerOpen = false;
		setTimeout(() => {
			const fallback = window.matchMedia('(min-width: 640px)').matches
				? document.querySelector<HTMLButtonElement>('button[aria-label="Open GM tools and connection state"]')
				: document.querySelector<HTMLButtonElement>('button[aria-label="Open story actions"]');
			fallback?.focus();
		}, 240);
	}

	async function saveHeaderPrompt() {
		if (!story.currentStory || headerSaving) return;
		headerSaving = true;
		headerError = '';
		try {
			await story.updateStoryDetails({ title: titleDraft, headerPrompt: headerDraft, description: descriptionDraft });
			headerSaving = false;
			closeHeaderEditor();
		} catch (error) {
			headerError = error instanceof Error ? error.message : 'Could not save story controls. Please retry.';
		} finally {
			headerSaving = false;
		}
	}

	async function handleDelete() {
		if (!story.currentStory) return;
		const currentStory = story.currentStory;
		await deleteStoryEverywhere(currentStory);
		story.clear();
		app.closeStory();
	}

	async function handleDeleteEntry(entry: StoryEntry) {
		messageControlError = null;
		if (!confirm(`Delete this message?\n\n${transcriptDeleteNotice}`)) return;
		try {
			await story.deleteEntry(entry.id);
			invalidateEnrichments();
		} catch (e) {
			messageControlError = e instanceof Error ? e.message : 'Failed to delete message.';
		}
	}

	async function handleDeleteFromEntry(entry: StoryEntry) {
		messageControlError = null;
		if (!confirm(`Delete this message and all later messages?\n\n${transcriptDeleteNotice}`)) return;
		try {
			await story.deleteEntriesFromPosition(entry.position);
			invalidateEnrichments();
		} catch (e) {
			messageControlError = e instanceof Error ? e.message : 'Failed to delete transcript range.';
		}
	}

	async function generateSceneImage() {
		const originStoryId = story.currentStory?.id;
		if (loadingImage || !originStoryId || story.entries.length === 0) return;
		const requestId = ++imageRequestId;
		loadingImage = true;
		sceneImageUrl = null;
		imageError = null;
		try {
			const generated = await generateServerSceneImage(uuid());
			if (requestId === imageRequestId && story.currentStory?.id === originStoryId) {
				sceneImageUrl = generated.imageResult.url ?? null;
				await refreshImageHistory();
			}
		} catch (e) {
			if (requestId !== imageRequestId || story.currentStory?.id !== originStoryId) return;
			console.error('Image generation failed:', e);
			imageError = e instanceof Error ? e.message : 'Image generation failed.';
		}
		if (requestId === imageRequestId && story.currentStory?.id === originStoryId) {
			loadingImage = false;
			scrollToBottom();
		}
	}

	async function generateServerSceneImage(callId: string) {
		const current = story.currentStory;
		const narration = story.entries.filter(entry => entry.type === 'narration').at(-1);
		const clientTurnId = narrationTurnId(narration);
		if (!current?.serverStoryId || !current.shelfId || !clientTurnId) throw new Error('A saved game turn is required for a server image.');
		return requestBackendSceneImage({ projectId: current.shelfId,
			gameId: current.serverStoryId, clientTurnId, callId });
	}

	async function refreshImageHistory() {
		const gameId = historyGameId;
		const request = ++agentHistoryRequest;
		const turnIds = JSON.parse(visibleAgentTurnKey) as string[];
		if (!gameId || !turnIds.length) return;
		const value = await getBackendAgentHistory(gameId, turnIds);
		if (request === agentHistoryRequest && gameId === historyGameId) agentHistory = value;
	}

	const isAdventure = $derived(story.storyMode === 'adventure');
	const visibleEntries = $derived(story.entries);
	const historyGameId = $derived(story.currentStory?.serverStoryId ?? '');
	const agentNarrationEntries = $derived(agentHistoryNarrationEntries(story.entries));
	const visibleAgentTurnKey = $derived(JSON.stringify([...agentNarrationEntries.keys()]));
	$effect(() => {
		const gameId = historyGameId;
		const turnKey = visibleAgentTurnKey;
		const request = ++agentHistoryRequest;
		agentHistory = { interactions: [], rolls: [], images: [], research: [] };
		const turnIds = JSON.parse(turnKey) as string[];
		if (!gameId || !turnIds.length) return;
		void getBackendAgentHistory(gameId, turnIds).then(value => {
			if (request === agentHistoryRequest) agentHistory = value;
		}).catch(error => console.warn('[StoryView] Agent interaction history unavailable:', error));
	});
	type HistoryCard = { kind: 'roll'; actor: string; roll: BackendDiceRoll } | { kind: 'question'; prompt: string; answer: string } | { kind: 'image'; image: BackendImageJob } | { kind: 'research'; research: BackendResearchTool['result'] };
	const historyCards = $derived.by(() => {
		const cards = new Map<string, HistoryCard[]>();
		const add = (turnId: string, card: HistoryCard) => {
			const key = agentNarrationEntries.get(turnId);
			if (!key) return;
			cards.set(key, [...(cards.get(key) ?? []), card]);
		};
		for (const item of agentHistory.interactions) {
			if (item.kind === 'roll') {
				const roll = readBackendDiceRoll(item.response);
				if (roll) add(item.client_turn_id, { kind: 'roll', actor: roll.targetCharacterName ?? 'Player', roll });
			} else {
				const response = item.response && typeof item.response === 'object' ? item.response as { optionId?: string; text?: string } : {};
				const answer = response.text ?? item.options.find(option => option.id === response.optionId)?.label ?? '';
				if (answer) add(item.client_turn_id, { kind: 'question', prompt: item.prompt, answer });
			}
		}
		for (const item of agentHistory.rolls) add(item.client_turn_id, { kind: 'roll', actor: 'Game Master', roll: item.result });
		for (const item of agentHistory.images) add(item.client_turn_id, { kind: 'image', image: item });
		for (const item of agentHistory.research) add(item.client_turn_id, { kind: 'research', research: item.result });
		return cards;
	});
	const currentLocation = $derived(story.locations.find(location => location.current) ?? null);
	const dialogueSpeakers = $derived.by(() => {
		const names = new Set<string>();
		const addName = (name: string | null | undefined) => {
			const trimmed = name?.trim();
			if (trimmed) names.add(trimmed);
		};

		addName(story.protagonist?.name);
		for (const character of story.characters) {
			addName(character.name);
		}

		return [...names];
	});

	function getGmTurnReceipt(entry: StoryEntry): GmTurnReceipt | null {
		const metadata = entry.metadata as unknown as Record<string, unknown> | null;
		const parsed = gmTurnReceiptSchema.safeParse(metadata?.gmTurnReceipt);
		return parsed.success ? parsed.data : null;
	}

	function getTurnContextReceipt(entry: StoryEntry) {
		const metadata = entry.metadata as unknown as Record<string, unknown> | null;
		const parsed = turnContextReceiptSchema.safeParse(metadata?.contextReceipt);
		return parsed.success ? parsed.data : null;
	}

	function receiptChangeCount(receipt: GmTurnReceipt): number {
		return receipt.changes.statePatches + receipt.changes.events + receipt.changes.memoryNodes;
	}

	function compactTokenCount(value: number | null): string {
		if (value === null) return 'context sized';
		if (value < 1_000) return `${value} tokens`;
		return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k tokens`;
	}

	function stateExtractionLabel(receipt: GmTurnReceipt): string {
		if (receipt.stateExtractionStatus === 'failed') return 'State update failed; narration kept';
		if (receipt.stateExtractionStatus === 'running') return 'State update running';
		if (receipt.stateExtractionStatus === 'queued') return 'State update queued';
		if (receipt.stateExtractionStatus === 'succeeded') return 'State checked';
		return receipt.stateExtractionMode === 'none' ? 'No durable update needed' : 'State update skipped';
	}

	function updateReaderPosition() {
		if (!scrollContainer) return;
		const distanceFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
		readerNearBottom = distanceFromBottom <= SCROLL_FOLLOW_THRESHOLD;
		showLatestButton = !readerNearBottom;
	}

	async function scrollToBottom(behavior: ScrollBehavior = 'smooth', force = false) {
		await tick();
		if (!scrollContainer) return;
		if (!force && (!settings.uiSettings.autoScroll || !readerNearBottom)) {
			showLatestButton = true;
			return;
		}
		scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
		readerNearBottom = true;
		showLatestButton = false;
	}

	function handleTurnStart() {
		activeTurnStoryId = story.currentStory?.id ?? '';
		enrichmentRequestId += 1;
		imageRequestId += 1;
		suggestionRequestId += 1;
		suggestions = [];
		suggestionsLoading = false;
		turnStarting = true;
		story.beginGmActivity();
		// Don't clear sceneImageUrl here — leave the previous scene visible
		// until the new image actually arrives (or image gen is disabled,
		// in which case the user keeps their last scene). The user has an
		// explicit dismiss button (×) on the image card if they want to clear.
		scrollToBottom('auto');
	}

	async function handleTurnEnd(fullText: string) {
		const originStoryId = activeTurnStoryId;
		const requestId = enrichmentRequestId;
		turnStarting = false;
		story.clearGmActivity();
		scrollToBottom('auto');
		if (!fullText.trim() || !originStoryId || story.currentStory?.id !== originStoryId) return;
		const isCurrentRequest = () => requestId === enrichmentRequestId && story.currentStory?.id === originStoryId;

		// The server already saved the turn. Here we run only optional UI enrichment in parallel.
		const errors: string[] = [];
		const jobs: Promise<void>[] = [];

		const imageMode = settings.uiSettings.imageGenerationMode ?? story.currentStory?.settings?.imageGenerationMode;
		if (imageMode && imageMode !== 'none') {
			const currentImageRequestId = ++imageRequestId;
			jobs.push(
				(async () => {
					try {
						const narration = story.entries.filter(entry => entry.type === 'narration').at(-1);
						if (!narration) return;
						await generateServerSceneImage(`automatic-scene-${narrationTurnId(narration)}`);
						if (isCurrentRequest() && currentImageRequestId === imageRequestId) await refreshImageHistory();
					} catch (e) {
						errors.push(`ImageGen: ${e}`);
					}
				})()
			);
		}

		const suggestionsConfig = settings.getServiceConfig('suggestions');
		if (isAdventure && !settings.uiSettings.disableSuggestions && suggestionsConfig.enabled) {
			const requestId = ++suggestionRequestId;
			suggestionsLoading = true;
			jobs.push(
				(async () => {
					try {
						const result = await ai.suggestions.suggest(story.entries, story.protagonist, story.storyMode, story.pov);
						if (requestId === suggestionRequestId) suggestions = result.suggestions.slice(0, 3);
					} catch (error) {
						console.warn('[StoryView] Suggestions unavailable:', error);
					} finally {
						if (requestId === suggestionRequestId) suggestionsLoading = false;
					}
				})()
			);
		}

		await Promise.allSettled(jobs);

		if (errors.length > 0 && isCurrentRequest()) {
			enrichmentErrors = errors;
		}

		scrollToBottom('auto');
	}

	function handleTurnClear() {
		turnStarting = false;
		story.clearGmActivity();
	}

	function handleSuggestionSelect(suggestion: Suggestion) {
		window.dispatchEvent(new CustomEvent('mtherios:inject-input', {
			detail: {
				text: suggestion.text,
				actionType: suggestion.type === 'thought' ? 'think' : 'do',
			},
		}));
		suggestions = [];
	}

	function goBack() {
		if (!canLeaveLore() || headerSaving) return;
		if (!app.closeStory()) return;
		story.clear();
	}

	function canLeaveLore() {
		if (!loreDirty) return true;
		navigationNotice = 'Save or discard your lore changes before leaving this workspace.';
		return false;
	}

	function selectWorkspaceTab(tab: 'play' | 'lore' | 'chapters') {
		if (tab !== workspaceTab && !canLeaveLore()) return;
		app.selectStoryTab(tab);
	}

	function updateLoreDirty(dirty: boolean) {
		loreDirty = dirty;
		if (!dirty) navigationNotice = '';
	}

	onMount(() => {
		const releaseNavigationGuard = app.registerNavigationGuard(() => {
			if (headerSaving) return false;
			if (headerEditorOpen && (titleDraft !== (story.currentStory?.title ?? '') || headerDraft !== (story.currentStory?.headerPrompt ?? '') || descriptionDraft !== (story.currentStory?.description ?? ''))) {
				headerError = 'Save or cancel your story controls before leaving.';
				return false;
			}
			return canLeaveLore();
		});
		online = navigator.onLine;
		const updateOnline = () => online = navigator.onLine;
		window.addEventListener('online', updateOnline);
		window.addEventListener('offline', updateOnline);
		return () => {
			releaseNavigationGuard();
			story.clearGmActivity();
			window.removeEventListener('online', updateOnline);
			window.removeEventListener('offline', updateOnline);
		};
	});

	$effect(() => {
		const storyId = story.currentStory?.id ?? '';
		if (storyId !== enrichmentStoryId) {
			enrichmentStoryId = storyId;
			invalidateEnrichments();
		}
		const ready = storyId && !story.loading && story.entries.length > 0;
		if (!ready || initialScrollStoryId === storyId) return;
		initialScrollStoryId = storyId;
		if (!app.pendingStoryEntryId) void scrollToBottom('auto', true);
	});

	$effect(() => {
		const entryId = app.pendingStoryEntryId;
		if (!entryId || story.loading || story.currentStory?.id !== app.currentStoryId) return;
		app.pendingStoryEntryId = null;
		void focusStorySource(entryId);
	});
</script>

<svelte:window onpointerdown={dismissActions} onkeydown={handleHeaderKeys} />
<svelte:head><title>{story.currentStory?.title ?? 'Story'} · MythEngine</title></svelte:head>

<div class="reader-workspace app-shell flex min-h-0 overflow-hidden bg-[var(--bg-reader)]" class:focus-mode={focusMode} class:assistant-visible={assistantOpen}>
	<a class="reader-skip" href="#story-reading-area">Skip to story</a>
	<aside class="reader-rail" aria-label="Story navigation">
		<button class="rail-brand" onclick={goBack} title="Back to library" aria-label="Back to library"><Feather size={24} strokeWidth={1.3} /><span>MythEngine</span></button>
		<nav aria-label="Story tools">
			<button class:active={workspaceTab === 'play'} onclick={() => selectWorkspaceTab('play')} aria-current={workspaceTab === 'play' ? 'page' : undefined}><BookOpen size={21} strokeWidth={1.5} /><span>Story</span></button>
			<button class:active={workspaceTab === 'lore'} onclick={() => selectWorkspaceTab('lore')} aria-current={workspaceTab === 'lore' ? 'page' : undefined}><Database size={21} strokeWidth={1.5} /><span>World lore</span></button>
			<button class:active={workspaceTab === 'chapters'} onclick={() => selectWorkspaceTab('chapters')} aria-current={workspaceTab === 'chapters' ? 'page' : undefined}><ScrollText size={21} strokeWidth={1.5} /><span>Chapters</span></button>
			<span class="rail-divider"></span>
			<button onclick={openPlayerMenu}><Users size={21} strokeWidth={1.5} /><span>Characters</span></button>
			{#if story.currentStory?.serverStoryId && story.currentStory?.shelfId}<button class:active={assistantOpen} onclick={() => assistantOpen = !assistantOpen} aria-expanded={assistantOpen}><Feather size={21} strokeWidth={1.5} /><span>Assistant</span></button>{/if}
		</nav>
		<div class="rail-bottom"><button onclick={openStorySettings}><Settings size={20} strokeWidth={1.5} /><span>Settings</span></button><button onclick={goBack}><ArrowLeft size={20} strokeWidth={1.5} /><span>Library</span></button></div>
	</aside>
	<div class="reader-frame">
	<!-- Header -->
	<div class="reader-header">
		<button onclick={goBack} class="reader-back" title="Back to library" aria-label="Back to library">
			<ArrowLeft class="h-4 w-4" /><span>Library</span>
		</button>
		<div class="reader-title">
			<span class="reader-eyebrow">{story.currentStory?.genre || (isAdventure ? 'Interactive fiction' : 'Creative writing')}</span>
			<h1 class="truncate font-display">
				{story.currentStory?.title ?? 'Untitled'}
			</h1>
		</div>
		<div class="reader-navigation" role="group" aria-label="Story workspace">
			<button
				onclick={() => selectWorkspaceTab('play')}
				aria-pressed={workspaceTab === 'play'}
			>
				<BookOpen class="h-3.5 w-3.5" /> Story
			</button>
			<button
				onclick={() => selectWorkspaceTab('lore')}
				aria-pressed={workspaceTab === 'lore'}
			>
				<Database class="h-3.5 w-3.5" />
				World lore
			</button>
			<button onclick={() => selectWorkspaceTab('chapters')} aria-pressed={workspaceTab === 'chapters'}><ScrollText class="h-3.5 w-3.5" /> Chapters</button>
		</div>
		<button onclick={() => focusMode = !focusMode} class="reader-tool reader-focus" title={focusMode ? 'Show story navigation' : 'Focus on the story'} aria-label={focusMode ? 'Exit focus mode' : 'Enter focus mode'} aria-pressed={focusMode}>
			{#if focusMode}<PanelLeftOpen size={18} />{:else}<PanelLeftClose size={18} />{/if}<span>{focusMode ? 'Show tools' : 'Focus'}</span>
		</button>
		{#if story.currentStory?.serverStoryId && story.currentStory?.shelfId}<button onclick={() => assistantOpen = !assistantOpen} class="reader-tool reader-assistant" aria-label="Open Assistant" aria-expanded={assistantOpen}><Feather size={17} /><span>Assistant</span></button>{/if}
		<button onclick={openPlayerMenu} class="reader-tool reader-world" title="Characters and world" aria-label="Open player menu">
			<Users class="h-4 w-4" /><span>Characters</span>
		</button>
		<button onclick={openGmTools} class="reader-tool reader-connection" title="GM tools and connection state" aria-label="Open GM tools and connection state">
			{#if online}<Wifi class="h-4 w-4 {story.engineStreamStatus.connected ? 'text-[var(--success)]' : ''}" />{:else}<WifiOff class="h-4 w-4 text-[var(--color-crimson-400)]" />{/if}
		</button>
		<div class="relative shrink-0">
			<button
				bind:this={actionsTrigger}
				onclick={() => { fabOpen = !fabOpen; confirmingDelete = false; }}
				class="reader-tool"
				title={fabOpen ? 'Close story actions' : 'Open story actions'}
				aria-label={fabOpen ? 'Close story actions' : 'Open story actions'}
				aria-expanded={fabOpen}
			>
				{#if fabOpen}
					<X class="h-4 w-4 text-[var(--text-primary)]" />
				{:else}
					<MoreVertical class="h-4 w-4 text-[var(--text-accent)]" />
				{/if}
			</button>

			{#if fabOpen}
				<div bind:this={actionsMenu} class="story-actions-menu absolute right-0 top-12 z-30 flex min-w-[210px] flex-col gap-1 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 shadow-2xl">
					<button onclick={() => { openStorySettings(); fabOpen = false; }} class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--bg-tertiary)]"><Settings size={16} /><span>Settings</span></button>
					{#if story.currentStory?.serverStoryId && story.currentStory?.shelfId}
						<button onclick={() => { assistantOpen = true; fabOpen = false; }} class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]"><Feather class="h-4 w-4 text-[var(--text-accent)]" /><span class="text-xs font-medium text-[var(--text-primary)]">Assistant</span></button>
					{/if}
					<button
				onclick={() => { openPlayerMenu(); fabOpen = false; }}
						class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
					>
						<Users class="h-4 w-4 text-[var(--text-accent)]" />
						<span class="text-xs font-medium text-[var(--text-primary)]">World</span>
						{#if story.characters.length > 0}
							<span class="ml-auto flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-gold-400)] text-[8px] font-bold text-[var(--bg-primary)]">{story.characters.length}</span>
						{/if}
					</button>
					<button
						onclick={() => { selectWorkspaceTab('lore'); fabOpen = false; }}
						class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
					>
						<Database class="h-4 w-4 text-[var(--text-accent)]" />
						<span class="text-xs font-medium text-[var(--text-primary)]">Lore</span>
					</button>
					<button
						onclick={() => { openGmTools(); fabOpen = false; }}
						class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)] sm:hidden"
					>
						{#if online}<Wifi class="h-4 w-4 text-[var(--text-accent)]" />{:else}<WifiOff class="h-4 w-4 text-[var(--color-crimson-400)]" />{/if}
						<span class="text-xs font-medium text-[var(--text-primary)]">GM tools</span>
					</button>
					<button
						onclick={() => { openHeaderEditor(); fabOpen = false; }}
						class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
					>
						<ScrollText class="h-4 w-4 text-[var(--text-accent)]" />
						<span class="text-xs font-medium text-[var(--text-primary)]">Story controls</span>
						{#if story.currentStory?.headerPrompt}
							<span class="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--text-accent)]"></span>
						{/if}
					</button>
					<button
						onclick={() => { generateSceneImage(); fabOpen = false; }}
						disabled={loadingImage || story.entries.length === 0}
						class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
					>
						{#if loadingImage}
							<Loader2 class="h-4 w-4 animate-spin text-sky-400" />
						{:else}
							<Image class="h-4 w-4 text-sky-400" />
						{/if}
						<span class="text-xs font-medium text-[var(--text-primary)]">Scene Image</span>
					</button>
					<button
						onclick={() => { handleExport(); fabOpen = false; }}
						disabled={exporting}
						class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
					>
						{#if exporting}
							<Loader2 class="h-4 w-4 animate-spin text-emerald-400" />
						{:else}
							<Download class="h-4 w-4 text-emerald-400" />
						{/if}
						<span class="text-xs font-medium text-[var(--text-primary)]">Export</span>
					</button>
					{#if !confirmingDelete}
						<button
							onclick={() => confirmingDelete = true}
							class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--color-crimson-900)]/20"
						>
							<Trash2 class="h-4 w-4 text-[var(--color-crimson-400)]" />
							<span class="text-xs font-medium text-[var(--color-crimson-400)]">Delete</span>
						</button>
					{:else}
						<button
							onclick={handleDelete}
							class="flex items-center gap-2 rounded-lg bg-[var(--color-crimson-900)]/30 px-3 py-2 text-left border border-[var(--color-crimson-500)]/40"
						>
							<Trash2 class="h-4 w-4 text-[var(--color-crimson-400)]" />
							<span class="text-xs font-bold text-[var(--color-crimson-400)]">Confirm</span>
						</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<div class="reader-context">
		<div class="mobile-reader-navigation" role="group" aria-label="Story workspace">
		<button
			onclick={() => selectWorkspaceTab('play')}
			aria-pressed={workspaceTab === 'play'}
		>
			<BookOpen class="h-3.5 w-3.5" /> Story
		</button>
		<button
			onclick={() => selectWorkspaceTab('lore')}
			aria-pressed={workspaceTab === 'lore'}
		>
			<Database class="h-3.5 w-3.5" />
			Lore
		</button>
		<button onclick={() => selectWorkspaceTab('chapters')} aria-pressed={workspaceTab === 'chapters'}><ScrollText class="h-3.5 w-3.5" /> Chapters</button>
		</div>
		<div class="scene-location">
			{#if currentLocation}<MapPin class="h-3 w-3 shrink-0" /><span class="truncate">{currentLocation.name}</span>
			{:else}<Feather class="h-3 w-3 shrink-0" /><span>{isAdventure ? 'An unfolding adventure' : 'A story in the making'}</span>{/if}
		</div>
		{#if story.protagonist}<span class="reader-protagonist">Playing as <strong>{story.protagonist.name}</strong></span>{/if}
	</div>

	<!-- Meters HUD: visible meters tracked by the GM -->
	{#if story.currentStory?.meters && story.currentStory.meters.some(m => m.visible)}
		<div class="reader-meters mobile-hud flex flex-nowrap items-center gap-2 overflow-x-auto border-b border-[var(--border-secondary)] bg-[var(--bg-secondary)]/60 px-4 py-2 sm:flex-wrap">
			{#each story.currentStory.meters.filter(m => m.visible) as meter}
				{@const pct = meter.max > 0 ? Math.round((meter.value / meter.max) * 100) : 0}
				<div class="flex items-center gap-1.5 rounded-md bg-[var(--bg-tertiary)] px-2 py-1" title="{meter.name}: {meter.value}/{meter.max}">
					<span class="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{meter.name}</span>
					<div class="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--border-primary)]">
						<div
							class="h-full transition-all"
							style="width: {pct}%; background: {pct < 25 ? 'var(--color-crimson-400)' : pct < 60 ? 'var(--color-gold-400)' : 'var(--color-emerald-400, #10b981)'}"
						></div>
					</div>
					<span class="text-[10px] tabular-nums text-[var(--text-primary)]">{meter.value}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if navigationNotice}<p class="shrink-0 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-5 py-3 text-xs text-[var(--text-accent)]" role="alert">{navigationNotice}</p>{/if}
	{#if storyActionError}<div class="flex shrink-0 items-center gap-3 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-5 py-3 text-xs text-[var(--color-crimson-400)]" role="alert"><p class="flex-1">{storyActionError}</p><button onclick={() => storyActionError = ''} aria-label="Dismiss story action error"><X size={16} /></button></div>{/if}
	{#if workspaceTab === 'chapters'}
		<div class="min-h-0 flex-1 overflow-hidden"><StoryMemoryPanel storyId={story.currentStory?.id ?? null} /></div>
	{:else if workspaceTab === 'lore'}
		<div class="min-h-0 flex-1 overflow-hidden">
			<WorldExplorer storyId={story.currentStory?.serverStoryId ?? story.currentStory?.id ?? null} title="Story Lore" onDirtyChange={updateLoreDirty} />
		</div>
	{:else}
	<!-- Story entries -->
	<div class="relative min-h-0 flex-1">
	<div id="story-reading-area" tabindex="-1" role="region" aria-label="Story transcript" bind:this={scrollContainer} onscroll={updateReaderPosition} class="reader-scroll h-full overflow-y-auto overscroll-contain pb-4">
		{#if story.loading}
			<div class="flex items-center justify-center py-20">
				<Loader2 class="h-6 w-6 animate-spin text-[var(--text-accent)]" />
			</div>
		{:else if story.entries.length === 0 && !turnStarting}
			<div class="reader-opening mx-auto flex min-h-full max-w-xl flex-col items-center justify-center gap-5 px-7 py-16 text-center">
				<span class="opening-mark"><Feather class="h-6 w-6" /></span>
				<div class="space-y-2">
					<p class="reader-eyebrow mb-3">The first page</p>
					<p class="font-display text-3xl text-[var(--text-primary)]">{story.currentStory?.title ?? 'Your story begins here'}</p>
					{#if currentLocation}<p class="text-sm text-[var(--text-accent)]">{currentLocation.name}</p>{/if}
					{#if story.protagonist}<p class="font-story text-lg leading-relaxed text-[var(--text-secondary)]"><strong>{story.protagonist.name}</strong>{story.protagonist.description ? ` — ${story.protagonist.description}` : ''}</p>{/if}
					<p class="pt-2 text-sm text-[var(--text-muted)]">
						{#if isAdventure}
							Type what you want to do and the AI will narrate the world around you.
						{:else}
							Describe what happens next and the AI will weave your narrative.
						{/if}
					</p>
				</div>
			</div>
		{:else}
			<div class="reader-pages mx-auto max-w-[50rem] space-y-6 px-5 pt-7 sm:px-10 sm:pt-10">
				{#if story.hasOlderEntries}
					<div class="flex justify-center">
						<button
							onclick={() => story.loadOlderEntries()}
							disabled={story.loadingOlderEntries}
							class="min-h-11 rounded-full border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-muted)] transition-colors hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)] disabled:opacity-50"
						>
							{story.loadingOlderEntries ? 'Loading older messages...' : `Load older messages (${story.entries.length}/${story.entryCount})`}
						</button>
					</div>
				{/if}
				{#if messageControlError}
					<div class="flex items-start gap-2 rounded-xl border border-[var(--color-crimson-500)]/20 bg-[var(--color-crimson-900)]/10 px-3 py-2.5">
						<AlertTriangle class="h-4 w-4 shrink-0 text-[var(--color-crimson-400)] mt-0.5" />
						<div class="flex-1 text-xs text-[var(--color-crimson-400)]">{messageControlError}</div>
						<button onclick={() => messageControlError = null} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Dismiss message control error" aria-label="Dismiss message control error">
							<X class="h-3.5 w-3.5" />
						</button>
					</div>
				{/if}
				{#each visibleEntries as entry (entry.id)}
					{#if entry.type === 'user_action'}
						<div id={`story-entry-${entry.id}`} class="player-turn group flex flex-col gap-1" role="group" tabindex="-1">
							<div class="player-turn-card">
								<span class="turn-label"><Feather class="h-3 w-3" /> Your move</span>
								<p class="whitespace-pre-wrap text-base leading-relaxed text-[var(--text-primary)] sm:text-sm">{entry.content.replace(/^>\s*/, '')}</p>
							</div>
							<div class="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
								<button
									onclick={() => handleDeleteFromEntry(entry)}
									class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-amber-500/40 hover:text-amber-300"
									title="Delete transcript from here"
									aria-label="Delete transcript from here"
								>
									<Scissors class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
								<button
									onclick={() => handleDeleteEntry(entry)}
									class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-[var(--color-crimson-500)]/40 hover:text-[var(--color-crimson-400)]"
									title="Delete message"
									aria-label="Delete message"
								>
									<Trash2 class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
							</div>
						</div>
					{:else if entry.type === 'narration'}
						{@const receipt = getGmTurnReceipt(entry)}
						{@const contextReceipt = getTurnContextReceipt(entry)}
						<div id={`story-entry-${entry.id}`} class="narration-passage group space-y-1" role="group" tabindex="-1">
						{#each historyCards.get(entry.id) ?? [] as card}
							{#if card.kind === 'roll'}
								<DiceRollCard actor={card.actor} portrait={card.roll.portraitUrl ?? visibleRollPortrait(story.characters, card.roll.targetCharacterId)} roll={card.roll} />
							{:else if card.kind === 'image'}
								<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-secondary)]" aria-label="Game Master image"><strong class="block text-[var(--text-primary)]">{card.image.tool === 'generateFileImage' ? 'File cover' : 'Image'} · {card.image.job_status ?? 'generating'}</strong>{#if card.image.image_result?.url?.startsWith('/api/assets/')}<img src={card.image.image_result.url} alt="Game Master artwork" class="mt-2 max-h-80 max-w-full object-contain" />{:else if card.image.image_result?.assetId && story.currentStory?.shelfId && story.currentStory?.serverStoryId}<PrivateImagePreview assetId={card.image.image_result.assetId} projectId={story.currentStory.shelfId} gameId={story.currentStory.serverStoryId} alt="Game Master artwork" />{/if}{#if card.image.job_status === 'complete'}<small>{imageUsageCostLabel(card.image.image_usage)}</small>{/if}{#if card.image.job_error}<p role="alert">{card.image.job_error}</p>{/if}</section>
							{:else if card.kind === 'research'}
								<ResearchEvidenceCard research={card.research} projectId={story.currentStory?.shelfId} gameId={story.currentStory?.serverStoryId} />
							{:else}
								<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-secondary)]" aria-label="Answered Game Master question"><strong class="block text-[var(--text-primary)]">{card.prompt}</strong>Answered: {card.answer}</section>
							{/if}
						{/each}
						<div class="prose-mtherios px-1 sm:px-2">
							{@html formatNarrative(entry.content, dialogueSpeakers)}
							{#if story.getImageForEntry(entry.id)}
								{@const img = story.getImageForEntry(entry.id)}
								{#if img}
								<div class="relative mt-2 overflow-hidden rounded-xl border border-[var(--border-primary)]">
									<img src={img.imageData} alt="Scene" class="w-full" loading="lazy" />
									<button
										onclick={() => story.removeImage(img.id)}
										class="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-xl bg-black/50 text-white/80 backdrop-blur-sm hover:bg-black/70 sm:h-7 sm:w-7 sm:rounded-lg"
										title="Remove image"
									>
										<X class="h-3.5 w-3.5" />
									</button>
								</div>
								{/if}
							{/if}
							</div>
							{#if receipt}
								<details class="turn-receipt mx-1 mt-3 overflow-hidden rounded-xl border border-[var(--border-primary)] text-xs sm:mx-2">
									<summary class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-[var(--text-muted)] marker:hidden">
										<span class="flex items-center gap-2 font-semibold text-[var(--text-secondary)]"><span class="h-1.5 w-1.5 rounded-full bg-[var(--text-accent)]"></span>GM turn receipt</span>
										<span class="truncate text-right">{receipt.tools.length} {receipt.tools.length === 1 ? 'tool' : 'tools'} · {receiptChangeCount(receipt)} {receiptChangeCount(receipt) === 1 ? 'change' : 'changes'} · {compactTokenCount(receipt.context.totalTokens)}</span>
									</summary>
									<div class="grid gap-3 border-t border-[var(--border-primary)] px-3 py-3 sm:grid-cols-3">
										<section>
											<p class="mb-1.5 font-semibold uppercase tracking-[0.14em] text-[var(--text-accent)]">Explored</p>
											{#if receipt.tools.length}
												<ul class="space-y-1 text-[var(--text-secondary)]">
													{#each receipt.tools as tool}
														<li class="flex gap-1.5"><span class={tool.ok ? 'text-emerald-400' : 'text-amber-400'}>{tool.ok ? '✓' : '!'}</span><span>{tool.label}</span></li>
													{/each}
												</ul>
											{:else}<p class="text-[var(--text-muted)]">Prepared scene context was enough.</p>{/if}
										</section>
										<section>
											<p class="mb-1.5 font-semibold uppercase tracking-[0.14em] text-[var(--text-accent)]">Context</p>
											<p class="leading-relaxed text-[var(--text-secondary)]">{receipt.context.recentEntries} recent · {receipt.context.memoryNodes} memories · {receipt.context.wikiChunks} lore · {receipt.context.timelineEvents} timeline</p>
											<p class="mt-1 text-[var(--text-muted)]">{compactTokenCount(receipt.context.totalTokens)} · {receipt.context.truncated ? 'budget trimmed' : 'full selection'}</p>
										</section>
										<section>
											<p class="mb-1.5 font-semibold uppercase tracking-[0.14em] text-[var(--text-accent)]">Canon</p>
											<p class="leading-relaxed text-[var(--text-secondary)]">{receipt.changes.statePatches} patches · {receipt.changes.events} events · {receipt.changes.memoryNodes} memories</p>
											<p class="mt-1 {receipt.stateExtractionStatus === 'failed' ? 'text-amber-400' : 'text-[var(--text-muted)]'}">{stateExtractionLabel(receipt)}{receipt.warningCount ? ` · ${receipt.warningCount} notices` : ''}</p>
											{#if receipt.stateExtractionStatus === 'failed' && receipt.stateExtractionError}
												<p class="mt-1 line-clamp-3 text-[var(--text-muted)]">{receipt.stateExtractionError}</p>
											{/if}
											{#if receipt.floor?.status === 'decided'}
												{@const floor = receipt.floor}
												{@const nameOf = (id: string) => floor.actors.find(actor => actor.id === id)?.name ?? id}
												<p class="mt-1.5 text-[var(--text-secondary)]">Floor{floor.mode === 'shadow' ? ' (recorded only)' : ''}: {floor.actors.filter(actor => actor.role === 'answer' || actor.role === 'speak').map(actor => `${actor.name} ${actor.role === 'answer' ? 'answers' : 'may speak'}`).join(' · ') || 'no one needed to speak'}</p>
												{#if floor.adherence?.unexpected.length || floor.adherence?.missing.length}
													<p class="text-amber-400">{[...(floor.adherence?.unexpected ?? []).map(id => `${nameOf(id)} spoke unprompted`), ...(floor.adherence?.missing ?? []).map(id => `${nameOf(id)} did not answer`)].join(' · ')}</p>
												{/if}
											{:else if receipt.floor && receipt.floor.status !== 'abstained'}
												<p class="mt-1.5 text-[var(--text-muted)]">Floor {receipt.floor.status.replace('_', ' ')}{receipt.floor.reason ? `: ${receipt.floor.reason}` : ''}</p>
											{/if}
											{#if receipt.effects.length}
												<ul class="mt-1.5 space-y-0.5">
													{#each receipt.effects as effect}
														<li class="{effect.status === 'applied' ? 'text-[var(--text-secondary)]' : effect.status === 'rejected' || effect.status === 'unresolved' ? 'text-amber-400' : 'text-[var(--text-muted)]'}">{effect.summary}</li>
													{/each}
												</ul>
											{/if}
										</section>
									</div>
									{#if contextReceipt?.selection}
										<div class="border-t border-[var(--border-primary)] px-3 py-2">
											<ContextSelection selection={contextReceipt.selection} projectId={story.currentStory?.shelfId ?? undefined} gameId={story.currentStory?.id ?? undefined} />
										</div>
									{/if}
								</details>
							{/if}
							<div class="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
								<button
									onclick={() => handleDeleteFromEntry(entry)}
									class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-amber-500/40 hover:text-amber-300"
									title="Delete transcript from here"
									aria-label="Delete transcript from here"
								>
									<Scissors class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
								<button
									onclick={() => handleDeleteEntry(entry)}
									class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-[var(--color-crimson-500)]/40 hover:text-[var(--color-crimson-400)]"
									title="Delete message"
									aria-label="Delete message"
								>
									<Trash2 class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
							</div>
						</div>
					{:else if entry.type === 'system'}
						{#if entry.content.startsWith('Roll:')}
							<div class="group space-y-1" role="group">
							<div class="dice-player-roll">
								<span class="dice-card-icon">&#127922;</span>
								<span>{entry.content.slice(5).trim()}</span>
							</div>
							<div class="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
								<button onclick={() => handleDeleteEntry(entry)} class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-[var(--color-crimson-500)]/40 hover:text-[var(--color-crimson-400)]" title="Delete message" aria-label="Delete message">
									<Trash2 class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
							</div>
							</div>
						{:else}
							<div class="group space-y-1" role="group">
							<div class="rounded-lg bg-[var(--color-crimson-900)]/20 border border-[var(--color-crimson-500)]/20 px-4 py-3 text-center text-xs text-[var(--color-crimson-400)]">
								{entry.content}
							</div>
							<div class="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
								<button onclick={() => handleDeleteEntry(entry)} class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-[var(--color-crimson-500)]/40 hover:text-[var(--color-crimson-400)]" title="Delete message" aria-label="Delete message">
									<Trash2 class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
							</div>
							</div>
						{/if}
					{/if}
				{/each}

				<!-- Turn request in flight -->
				{#if turnStarting}
					<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)]/70 px-4 py-3" role="status" aria-live="polite">
						<div class="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
							<Loader2 class="h-4 w-4 shrink-0 animate-spin text-[var(--text-accent)]" />
							<span>{story.gmActivities.at(-1)?.label ?? 'Preparing the turn context'}</span>
						</div>
						{#if story.gmActivities.length > 1}
							<ol class="mt-3 space-y-1.5 border-l border-[var(--border-primary)] pl-3" aria-label="GM turn activity">
								{#each story.gmActivities as activity, index}
									<li class="flex min-w-0 items-center gap-2 text-xs {index === story.gmActivities.length - 1 ? 'text-[var(--text-accent)]' : 'text-[var(--text-muted)]'}" aria-current={index === story.gmActivities.length - 1 ? 'step' : undefined}>
										<span class="h-1.5 w-1.5 shrink-0 rounded-full {index === story.gmActivities.length - 1 ? 'bg-[var(--text-accent)]' : 'bg-[var(--success)]'}"></span>
										<span class="truncate">{activity.label}</span>
										{#if activity.command}
											<code class="ml-auto hidden shrink-0 text-[10px] text-[var(--text-muted)] sm:inline">{activity.command}</code>
										{/if}
								</li>
							{/each}
							</ol>
						{/if}
					</div>
				{/if}

				<!-- Scene Image -->
				{#if sceneImageUrl}
					<div class="relative overflow-hidden rounded-xl border border-[var(--border-primary)]">
						<img src={sceneImageUrl} alt="Scene" class="w-full" loading="lazy" />
						<div class="absolute right-2 top-2 flex gap-1.5">
							<button
								onclick={generateSceneImage}
								disabled={loadingImage || story.entries.length === 0}
								class="flex h-11 w-11 items-center justify-center rounded-xl bg-black/50 text-white/80 backdrop-blur-sm active:scale-95 hover:bg-black/70 disabled:opacity-40 sm:h-8 sm:w-8 sm:rounded-lg"
								title="Regenerate"
							>
								<Image class="h-4 w-4" />
							</button>
							<button
								onclick={() => sceneImageUrl = null}
								class="flex h-11 w-11 items-center justify-center rounded-xl bg-black/50 text-white/80 backdrop-blur-sm active:scale-95 hover:bg-black/70 sm:h-8 sm:w-8 sm:rounded-lg"
								title="Dismiss"
							>
								<X class="h-4 w-4" />
							</button>
						</div>
					</div>
				{:else if loadingImage}
					<div class="flex items-center gap-2 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-muted)]">
						<Image class="h-4 w-4 animate-pulse" />
						<span>Generating scene...</span>
					</div>
				{/if}

				{#if imageError}
					<div class="flex items-start gap-2 rounded-xl border border-[var(--color-crimson-500)]/20 bg-[var(--color-crimson-900)]/10 px-3 py-2.5">
						<AlertTriangle class="h-4 w-4 shrink-0 text-[var(--color-crimson-400)] mt-0.5" />
						<div class="flex-1 text-xs text-[var(--color-crimson-400)]">
							<span class="font-semibold">Image failed:</span> {imageError}
						</div>
						<button onclick={() => imageError = null} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
							<X class="h-3.5 w-3.5" />
						</button>
					</div>
				{/if}

				<!-- Enrichment Errors -->
				{#if enrichmentErrors.length > 0}
					<div class="flex items-start gap-2 rounded-xl border border-[var(--color-crimson-500)]/20 bg-[var(--color-crimson-900)]/10 px-3 py-2.5">
						<AlertTriangle class="h-4 w-4 shrink-0 text-[var(--color-crimson-400)] mt-0.5" />
						<div class="flex-1 text-xs text-[var(--color-crimson-400)]">
							<span class="font-semibold">Enrichment {enrichmentErrors.length === 1 ? 'error' : 'errors'}:</span>
							{#each enrichmentErrors as error}
								<div class="mt-0.5 text-[var(--color-crimson-400)]/80">{error}</div>
							{/each}
						</div>
						<button onclick={() => enrichmentErrors = []} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
							<X class="h-3.5 w-3.5" />
						</button>
					</div>
				{/if}

			</div>
		{/if}
	</div>
	{#if showLatestButton && !story.loading && story.entries.length > 0}
		<button
			onclick={() => scrollToBottom('smooth', true)}
			class="absolute bottom-3 left-1/2 z-10 flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--border-primary)] bg-[var(--bg-secondary)]/95 px-3 py-2 text-xs font-medium text-[var(--text-accent)] shadow-lg backdrop-blur transition-colors hover:bg-[var(--bg-tertiary)]"
			aria-label="Jump to latest story entry"
		>
			<ArrowDown class="h-3.5 w-3.5" />
			Latest
		</button>
	{/if}
	</div>

	<!-- Input tray with menu -->
	<div class="composer-dock shrink-0 px-3 py-3 pb-[max(env(safe-area-inset-bottom),12px)] sm:px-6 sm:py-4">
		<div class="mx-auto max-w-[50rem]">
			{#if isAdventure && (suggestionsLoading || suggestions.length > 0)}
				<div class="mb-2 flex items-center gap-2 overflow-x-auto pb-0.5 sm:flex-wrap">
					{#if suggestionsLoading}
						<span class="flex shrink-0 items-center gap-1.5 px-1 text-[11px] text-[var(--text-muted)]">
							<Loader2 class="h-3 w-3 animate-spin" /> Considering the scene…
						</span>
					{:else}
						<span class="shrink-0 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Try</span>
					{/if}
					{#each suggestions as suggestion}
						<button
							onclick={() => handleSuggestionSelect(suggestion)}
							class="shrink-0 rounded-full border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-1.5 text-left text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]"
							title={suggestion.text}
							aria-label={`Use suggestion: ${suggestion.text}`}
						>
							{suggestion.brief ?? suggestion.text}
						</button>
					{/each}
				</div>
			{/if}
			<div class="flex items-end gap-2">

				<div class="flex-1 min-w-0">
					<ActionInput
						onTurnStart={handleTurnStart}
						onTurnEnd={handleTurnEnd}
						onTurnClear={handleTurnClear}
					/>
				</div>
			</div>
		</div>
	</div>
	{/if}
	</div>
</div>
	{#if assistantOpen && story.currentStory?.serverStoryId && story.currentStory?.shelfId}<AssistantPanel authoringDirty={loreDirty} selectedStoryTitle={story.currentStory.title} projectId={story.currentStory.shelfId} gameId={story.currentStory.serverStoryId} onClose={() => assistantOpen = false} onOpenStoryEntry={openAssistantStorySource} onStoryChanged={() => story.refreshCampaignProjection()} />{/if}
	<SettingsModal open={settingsOpen} onClose={() => settingsOpen = false} />


<!-- World State Drawer -->
<WorldSheet
	open={playerMenuOpen}
	onClose={() => playerMenuOpen = false}
	onOpenLore={() => { playerMenuOpen = false; selectWorkspaceTab('lore'); }}
/>
<WorldDrawer open={drawerOpen} onClose={closeWorldDrawer} />

<!-- Header Prompt Editor Modal -->
{#if headerEditorOpen}
	<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
		<!-- Backdrop -->
		<button
			class="absolute inset-0 bg-black/60 backdrop-blur-sm"
			disabled={headerSaving} onclick={closeHeaderEditor}
			aria-label="Close header editor"
		></button>

		<!-- Panel -->
		<div
			class="relative z-10 flex max-h-[85dvh] w-full max-w-xl flex-col rounded-t-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] pb-[env(safe-area-inset-bottom)] shadow-2xl sm:rounded-2xl sm:pb-0"
			role="dialog"
			aria-modal="true"
			aria-labelledby="story-controls-title"
			tabindex="-1"
			onkeydown={handleEditorKeys}
		>
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-5 py-4">
				<div class="flex items-center gap-2.5">
					<ScrollText class="h-4 w-4 text-[var(--text-accent)]" />
					<h3 id="story-controls-title" class="font-display text-xl font-medium text-[var(--text-primary)]">Story controls</h3>
				</div>
				<button disabled={headerSaving} onclick={closeHeaderEditor} class="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] sm:h-8 sm:w-8" aria-label="Close story controls">
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="flex border-b border-[var(--border-primary)] px-5 pt-2">
				<button
					onclick={() => editorTab = 'story'}
					class="flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs transition-colors {editorTab === 'story' ? 'border-[var(--text-accent)] text-[var(--text-accent)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
				>
					<ScrollText class="h-3.5 w-3.5" />
					<span>Story</span>
				</button>
			</div>

			<!-- Content -->
			<div class="flex-1 overflow-y-auto px-5 py-4 space-y-4">
				{#if editorTab === 'story'}
				<!-- Title -->
				<div class="space-y-1.5">
					<label for="story-title-input" class="text-xs font-medium text-[var(--text-muted)]">Story Title</label>
					<input
						bind:this={headerTitleInput}
						id="story-title-input"
						type="text"
						disabled={headerSaving} bind:value={titleDraft}
						placeholder="Enter story title..."
						class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-[var(--text-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--text-accent)]/20"
					/>
				</div>

				<div class="border-t border-[var(--border-primary)]"></div>

				<!-- World Description -->
				<div class="space-y-1.5">
					<label for="story-description-input" class="text-xs font-medium text-[var(--text-muted)]">World Description</label>
					<p class="text-[10px] text-[var(--text-muted)]/80 leading-relaxed">
						The setting summary the AI sees as "Setting: …" in every prompt. Edit if it contains stale facts (dates, character states, anachronisms).
					</p>
					<textarea
						id="story-description-input"
						disabled={headerSaving} bind:value={descriptionDraft}
						placeholder="A crumbling empire where ancient magic seeps through fractured ley lines..."
						rows="4"
						class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-[var(--text-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--text-accent)]/20"
					></textarea>
				</div>

				<div class="border-t border-[var(--border-primary)]"></div>

				<!-- AI Preamble -->
				<p class="text-xs text-[var(--text-muted)] leading-relaxed">
					This preamble is prepended to every AI prompt for this story. Use it to define tone, rules, content guidelines, or narrative constraints unique to this story.
				</p>
				<textarea
					aria-label="AI preamble"
					disabled={headerSaving} bind:value={headerDraft}
					placeholder={"Example:\nYou are narrating a gritty noir detective story. Keep dialogue sharp and cynical. Avoid flowery language. Violence is implied, never graphic. Every scene should feel like it's raining, even when it isn't."}
					rows="10"
					class="w-full resize-none rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-[var(--text-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--text-accent)]/20 leading-relaxed"
				></textarea>
				<div class="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
					<span>{headerDraft.length > 0 ? `~${Math.ceil(headerDraft.length / 4)} tokens` : 'Empty — default behavior'}</span>
					{#if headerDraft !== (story.currentStory?.headerPrompt ?? '') || titleDraft !== (story.currentStory?.title ?? '') || descriptionDraft !== (story.currentStory?.description ?? '')}
						<span class="text-[var(--text-accent)]">Unsaved changes</span>
					{/if}
				</div>
				{:else}
				<div class="space-y-1.5">
					<label for="character-name-input" class="text-xs font-medium text-[var(--text-muted)]">Protagonist Name</label>
					<input
						id="character-name-input"
						type="text"
						bind:value={characterNameDraft}
						placeholder="Who the player controls..."
						class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-[var(--text-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--text-accent)]/20"
					/>
				</div>

				<div class="space-y-1.5">
					<label for="character-description-input" class="text-xs font-medium text-[var(--text-muted)]">Description</label>
					<textarea
						id="character-description-input"
						bind:value={characterDescriptionDraft}
						placeholder="Age, appearance, background, current condition, role, and anything the narrator must keep current..."
						rows="8"
						class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-[var(--text-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--text-accent)]/20"
					></textarea>
				</div>

				<div class="space-y-1.5">
					<label for="character-traits-input" class="text-xs font-medium text-[var(--text-muted)]">Traits</label>
					<textarea
						id="character-traits-input"
						bind:value={characterTraitsDraft}
						placeholder="Comma or line separated traits..."
						rows="3"
						class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-[var(--text-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--text-accent)]/20"
					></textarea>
				</div>

				<div class="space-y-1.5">
					<label for="player-reputation-input" class="text-xs font-medium text-[var(--text-muted)]">Player Reputation</label>
					<p class="text-[10px] text-[var(--text-muted)]/80 leading-relaxed">
						Public-facing reputation the narrator sees as its own prompt section.
					</p>
					<textarea
						id="player-reputation-input"
						bind:value={reputationDraft}
						placeholder="How the realm, smallfolk, noble courts, factions, enemies, and rumor networks currently speak of the player..."
						rows="6"
						class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-[var(--text-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--text-accent)]/20"
					></textarea>
				</div>

				<div class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-muted)]">
					This is the live protagonist record used in prompts. Update age, injuries, identity changes, titles, or appearance here when long play drifts.
				</div>
				{#if characterNameDraft !== (story.protagonist?.name ?? '') || characterDescriptionDraft !== (story.protagonist?.description ?? '') || characterTraitsDraft !== (story.protagonist?.traits?.join(', ') ?? '') || reputationDraft !== (story.currentStory?.playerReputation ?? '')}
					<div class="text-right text-[10px] text-[var(--text-accent)]">Unsaved changes</div>
				{/if}
				{/if}
			</div>

			{#if headerError}<p class="px-5 py-3 text-xs text-[var(--color-crimson-400)]" role="alert">{headerError}</p>{/if}
			<!-- Footer -->
			<div class="flex items-center justify-end gap-2 border-t border-[var(--border-primary)] px-5 py-3">
				{#if editorTab === 'story' && headerDraft.trim()}
					<button
						disabled={headerSaving} onclick={() => { headerDraft = ''; }}
						class="rounded-lg px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--color-crimson-400)] transition-colors"
					>
						Clear
					</button>
				{/if}
				<button
					disabled={headerSaving} onclick={closeHeaderEditor}
					class="rounded-lg px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
				>
					Cancel
				</button>
				<button
					disabled={headerSaving} onclick={saveHeaderPrompt}
					class="rounded-lg bg-[var(--text-accent)]/15 border border-[var(--text-accent)]/25 px-4 py-2 text-xs font-medium text-[var(--text-accent)] hover:bg-[var(--text-accent)]/25 transition-colors"
				>
					{headerSaving ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.reader-frame { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
	.reader-rail { display: none; }
	.reader-skip { position: fixed; top: -80px; left: 20px; z-index: 80; background: var(--text-accent); color: var(--bg-primary); padding: 12px 20px; border-radius: 8px; }
	.reader-skip:focus { top: 12px; }
	.reader-assistant { color: var(--text-accent); border: 1px solid var(--border-primary); }
	.reader-focus[aria-pressed='true'] { color: var(--text-accent); background: var(--bg-tertiary); }
	.reader-workspace { background-image: radial-gradient(ellipse at 50% 15%, color-mix(in srgb, var(--text-accent) 3%, transparent), transparent 65%); }
	.reader-header { position: relative; z-index: 20; display: flex; align-items: center; gap: 0.75rem; min-height: 5.25rem; flex-shrink: 0; padding: 0.85rem 1.75rem; border-bottom: 1px solid var(--border-secondary); background: var(--bg-secondary); }
	.reader-back, .reader-tool { display: inline-flex; align-items: center; justify-content: center; gap: 0.6rem; min-width: 2.75rem; min-height: 2.75rem; flex-shrink: 0; border-radius: 0.65rem; padding: 0 0.7rem; color: var(--text-muted); font-size: 0.75rem; transition: color 150ms ease, background 150ms ease; }
	.reader-back { margin-right: 0.5rem; border-right: 1px solid var(--border-primary); border-radius: 0; padding-right: 1.25rem; }
	.reader-back:hover, .reader-tool:hover { color: var(--text-primary); background: var(--bg-tertiary); }
	.reader-title { min-width: 0; flex: 1; }
	.reader-title h1 { margin-top: 0.1rem; color: var(--text-primary); font-size: 1.3rem; font-weight: 500; line-height: 1.35; letter-spacing: -0.015em; }
	.reader-eyebrow { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-accent); font-size: 0.59rem; line-height: 1.5; font-weight: 600; letter-spacing: 0.15em; text-transform: uppercase; }
	.reader-navigation { display: flex; gap: 0.25rem; padding: 0.3rem; border: 1px solid var(--border-primary); border-radius: 0.75rem; background: var(--bg-primary); }
	.reader-navigation button, .mobile-reader-navigation button { display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem; min-height: 2.2rem; border-radius: 0.45rem; padding: 0 0.8rem; color: var(--text-muted); font-size: 0.75rem; transition: color 150ms ease, background 150ms ease; }
	.reader-navigation button[aria-pressed='true'] { color: var(--text-accent); background: var(--bg-tertiary); }
	.reader-navigation button:hover, .mobile-reader-navigation button:hover { color: var(--text-primary); }
	.reader-world { color: var(--text-secondary); }
	.reader-context { display: flex; align-items: center; gap: 1.5rem; min-height: 2.5rem; flex-shrink: 0; padding: 0.45rem 2rem; border-bottom: 1px solid var(--border-secondary); font-size: 0.69rem; color: var(--text-muted); }
	.scene-location { display: flex; align-items: center; gap: 0.45rem; min-width: 0; }
	.reader-protagonist { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.reader-protagonist strong { margin-left: 0.25rem; color: var(--text-secondary); font-weight: 500; }
	.mobile-reader-navigation { display: none; }
	.reader-meters { padding-left: 2rem; padding-right: 2rem; }
	.reader-scroll { scrollbar-gutter: stable both-edges; }
	.reader-pages { padding-bottom: 1.5rem; width: 100%; }
	.reader-opening { padding-top: 3rem; padding-bottom: 3rem; }
	.opening-mark { display: flex; align-items: center; justify-content: center; width: 4rem; height: 4rem; border: 1px solid color-mix(in srgb, var(--text-accent) 28%, transparent); border-radius: 50%; color: var(--text-accent); background: color-mix(in srgb, var(--text-accent) 5%, transparent); }
	.player-turn { margin-left: 1.5rem; }
	.player-turn-card { padding: 1rem 1.25rem; border-left: 2px solid color-mix(in srgb, var(--text-accent) 65%, transparent); border-radius: 0 0.7rem 0.7rem 0; background: color-mix(in srgb, var(--text-accent) 6%, transparent); }
	.turn-label { display: inline-flex; align-items: center; gap: 0.45rem; margin-bottom: 0.5rem; color: var(--text-accent); font-size: 0.58rem; font-weight: 650; text-transform: uppercase; letter-spacing: 0.12em; }
	.narration-passage { padding-bottom: 0.5rem; }
	.turn-receipt { border-color: var(--border-secondary); background: color-mix(in srgb, var(--bg-secondary) 65%, transparent); }
	.turn-receipt summary { font-size: 0.65rem; }
	.turn-receipt[open] { border-color: var(--border-primary); }
	.composer-dock { background: linear-gradient(180deg, transparent, var(--bg-reader) 15%); }
	.story-actions-menu { max-height: min(70dvh, 32rem); overflow-y: auto; }
	.story-actions-menu button { min-height: 2.75rem; }
	@media (max-width: 900px) {
		.reader-header { gap: 0.4rem; padding-left: 1rem; padding-right: 1rem; }
		.reader-back span, .reader-world span { display: none; }
		.reader-back { margin-right: 0; padding: 0 0.75rem; border-right: 0; border-radius: 0.65rem; }
		.reader-context { padding-left: 1.5rem; padding-right: 1.5rem; }
	}
	@media (max-width: 639px) {
		.reader-header { min-height: 4.5rem; gap: 0.125rem; padding: 0.5rem; }
		.reader-title { padding: 0 0.35rem; }
		.reader-title h1 { font-size: 1.05rem; }
		.reader-eyebrow { font-size: 0.53rem; letter-spacing: 0.12em; }
		.reader-navigation, .reader-connection, .reader-protagonist { display: none; }
		.reader-tool { padding: 0 0.65rem; }
		.reader-context { min-height: 2.85rem; gap: 1rem; padding: 0 1rem 0 0.5rem; }
		.mobile-reader-navigation { display: flex; gap: 0.15rem; flex-shrink: 0; align-self: stretch; }
		.mobile-reader-navigation button { min-height: 2.75rem; border-radius: 0; padding: 0 0.65rem; border-bottom: 2px solid transparent; font-size: 0.69rem; }
		.mobile-reader-navigation button[aria-pressed='true'] { border-color: var(--text-accent); color: var(--text-accent); }
		.scene-location { margin-left: auto; font-size: 0.61rem; }
		.scene-location span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.reader-meters { padding-left: 1rem; padding-right: 1rem; }
		.reader-scroll { scrollbar-gutter: auto; }
		.player-turn { margin-left: 0.35rem; }
		.player-turn-card { padding: 0.85rem 1rem; }
		.turn-receipt summary { flex-wrap: wrap; gap: 0.25rem; }
	}
	@media (hover: none) and (pointer: coarse) { .reader-navigation button { min-height: 2.75rem; } }
	@media (min-width: 1100px) {
		.reader-rail { display: flex; flex-direction: column; width: 104px; flex-shrink: 0; padding: 22px 10px 12px; background: var(--bg-primary); border-right: 1px solid var(--border-primary); }
		.reader-rail button { display: flex; width: 100%; min-height: 64px; flex-direction: column; align-items: center; justify-content: center; gap: 9px; border-radius: 10px; color: var(--text-muted); font-size: 10px; font-weight: 500; transition: background 150ms, color 150ms; }
		.reader-rail button:hover { color: var(--text-primary); background: var(--bg-tertiary); }
		.reader-rail button.active { background: color-mix(in srgb, var(--text-accent) 10%, transparent); color: var(--text-accent); box-shadow: inset 2px 0 var(--text-accent); }
		.reader-rail .rail-brand { color: var(--text-accent); margin-bottom: 34px; }
		.rail-brand span { font-family: var(--font-display); font-size: 12px; color: var(--text-primary); }
		.reader-rail nav { display: grid; gap: 7px; }
		.rail-divider { height: 1px; margin: 12px 16px; background: var(--border-primary); }
		.rail-bottom { margin-top: auto; padding-top: 22px; }
		.reader-header { min-height: 96px; padding: 18px 36px; background: transparent; }
		.reader-header > .reader-back, .reader-header > .reader-navigation, .reader-header > .reader-world { display: none; }
		.reader-title h1 { font-size: 1.65rem; margin-top: 5px; }
		.reader-eyebrow { font-size: 10px; }
		.reader-context { padding-inline: 36px; min-height: 45px; font-size: 12px; background: color-mix(in srgb, var(--bg-secondary) 45%, transparent); }
		.reader-pages { padding-top: 44px; padding-inline: 42px; }
		.narration-passage { padding-bottom: 18px; }
		.player-turn { margin-left: 0; }
		.player-turn-card { border-left-width: 1px; border-radius: 0 12px 12px 0; padding: 18px 24px; }
		.turn-label { font-size: 10px; }
		.focus-mode .reader-rail { display: none; }
		.focus-mode .reader-header > .reader-back { display: flex; }
	}
	.focus-mode .reader-context, .focus-mode .reader-meters { display: none; }
	@media (min-width: 1400px) { .assistant-visible { width: calc(100% - 480px); right: auto; } }
	@media (max-width: 1099px) { .reader-focus span, .reader-assistant span { display: none; } }
	@media (max-width: 639px) {
		.reader-header { gap: 2px; }
		.reader-world { display: none; }
		.reader-focus { display: none; }
		.reader-assistant { min-width: 40px; min-height: 40px; padding: 0; border: 0; }
		.reader-context { flex-wrap: wrap; gap: 0; padding-right: 8px; }
		.scene-location { max-width: 27%; }
		.reader-pages { padding-top: 24px; }
	}
</style>
