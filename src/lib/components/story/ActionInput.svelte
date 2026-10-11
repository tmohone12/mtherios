<script lang="ts">
	import { Send, Wand2, MessageSquare, Brain, Sparkles, PenLine, BookOpen, Square, Loader2, Target, X, ChevronDown, WifiOff, Upload } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { story } from '$lib/stores/story.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { declarePlayerScheme } from '$lib/services/ai/scheme/SchemeService';
	import { fetchBackendEntriesAround, isTerminalReachabilityError, previewBackendTurn } from '$lib/services/backendMemory';
	import { cancelBackendAgentRun, completedBackendAgentTurn, currentBackendAgentRun, getBackendAgentRun, openBackendAgentRunStream, readBackendAgentSource, readBackendDiceRoll, respondBackendAgentRun, startBackendAgentRun, visibleRollPortrait, type BackendAgentActivity, type BackendAgentRun, type BackendAgentInteraction, type BackendAgentSource } from '$lib/services/backendAgentRuns';
	import type { TurnPreviewResponse } from '$lib/contracts/memory';
	import { buildBackendClientContext as buildBackendClientContextHint } from '$lib/services/backendClientContext';
	import { parseRollCommand, rollDice, formatRollText } from '$lib/utils/dice';
	import { imageUsageCostLabel } from '$lib/utils/imageUsage';
	import { deleteSetting, getSetting, setSetting } from '$lib/services/database';
	import { shouldUseTerminalEngineTurn } from './engineTurnRouting';
	import DiceRollCard from './DiceRollCard.svelte';
	import ResearchEvidenceCard from './ResearchEvidenceCard.svelte';
	import { buildActionContent, decodeActionDraft, encodeActionDraft, failedDraftRestoreTarget, startServerTurn, turnActionTypeForInput, type ActionType } from './actionInput';

	type InjectedInput = string | { text: string; actionType?: ActionType };

	interface Props {
		/** A turn request is being sent to the server. */
		onTurnStart?: () => void;
		/** A turn finished with its narration, or stopped without one (''). */
		onTurnEnd?: (narration: string) => void;
		/** Discard any pending-turn display. */
		onTurnClear?: () => void;
	}

	let { onTurnStart, onTurnEnd, onTurnClear }: Props = $props();

	let inputValue = $state('');
	let inputElement = $state<HTMLTextAreaElement | null>(null);
	let actionType = $state<ActionType>('do');
	let startingTurn = $state(false);
	let turnError = $state<string | null>(null);
	let agentRun = $state<BackendAgentRun | null>(null);
	let agentBusy = $state(false);
	let agentRestoring = $state(false);
	let customAnswer = $state('');
	let agentLoadVersion = 0;
	let hydratedAgentRunId = '';
	/** A run started or answered here; its completion runs the post-turn suggestions and images. */
	let followedAgentRunId = '';
	/** The move behind a run started here, returned to the composer if the run ends without a turn. */
	let pendingSubmission: { runId: string; storyId: string; revision: number; text: string; actionType: ActionType } | null = null;
	let inspectedAgentSource = $state<{ source: BackendAgentSource; text: string } | null>(null);
	let modeSheetOpen = $state(false);
	let modeSheetDialog = $state<HTMLElement | null>(null);
	let modeSheetTrigger = $state<HTMLButtonElement | null>(null);
	let online = $state(true);
	let importingStory = $state(false);
	let importError = $state<string | null>(null);
	let preview = $state<TurnPreviewResponse | null>(null);
	let previewLoading = $state(false);
	let previewError = $state<string | null>(null);
	let previewRequestId = 0;
	let previewButton = $state<HTMLButtonElement | null>(null);
	let previewReturnFocus: HTMLElement | null = null;
	let previewSnapshot = $state<{
		rawInput: string;
		actionType: ActionType;
		storyId: string;
		serverVersion: number;
		settingsKey: string;
		creativeMode: boolean;
	} | null>(null);
	let evidenceLoading = $state(false);
	let evidenceError = $state<string | null>(null);
	let evidenceEntries = $state<Record<string, unknown>[]>([]);
	let evidencePosition = $state<number | null>(null);
	let draftLoadVersion = 0;
	let draftEdited = false;
	let draftRevision = 0;
	const draftStoryId = $derived(story.currentStory?.id ?? '');
	const backendTurnEnabled = $derived(shouldUseTerminalEngineTurn(story.currentStory));
	const backendStoryId = $derived(backendTurnEnabled ? story.currentStory?.serverStoryId?.trim() ?? '' : '');
	/** A browser-only save: readable and exportable, but play continues only after import. */
	const localOnlyStory = $derived(Boolean(story.currentStory) && !backendTurnEnabled);

	function draftKey(storyId: string): string {
		return `narratorDraft:${storyId}`;
	}

	function previewSettingsKey(): string {
		return JSON.stringify({
			contextBudget: settings.contextBudget,
			recentDialogueTurns: settings.uiSettings.recentDialogueTurns,
			memoryTokenBudget: settings.uiSettings.backendMemoryTokenBudget,
		});
	}

	function invalidatePreviewRequest(): void {
		previewRequestId += 1;
		previewLoading = false;
	}

	const previewIsStale = $derived.by(() => {
		const snapshot = previewSnapshot;
		const currentStory = story.currentStory;
		if (!preview || !snapshot || !currentStory?.serverStoryId) return false;
		return snapshot.rawInput !== inputValue.trim()
			|| snapshot.actionType !== actionType
			|| snapshot.storyId !== currentStory.serverStoryId
			|| snapshot.serverVersion !== (currentStory.serverVersion ?? 0)
			|| snapshot.settingsKey !== previewSettingsKey()
			|| snapshot.creativeMode !== isCreativeMode;
	});

	function setInputDraft(value: string): void {
		invalidatePreviewRequest();
		draftEdited = true;
		draftRevision += 1;
		inputValue = value;
		if (!draftStoryId) return;
		const operation = value
			? setSetting(draftKey(draftStoryId), encodeActionDraft({ text: value, actionType }))
			: deleteSetting(draftKey(draftStoryId));
		operation.catch(error => console.warn('[ActionInput] Failed to persist draft:', error));
	}

	function selectActionType(type: ActionType): void {
		invalidatePreviewRequest();
		actionType = type;
		if (inputValue) setInputDraft(inputValue);
	}

	async function restoreSubmittedDraft(storyId: string, revision: number, text: string, type: ActionType): Promise<void> {
		const stored = draftStoryId === storyId ? null : await getSetting(draftKey(storyId)).catch(() => null);
		const target = failedDraftRestoreTarget({
			submittedStoryId: storyId,
			submittedRevision: revision,
			currentStoryId: draftStoryId,
			currentRevision: draftRevision,
			storedDraftForSubmittedStory: stored,
		});
		if (target === 'composer') {
			actionType = type;
			setInputDraft(text);
		} else if (target === 'storage') {
			await setSetting(draftKey(storyId), encodeActionDraft({ text, actionType: type }))
				.catch(error => console.warn('[ActionInput] Failed to restore draft:', error));
		}
	}

	function handleDraftInput(event: Event): void {
		setInputDraft((event.currentTarget as HTMLTextAreaElement).value);
	}

	$effect(() => {
		const storyId = draftStoryId;
		closePreview();
		const loadVersion = ++draftLoadVersion;
		draftEdited = false;
		inputValue = '';
		actionType = 'do';
		importError = null;
		if (!storyId) return;
		getSetting(draftKey(storyId)).then(value => {
			if (loadVersion === draftLoadVersion && !draftEdited) {
				const draft = decodeActionDraft(value);
				inputValue = draft.text;
				actionType = draft.actionType;
			}
		}).catch(error => console.warn('[ActionInput] Failed to restore draft:', error));
	});

	$effect(() => {
		const serverStoryId = backendStoryId;
		const localStoryId = draftStoryId;
		const version = ++agentLoadVersion;
		agentRun = null;
		inspectedAgentSource = null;
		if (!serverStoryId || !localStoryId) return;
		agentRestoring = true;
		void (async () => {
			try {
				const current = await currentBackendAgentRun(serverStoryId);
				const storedId = localStorage.getItem(`mythengine:agent-run:${serverStoryId}`);
				const recovered = current ?? (storedId ? await getBackendAgentRun(serverStoryId, storedId) : null);
				if (version !== agentLoadVersion || draftStoryId !== localStoryId) return;
				if (recovered) await acceptAgentRun(recovered, localStoryId);
			} catch (error) {
				if (version === agentLoadVersion) turnError = `Could not restore the pending turn: ${error instanceof Error ? error.message : String(error)}`;
			} finally {
				if (version === agentLoadVersion) agentRestoring = false;
			}
		})();
	});

	// ── Player scheme declaration (Declare Plan modal) ──
	let showPlanModal = $state(false);
	let planText = $state('');
	let planSubmitting = $state(false);
	let planError = $state<string | null>(null);
	let planInputElement = $state<HTMLTextAreaElement | null>(null);
	let planReturnFocus: HTMLElement | null = null;

	// Listen for injected text from suggestion/choice chips
	$effect(() => {
		function onInject(e: Event) {
			const detail = (e as CustomEvent<InjectedInput>).detail;
			const text = typeof detail === 'string' ? detail : detail?.text;
			if (!text) return;
			if (typeof detail === 'object' && detail.actionType) actionType = detail.actionType;
			setInputDraft(text);
			requestAnimationFrame(() => inputElement?.focus());
		}
		window.addEventListener('mtherios:inject-input', onInject);
		return () => window.removeEventListener('mtherios:inject-input', onInject);
	});

	const isCreativeMode = $derived(story.storyMode === 'creative-writing');

	const storyServerUnavailable = $derived(Boolean(
		backendTurnEnabled &&
		story.currentStory?.syncStatus === 'offline' &&
		!story.engineStreamStatus.connected,
	));
	const sendBlocked = $derived(!online || localOnlyStory || importingStory || story.hydratingWorld || storyServerUnavailable || agentRestoring || agentBusy || (agentRun !== null && ['running', 'awaiting_input', 'committing'].includes(agentRun.status)));
	const activeAgentRun = $derived(agentRun !== null && ['running', 'awaiting_input', 'committing'].includes(agentRun.status));
	const startingAgentRun = $derived(startingTurn && !activeAgentRun);
	const pendingInteraction = $derived(agentRun?.interactions.find(interaction => interaction.status === 'pending'));
	const turnStatusTitle = $derived(agentRestoring ? 'Restoring your turn' : startingAgentRun ? 'Starting your turn' : agentRun ? {
		running: 'The Game Master is at work',
		awaiting_input: pendingInteraction?.kind === 'roll' ? 'Your roll is needed' : 'Your choice is needed',
		committing: 'Saving your next passage',
		completed: 'Ready for your next move',
		failed: 'This turn needs attention',
		cancelled: 'Turn stopped',
	}[agentRun.status] : '');
	const turnStatusHint = $derived(agentRestoring ? 'Checking saved progress before you continue.' : startingAgentRun ? 'Connecting your move to the saved story.' : agentRun ? {
		running: 'You can keep drafting while the world responds.',
		awaiting_input: 'Answer below to continue this saved turn.',
		committing: 'The outcome is being added to your story.',
		completed: 'The previous turn is complete.',
		failed: 'Review the message below before trying again.',
		cancelled: 'You can prepare another move below.',
	}[agentRun.status] : '');

	async function acceptAgentRun(snapshot: BackendAgentRun, localStoryId: string): Promise<void> {
		if (draftStoryId !== localStoryId || story.currentStory?.serverStoryId !== snapshot.gameId) return;
		agentRun = snapshot;
		localStorage.setItem(`mythengine:agent-run:${snapshot.gameId}`, snapshot.id);
		const turn = completedBackendAgentTurn(snapshot);
		if (turn) {
			if (hydratedAgentRunId !== snapshot.id && (story.currentStory?.serverVersion ?? 0) < turn.serverVersion) {
				hydratedAgentRunId = snapshot.id;
				await story.applyBackendTurnResponse(turn, localStoryId);
			}
			localStorage.removeItem(`mythengine:agent-run:${snapshot.gameId}`);
			if (pendingSubmission?.runId === snapshot.id) pendingSubmission = null;
			if (followedAgentRunId === snapshot.id) {
				followedAgentRunId = '';
				onTurnClear?.();
				onTurnEnd?.(turn.narration);
			}
		} else if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
			localStorage.removeItem(`mythengine:agent-run:${snapshot.gameId}`);
			if (followedAgentRunId === snapshot.id) followedAgentRunId = '';
			turnError = snapshot.error ?? `Turn ${snapshot.status}.`;
			const submission = pendingSubmission?.runId === snapshot.id ? pendingSubmission : null;
			if (submission) {
				pendingSubmission = null;
				await restoreSubmittedDraft(submission.storyId, submission.revision, submission.text, submission.actionType);
			}
		}
	}

	$effect(() => {
		const snapshot = agentRun;
		if (!snapshot || !['running', 'committing'].includes(snapshot.status)) return;
		const localStoryId = draftStoryId;
		const timer = setTimeout(() => {
			void getBackendAgentRun(snapshot.gameId, snapshot.id)
				.then(next => acceptAgentRun(next, localStoryId))
				.catch(error => { if (draftStoryId === localStoryId) turnError = error instanceof Error ? error.message : String(error); });
		}, 2000);
		return () => clearTimeout(timer);
	});

	const agentStreamRunId = $derived(agentRun && ['running', 'awaiting_input', 'committing'].includes(agentRun.status) ? agentRun.id : '');
	const agentStreamGameId = $derived(agentRun && ['running', 'awaiting_input', 'committing'].includes(agentRun.status) ? agentRun.gameId : '');
	$effect(() => {
		const runId = agentStreamRunId, gameId = agentStreamGameId;
		if (!runId || !gameId || typeof EventSource === 'undefined') return;
		const cursorKey = `mythengine:agent-cursor:${runId}`;
		const after = Number(localStorage.getItem(cursorKey) ?? 0);
		const stream = openBackendAgentRunStream(gameId, runId, after, event => {
			if (agentRun?.id !== runId || story.currentStory?.serverStoryId !== gameId) return;
			const merged = new Map(agentRun.activity.map(item => [item.seq, item]));
			merged.set(event.seq, event);
			agentRun = { ...agentRun, activity: [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-80) };
			localStorage.setItem(cursorKey, String(event.seq));
		}, () => {
			if (agentRun?.id !== runId) return;
			const localStoryId = draftStoryId;
			void getBackendAgentRun(gameId, runId).then(snapshot => acceptAgentRun(snapshot, localStoryId))
				.catch(error => { if (agentRun?.id === runId) turnError = error instanceof Error ? error.message : String(error); });
		});
		return () => stream.close();
	});

	function agentActivityLabel(event: BackendAgentActivity) {
		const tool = typeof event.data.tool === 'string' ? event.data.tool : 'tool';
		if (event.event_type === 'tool.reserved') return `Running ${tool}`;
		if (event.event_type === 'tool.completed') return `Finished ${tool}`;
		if (event.event_type === 'provider.requested') return `Model request ${event.data.index ?? ''} · ${event.data.model ?? 'configured model'}`;
		if (event.event_type === 'context.compacted') return `Context compacted · ${event.data.omittedCount ?? (Array.isArray(event.data.omitted) ? event.data.omitted.length : 0)} older results omitted`;
		if (event.event_type === 'runtime.checkpoint') return `Saved ${event.data.stage ?? 'agent'} progress`;
		if (event.event_type === 'runtime.handoff') return 'Investigation finished · reserved budget for narration';
		return event.event_type.replaceAll('.', ' ');
	}

	async function stopAgentRun() {
		const current = agentRun;
		if (!current || agentBusy) return;
		agentBusy = true;
		try { await acceptAgentRun(await cancelBackendAgentRun(current.gameId, current.id), draftStoryId); }
		catch (error) { turnError = error instanceof Error ? error.message : String(error); }
		finally { agentBusy = false; }
	}

	async function openAgentSource(source: BackendAgentSource) {
		const current = agentRun;
		const projectId = current?.projectId ?? story.currentStory?.shelfId;
		if (!current || !projectId) return;
		try {
			const read = await readBackendAgentSource(projectId, current.gameId, source);
			if (agentRun?.id === current.id) inspectedAgentSource = { source, text: read.text };
		} catch (error) { turnError = error instanceof Error ? error.message : String(error); }
	}

	async function answerAgentInteraction(interaction: BackendAgentInteraction, response: { optionId?: string; text?: string; roll?: true }): Promise<void> {
		const current = agentRun;
		if (!current || agentBusy || interaction.status !== 'pending') return;
		agentBusy = true;
		turnError = null;
		followedAgentRunId = current.id;
		onTurnStart?.();
		try {
			const next = await respondBackendAgentRun(current.gameId, current.id, interaction.id, interaction.revision, response);
			await acceptAgentRun(next, draftStoryId);
			if (!completedBackendAgentTurn(next)) onTurnEnd?.('');
			customAnswer = '';
		} catch (error) {
			onTurnEnd?.('');
			turnError = error instanceof Error ? error.message : String(error);
			await getBackendAgentRun(current.gameId, current.id).then(value => acceptAgentRun(value, draftStoryId)).catch(() => {});
		} finally {
			agentBusy = false;
		}
	}

	function answeredQuestion(interaction: BackendAgentInteraction): string {
		const response = interaction.response;
		if (!response || typeof response !== 'object') return '';
		const answer = response as { optionId?: string; text?: string };
		return answer.text ?? interaction.options.find(option => option.id === answer.optionId)?.label ?? '';
	}

	onMount(() => {
		online = navigator.onLine;
		const updateOnline = () => online = navigator.onLine;
		window.addEventListener('online', updateOnline);
		window.addEventListener('offline', updateOnline);
		return () => {
			window.removeEventListener('online', updateOnline);
			window.removeEventListener('offline', updateOnline);
		};
	});

	async function importLocalStory(): Promise<void> {
		if (importingStory || !story.currentStory) return;
		importingStory = true;
		importError = null;
		try {
			// The draft is saved under the local story ID, which the import keeps.
			await story.importCurrentStoryToServer();
		} catch (error) {
			importError = error instanceof Error ? error.message : String(error);
		} finally {
			importingStory = false;
		}
	}

	function buildBackendClientContext(currentActionText: string) {
		return buildBackendClientContextHint({
			characters: story.characters,
			locations: story.locations,
			entries: story.entries,
			promptEntries: story.promptEntries,
			currentActionText,
			backendMemoryTokenBudget: settings.uiSettings.backendMemoryTokenBudget,
			contextBudget: settings.contextBudget,
			recentDialogueTurns: settings.uiSettings.recentDialogueTurns,
		});
	}

	function buildSubmittedContent(rawInput: string, selectedActionType: ActionType): string {
		if (turnActionTypeForInput(rawInput, selectedActionType) === 'ooc' || isCreativeMode) return rawInput;
		return buildActionContent(rawInput, selectedActionType, {
			thirdPerson: pov === 'third',
			protagonistName,
		});
	}

	async function previewNextTurn(): Promise<void> {
		const currentStory = story.currentStory;
		const serverStoryId = backendStoryId;
		if (!inputValue.trim() || previewLoading || !serverStoryId || sendBlocked || !currentStory) return;
		const requestId = ++previewRequestId;
		const rawInput = inputValue.trim();
		const content = buildSubmittedContent(rawInput, actionType);
		previewSnapshot = {
			rawInput,
			actionType,
			storyId: serverStoryId,
			serverVersion: currentStory.serverVersion ?? 0,
			settingsKey: previewSettingsKey(),
			creativeMode: isCreativeMode,
		};
		previewLoading = true;
		previewError = null;
		try {
			const result = await previewBackendTurn({
				storyId: serverStoryId,
				clientTurnId: `preview_${crypto.randomUUID()}`,
				playerText: content,
				actionType: turnActionTypeForInput(rawInput, actionType),
				localVersion: currentStory.serverVersion ?? 0,
				clientContext: buildBackendClientContext(content),
			});
			if (requestId === previewRequestId) preview = result;
		} catch (error) {
			if (requestId === previewRequestId) previewError = error instanceof Error ? error.message : String(error);
		} finally {
			if (requestId === previewRequestId) previewLoading = false;
		}
	}

	async function openEvidence(position: number | null): Promise<void> {
		if (position == null || !backendStoryId) return;
		evidencePosition = position;
		evidenceLoading = true;
		evidenceError = null;
		try {
			evidenceEntries = (await fetchBackendEntriesAround(backendStoryId, position, 2)).entries;
		} catch (error) {
			evidenceEntries = [];
			evidenceError = error instanceof Error ? error.message : String(error);
		} finally {
			evidenceLoading = false;
		}
	}

	function closePreview(): void {
		invalidatePreviewRequest();
		preview = null;
		previewSnapshot = null;
		evidenceEntries = [];
		evidencePosition = null;
		evidenceError = null;
		const returnFocus = previewReturnFocus;
		previewReturnFocus = null;
		requestAnimationFrame(() => returnFocus?.isConnected && returnFocus.focus());
	}

	function requestPreview(): void {
		if (!preview) previewReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : previewButton;
		void previewNextTurn();
	}

	const actionConfig: Record<ActionType, {
		icon: typeof Wand2;
		label: string;
		placeholder: string;
	}> = {
		do: {
			icon: Wand2, label: 'Do', placeholder: 'What do you do?',
		},
		say: {
			icon: MessageSquare, label: 'Say', placeholder: 'What do you say?',
		},
		think: {
			icon: Brain, label: 'Think', placeholder: 'Private thought — NPCs cannot hear it',
		},
		story: {
			icon: Sparkles, label: 'Story', placeholder: 'Describe what happens...',
		},
		pov: {
			icon: BookOpen, label: 'POV', placeholder: 'Character name | optional focus for the interlude',
		},
		free: {
			icon: PenLine, label: 'Roleplay', placeholder: 'Mix dialogue, action, and intent...',
		},
	};

	const actionTypes: ActionType[] = ['do', 'say', 'think', 'story', 'pov', 'free'];

	// POV-based prefixes
	const protagonistName = $derived(story.protagonist?.name ?? 'The protagonist');
	const pov = $derived(story.pov);

	/** Player /roll command — a standalone dice roll saved as a system entry, no narration. */
	async function handlePlayerRoll(rawInput: string): Promise<boolean> {
		const notation = parseRollCommand(rawInput);
		if (!notation) return false;
		await story.addEntry('system', `Roll: ${formatRollText(rollDice(notation))}`);
		return true;
	}

	async function handleSubmit() {
		if (!inputValue.trim() || startingTurn || !story.currentStory || sendBlocked) return;

		const submittedInput = inputValue;
		const submittedActionType = actionType;
		const rawInput = submittedInput.trim();
		turnError = null;
		const submittedStoryId = draftStoryId;
		setInputDraft('');
		const submittedDraftRevision = draftRevision;
		const restoreDraft = () => restoreSubmittedDraft(submittedStoryId, submittedDraftRevision, submittedInput, submittedActionType);

		if (/^\/roll\s/i.test(rawInput)) {
			try {
				if (!await handlePlayerRoll(rawInput)) {
					await restoreDraft();
					turnError = 'Use /roll with dice notation, such as /roll 2d6+1.';
				}
			} catch (error) {
				await restoreDraft();
				turnError = error instanceof Error ? error.message : String(error);
			}
			return;
		}

		// /plan <free text> — declare a player scheme inline (no narrator turn).
		const planMatch = rawInput.match(/^\/plan\s+([\s\S]+)$/i);
		if (planMatch) {
			if (!await submitPlayerPlan(planMatch[1].trim())) {
				await restoreDraft();
				if (draftStoryId === submittedStoryId) turnError = `Plan not declared: ${planError ?? 'try again.'}`;
			}
			return;
		}

		await submitServerTurn(buildSubmittedContent(rawInput, submittedActionType), submittedInput, submittedActionType, submittedStoryId, submittedDraftRevision);
	}

	async function submitServerTurn(content: string, submittedInput: string, submittedActionType: ActionType, submittedStoryId: string, submittedDraftRevision: number): Promise<void> {
		const serverStoryId = backendStoryId;
		if (!serverStoryId) return;
		const clientContext = buildBackendClientContext(content);
		const clientTurnId = crypto.randomUUID();

		startingTurn = true;
		onTurnStart?.();
		try {
			const outcome = await startServerTurn<BackendAgentRun>({
				serverStoryId,
				clientTurnId,
				stillSelected: () => draftStoryId === submittedStoryId,
				prepare: async () => {
					const current = await story.prepareBackendAgentTurn();
					return { serverStoryId: current.serverStoryId ?? serverStoryId, serverVersion: current.serverVersion ?? 0 };
				},
				start: request => startBackendAgentRun({
					...request,
					playerText: content,
					actionType: turnActionTypeForInput(submittedInput, submittedActionType),
					clientContext,
				}),
				current: currentBackendAgentRun,
			});
			if ((outcome.kind === 'run' && outcome.restoreDraft) || outcome.kind === 'failed') {
				await restoreSubmittedDraft(submittedStoryId, submittedDraftRevision, submittedInput, submittedActionType);
			}
			if (outcome.kind === 'run' && !outcome.storyChanged) {
				followedAgentRunId = outcome.run.id;
				if (!outcome.restoreDraft) {
					pendingSubmission = { runId: outcome.run.id, storyId: submittedStoryId, revision: submittedDraftRevision, text: submittedInput, actionType: submittedActionType };
				}
				await acceptAgentRun(outcome.run, submittedStoryId);
				if (!completedBackendAgentTurn(outcome.run)) onTurnEnd?.('');
				return;
			}
			if (outcome.kind === 'run') {
				// The player switched stories; keep the run discoverable for that story's composer.
				if (!completedBackendAgentTurn(outcome.run)) {
					localStorage.setItem(`mythengine:agent-run:${outcome.run.gameId}`, outcome.run.id);
					if (!outcome.restoreDraft) pendingSubmission = { runId: outcome.run.id, storyId: submittedStoryId, revision: submittedDraftRevision, text: submittedInput, actionType: submittedActionType };
				}
			} else {
				const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
				const unreachable = isTerminalReachabilityError(outcome.error);
				console.warn(unreachable
					? '[ServerTurn] Story server unavailable; the move was not queued:'
					: '[ServerTurn] Turn did not start; the move was not queued:', outcome.error);
				if (!outcome.storyChanged) {
					turnError = unreachable
						? `Couldn't reach the story server, so your move wasn't sent. ${message}`
						: `Your move couldn't start: ${message}`;
				}
			}
			onTurnClear?.();
			onTurnEnd?.('');
		} finally {
			startingTurn = false;
		}
	}

	function openModeSheet(): void {
		modeSheetOpen = true;
		requestAnimationFrame(() => {
			modeSheetDialog?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
		});
	}

	function closeModeSheet(returnFocus = true): void {
		modeSheetOpen = false;
		if (returnFocus) requestAnimationFrame(() => (modeSheetTrigger?.isConnected ? modeSheetTrigger : inputElement)?.focus());
	}

	function handleModeSheetKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeModeSheet();
			return;
		}
		if (event.key !== 'Tab' || !modeSheetDialog) return;
		const controls = [...modeSheetDialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
		if (controls.length === 0) return;
		const current = controls.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.shiftKey
			? (current <= 0 ? controls.length - 1 : current - 1)
			: (current === controls.length - 1 ? 0 : current + 1);
		if (current === -1 || next !== current + (event.shiftKey ? -1 : 1)) {
			event.preventDefault();
			controls[next]?.focus();
		}
	}

	/** Structures and saves a player plan. Failures stay in the composer, not the transcript. */
	async function submitPlayerPlan(text: string): Promise<boolean> {
		if (!text.trim() || !story.currentStory || !backendTurnEnabled) return false;
		planSubmitting = true;
		planError = null;
		try {
			const { scheme, error } = await declarePlayerScheme(text);
			if (error || !scheme) {
				planError = error ?? 'Failed to declare plan.';
				return false;
			}
			const stageList = scheme.stages
				.map((s, i) => `  ${i + 1}. ${s.label}`)
				.join('\n');
			await story.addEntry(
				'system',
				`Plan declared — "${scheme.goal}"\nStages:\n${stageList}`,
			);
			showPlanModal = false;
			planText = '';
			return true;
		} catch (e) {
			planError = e instanceof Error ? e.message : String(e);
			return false;
		} finally {
			planSubmitting = false;
		}
	}

	async function submitPlanFromModal() {
		await submitPlayerPlan(planText);
	}

	function openPlanModal() {
		planReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		planError = null;
		showPlanModal = true;
		requestAnimationFrame(() => planInputElement?.focus());
	}

	function closePlanModal() {
		if (planSubmitting) return;
		showPlanModal = false;
		planText = '';
		planError = null;
		requestAnimationFrame(() => {
			const fallback = document.querySelector<HTMLButtonElement>('button[aria-label^="Choose action mode"]');
			(planReturnFocus?.isConnected ? planReturnFocus : fallback)?.focus();
		});
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.isComposing || e.keyCode === 229 || e.repeat) return;
		// Coarse-pointer devices use Shift+Enter to avoid accidental mobile submits.
		const isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
		const shouldSubmit = isMobile
			? e.key === 'Enter' && e.shiftKey
			: e.key === 'Enter' && !e.shiftKey;
		if (shouldSubmit) {
			e.preventDefault();
			handleSubmit();
		}
	}
