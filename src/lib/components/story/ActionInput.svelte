<script lang="ts">
	import { Send, Wand2, MessageSquare, Brain, Sparkles, PenLine, Square, Loader2 } from 'lucide-svelte';
	import { story } from '$lib/stores/story.svelte';
	import { streamNarrative } from '$lib/services/ai/sdk/generate';

	type ActionType = 'do' | 'say' | 'think' | 'story' | 'free';

	interface Props {
		onStreamStart?: () => void;
		onStreamChunk?: (text: string) => void;
		onStreamEnd?: (fullText: string) => void;
	}

	let { onStreamStart, onStreamChunk, onStreamEnd }: Props = $props();

	let inputValue = $state('');
	let actionType = $state<ActionType>('do');
	let isGenerating = $state(false);
	let abortController = $state<AbortController | null>(null);

	// Listen for injected text from suggestion/choice chips
	$effect(() => {
		const injected = (window as any).__mtherios_input_inject;
		if (injected) {
			inputValue = injected;
			(window as any).__mtherios_input_inject = null;
		}
	});

	const isCreativeMode = $derived(story.storyMode === 'creative-writing');

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

	const actionPrefixes = $derived.by(() => {
		if (pov === 'third') {
			return {
				do: `${protagonistName} `,
				say: `${protagonistName} says, "`,
				think: `${protagonistName} thinks, "`,
				story: '', free: '',
			};
		}
		return {
			do: 'I ', say: 'I say, "', think: 'I think to myself, "',
			story: '', free: '',
		};
	});
	const actionSuffixes: Record<ActionType, string> = {
		do: '', say: '"', think: '"', story: '', free: '',
	};

	async function handleSubmit() {
		if (!inputValue.trim() || isGenerating || !story.currentStory) return;

		const rawInput = inputValue.trim();
		let content: string;

		if (isCreativeMode || actionType === 'free' || actionType === 'story') {
			content = rawInput;
		} else {
			content = actionPrefixes[actionType] + rawInput + actionSuffixes[actionType];
		}

		inputValue = '';

		// Add user action entry
		await story.addEntry('user_action', content);

		// Generate response
		isGenerating = true;
		abortController = new AbortController();
		onStreamStart?.();

		let fullResponse = '';

		try {
			const systemPrompt = story.buildSystemPrompt();
			const userPrompt = story.buildUserPrompt(content);

			const stream = streamNarrative({
				system: systemPrompt,
				prompt: userPrompt,
				signal: abortController.signal,
			});

			for await (const chunk of stream) {
				if (chunk.done) break;
				if (chunk.content) {
					fullResponse += chunk.content;
					onStreamChunk?.(fullResponse);
				}
			}

			if (fullResponse.trim()) {
				await story.addEntry('narration', fullResponse);
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
