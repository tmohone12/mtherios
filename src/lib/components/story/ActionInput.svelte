<script lang="ts">
	import { Send, Wand2, MessageSquare, Brain, Sparkles, PenLine, Square, Loader2, Dices } from 'lucide-svelte';
	import { story } from '$lib/stores/story.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { ai } from '$lib/services/ai';
	import { streamNarrative } from '$lib/services/ai/sdk/generate';
	import { executeWorldUpdate } from '$lib/services/ai/tools/generate-with-tools';
	import { parseRollCommand, rollDice, rollCheck, parseRollMarker, encodeDiceMarker, formatRollText } from '$lib/utils/dice';

	type ActionType = 'do' | 'say' | 'think' | 'story' | 'free';

	interface Props {
		onStreamStart?: () => void;
		onStreamChunk?: (text: string) => void;
		onStreamEnd?: (fullText: string) => void;
		onStreamClear?: () => void;
	}

	let { onStreamStart, onStreamChunk, onStreamEnd, onStreamClear }: Props = $props();

	let inputValue = $state('');
	let actionType = $state<ActionType>('do');
	let isGenerating = $state(false);
	let abortController = $state<AbortController | null>(null);

	// Listen for injected text from suggestion/choice chips
	$effect(() => {
		function onInject(e: Event) {
			const text = (e as CustomEvent<string>).detail;
			if (text) inputValue = text;
		}
		window.addEventListener('mtherios:inject-input', onInject);
		return () => window.removeEventListener('mtherios:inject-input', onInject);
	});

	const isCreativeMode = $derived(story.storyMode === 'creative-writing');
	const isAdventure = $derived(story.storyMode === 'adventure');

	const actionConfig: Record<ActionType, {
		icon: typeof Wand2;
		label: string;
		placeholder: string;
		borderColor: string;
		activeStyle: string;
		buttonStyle: string;
	}> = {
		do: {
			icon: Wand2, label: 'Do', placeholder: 'What do you do?',
			borderColor: 'border-l-emerald-500',
			activeStyle: 'bg-emerald-500/15 text-emerald-400',
			buttonStyle: 'text-emerald-400 hover:bg-emerald-500/10',
		},
		say: {
			icon: MessageSquare, label: 'Say', placeholder: 'What do you say?',
			borderColor: 'border-l-blue-500',
			activeStyle: 'bg-blue-500/15 text-blue-400',
			buttonStyle: 'text-blue-400 hover:bg-blue-500/10',
		},
		think: {
			icon: Brain, label: 'Think', placeholder: 'What are you thinking?',
			borderColor: 'border-l-purple-500',
			activeStyle: 'bg-purple-500/15 text-purple-400',
			buttonStyle: 'text-purple-400 hover:bg-purple-500/10',
		},
		story: {
			icon: Sparkles, label: 'Story', placeholder: 'Describe what happens...',
			borderColor: 'border-l-amber-500',
			activeStyle: 'bg-amber-500/15 text-amber-400',
			buttonStyle: 'text-amber-400 hover:bg-amber-500/10',
		},
		free: {
			icon: PenLine, label: 'Free', placeholder: 'Write anything...',
			borderColor: 'border-l-[var(--color-surface-600)]',
			activeStyle: 'bg-[var(--color-surface-600)]/30 text-[var(--text-muted)]',
			buttonStyle: 'text-[var(--text-muted)] hover:bg-[var(--color-surface-600)]/10',
		},
	};

	const actionTypes: ActionType[] = ['do', 'say', 'think', 'story', 'free'];

	// POV-based prefixes
	const protagonistName = $derived(story.protagonist?.name ?? 'The protagonist');
	const pov = $derived(story.pov);

	/**
	 * Text adventure shorthand commands (Do mode only).
	 * Classic interactive fiction verbs.
	 */
	const SHORTHAND_COMMANDS: Record<string, string> = {
		l: 'look around',
		i: 'check my inventory',
		z: 'wait',
		n: 'go north', s: 'go south', e: 'go east', w: 'go west',
		ne: 'go northeast', nw: 'go northwest', se: 'go southeast', sw: 'go southwest',
		u: 'go up', d: 'go down',
	};

	/**
	 * Build the action content from raw input + action type.
	 * Handles: shorthand commands, say punctuation variants,
	 * wildcards (*), narrator prefix (!), and mode overrides ("/").
	 */
	function buildActionContent(rawInput: string, type: ActionType): string {
		const thirdPerson = pov === 'third';
		const name = protagonistName;

		// ── ! prefix: narrator/world event (not a player action) ──
		if (rawInput.startsWith('!')) {
			return `> ${rawInput.slice(1).trim()}`;
		}

		// ── " prefix in Do mode: force Say behavior ──
		if (type === 'do' && rawInput.startsWith('"')) {
			return buildSayContent(rawInput.slice(1).replace(/"$/, ''), thirdPerson, name);
		}

		// ── Mode-specific building ──
		if (type === 'do') {
			// Check shorthand commands first
			const lower = rawInput.toLowerCase();
			const xMatch = lower.match(/^x\s+(.+)$/);
			if (xMatch) {
				return thirdPerson
					? `> ${name} examines the ${xMatch[1]}.`
					: `> I examine the ${xMatch[1]}.`;
			}
			if (SHORTHAND_COMMANDS[lower]) {
				const expanded = SHORTHAND_COMMANDS[lower];
				return thirdPerson
					? `> ${name} ${expanded.replace(/^(go|check|look|wait)/, (m) => m === 'check' ? 'checks' : m === 'look' ? 'looks' : m === 'wait' ? 'waits' : 'goes')}.`
					: `> I ${expanded}.`;
			}

			// Wildcard: * at end means AI should continue/complete the action
			const isWildcard = rawInput.endsWith('*') || rawInput.endsWith(',');
			const cleanInput = isWildcard ? rawInput.slice(0, -1).trim() : rawInput;

			const prefix = thirdPerson ? `> ${name} ` : '> I ';
			return prefix + cleanInput + (isWildcard ? '' : '.');
		}

		if (type === 'say') {
			return buildSayContent(rawInput, thirdPerson, name);
		}

		if (type === 'think') {
			return thirdPerson
				? `> ${name} thinks: "${rawInput}"`
				: `> I think to myself: "${rawInput}"`;
		}

		// story / free — pass through
		return rawInput;
	}

	/**
	 * Build say content with punctuation-aware verb (say/ask/yell).
	 */
	function buildSayContent(text: string, thirdPerson: boolean, name: string): string {
		const lastChar = text.trim().slice(-1);
		let verb: string;
		if (lastChar === '?') {
			verb = thirdPerson ? 'asks' : 'ask';
		} else if (lastChar === '!') {
			verb = thirdPerson ? 'yells' : 'yell';
		} else {
			verb = thirdPerson ? 'says' : 'say';
		}
		return thirdPerson
			? `> ${name} ${verb}, "${text}"`
			: `> I ${verb}, "${text}"`;
	}

	/**
	 * Handle player /roll command — standalone dice roll, no AI generation.
	 */
	async function handlePlayerRoll(rawInput: string): Promise<boolean> {
		const notation = parseRollCommand(rawInput);
		if (!notation) return false;

		const result = rollDice(notation);
		const rollText = formatRollText(result);
		await story.addEntry('system', `Roll: ${rollText}`);
		onStreamStart?.();
		onStreamEnd?.('');
		return true;
	}

	/**
	 * After AI narrative streams, check for roll markers.
	 * If found: execute the roll, embed the result, and stream a continuation.
	 */
	async function handleAIRollContinuation(
		fullResponse: string,
		systemPrompt: string,
		conversationHistory: { role: 'user' | 'assistant'; content: string }[],
	): Promise<string> {
		const { preText, marker } = parseRollMarker(fullResponse);
		if (!marker) return fullResponse;

		// Execute the roll
		const result = rollCheck(marker.notation, marker.dc, marker.ability, marker.description);
		const diceMarker = encodeDiceMarker(result);

		// Build the narrative so far with the dice result embedded
		let combined = preText + '\n\n' + diceMarker + '\n\n';
		onStreamChunk?.(combined);

		// Build the continuation prompt with roll outcome
		const critLabel = result.critical === 'success' ? ' (NATURAL 20 — CRITICAL SUCCESS!)' :
			result.critical === 'failure' ? ' (NATURAL 1 — CRITICAL FAILURE!)' : '';
		const outcomeLabel = result.success ? 'SUCCESS' : 'FAILURE';
		const rollSummary = `[Roll Result: ${marker.ability} Check — ${result.notation} = ${result.total} (natural ${result.natural}) vs DC ${marker.dc} — ${outcomeLabel}${critLabel}]`;

		// Continue generation with roll result as context
		const continuationPrompt = `${rollSummary}\n\nContinue narrating the outcome. Do NOT include another roll marker.`;
		const continuationMessages = [
			...conversationHistory,
			{ role: 'assistant' as const, content: preText },
		];

		const continuationStream = streamNarrative({
			system: systemPrompt,
			prompt: continuationPrompt,
			messages: continuationMessages,
			temperature: settings.narrativeSettings.temperature,
			maxTokens: settings.narrativeSettings.maxTokens,
			signal: abortController?.signal,
			_service: 'narrative',
		} as any);

		for await (const chunk of continuationStream) {
			if (chunk.done) break;
			if (chunk.content) {
				combined += chunk.content;
				onStreamChunk?.(combined);
			}
		}

		return combined;
	}

	async function handleSubmit() {
		if (!inputValue.trim() || isGenerating || !story.currentStory) return;

		const rawInput = inputValue.trim();

		// Check for /roll command first
		if (rawInput.match(/^\/roll\s/i)) {
			inputValue = '';
			await handlePlayerRoll(rawInput);
			return;
		}

		let content: string;

		if (isCreativeMode) {
			content = rawInput;
		} else {
			content = buildActionContent(rawInput, actionType);
		}

		inputValue = '';

		// Add user action entry
		await story.addEntry('user_action', content);

		// Generate response
		isGenerating = true;
		abortController = new AbortController();

		let fullResponse = '';

		const useOrchestrator = settings.uiSettings.generationMode === 'orchestrator';

		try {
			let systemPrompt: string;
			let conversationHistory: { role: 'user' | 'assistant'; content: string }[];
			let userPrompt: string;
			let stateSnapshot = '';

			if (useOrchestrator) {
				// ── Orchestrator path: snapshot with chapters, arcs, world sim ──
				stateSnapshot = await story.buildStateSnapshot();
				if (story.pendingFactionReactions.length > 0) {
					story.pendingFactionReactions = [];
				}
				systemPrompt = story.buildOrchestratorSystemPrompt(stateSnapshot);
				const allHistory = story.buildConversationMessages();
				conversationHistory = allHistory.length > 0 && allHistory[allHistory.length - 1].role === 'user'
					? allHistory.slice(0, -1)
					: allHistory;
				userPrompt = story.buildUserPrompt(content);

				// Context stats for the meter
				const estimateTokens = (t: string) => Math.ceil(t.length / 4);
				const historyTokens = conversationHistory.reduce((s, m) => s + estimateTokens(m.content), 0);
				story.lastTierUsage = { snapshot: estimateTokens(stateSnapshot) };
				story.lastContextTotal = estimateTokens(systemPrompt) + historyTokens + estimateTokens(userPrompt);
			} else {
				// ── Pipeline path: full context assembly (existing behavior) ──
				const assembled = await ai.contextAssembler.assemble({
					storyId: story.currentStory.id,
					userAction: content,
					entries: story.entries,
					characters: story.characters,
					locations: story.locations,
					items: story.items,
					lorebookEntries: story.lorebookEntries,
					lastWorldSimResult: story.lastWorldSimResult,
					pendingFactionReactions: story.pendingFactionReactions,
					entryRelationships: story.entryRelationships,
					worldEvents: story.worldEvents,
					storyMode: story.storyMode,
					pov: story.pov,
					tense: story.tense,
					maxChaptersPerRetrieval: story.currentStory.memoryConfig?.maxChaptersPerRetrieval,
				});

				if (story.pendingFactionReactions.length > 0) {
					story.pendingFactionReactions = [];
				}

				systemPrompt = story.buildSystemPrompt(assembled.contextBlock);
				const allHistory = story.buildConversationMessages();
				conversationHistory = allHistory.length > 0 && allHistory[allHistory.length - 1].role === 'user'
					? allHistory.slice(0, -1)
					: allHistory;
				userPrompt = story.buildUserPrompt(content);

				story.lastTierUsage = assembled.tierUsage as unknown as Record<string, number>;
				const estimateTokens = (t: string) => Math.ceil(t.length / 4);
				const historyTokens = conversationHistory.reduce((s, m) => s + estimateTokens(m.content), 0);
				story.lastContextTotal = estimateTokens(systemPrompt) + historyTokens + estimateTokens(userPrompt);
			}

			// ── Stream narrative (same for both paths) ──
			onStreamStart?.();

			const stream = streamNarrative({
				system: systemPrompt,
				prompt: userPrompt,
				messages: conversationHistory,
				temperature: settings.narrativeSettings.temperature,
				maxTokens: settings.narrativeSettings.maxTokens,
				signal: abortController.signal,
				_service: 'narrative',
			} as any);

			for await (const chunk of stream) {
				if (chunk.done) break;
				if (chunk.content) {
					fullResponse += chunk.content;
					onStreamChunk?.(fullResponse);
				}
			}

			// Check for AI-initiated dice roll markers and handle continuation
			if (isAdventure && fullResponse.includes('{{roll:')) {
				fullResponse = await handleAIRollContinuation(
					fullResponse,
					systemPrompt,
					conversationHistory,
				);
			}

			if (fullResponse.trim()) {
				// Clear streaming display before adding entry to prevent double display
				onStreamClear?.();
				await story.addEntry('narration', fullResponse);

				// ── Orchestrator: run world update before signaling stream end ──
				if (useOrchestrator) {
					const errors = await executeWorldUpdate(fullResponse, stateSnapshot, abortController?.signal);
					if (errors.length > 0) {
						console.warn('[Orchestrator] World update errors:', errors);
					}
				}

				onStreamEnd?.(fullResponse);
			}
		} catch (e) {
			if (e instanceof Error && e.name === 'AbortError') return;
			console.error('Generation error:', e);
			const errorMsg = e instanceof Error ? e.message : 'Generation failed. Please try again.';
			await story.addEntry('system', errorMsg);
			onStreamEnd?.('');
		} finally {
			isGenerating = false;
			abortController = null;
		}
	}

	function handleStop() {
		abortController?.abort();
		isGenerating = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		// Mobile: Shift+Enter submits. Desktop: Enter submits, Shift+Enter newline.
		const isMobile = 'ontouchstart' in window;
		const shouldSubmit = isMobile
			? e.key === 'Enter' && e.shiftKey
			: e.key === 'Enter' && !e.shiftKey;
		if (shouldSubmit) {
			e.preventDefault();
			handleSubmit();
		}
	}
</script>

<div class="space-y-2">
	<!-- Action type selector (adventure mode only) -->
	{#if !isCreativeMode}
		<div class="flex items-center gap-1 px-1">
			{#each actionTypes as type}
				{@const config = actionConfig[type]}
				<button
					class="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-[11px] font-medium transition-all
						{actionType === type ? config.activeStyle : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
					onclick={() => actionType = type}
				>
					<config.icon class="h-3.5 w-3.5" />
					<span>{config.label}</span>
				</button>
			{/each}
		</div>
	{/if}

	<!-- Input area -->
	<div class="flex items-end gap-2 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2
		{!isCreativeMode ? `border-l-2 ${actionConfig[actionType].borderColor}` : ''}">
		<textarea
			bind:value={inputValue}
			onkeydown={handleKeydown}
			placeholder={isCreativeMode ? 'Describe what happens next...' : actionConfig[actionType].placeholder}
			rows="1"
			class="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
			style="field-sizing: content;"
		></textarea>

		{#if isGenerating}
			<button
				onclick={handleStop}
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-red-400 transition-all hover:bg-red-500/10 active:scale-95"
				title="Stop generation"
			>
				<Square class="h-5 w-5" />
			</button>
		{:else}
			<button
				onclick={handleSubmit}
				disabled={!inputValue.trim()}
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-all active:scale-95 disabled:opacity-30
					{isCreativeMode
						? 'text-[var(--text-accent)] hover:bg-[rgba(212,168,83,0.1)]'
						: actionConfig[actionType].buttonStyle}"
				title="Send"
			>
				<Send class="h-5 w-5" />
			</button>
		{/if}
	</div>
</div>
