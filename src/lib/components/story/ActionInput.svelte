<script lang="ts">
	import { Send, Wand2, MessageSquare, Brain, Sparkles, PenLine, Square, Loader2, Dices, Target, X } from 'lucide-svelte';
	import { story } from '$lib/stores/story.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { streamNarrative, continueAfterTools, type ToolCall, type ToolRoundResult } from '$lib/services/ai/sdk/generate';
	import { ai } from '$lib/services/ai';
	import { executeWorldUpdate } from '$lib/services/ai/tools/generate-with-tools';
	import { executeToolCall, runSchemeEvaluation } from '$lib/services/ai/tools/executor';
	import { extractInlineToolCalls } from '$lib/services/ai/tools/inline-extractor';
	import { GM_TOOLS, worldStateUpdateSchema, type WorldStateUpdate } from '$lib/services/ai/tools/schemas';
	import { declarePlayerScheme } from '$lib/services/ai/scheme/SchemeService';
	import { runBackgroundJobs } from '$lib/services/ai/background/runner';
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

	// ── Player scheme declaration (Declare Plan modal) ──
	let showPlanModal = $state(false);
	let planText = $state('');
	let planSubmitting = $state(false);
	let planError = $state<string | null>(null);

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

	function getNarrativeRequestConfig() {
		const config = settings.getServiceConfig('narrative');
		return {
			model: config.model || undefined,
			temperature: config.temperature,
			maxTokens: config.maxTokens,
			profileId: config.profileId || undefined,
		};
	}

	function narrativeSupportsInlineTools(): boolean {
		return settings.getServiceProfile('narrative')?.providerType === 'anthropic';
	}

	function shouldUseBackendTurn(): boolean {
		const profile = settings.getServiceProfile('narrative');
		const provider = settings.getServiceProvider('narrative');
		const configured = Boolean(profile && provider && (!provider.requiresApiKey || profile.apiKey));
		return Boolean(
			settings.uiSettings.serverAuthoritativeTurns &&
			story.currentStory?.serverStoryId &&
			configured,
		);
	}

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
		systemStable: string,
		systemDynamic: string,
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
		const narrativeConfig = getNarrativeRequestConfig();

		const continuationStream = streamNarrative({
			system: systemStable,
			systemDynamic,
			prompt: continuationPrompt,
			messages: continuationMessages,
			model: narrativeConfig.model,
			temperature: narrativeConfig.temperature,
			maxTokens: narrativeConfig.maxTokens,
			profileId: narrativeConfig.profileId,
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
		if (!inputValue.trim() || isGenerating || !story.currentStory || story.hydratingWorld) return;

		const rawInput = inputValue.trim();

		// Check for /roll command first
		if (rawInput.match(/^\/roll\s/i)) {
			inputValue = '';
			await handlePlayerRoll(rawInput);
			return;
		}

		// /plan <free text> — declare a player scheme inline (no narrator turn).
		const planMatch = rawInput.match(/^\/plan\s+([\s\S]+)$/i);
		if (planMatch) {
			const text = planMatch[1].trim();
			inputValue = '';
			await submitPlayerPlan(text);
			return;
		}

		let content: string;

		if (isCreativeMode) {
			content = rawInput;
		} else {
			content = buildActionContent(rawInput, actionType);
		}

		inputValue = '';

		if (shouldUseBackendTurn()) {
			const handled = await submitBackendAuthoritativeTurn(content);
			if (handled) return;
		}

		// Add user action entry
		await story.addEntry('user_action', content);

		// Generate response
		isGenerating = true;
		abortController = new AbortController();

		let fullResponse = '';

		try {
			// ── Provider-aware path selection ──
			// Inline tool calls only work reliably on Anthropic native. OpenAI-compat
			// providers (OpenRouter, Kimi, etc.) — especially smaller open-source
			// models — frequently emit tool calls without prose, dropping the turn.
			// They also don't honor cache_control, so the larger tool-attached
			// prompt is pure overhead. Fall back to the post-stream classifier.
			const narrativeConfig = getNarrativeRequestConfig();
			const useInlineTools = isAdventure
				&& narrativeSupportsInlineTools();

			// ── Build orchestrator context: structured state snapshot + classifier-facing string ──
			const stateSnapshot = await story.buildStateSnapshot(content);

			// ── Generate plot momentum for this turn ──
			if (isAdventure) {
				try {
					const factionEntries = story.lorebookEntries.filter(e => e.type === 'faction');
					const characterEntries = story.lorebookEntries.filter(e => e.type === 'character');
					const recentFactionActions = story.factionActions.slice(-5);
					const worldEventList = story.worldEvents.slice(-6).map(e => ({ name: e.name, description: e.description }));
					const schemeText = story.schemes.length > 0
						? story.schemes.map(s => `- ${s.ownerName} (${s.status}): ${s.goal.slice(0, 120)}`).join('\n')
						: '';
					const locationName = stateSnapshot.currentLocation?.name ?? '';
					const tracker = story.currentStory?.timeTracker ?? null;

					const pmResult = await ai.worldSim.generateMomentum(
						stateSnapshot.chapters,
						stateSnapshot.arcs,
						story.entries,
						factionEntries,
						characterEntries,
						story.entryRelationships,
						stateSnapshot.threads,
						stateSnapshot.activeAgreements,
						worldEventList,
						locationName,
						schemeText,
						tracker,
						story.storyMode,
						story.pov,
						story.tense,
						recentFactionActions,
						[], // relationChangeLog — computed in service or passed if available
					);
					// Store in lastWorldSimResult as a partial update so #sectionPlotMomentum picks it up
					story.lastWorldSimResult = {
						...(story.lastWorldSimResult ?? {
							plotInjection: null,
							worldNarrative: '',
							factionActions: [],
							rumors: [],
							worldTension: 0,
							plotSeeds: [],
							threadUpdates: [],
						}),
						plotMomentum: pmResult,
					};
				} catch (e) {
					console.warn('[PlotMomentum] generation failed, falling back to no momentum', e);
				}
			}

			const { stable: systemStable, dynamic: systemDynamic } = story.buildOrchestratorSystemBlocks(stateSnapshot, { useInlineTools });
			const snapshotText = story.serializeSnapshotForClassifier(stateSnapshot);
			const allHistory = story.buildConversationMessages();
			const conversationHistory = allHistory.length > 0 && allHistory[allHistory.length - 1].role === 'user'
				? allHistory.slice(0, -1)
				: allHistory;
			const userPrompt = story.buildUserPrompt(content);

			const estimateTokens = (t: string) => Math.ceil(t.length / 4);
			const historyTokens = conversationHistory.reduce((s, m) => s + estimateTokens(m.content), 0);
			const promptUsage = story.lastPromptSectionUsage ?? {};
			story.lastTierUsage = {
				snapshot: estimateTokens(snapshotText),
				scene: (promptUsage.characters ?? 0) + (promptUsage.playerReputation ?? 0) + (promptUsage.playerLedger ?? 0),
				recent: (promptUsage.storyMemory ?? 0) + (promptUsage.arcs ?? 0) + (promptUsage.chapters ?? 0) + (promptUsage.chapterIntro ?? 0),
				world: (promptUsage.factions ?? 0) + (promptUsage.livingWorld ?? 0) + (promptUsage.schemes ?? 0) + (promptUsage.plotMomentum ?? 0) + (promptUsage.plotLedger ?? 0),
				procedural: promptUsage.proceduralMemory ?? 0,
				retrieved: (promptUsage.lore ?? 0) + (promptUsage.episodicMemory ?? 0) + (promptUsage.conversationMemory ?? 0) + (promptUsage.backendMemory ?? 0),
			};
			story.lastContextTotal = estimateTokens(systemStable) + estimateTokens(systemDynamic) + historyTokens + estimateTokens(userPrompt);

			onStreamStart?.();

			// Inline tool calls: the narrator emits prose AND world-state updates in
			// one streamed response. Falls back to the separate classifier call only
			// when the model didn't call any tools (older models / cautious settings).
			const inlineToolCalls: ToolCall[] = [];
			let inlineReasoning = '';

			const stream = streamNarrative({
				system: systemStable,
				systemDynamic,
				prompt: userPrompt,
				messages: conversationHistory,
				model: narrativeConfig.model,
				temperature: narrativeConfig.temperature,
				maxTokens: narrativeConfig.maxTokens,
				profileId: narrativeConfig.profileId,
				signal: abortController.signal,
				tools: useInlineTools ? GM_TOOLS : undefined,
				_service: 'narrative',
			} as any);

			for await (const chunk of stream) {
				if (chunk.done) break;
				if (chunk.content) {
					fullResponse += chunk.content;
					onStreamChunk?.(fullResponse);
				}
				if (chunk.toolCall) {
					inlineToolCalls.push(chunk.toolCall);
				}
				if (chunk.reasoning) {
					inlineReasoning += chunk.reasoning;
				}
			}

			// cc-bridge fallback: if the model emitted tool calls as text inside
			// the prose (Claude Code wire format), recover them and clean the
			// visible narration.
			if (inlineToolCalls.length === 0 && fullResponse) {
				const { cleaned, toolCalls } = extractInlineToolCalls(fullResponse);
				if (toolCalls.length > 0) {
					fullResponse = cleaned;
					inlineToolCalls.push(...toolCalls);
					onStreamChunk?.(fullResponse);
				}
			}

			// DeepSeek (and a few other OpenAI-compatible models) sometimes
			// emit tool calls without any accompanying prose. Apply the tool
			// calls, then continue the conversation per the DeepSeek/OpenAI
			// multi-round protocol: append the assistant tool_calls + a tool
			// result message for each one, and let the model produce the
			// final narration in-context.
			//
			// https://api-docs.deepseek.com/guides/tool_calls
			let toolCallsApplied = false;
			if (!fullResponse.trim() && inlineToolCalls.length > 0) {
				console.warn('[Orchestrator] tool-only response — applying tools and continuing per DeepSeek multi-round flow');
				const toolResults: ToolRoundResult[] = [];
				for (const tc of inlineToolCalls) {
					let resultText = JSON.stringify({ ok: true });
					try {
						const out = await executeToolCall(tc.name, tc.arguments);
						if (typeof out === 'string' && out) resultText = out;
					} catch (e) {
						console.error(`[Orchestrator] retry-apply ${tc.name} failed:`, e);
						resultText = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
					}
					toolResults.push({ toolCallId: tc.id, toolName: tc.name, content: resultText });
				}
				toolCallsApplied = true;

				// State changed; rebuild the snapshot so the model's final
				// narration sees the freshly-applied world updates.
				const retrySnapshot = await story.buildStateSnapshot(content);
				const { stable: retryStable, dynamic: retryDynamic } = story.buildOrchestratorSystemBlocks(retrySnapshot);

				try {
					await continueAfterTools(
						{
							system: retryStable,
							systemDynamic: retryDynamic,
							prompt: userPrompt,
							messages: conversationHistory,
							model: narrativeConfig.model,
							temperature: narrativeConfig.temperature,
							maxTokens: narrativeConfig.maxTokens,
							profileId: narrativeConfig.profileId,
							signal: abortController.signal,
							priorToolCalls: inlineToolCalls,
							toolResults,
							priorReasoningContent: inlineReasoning,
							_service: 'narrative-continuation',
						} as any,
						(_delta, full) => {
							fullResponse = full;
							onStreamChunk?.(fullResponse);
						},
					);
				} catch (e) {
					console.error('[Orchestrator] continueAfterTools failed:', e);
				}

				// The continuation can still emit cc-bridge XML if it tried to
				// re-call tools. Strip leaked tags before showing the player.
				if (fullResponse) {
					const { cleaned } = extractInlineToolCalls(fullResponse);
					if (cleaned !== fullResponse) {
						fullResponse = cleaned;
						onStreamChunk?.(fullResponse);
					}
				}
			}

			// Check for AI-initiated dice roll markers and handle continuation
			if (isAdventure && fullResponse.includes('{{roll:')) {
				fullResponse = await handleAIRollContinuation(
					fullResponse,
					systemStable,
					systemDynamic,
					conversationHistory,
				);
			}

			if (!fullResponse.trim()) {
				// Surface a visible system message instead of silently dropping
				// the turn. Reaches here when the model returned nothing at all
				// (provider hiccup, empty SSE stream) — the tool-only case is
				// already handled by the retry above.
				const reason = toolCallsApplied
					? 'The model emitted tool calls but no narration, and the prose retry was also empty. Tool calls were applied; try sending another action to continue.'
					: 'The model returned an empty response. This usually means a provider error or a tool-call leak — try again, or check the active model in Settings.';
				console.warn('[Orchestrator]', reason);
				onStreamClear?.();
				await story.addEntry('system', reason);
				onStreamEnd?.('');
			}
			if (fullResponse.trim()) {
				// Clear streaming display before adding entry to prevent double display
				onStreamClear?.();
				await story.addEntry('narration', fullResponse);

				const worldUpdateErrors: string[] = [];
				if (inlineToolCalls.length > 0) {
					// Inline path: dispatch each tool call the narrator emitted —
					// unless we already applied them in the prose-retry path above.
					let worldStateArgs: WorldStateUpdate | null = null;
					if (!toolCallsApplied) {
						for (const tc of inlineToolCalls) {
							try {
								await executeToolCall(tc.name, tc.arguments);
								if (tc.name === 'update_world_state') {
									const parsed = worldStateUpdateSchema.safeParse(tc.arguments);
									if (parsed.success) worldStateArgs = parsed.data;
								}
							} catch (e) {
								const msg = `Tool ${tc.name}: ${e instanceof Error ? e.message : e}`;
								worldUpdateErrors.push(msg);
								console.error(`[Orchestrator] ${msg}`);
							}
						}
					} else {
						// Re-parse from prior tool calls for scheme evaluation gating.
						for (const tc of inlineToolCalls) {
							if (tc.name === 'update_world_state') {
								const parsed = worldStateUpdateSchema.safeParse(tc.arguments);
								if (parsed.success) worldStateArgs = parsed.data;
							}
						}
					}
					// Reactive scheme evaluation — gated on story beats / deaths / agreement breaks.
					try {
						const schemeErrs = await runSchemeEvaluation(fullResponse, snapshotText, worldStateArgs, abortController?.signal);
						worldUpdateErrors.push(...schemeErrs);
					} catch (e) {
						worldUpdateErrors.push(`Scheme: ${e}`);
					}
					// Background jobs (chapters, arcs, lore management) still run.
					try {
						const bgErrors = await runBackgroundJobs();
						worldUpdateErrors.push(...bgErrors);
					} catch (e) {
						worldUpdateErrors.push(`Background: ${e}`);
					}
				} else {
					// Fallback path: separate classifier call extracts state from prose.
					// executeWorldUpdate runs scheme evaluation internally.
					const errs = await executeWorldUpdate(fullResponse, snapshotText, abortController?.signal);
					worldUpdateErrors.push(...errs);
				}

				if (worldUpdateErrors.length > 0) {
					console.warn('[Orchestrator] World update errors:', worldUpdateErrors);
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

	async function submitBackendAuthoritativeTurn(content: string): Promise<boolean> {
		const currentStory = story.currentStory;
		if (!currentStory?.serverStoryId) return false;
		const narrativeConfig = getNarrativeRequestConfig();
		const profile = settings.getServiceProfile('narrative');
		const provider = settings.getServiceProvider('narrative');
		if (!profile || !provider || (provider.requiresApiKey && !profile.apiKey)) return false;

		isGenerating = true;
		abortController = new AbortController();
		onStreamStart?.();
		try {
			const response = await story.submitBackendTurn({
				clientTurnId: crypto.randomUUID(),
				playerText: content,
				providerProfile: profile,
				generation: {
					model: narrativeConfig.model,
					temperature: narrativeConfig.temperature,
					maxTokens: narrativeConfig.maxTokens,
				},
				clientContext: {
					sceneEntityIds: story.characters.filter((character) => character.status === 'active').map((character) => character.id),
					presentNpcIds: story.characters.filter((character) => character.status === 'active').map((character) => character.id),
					locationId: story.locations.find((location) => location.current)?.id ?? null,
					threadIds: [],
					playerReputation: currentStory.playerReputation ?? null,
					playerLedger: currentStory.playerLedger ?? null,
				},
			});
			if (response.narration.trim()) {
				onStreamChunk?.(response.narration);
			}
			onStreamClear?.();
			try {
				const backgroundErrors = await runBackgroundJobs();
				if (backgroundErrors.length > 0) {
					console.warn('[BackendTurn] Background job errors:', backgroundErrors);
				}
			} catch (e) {
				console.warn('[BackendTurn] Background jobs failed:', e);
			}
			onStreamEnd?.(response.narration);
			return true;
		} catch (error) {
			console.warn('[BackendTurn] Falling back to local narrator path:', error);
			onStreamClear?.();
			return false;
		} finally {
			isGenerating = false;
			abortController = null;
		}
	}

	function handleStop() {
		abortController?.abort();
		isGenerating = false;
	}

	async function submitPlayerPlan(text: string): Promise<void> {
		if (!text.trim() || !story.currentStory) return;
		planSubmitting = true;
		planError = null;
		try {
			const { scheme, error } = await declarePlayerScheme(text);
			if (error || !scheme) {
				planError = error ?? 'Failed to declare plan.';
				await story.addEntry('system', `Plan declaration failed: ${planError}`);
				return;
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
		} catch (e) {
			planError = e instanceof Error ? e.message : String(e);
		} finally {
			planSubmitting = false;
		}
	}

	async function submitPlanFromModal() {
		await submitPlayerPlan(planText);
	}

	function openPlanModal() {
		planError = null;
		showPlanModal = true;
	}

	function closePlanModal() {
		if (planSubmitting) return;
		showPlanModal = false;
		planText = '';
		planError = null;
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

{#if showPlanModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
		onclick={closePlanModal}
		onkeydown={(e) => e.key === 'Escape' && closePlanModal()}
		role="presentation"
	>
		<div
			class="w-full max-w-lg rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-5 shadow-2xl"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-labelledby="plan-modal-title"
			tabindex="-1"
		>
			<div class="mb-3 flex items-start justify-between gap-3">
				<div>
					<h2 id="plan-modal-title" class="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
						<Target class="h-5 w-5 text-rose-400" />
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
					class="rounded-lg p-1 text-[var(--text-muted)] transition-all hover:bg-[var(--color-surface-600)]/30 hover:text-[var(--text-primary)] disabled:opacity-30"
					aria-label="Close"
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			<textarea
				bind:value={planText}
				placeholder="e.g. I plan to poison Lord Frey at the wedding feast — but I'll need to find an alchemist first, and bribe a serving girl to switch the cups…"
				rows="5"
				disabled={planSubmitting}
				class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-rose-500/60 focus:outline-none disabled:opacity-50"
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
					class="flex items-center gap-1.5 rounded-lg bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-400 transition-all hover:bg-rose-500/25 disabled:opacity-30"
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
			<button
				class="flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-[11px] font-medium text-[var(--text-muted)] transition-all hover:bg-rose-500/10 hover:text-rose-400"
				onclick={openPlanModal}
				title="Declare a scheme — break a goal into stages the narrator must surface"
				disabled={isGenerating || planSubmitting}
			>
				<Target class="h-3.5 w-3.5" />
				<span>Plan</span>
			</button>
		</div>
	{/if}

	{#if story.hydratingWorld}
		<div class="flex items-center gap-2 px-1 text-[11px] text-[var(--text-muted)]">
			<Loader2 class="h-3.5 w-3.5 animate-spin" />
			<span>Loading memory and world state...</span>
		</div>
	{:else if story.worldHydrationError}
		<div class="px-1 text-[11px] text-amber-300">
			Memory load had trouble; transcript is available, but context may be thin.
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
				disabled={!inputValue.trim() || story.hydratingWorld}
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-all active:scale-95 disabled:opacity-30
					{isCreativeMode
						? 'text-[var(--text-accent)] hover:bg-[rgba(212,168,83,0.1)]'
						: actionConfig[actionType].buttonStyle}"
				title={story.hydratingWorld ? 'Memory is still loading' : 'Send'}
			>
				<Send class="h-5 w-5" />
			</button>
		{/if}
	</div>
</div>