</script>

{#if preview}
	<div class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="presentation">
		<div class="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5 pb-[max(env(safe-area-inset-bottom),20px)] shadow-2xl sm:rounded-xl sm:pb-5" role="dialog" aria-modal="true" aria-labelledby="turn-preview-title">
			<div class="mb-4 flex items-start justify-between gap-3">
				<div>
					<h2 id="turn-preview-title" class="flex items-center gap-2 font-display text-2xl font-medium text-[var(--text-primary)]"><BookOpen class="h-5 w-5 text-[var(--text-accent)]" />Next turn context</h2>
					<p class="mt-1 text-xs text-[var(--text-muted)]">Context before GM tool observations. This inspection is read-only and does not send the turn.</p>
				</div>
				<button onclick={closePreview} class="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]" aria-label="Close context preview"><X class="h-4 w-4" /></button>
			</div>
			{#if previewIsStale}
				<div class="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-200" role="status">
					<span>This preview is stale because the draft, settings, or campaign changed.</span>
					<button onclick={previewNextTurn} disabled={previewLoading} class="shrink-0 rounded px-2 py-1 font-medium text-amber-100 hover:bg-amber-200/10 disabled:opacity-50">Refresh</button>
				</div>
			{/if}
			<div class="grid gap-2 text-xs sm:grid-cols-3">
				<div class="rounded-lg border border-[var(--border-primary)] p-3"><span class="block text-[var(--text-muted)]">Model</span><strong class="text-[var(--text-primary)]">{preview.model.id ?? 'Default'} </strong><span class="block text-[var(--text-muted)]">{preview.model.capacityTokens.toLocaleString()} token capacity · {preview.model.capacitySource}</span></div>
				<div class="rounded-lg border border-[var(--border-primary)] p-3"><span class="block text-[var(--text-muted)]">Preparation</span><strong class="text-[var(--text-primary)]">{preview.preparationMs} ms</strong><span class="block text-[var(--text-muted)]">{preview.prompt.tokenEstimate.toLocaleString()} estimated input tokens</span></div>
				<div class="rounded-lg border border-[var(--border-primary)] p-3"><span class="block text-[var(--text-muted)]">Budgets</span><strong class="text-[var(--text-primary)]">{preview.budgets.contextTokens.toLocaleString()} context</strong><span class="block text-[var(--text-muted)]">{preview.budgets.recentDialogueTurns != null ? `${preview.budgets.recentDialogueTurns} dialogue turns` : `${preview.budgets.recentDialogueTokens.toLocaleString()} dialogue tokens`} · {preview.budgets.memoryTokens.toLocaleString()} memory tokens</span></div>
			</div>
			<div class="mt-4 rounded-lg border border-[var(--border-primary)] p-3">
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Request sections</h3>
				<div class="space-y-2">
					{#each preview.selection.sections as section}
						<div class="flex items-center justify-between gap-3 text-xs"><span class="text-[var(--text-secondary)]">{section.label}</span><span class="tabular-nums text-[var(--text-primary)]">~{section.tokens.toLocaleString()} tokens</span></div>
					{/each}
				</div>
			</div>
			<div class="mt-4 rounded-lg border border-[var(--border-primary)] p-3">
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Selected evidence</h3>
				<div class="max-h-56 space-y-1 overflow-y-auto">
					{#each preview.sourceReferences.slice(0, 80) as source}
						<div class="flex items-center justify-between gap-3 border-b border-[var(--border-secondary)] py-1.5 text-xs last:border-0"><span class="min-w-0 truncate text-[var(--text-secondary)]" title={source.id}>{source.kind} · {source.id}</span><span class="flex shrink-0 items-center gap-2"><span class="text-[var(--text-muted)]">{source.status}</span>{#if source.position !== null}<button class="rounded px-2 py-1 text-[var(--text-accent)] hover:bg-[var(--bg-tertiary)]" onclick={() => openEvidence(source.position)}>Open source</button>{/if}</span></div>
					{:else}
						<p class="text-xs text-[var(--text-muted)]">No source references reached the request.</p>
					{/each}
				</div>
			</div>
			{#if evidencePosition !== null}
				<div class="mt-4 rounded-lg border border-[var(--text-accent)]/40 bg-[var(--bg-tertiary)]/40 p-3">
					<div class="mb-2 flex items-center justify-between"><h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Original evidence near position {evidencePosition}</h3>{#if evidenceLoading}<Loader2 class="h-3.5 w-3.5 animate-spin text-[var(--text-accent)]" />{/if}</div>
					{#if evidenceError}<p class="text-xs text-amber-300">{evidenceError}</p>{:else if evidenceEntries.length === 0 && !evidenceLoading}<p class="text-xs text-[var(--text-muted)]">No visible transcript evidence was returned.</p>{:else}<div class="space-y-3">{#each evidenceEntries as entry}<article class="border-l-2 border-[var(--border-primary)] pl-3"><div class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Position {String(entry.position ?? '?')} · {String(entry.type ?? 'entry')}</div><p class="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">{String(entry.content ?? '').slice(0, 1600)}</p></article>{/each}</div>{/if}
				</div>
			{/if}
			{#if preview.warnings.length}<p class="mt-3 text-xs text-amber-300">{preview.warnings.join(' ')}</p>{/if}
		</div>
	</div>
{/if}

{#if showPlanModal}
	<div
		class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
		onclick={closePlanModal}
		onkeydown={(e) => e.key === 'Escape' && closePlanModal()}
		role="presentation"
	>
		<div
			class="max-h-[100dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5 pb-[max(env(safe-area-inset-bottom),20px)] shadow-2xl sm:rounded-xl sm:pb-5"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => {
				e.stopPropagation();
				if (e.key === 'Escape') closePlanModal();
			}}
			role="dialog"
			aria-modal="true"
			aria-labelledby="plan-modal-title"
			tabindex="-1"
		>
			<div class="mb-3 flex items-start justify-between gap-3">
				<div>
					<h2 id="plan-modal-title" class="flex items-center gap-2 font-display text-2xl font-medium text-[var(--text-primary)]">
						<Target class="h-5 w-5 text-[var(--text-accent)]" />
						Declare a Plan
					</h2>
					<p class="mt-1 text-xs text-[var(--text-muted)]">
						Describe what you intend to do. The system breaks it into stages — obstacles
						and opportunities the narrator will surface as you play. Plans are intent,
						not guarantees.
					</p>
				</div>
				<button
					onclick={closePlanModal}
					disabled={planSubmitting}
					class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-all hover:bg-[var(--color-surface-600)]/30 hover:text-[var(--text-primary)] disabled:opacity-30 sm:h-8 sm:w-8"
					aria-label="Close"
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			<textarea
				bind:this={planInputElement}
				bind:value={planText}
				placeholder="e.g. I plan to poison Lord Frey at the wedding feast — but I'll need to find an alchemist first, and bribe a serving girl to switch the cups…"
				rows="5"
				disabled={planSubmitting}
				class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--text-accent)] focus:outline-none disabled:opacity-50"
			></textarea>

			{#if planError}
				<p class="mt-2 text-xs text-red-400">{planError}</p>
			{/if}

			<div class="mt-4 flex items-center justify-end gap-2">
				<button
					onclick={closePlanModal}
					disabled={planSubmitting}
					class="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-all hover:text-[var(--text-primary)] disabled:opacity-30"
				>
					Cancel
				</button>
				<button
					onclick={submitPlanFromModal}
					disabled={!planText.trim() || planSubmitting}
					class="flex items-center gap-1.5 rounded-lg bg-[var(--text-accent)]/15 px-3 py-1.5 text-xs font-medium text-[var(--text-accent)] transition-all hover:bg-[var(--text-accent)]/25 disabled:opacity-30"
				>
					{#if planSubmitting}
						<Loader2 class="h-3.5 w-3.5 animate-spin" />
						Structuring…
					{:else}
						<Target class="h-3.5 w-3.5" />
						Declare
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if modeSheetOpen}
	<div class="fixed inset-0 z-50 flex items-end bg-black/55 sm:hidden" role="presentation">
		<button class="absolute inset-0" onclick={() => closeModeSheet()} aria-label="Close action mode menu"></button>
		<div bind:this={modeSheetDialog} onkeydown={handleModeSheetKeydown} tabindex="-1" class="relative z-10 w-full rounded-t-[1.75rem] border border-white/10 bg-[var(--bg-secondary)] p-4 pb-[max(env(safe-area-inset-bottom),16px)] shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="action-mode-title">
			<div class="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20"></div>
			<div class="mb-2 flex items-center justify-between"><h2 id="action-mode-title" class="font-semibold text-[var(--text-primary)]">How will you act?</h2><button class="flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-muted)]" onclick={() => closeModeSheet()} aria-label="Close action mode menu"><X class="h-5 w-5" /></button></div>
			<div class="grid grid-cols-2 gap-2">
				{#each actionTypes as type}
					{@const config = actionConfig[type]}
					<button class="flex min-h-14 items-center gap-3 rounded-xl px-4 text-left {actionType === type ? 'bg-[var(--text-accent)] text-[#09090b]' : 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'}" onclick={() => { selectActionType(type); closeModeSheet(); }} aria-pressed={actionType === type}>
						<config.icon class="h-4 w-4" /><span><strong class="block text-sm">{config.label === 'Story' ? 'Narrate / Story' : config.label}</strong><small class="block opacity-70">{config.placeholder}</small></span>
					</button>
				{/each}
				<button class="flex min-h-14 items-center gap-3 rounded-xl bg-[var(--bg-tertiary)] px-4 text-left text-[var(--text-primary)]" onclick={() => { closeModeSheet(false); openPlanModal(); }} disabled={startingTurn || planSubmitting || localOnlyStory}>
					<Target class="h-4 w-4 text-[var(--text-accent)]" /><span><strong class="block text-sm">Declare Plan</strong><small class="block text-[var(--text-muted)]">Structure a longer intent</small></span>
				</button>
			</div>
		</div>
	</div>
{/if}

<div class="turn-composer">
	{#if agentRestoring || agentRun || startingAgentRun}
		<div class="turn-status-strip" class:needs-answer={agentRun?.status === 'awaiting_input'} class:needs-attention={agentRun?.status === 'failed'}>
			<span class="turn-status-icon" aria-hidden="true">
				{#if agentRestoring || startingAgentRun || agentRun?.status === 'running' || agentRun?.status === 'committing'}<Loader2 size={17} class="animate-spin" />
				{:else if agentRun?.status === 'awaiting_input'}<MessageSquare size={17} />
				{:else}<BookOpen size={17} />{/if}
			</span>
			<div class="turn-status-copy" role="status" aria-live="polite" aria-atomic="true"><strong>{turnStatusTitle}</strong><span>{turnStatusHint}</span></div>
			{#if activeAgentRun}<button type="button" onclick={stopAgentRun} disabled={agentBusy || !online} class="turn-stop" aria-label="Stop this turn" title={!online ? 'Reconnect to stop this turn' : 'Stop this saved turn'}><Square size={12} /><span>Stop</span></button>{/if}
		</div>
	{/if}
	<div class="turn-support">
	{#if agentRun && agentRun.status !== 'completed'}
		<div class="turn-interactions" aria-label="Game Master interactions">
			{#each agentRun.interactions as interaction (interaction.id)}
				{#if interaction.kind === 'question'}
					<section class="turn-question" aria-label={interaction.status === 'pending' ? 'Your choice' : 'Previous choice'}>
						<span class="question-eyebrow">{interaction.status === 'pending' ? 'Your choice' : 'Previous choice'}</span>
						<div class="question-prompt">{interaction.prompt}</div>
						{#if interaction.status === 'pending'}
							<div class="question-options">
								{#each interaction.options as option (option.id)}
									<button type="button" disabled={agentBusy || !online} onclick={() => answerAgentInteraction(interaction, { optionId: option.id })} class="question-option">{option.label}</button>
								{/each}
							</div>
							{#if interaction.options_meta.allowCustom}
								<div class="question-custom">
									<input aria-label="Custom answer" placeholder="Or write your own answer…" bind:value={customAnswer} maxlength="1000" />
									<button type="button" disabled={agentBusy || !online || !customAnswer.trim()} onclick={() => answerAgentInteraction(interaction, { text: customAnswer.trim() })} class="question-submit">Answer</button>
								</div>
							{/if}
						{:else if interaction.status === 'answered'}
							<div class="mt-1 text-xs text-[var(--text-secondary)]">Answered: {answeredQuestion(interaction)}</div>
						{:else}<p class="question-closed">This question is {interaction.status}.</p>
						{/if}
					</section>
				{:else if interaction.kind === 'roll'}
					{#if interaction.status === 'pending'}
						<section class="turn-question" aria-label="Your dice roll">
							<span class="question-eyebrow">Your dice roll</span>
							<div class="question-prompt">{interaction.prompt}</div>
							<div class="mt-1 text-xs text-[var(--text-muted)]">{interaction.options_meta.targetCharacterName ? `${String(interaction.options_meta.targetCharacterName)} · ` : ''}{interaction.options_meta.skillName ? `${String(interaction.options_meta.skillName)} · ` : ''}{String(interaction.options_meta.diceExpression ?? '')}</div>
							<button type="button" disabled={agentBusy || !online} onclick={() => answerAgentInteraction(interaction, { roll: true })} class="question-submit mt-3">Roll dice</button>
						</section>
					{:else if interaction.status === 'answered' && readBackendDiceRoll(interaction.response)}
						<DiceRollCard actor={readBackendDiceRoll(interaction.response)?.targetCharacterName ?? 'Player'} portrait={visibleRollPortrait(story.characters, readBackendDiceRoll(interaction.response)?.targetCharacterId)} roll={readBackendDiceRoll(interaction.response)!} />
					{/if}
				{/if}
			{/each}
			{#each agentRun.rolls as gmRoll (gmRoll.call_id)}
				<DiceRollCard actor="Game Master" portrait={gmRoll.result.portraitUrl ?? null} roll={gmRoll.result} />
			{/each}
			{#each agentRun.images as image (image.call_id)}
				<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-secondary)]" aria-label="Game Master image job"><strong>{image.tool === 'generateFileImage' ? 'File cover' : 'Image'} · {image.job_status ?? 'queued'}</strong>{#if image.job_status === 'complete'}<small> · {imageUsageCostLabel(image.image_usage)}</small>{/if}{#if image.job_error}<p role="alert">{image.job_error}</p>{/if}</section>
			{/each}
			{#each agentRun.research as item (item.call_id)}
				<ResearchEvidenceCard research={item.result} projectId={story.currentStory?.shelfId} gameId={story.currentStory?.serverStoryId} />
			{/each}
		</div>
	{/if}
	{#if agentRun}
		<details class="turn-activity" aria-label="Game Master activity">
			<summary><span>Turn activity &amp; sources</span><span class="activity-count">{agentRun.activity.length} events</span></summary>
			<div class="turn-activity-body">
			<p class="activity-runtime">Runtime: {agentRun.continuation?.runtime ?? 'legacy'} · {agentRun.status}</p>
			{#if agentRun.continuation?.budget}{@const budget = agentRun.continuation.budget}<p class="mt-2">{budget.modelRequests ?? 0} model requests · {budget.toolCalls ?? 0} tool calls · {budget.consumedTokens ?? 0} accounted tokens · {budget.unknownUsage ? 'some usage unknown' : 'usage accounted'}</p>{#if budget.stopReason}<p role="status">Stopped: {String(budget.stopReason)}</p>{/if}{/if}
			{#if agentRun.activity.length}<ol class="mt-2 space-y-1" aria-label="Persisted tool activity">{#each agentRun.activity as event (event.seq)}<li>{agentActivityLabel(event)}</li>{/each}</ol>{/if}
			{#if agentRun.continuation?.receipts?.length}<details class="mt-2"><summary>Model request receipts</summary>{#each agentRun.continuation.receipts as receipt}<p class="mt-1">{receipt.stage ?? 'agent'} · {receipt.model ?? 'configured model'} · {receipt.inputTokens ?? 'unknown'} input / {receipt.reservedOutputTokens ?? 'unknown'} output allowance · {receipt.requestBytes ?? 'unknown'} bytes</p>{#if receipt.requestHash}<code class="block break-all">{receipt.requestHash}</code>{/if}{/each}</details>{/if}
			{#if agentRun.sources.length}<details class="mt-2"><summary>Observed public sources</summary>{#each agentRun.sources as source (source.callId)}<button type="button" onclick={() => openAgentSource(source)} class="mt-1 block text-left underline">{source.path} · lines {source.startLine}-{source.endLine} · revision {source.revision}</button>{/each}</details>{/if}
			</div>
		</details>
	{/if}
	{#if inspectedAgentSource}<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-secondary)]" aria-label="Observed source range"><strong>{inspectedAgentSource.source.path} · lines {inspectedAgentSource.source.startLine}–{inspectedAgentSource.source.endLine}</strong><p>Revision {inspectedAgentSource.source.revision}</p><pre class="max-h-64 overflow-auto whitespace-pre-wrap">{inspectedAgentSource.text}</pre><button type="button" onclick={() => { inspectedAgentSource = null; }} class="mt-2 underline">Close source</button></section>{/if}
	{#if localOnlyStory}
		<div class="composer-notice local-only-notice" role="status">
			<Upload size={15} />
			<span>This story is saved only in this browser. You can read and export it here; import it to the story server to keep playing. Your draft stays in the box.</span>
			<button type="button" class="composer-notice-action" onclick={importLocalStory} disabled={importingStory || !online}>{importingStory ? 'Importing…' : 'Import and continue'}</button>
		</div>
		{#if importError}
			<div class="composer-notice" role="alert">Import failed: {importError}</div>
		{/if}
	{:else if story.hydratingWorld}
		<div class="composer-notice" role="status">
			<Loader2 class="h-3.5 w-3.5 animate-spin" />
			<span>Loading memory and world state...</span>
		</div>
	{:else if story.worldHydrationError}
		<div class="composer-notice" role="alert">
			{#if storyServerUnavailable}
				The story server isn't running. Start Mtherios on this computer to continue this story.
			{:else}
				Memory load had trouble; context may be thin.
			{/if}
		</div>
	{/if}
	{#if turnError}
		<div class="composer-notice" role="alert">{turnError}</div>
	{/if}
	{#if previewError}
		<div class="composer-notice" role="alert">Context preview failed: {previewError}</div>
	{/if}
	{#if !online}
		<div class="composer-notice" role="status"><WifiOff size={15} />Offline — your draft is saved; reconnect to send.</div>
	{/if}
	</div>

	<div class="action-composer">
		{#if !isCreativeMode}
			<div class="composer-modes" role="group" aria-label="Action mode">
				{#each actionTypes as type}
					{@const config = actionConfig[type]}
					<button class="mode-button" onclick={() => selectActionType(type)} title={config.placeholder} aria-pressed={actionType === type}>
						<config.icon class="h-3.5 w-3.5" />
						<span>{config.label}</span>
					</button>
				{/each}
				<button class="mode-button plan-button" onclick={openPlanModal} title="Declare a plan — turn a longer intent into stages" disabled={startingTurn || planSubmitting || localOnlyStory}>
					<Target class="h-3.5 w-3.5" /><span>Plan</span>
				</button>
			</div>
		{/if}
		<textarea
			bind:this={inputElement}
			value={inputValue}
			oninput={handleDraftInput}
			onkeydown={handleKeydown}
			placeholder={isCreativeMode ? 'Describe what happens next...' : actionConfig[actionType].placeholder}
			aria-label={isCreativeMode ? 'Story continuation' : `${actionConfig[actionType].label} input`}
			rows="2"
			class="composer-input"
		></textarea>
		<div class="composer-footer">
			{#if !isCreativeMode}
				{@const ModeIcon = actionConfig[actionType].icon}
				<button bind:this={modeSheetTrigger} class="mobile-mode-button" onclick={openModeSheet} aria-haspopup="dialog" aria-expanded={modeSheetOpen} aria-label="Choose action mode, currently {actionConfig[actionType].label}">
					<ModeIcon class="h-3.5 w-3.5" />{actionConfig[actionType].label}<ChevronDown class="h-3.5 w-3.5" />
				</button>
			{/if}
			<div class="composer-hint">
				{#if activeAgentRun || agentRestoring}
					<span>You can prepare your next move here.</span>
				{:else if startingTurn}
					<Loader2 class="h-3.5 w-3.5 animate-spin" /><span>Sending your move…</span>
				{:else}
					<span class="desktop-shortcut"><kbd>Enter</kbd> to send <span aria-hidden="true">·</span> <kbd>Shift + Enter</kbd> for a new line</span>
					<span class="touch-shortcut">Your next move</span>
				{/if}
			</div>
			{#if activeAgentRun || agentRestoring || startingAgentRun}
				<button class="submit-button pending-button" disabled title={turnStatusTitle}>{#if agentRun?.status === 'awaiting_input'}<MessageSquare size={15} /><span>Answer above</span>{:else}<Loader2 size={15} class="animate-spin" /><span>{agentRestoring ? 'Restoring' : 'Working'}</span>{/if}</button>
			{:else}
				{#if backendTurnEnabled}
					<button bind:this={previewButton} onclick={requestPreview} disabled={!inputValue.trim() || sendBlocked || previewLoading} class="submit-button preview-button" title="Preview the server context for this draft" aria-label="Preview context">
						{#if previewLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<BookOpen class="h-3.5 w-3.5" />{/if}<span>Preview context</span>
					</button>
				{/if}
				<button
					onclick={handleSubmit}
					disabled={!inputValue.trim() || sendBlocked}
					class="submit-button"
					title={localOnlyStory ? 'Import this story to keep playing' : !online ? 'Reconnect to send' : storyServerUnavailable ? 'Story server unavailable' : story.hydratingWorld ? 'Memory is still loading' : 'Send'}
					aria-label="Send turn"
				>
					<span>Send</span><Send class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
	</div>
</div>

<style>
	.turn-composer { display: flex; flex-direction: column; gap: .5rem; max-height: min(65dvh, calc(var(--visual-viewport-height, 100dvh) * .65)); }
	.turn-status-strip { display: flex; align-items: center; gap: .7rem; flex-shrink: 0; padding: .7rem .85rem; border: 1px solid var(--border-secondary); border-radius: .75rem; background: var(--bg-secondary); }
	.turn-status-icon { display: grid; place-items: center; width: 2rem; height: 2rem; flex-shrink: 0; border-radius: .6rem; color: var(--text-accent); background: color-mix(in srgb, var(--text-accent) 9%, transparent); }
	.turn-status-copy { display: grid; gap: .15rem; min-width: 0; flex: 1; }
	.turn-status-copy strong { font-size: .8rem; line-height: 1.35; font-weight: 600; color: var(--text-primary); }
	.turn-status-copy > span { font-size: .69rem; line-height: 1.4; color: var(--text-muted); }
	.needs-answer { border-color: color-mix(in srgb, var(--text-accent) 40%, var(--border-primary)); }
	.needs-attention { border-color: color-mix(in srgb, var(--color-crimson-400) 40%, var(--border-primary)); }
	.turn-stop { display: inline-flex; align-items: center; justify-content: center; gap: .45rem; flex-shrink: 0; min-height: 2.5rem; padding: 0 .8rem; border: 1px solid var(--border-primary); border-radius: .5rem; color: var(--text-primary); font-size: .75rem; }
	.turn-stop:hover:not(:disabled) { border-color: var(--color-crimson-400); color: var(--color-crimson-400); }
	.turn-stop:disabled { opacity: .45; cursor: not-allowed; }
	.turn-support { min-height: 0; max-height: min(28dvh, 18rem); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; border-radius: .75rem; }
	.turn-support:empty { display: none; }
	.turn-support > * + * { margin-top: .5rem; }
	.turn-interactions { display: grid; gap: .5rem; }
	.turn-interactions:empty { display: none; }
	.turn-question { padding: .9rem 1rem; border: 1px solid color-mix(in srgb, var(--text-accent) 30%, var(--border-primary)); border-radius: .75rem; background: color-mix(in srgb, var(--text-accent) 5%, var(--bg-secondary)); }
	.question-eyebrow { display: block; margin-bottom: .4rem; color: var(--text-accent); font-size: .6rem; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; }
	.question-prompt { font-size: .9rem; font-weight: 500; line-height: 1.55; color: var(--text-primary); overflow-wrap: anywhere; }
	.question-options { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
	.question-option { min-height: 2.75rem; padding: .55rem .85rem; border: 1px solid var(--border-primary); border-radius: .5rem; background: var(--bg-secondary); color: var(--text-primary); font-size: .8rem; line-height: 1.45; text-align: left; overflow-wrap: anywhere; }
	.question-option:hover:not(:disabled) { border-color: var(--text-accent); background: var(--bg-tertiary); }
	.question-custom { display: flex; gap: .5rem; margin-top: .65rem; }
	.question-custom input { min-width: 0; flex: 1; padding: .65rem .8rem; border: 1px solid var(--border-primary); border-radius: .5rem; background: var(--bg-primary); color: var(--text-primary); font-size: .8rem; }
	.question-submit { min-height: 2.75rem; padding: .55rem .9rem; border-radius: .5rem; background: var(--text-accent); color: var(--bg-primary); font-size: .8rem; font-weight: 600; }
	.question-option:disabled, .question-submit:disabled { opacity: .45; cursor: not-allowed; }
	.question-closed { margin-top: .4rem; font-size: .75rem; color: var(--text-muted); }
	.turn-activity { border: 1px solid var(--border-secondary); border-radius: .65rem; color: var(--text-secondary); background: var(--bg-secondary); font-size: .75rem; }
	.turn-activity > summary { min-height: 2.65rem; padding: .7rem .85rem; cursor: pointer; color: var(--text-secondary); }
	.activity-count { margin-left: .5rem; color: var(--text-muted); font-size: .65rem; }
	.turn-activity-body { padding: 0 .9rem .9rem; overflow-wrap: anywhere; line-height: 1.6; }
	.turn-activity-body :global(summary) { cursor: pointer; padding-block: .25rem; }
	.turn-activity-body ol { border-left: 1px solid var(--border-primary); padding-left: .85rem; }
	.activity-runtime { color: var(--text-muted); font-size: .68rem; }
	.composer-notice { display: flex; align-items: flex-start; gap: .5rem; padding: .6rem .85rem; border: 1px solid var(--border-primary); border-radius: .6rem; color: var(--text-secondary); background: var(--bg-secondary); font-size: .75rem; line-height: 1.5; overflow-wrap: anywhere; }
	.composer-notice-action { flex-shrink: 0; margin-left: auto; min-height: 2.25rem; padding: 0 .75rem; border-radius: .5rem; background: var(--text-accent); color: var(--bg-primary); font-size: .75rem; font-weight: 600; }
	.composer-notice-action:disabled { opacity: .45; cursor: not-allowed; }
	.local-only-notice { align-items: center; }
	.composer-notice[role='alert'] { color: var(--text-accent); border-color: color-mix(in srgb, var(--text-accent) 35%, var(--border-primary)); }
	.turn-composer :is(button, summary, input):focus-visible { outline: 2px solid var(--text-accent); outline-offset: 3px; }
	.action-composer {
		flex-shrink: 0;
		overflow: hidden;
		border: 1px solid var(--border-primary);
		border-radius: 1rem;
		background: var(--bg-secondary);
		box-shadow: 0 8px 28px rgb(0 0 0 / 0.08);
		transition: border-color 160ms ease, box-shadow 160ms ease;
	}
	.action-composer:focus-within {
		border-color: color-mix(in srgb, var(--text-accent) 65%, var(--border-primary));
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--text-accent) 8%, transparent);
	}
	.composer-modes { display: none; align-items: center; gap: 0.25rem; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border-secondary); }
	.mode-button, .mobile-mode-button { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: 2.25rem; border-radius: 0.5rem; padding: 0 0.65rem; font-size: 0.75rem; font-weight: 500; color: var(--text-muted); transition: color 150ms ease, background 150ms ease; }
	.mode-button:hover, .mobile-mode-button:hover { color: var(--text-primary); background: var(--bg-tertiary); }
	.mode-button[aria-pressed='true'] { color: var(--text-accent); background: color-mix(in srgb, var(--text-accent) 12%, transparent); }
	.plan-button { margin-left: auto; border-left: 1px solid var(--border-secondary); border-radius: 0; padding-left: 0.85rem; }
	.plan-button:disabled { opacity: 0.4; }
	.composer-input { display: block; width: 100%; min-height: 4.5rem; max-height: min(9rem, 18dvh); resize: none; overflow-y: auto; field-sizing: content; padding: 1rem 1.1rem 0.5rem; background: transparent; color: var(--text-primary); font-size: 1rem; line-height: 1.65; outline: none; }
	.composer-input::placeholder { color: var(--text-muted); }
	.composer-footer { display: flex; align-items: center; gap: 0.5rem; padding: 0.15rem 0.65rem 0.65rem; }
	.mobile-mode-button { min-height: 2.75rem; color: var(--text-accent); }
	.composer-hint { display: flex; align-items: center; gap: 0.4rem; min-width: 0; padding-left: 0.45rem; color: var(--text-muted); font-size: 0.65rem; }
	.composer-hint kbd { font-family: inherit; }
	.desktop-shortcut, .touch-shortcut { display: none; }
	.submit-button { display: inline-flex; align-items: center; justify-content: center; gap: 0.65rem; flex-shrink: 0; min-height: 2.75rem; margin-left: auto; border: 1px solid transparent; border-radius: 0.65rem; padding: 0 1.05rem; background: var(--text-accent); color: var(--bg-primary); font-size: 0.75rem; font-weight: 650; transition: opacity 150ms ease, transform 150ms ease; }
	.submit-button:hover:not(:disabled) { filter: brightness(1.08); }
	.submit-button:active:not(:disabled) { transform: scale(0.97); }
	.submit-button:disabled { opacity: 0.32; cursor: not-allowed; }
	.preview-button { margin-left: auto; padding-inline: .75rem; border-color: var(--border-primary); background: transparent; color: var(--text-secondary); font-weight: 500; }
	.preview-button + .submit-button { margin-left: 0; }
	.pending-button:disabled { opacity: .65; background: var(--bg-tertiary); color: var(--text-secondary); cursor: default; }
	@media (min-width: 640px) {
		.composer-modes { display: flex; }
		.mobile-mode-button { display: none; }
		.composer-input { font-size: 0.925rem; }
		.submit-button { min-height: 2.25rem; }
		.desktop-shortcut { display: inline; }
	}
	@media (hover: none) and (pointer: coarse) {
		.desktop-shortcut { display: none; }
		.mode-button { min-height: 2.75rem; }
		.touch-shortcut { display: inline; }
	}
	@media (max-width: 639px) {
		.turn-status-strip { padding: .6rem .7rem; gap: .55rem; }
		.turn-status-copy strong { font-size: .75rem; }
		.turn-status-copy > span { font-size: .65rem; }
		.turn-stop { min-height: 2.75rem; }
		.question-options { display: grid; }
		.question-custom input { font-size: 1rem; }
		.composer-hint, .touch-shortcut, .preview-button span { display: none; }
		.preview-button { min-width: 2.75rem; padding-inline: .5rem; }
	}
	@media (max-height: 600px) {
		.turn-status-copy > span { display: none; }
		.turn-status-strip { padding-block: .35rem; }
		.composer-input { min-height: 2.75rem; max-height: 5rem; padding-top: .5rem; }
		.composer-modes { padding-block: .2rem; }
	}
	@media (prefers-reduced-motion: reduce) { .turn-composer :global(.animate-spin) { animation: none; } }
</style>
