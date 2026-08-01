<script lang="ts">
	import { Sword, Feather, ChevronLeft, ChevronRight, Globe, Zap, Play, Plus, X, Upload, Loader2, Sparkles } from 'lucide-svelte';
	import { fly } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { uuid } from '$lib/utils/uuid';
	import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
	import { getSetting, setSetting, createStory } from '$lib/services/database';
	import { convertToEntries, type ImportedEntry } from '$lib/services/lorebookImporter';
	import { importStoryFromJson } from '$lib/services/storySync';
	import { saveCanonicalCharacter, saveCanonicalLorebookEntry } from '$lib/services/canonicalWrites';
	import { createBackendStoryShell } from '$lib/services/serverStories';
	import { ai } from '$lib/services/ai';
	import { settings } from '$lib/stores/settings.svelte';
	import { shouldRequireProviderSetup } from './onboardingFlow';
	import { DEFAULT_ONBOARDING_GENRE_PROMPT_PACK_ID, buildGenrePromptPack, getOnboardingGenreOption, getOnboardingGenreOptions } from './storyPromptPacks';
	import LorebookImport from '$lib/components/lorebook/LorebookImport.svelte';
	import type { Story, Character, Entry, StoryMode, APIProfile, ProviderType } from '$lib/types';

	interface Props {
		shelfId?: string | null;
		onComplete: (storyId: string) => void;
		onSkip?: () => void;
	}

	let { shelfId = null, onComplete, onSkip }: Props = $props();

	// ── Wizard State ──
	let currentStep = $state(0);
	let direction = $state(1);
	let hasExistingProfile = $state(false);
	let providerSetupRequired = $state(true);

	// Step 0: Provider
	let provider = $state<string>('nanogpt');
	let apiKey = $state('');
	let showKey = $state(false);

	// On mount: check if provider already configured → skip Step 0
	onMount(async () => {
		const onboardingComplete = (await getSetting('onboardingComplete')) === 'true';
		const profilesJson = await getSetting('apiProfiles');
		let profiles: APIProfile[] = [];
		if (profilesJson) {
			try {
				profiles = JSON.parse(profilesJson);
				const configuredProfile = profiles.find((profile) => Boolean(profile.apiKey?.trim()));
				if (configuredProfile) {
					hasExistingProfile = true;
					provider = configuredProfile.providerType;
					apiKey = configuredProfile.apiKey;
				}
			} catch { /* start at step 0 */ }
		}
		providerSetupRequired = shouldRequireProviderSetup({ onboardingComplete, profiles });
		if (!providerSetupRequired) currentStep = 1;
	});

	// Step 1: Story Mode
	let storyMode = $state<StoryMode>('adventure');

	// Step 2: World & Setting
	let storyTitle = $state('');
	let genre = $state(DEFAULT_ONBOARDING_GENRE_PROMPT_PACK_ID);
	let worldDescription = $state('');
	let storyAssistNotes = $state('');
	let assistingStorySetup = $state(false);
	let storyAssistError = $state<string | null>(null);
	let storyAssistRationale = $state<string | null>(null);

	// Step 3: Character
	let protagonistName = $state('');
	let protagonistDescription = $state('');

	// Step 4: Lorebook entries
	let lorebookEntries = $state<Array<{ name: string; content: string; keywords: string }>>([]);
	let importedFileEntries = $state<ImportedEntry[]>([]);

	let createdStoryId = $state<string | null>(null);
	let saving = $state(false);
	let saveError = $state<string | null>(null);

	// Story file import (from another device)
	let storyFileInput = $state<HTMLInputElement | null>(null);
	let importingStory = $state(false);

	async function handleStoryFileImport(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importingStory = true;
		try {
			const storyId = await importStoryFromJson(file);
			// Re-init settings so bundled API profiles are live in memory
			await settings.init();
			await setSetting('onboardingComplete', 'true');
			await setSetting('lastStoryId', storyId);
			onComplete(storyId);
		} catch (err) {
			console.error('Story import failed:', err);
			alert(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		} finally {
			importingStory = false;
			input.value = '';
		}
	}

	const genres = getOnboardingGenreOptions();

	function selectedGenreLabel(): string {
		return getOnboardingGenreOption(genre).label;
	}

	function selectedGenrePromptPack(): string {
		return buildGenrePromptPack(genre);
	}

	const steps = [
		{ title: 'Connect', subtitle: 'Choose your AI provider' },
		{ title: 'Mode', subtitle: 'How will you play?' },
		{ title: 'World', subtitle: 'Set the stage' },
		{ title: 'Character', subtitle: 'Who are you?' },
		{ title: 'Lore', subtitle: 'Build your codex' },
	];

	function next() {
		if (currentStep < steps.length - 1) {
			direction = 1;
			currentStep++;
		}
	}

	function prev() {
		if (currentStep > 0) {
			direction = -1;
			currentStep--;
		}
	}

	function goTo(step: number) {
		direction = step > currentStep ? 1 : -1;
		currentStep = step;
	}

	function addLorebookEntry() {
		lorebookEntries = [...lorebookEntries, { name: '', content: '', keywords: '' }];
	}

	function removeLorebookEntry(index: number) {
		lorebookEntries = lorebookEntries.filter((_, i) => i !== index);
	}

	async function assistStorySetup() {
		if (assistingStorySetup) return;
		assistingStorySetup = true;
		storyAssistError = null;
		storyAssistRationale = null;
		try {
			const promptPack = selectedGenrePromptPack();
			const result = await ai.storySetupAssist.assist({
				mode: storyMode,
				genre: selectedGenreLabel(),
				title: storyTitle,
				worldDescription,
				protagonistName,
				protagonistDescription,
				notes: storyAssistNotes,
				promptPack,
			});
			storyTitle = result.title || storyTitle;
			worldDescription = result.worldDescription || worldDescription;
			protagonistName = result.protagonistName || protagonistName;
			protagonistDescription = result.protagonistDescription || protagonistDescription;
			if (result.lorebookEntries.length > 0) {
				lorebookEntries = [...lorebookEntries, ...result.lorebookEntries];
			}
			storyAssistRationale = result.rationale || 'Drafted a stronger starting point for this story.';
		} catch (err) {
			console.error('Story setup assist failed:', err);
			storyAssistError = err instanceof Error ? err.message : 'AI assist failed. Check your existing provider settings, then try again.';
		} finally {
			assistingStorySetup = false;
		}
	}

	/** Save story + starting lore, preferring the backend daemon as canon. */
	async function saveStoryToDb(): Promise<string> {
		// Only save provider if we don't already have one
		if (providerSetupRequired && !hasExistingProfile) {
			const profileId = uuid();
			const providerConfig = PROVIDERS[provider as keyof typeof PROVIDERS];
			const profile: APIProfile = {
				id: profileId,
				name: providerConfig?.name ?? provider,
				providerType: provider as ProviderType,
				apiKey,
				customModels: [],
				fetchedModels: [],
				reasoningModels: [],
				hiddenModels: [],
				favoriteModels: [],
				createdAt: Date.now(),
			};
			await setSetting('apiProfiles', JSON.stringify([profile]));
			await setSetting('activeProfileId', profileId);
		}

		const storyId = uuid();
		const now = Date.now();
		const selectedGenre = selectedGenreLabel();
		const gmPromptPack = selectedGenrePromptPack();
		const storySettings: Story['settings'] = {
			pov: storyMode === 'adventure' ? 'first' : 'third',
			tense: 'present',
			tone: selectedGenre,
			temperature: 1.0,
			maxTokens: 8192,
		};
		let serverStoryId: string | null = null;
		let resultShelfId: string | null = shelfId ?? null;
		let serverVersion: number | null = null;
		let syncStatus: Story['syncStatus'] = 'offline';

		try {
			const result = await createBackendStoryShell({
				shelfId,
				clientStoryId: storyId,
				title: storyTitle || 'Untitled Chronicle',
				description: worldDescription || null,
				genre: selectedGenre,
				mode: storyMode,
				settings: storySettings,
				headerPrompt: gmPromptPack,
				playerReputation: null,
			});
			serverStoryId = result.storyId;
			resultShelfId = result.shelfId ?? resultShelfId;
			serverVersion = result.serverVersion;
			syncStatus = 'synced';
		} catch (error) {
			console.warn('[Onboarding] Backend story creation unavailable; creating an offline local story:', error);
		}

		const story: Story = {
			id: storyId,
			shelfId: resultShelfId ?? 'shelf_default',
			title: storyTitle || 'Untitled Chronicle',
			description: worldDescription || null,
			genre: selectedGenre,
			templateId: null,
			mode: storyMode,
			createdAt: now,
			updatedAt: now,
			settings: storySettings,
			memoryConfig: {
				tokenThreshold: 16000,
				chapterBuffer: 10,
				autoSummarize: true,
				enableRetrieval: true,
				maxChaptersPerRetrieval: 5,
			},
			retryState: null,
			styleReviewState: null,
			timeTracker: null,
			currentBranchId: null,
			currentBgImage: null,
			headerPrompt: gmPromptPack,
			playerReputation: null,
			serverStoryId,
			serverVersion,
			syncStatus,
			lastWorldSimDay: null,
			compactedLore: null,
			compactedLoreHistory: null,
			meters: null,
		};
		await createStory(story);

		// Create protagonist
		if (protagonistName) {
			const protagonistId = uuid();
			const char: Character = {
				id: protagonistId,
				storyId,
				branchId: null,
				name: protagonistName,
				description: protagonistDescription || null,
				traits: [],
				relationship: 'self',
				status: 'active',
				metadata: null,
				visualDescriptors: {},
				portrait: null,
			};
			await saveCanonicalCharacter(char, 'create');
		}

		// Create lorebook entries
		for (const entry of lorebookEntries) {
			if (!entry.name.trim()) continue;
			const lorebookEntry: Entry = {
				id: uuid(),
				storyId,
				branchId: null,
				name: entry.name,
				type: 'concept',
				description: entry.content,
				hiddenInfo: null,
				aliases: [],
				state: {
					type: 'concept',
					revealed: false,
					comprehensionLevel: 'unknown',
					relatedEntries: [],
				},
				adventureState: null,
				creativeState: null,
				injection: {
					mode: 'keyword',
					keywords: entry.keywords.split(',').map(k => k.trim()).filter(Boolean),
					priority: 100,
				},
				firstMentioned: null,
				lastMentioned: null,
				mentionCount: 0,
				createdBy: 'user',
				createdAt: now,
				updatedAt: now,
				loreManagementBlacklisted: false,
			};
			await saveCanonicalLorebookEntry(lorebookEntry, 'create');
		}

		// Write buffered file-imported entries with the real storyId
		if (importedFileEntries.length > 0) {
			const converted = convertToEntries(importedFileEntries, 'import');
			for (const entry of converted) {
				const fullEntry: Entry = {
					...entry,
					id: uuid(),
					storyId,
					createdAt: now,
					updatedAt: now,
				} as Entry;
				await saveCanonicalLorebookEntry(fullEntry, 'create');
			}
		}

		return storyId;
	}

	/** Save story and finish onboarding */
	async function beginStory() {
		if (createdStoryId || saving) return;
		saving = true;
		saveError = null;
		try {
			const storyId = await saveStoryToDb();
			createdStoryId = storyId;
			await setSetting('onboardingComplete', 'true');
			await setSetting('lastStoryId', storyId);
			onComplete(storyId);
		} catch (err) {
			saveError = err instanceof Error ? err.message : 'Failed to save story';
			saving = false;
		}
	}

	let canProceed = $derived.by(() => {
		switch (currentStep) {
			case 0: return !!apiKey.trim() || hasExistingProfile;
			case 1: return true;
			case 2: return !!storyTitle.trim();
			case 3: return true; // protagonist is optional
			case 4: return true; // lorebook is optional
			default: return true;
		}
	});
</script>

<div class="app-shell fixed inset-0 z-50 flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-[var(--bg-primary)]">
	<div class="grain-overlay"></div>
	<div class="cathedral-glow"></div>

	<!-- Header -->
	<div class="relative z-10 flex items-center justify-between px-6 py-4">
		<div class="flex items-center gap-3">
			<svg viewBox="0 0 48 48" fill="none" class="h-6 w-6 text-[var(--text-accent)]">
				<path d="M24 4L6 14v20l18 10 18-10V14L24 4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
				<circle cx="24" cy="24" r="5" fill="currentColor" opacity="0.6"/>
			</svg>
			<span class="font-display text-lg font-semibold tracking-wide text-[var(--text-accent)]">Mtherios</span>
		</div>
		{#if onSkip}
			<button class="flex min-h-11 items-center px-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]" onclick={onSkip}>
				Skip for now
			</button>
		{/if}
	</div>

	<!-- Progress dots -->
	<div class="relative z-10 flex justify-center gap-1 py-0 sm:gap-2 sm:py-2">
		{#each steps as s, i}
			<button
				class="flex h-11 w-11 items-center justify-center rounded-lg"
				aria-label={`Go to ${s.title}`}
				aria-current={i === currentStep ? 'step' : undefined}
				disabled={i > currentStep}
				onclick={() => i <= currentStep ? goTo(i) : null}
			>
				<span class="h-2 rounded-full transition-all duration-300 {i === currentStep ? 'w-8 bg-[var(--color-gold-400)]' : i < currentStep ? 'w-2 bg-[var(--color-gold-600)]' : 'w-2 bg-[var(--color-surface-700)]'}"></span>
			</button>
		{/each}
	</div>

	<!-- Step title -->
	<div class="relative z-10 px-6 py-4 text-center">
		<h2 class="font-display text-2xl tracking-wide text-[var(--text-primary)]">{steps[currentStep].title}</h2>
		<p class="mt-1 text-sm text-[var(--text-muted)]">{steps[currentStep].subtitle}</p>
	</div>

	<!-- Content -->
	<div class="relative z-[1] min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-32 sm:px-6">
		<div class="mx-auto max-w-lg">

		{#if currentStep === 0}
		<!-- Step 0: Provider Setup -->
		<div class="space-y-6" in:fly={{ x: direction * 200, duration: 250 }}>
			<div class="grid grid-cols-2 gap-3">
				{#each [
					{ id: 'nanogpt', name: 'NanoGPT', desc: 'Affordable multi-model', icon: Zap },
					{ id: 'openrouter', name: 'OpenRouter', desc: '100+ models', icon: Globe },
				] as p}
					<button class="flex flex-col items-center gap-3 rounded-xl border p-5 text-center transition-all
						{provider === p.id ? 'border-[var(--color-gold-400)] bg-[rgba(212,168,83,0.1)]' : 'border-[var(--border-primary)] hover:border-[var(--color-gold-600)]'}"
						onclick={() => provider = p.id}>
						<div class="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-tertiary)]">
							<p.icon class="h-6 w-6 text-[var(--text-accent)]" />
						</div>
						<div>
							<div class="font-display text-sm font-semibold text-[var(--text-primary)]">{p.name}</div>
							<div class="text-xs text-[var(--text-muted)]">{p.desc}</div>
						</div>
					</button>
				{/each}
			</div>

			<div class="space-y-2">
				<label for="onboarding-api-key" class="font-display text-sm tracking-wide text-[var(--text-primary)]">API Key</label>
				<div class="relative">
					<input
						id="onboarding-api-key"
						type={showKey ? 'text' : 'password'}
						bind:value={apiKey}
						placeholder="sk-..."
						class="w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-4 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none focus:ring-1 focus:ring-[var(--color-gold-600)]"
					/>
				</div>
				<p class="text-xs text-[var(--text-muted)]">
					{#if provider === 'nanogpt'}
						Get your key at <a href="https://nano-gpt.com/api" target="_blank" class="text-[var(--text-accent)] hover:underline">nano-gpt.com/api</a>
					{:else}
						Get your key at <a href="https://openrouter.ai/keys" target="_blank" class="text-[var(--text-accent)] hover:underline">openrouter.ai/keys</a>
					{/if}
				</p>
			</div>
			<!-- Import from another device -->
			<div class="flex items-center gap-4">
				<div class="h-px flex-1 bg-[var(--border-primary)]"></div>
				<span class="font-display text-xs tracking-wider uppercase text-[var(--text-muted)]">or</span>
				<div class="h-px flex-1 bg-[var(--border-primary)]"></div>
			</div>

			<input bind:this={storyFileInput} type="file" accept=".json" class="hidden" aria-label="Import story file" onchange={handleStoryFileImport} />
			<button
				class="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-primary)] py-4 text-sm text-[var(--text-muted)] transition-colors hover:border-[var(--color-gold-600)] hover:text-[var(--text-accent)]"
				disabled={importingStory}
				onclick={() => storyFileInput?.click()}
			>
				<Upload class="h-4 w-4" />
				{importingStory ? 'Importing...' : 'Import from another device'}
			</button>
			<p class="text-center text-xs text-[var(--text-muted)]">Import a .mtherios.json file — includes API settings</p>
		</div>

		{:else if currentStep === 1}
		<!-- Step 1: Story Mode -->
		<div class="space-y-4" in:fly={{ x: direction * 200, duration: 250 }}>
			<button class="w-full text-left" onclick={() => storyMode = 'adventure'}>
				<div class="rounded-xl border p-5 transition-all
					{storyMode === 'adventure' ? 'border-[var(--color-gold-400)] bg-[rgba(212,168,83,0.08)]' : 'border-[var(--border-primary)] hover:border-[var(--color-gold-600)]'}">
					<div class="flex items-center gap-4">
						<div class="flex h-12 w-12 items-center justify-center rounded-lg bg-[rgba(139,46,59,0.15)]">
							<Sword class="h-6 w-6 text-[var(--color-crimson-400)]" />
						</div>
						<div>
							<div class="font-display text-base font-semibold text-[var(--text-primary)]">Adventure Mode</div>
							<p class="mt-1 text-sm text-[var(--text-muted)]">You are the protagonist. Make choices, explore, and shape the story through your actions.</p>
						</div>
					</div>
				</div>
			</button>

			<button class="w-full text-left" onclick={() => storyMode = 'creative-writing'}>
				<div class="rounded-xl border p-5 transition-all
					{storyMode === 'creative-writing' ? 'border-[var(--color-gold-400)] bg-[rgba(212,168,83,0.08)]' : 'border-[var(--border-primary)] hover:border-[var(--color-gold-600)]'}">
					<div class="flex items-center gap-4">
						<div class="flex h-12 w-12 items-center justify-center rounded-lg bg-[rgba(42,82,120,0.15)]">
							<Feather class="h-6 w-6 text-blue-400" />
						</div>
						<div>
							<div class="font-display text-base font-semibold text-[var(--text-primary)]">Creative Writing</div>
							<p class="mt-1 text-sm text-[var(--text-muted)]">You are the author. Direct the narrative and collaborate with AI to craft prose.</p>
						</div>
					</div>
				</div>
			</button>
		</div>

		{:else if currentStep === 2}
		<!-- Step 2: World & Setting -->
		<div class="space-y-5" in:fly={{ x: direction * 200, duration: 250 }}>
			<div class="space-y-2">
				<label for="onboarding-story-title" class="font-display text-sm tracking-wide text-[var(--text-primary)]">Story Title</label>
				<input id="onboarding-story-title" type="text" bind:value={storyTitle} placeholder="The Fall of Aetheron"
					class="w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-4 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
			</div>

			<div class="space-y-2">
				<div class="flex items-end justify-between gap-3">
					<span class="font-display text-sm tracking-wide text-[var(--text-primary)]">GM Prompt Pack</span>
					<span class="text-[10px] italic text-[var(--text-muted)] opacity-60">Genre or selection here affects prompting.</span>
				</div>
				<div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
					{#each genres as g}
						<button class="flex min-h-[5.25rem] flex-col items-center gap-1 rounded-lg border p-3 text-center transition-all
							{genre === g.id ? 'border-[var(--color-gold-400)] bg-[rgba(212,168,83,0.08)]' : 'border-[var(--border-primary)] hover:border-[var(--color-gold-600)]'}"
							aria-pressed={genre === g.id}
							onclick={() => genre = g.id}>
							<span class="text-lg">{g.emoji}</span>
							<span class="text-xs text-[var(--text-muted)]">{g.label}</span>
						</button>
					{/each}
				</div>
				<p class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs leading-relaxed text-[var(--text-muted)] opacity-70">
					{getOnboardingGenreOption(genre).summary}
				</p>
			</div>

			<div class="space-y-2">
				<label for="onboarding-world-description" class="font-display text-sm tracking-wide text-[var(--text-primary)]">World Description <span class="text-[var(--text-muted)]">(optional)</span></label>
				<textarea id="onboarding-world-description" bind:value={worldDescription} placeholder="A crumbling empire where ancient magic seeps through fractured ley lines..."
					rows="4"
					class="w-full resize-none rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
			</div>

			<div class="space-y-3 rounded-xl border border-[rgba(212,168,83,0.25)] bg-[rgba(212,168,83,0.06)] p-4">
				<div class="flex items-start gap-3">
					<Sparkles class="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-accent)]" />
					<div>
						<div class="font-display text-sm tracking-wide text-[var(--text-primary)]">AI Writing Assist</div>
						<p class="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
							Use your existing provider settings to draft or expand this story seed with the selected GM prompt pack. Provider choice stays in first-time onboarding only.
						</p>
					</div>
				</div>
				<textarea bind:value={storyAssistNotes} placeholder="Optional notes: tone, conflict, themes, inspirations, must-have factions..."
					rows="3"
					aria-label="Story assist notes"
					class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
				<button type="button" onclick={assistStorySetup} disabled={assistingStorySetup}
					class="flex w-full items-center justify-center gap-2 rounded-lg bg-[rgba(212,168,83,0.12)] px-3 py-2 font-display text-xs uppercase tracking-wider text-[var(--text-accent)] transition-colors hover:bg-[rgba(212,168,83,0.2)] disabled:opacity-50">
					{#if assistingStorySetup}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Sparkles class="h-3.5 w-3.5" />{/if}
					{assistingStorySetup ? 'Drafting...' : 'AI Assist With Writing'}
				</button>
				{#if storyAssistRationale}
					<p class="text-xs text-[var(--text-muted)]">{storyAssistRationale}</p>
				{/if}
				{#if storyAssistError}
					<p class="text-xs text-red-400">{storyAssistError}</p>
				{/if}
			</div>
		</div>

		{:else if currentStep === 3}
		<!-- Step 3: Character -->
		<div class="space-y-5" in:fly={{ x: direction * 200, duration: 250 }}>
			<p class="text-sm text-[var(--text-muted)]">
				{#if storyMode === 'adventure'}
					Create your protagonist — the character you'll embody in this world.
				{:else}
					Create the main character of your story.
				{/if}
			</p>

			<div class="space-y-2">
				<label for="onboarding-protagonist-name" class="font-display text-sm tracking-wide text-[var(--text-primary)]">Name</label>
				<input id="onboarding-protagonist-name" type="text" bind:value={protagonistName} placeholder="Kael Ashborne"
					class="w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-4 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
			</div>

			<div class="space-y-2">
				<label for="onboarding-protagonist-description" class="font-display text-sm tracking-wide text-[var(--text-primary)]">Description <span class="text-[var(--text-muted)]">(optional)</span></label>
				<textarea id="onboarding-protagonist-description" bind:value={protagonistDescription} placeholder="A wandering scholar with silver-streaked hair and ink-stained fingers, carrying forbidden texts from the old empire..."
					rows="4"
					class="w-full resize-none rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
			</div>

			<button class="text-sm text-[var(--text-muted)] hover:text-[var(--text-accent)]"
				onclick={next}>
				Skip — I'll let the story decide →
			</button>
		</div>

		{:else if currentStep === 4}
		<!-- Step 4: Lorebook -->
		<div class="space-y-5" in:fly={{ x: direction * 200, duration: 250 }}>
			<p class="text-sm text-[var(--text-muted)]">
				Import an existing lorebook or add entries manually. The AI will use these to stay consistent with your world.
			</p>

			<!-- Import section (buffered — entries saved in finish() with real storyId) -->
			<LorebookImport storyId="buffer" onImported={(result) => {
				if (Array.isArray(result)) importedFileEntries = result;
			}} />

			<div class="flex items-center gap-4">
				<div class="h-px flex-1 bg-[var(--border-primary)]"></div>
				<span class="font-display text-xs tracking-wider uppercase text-[var(--text-muted)]">or add manually</span>
				<div class="h-px flex-1 bg-[var(--border-primary)]"></div>
			</div>

			{#each lorebookEntries as entry, i}
				<div class="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
					<div class="flex items-center justify-between">
						<span class="font-display text-xs tracking-wider uppercase text-[var(--text-accent)]">Entry {i + 1}</span>
						<button class="text-[var(--text-muted)] hover:text-[var(--color-crimson-400)]" aria-label={`Remove entry ${i + 1}`} onclick={() => removeLorebookEntry(i)}>
							<X class="h-4 w-4" />
						</button>
					</div>
					<input type="text" bind:value={entry.name} aria-label={`Entry ${i + 1} name`} placeholder="Entry name (e.g. The Ashen Court)"
						class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
					<textarea bind:value={entry.content} aria-label={`Entry ${i + 1} description`} placeholder="Describe this lore element..."
						rows="3"
						class="w-full resize-none rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
					<input type="text" bind:value={entry.keywords} aria-label={`Entry ${i + 1} keywords`} placeholder="Keywords (comma separated): ashen, court, tribunal"
						class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
				</div>
			{/each}

			<button class="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-primary)] py-4 text-sm text-[var(--text-muted)] transition-colors hover:border-[var(--color-gold-600)] hover:text-[var(--text-accent)]"
				onclick={addLorebookEntry}>
				<Plus class="h-4 w-4" />
				Add Lore Entry
			</button>

			{#if saveError}
				<p class="text-sm text-red-400">{saveError}</p>
			{/if}
		</div>

		{/if}

		</div>
	</div>

	<!-- Bottom nav -->
	<div class="fixed bottom-0 left-0 right-0 z-10 border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] px-6 py-4 pb-[max(env(safe-area-inset-bottom),16px)]">
		<div class="mx-auto flex max-w-lg items-center justify-between gap-4">
			<button
				class="flex items-center gap-2 rounded-xl px-4 py-3 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]
					{currentStep === 0 ? 'invisible' : ''}"
				onclick={prev}>
				<ChevronLeft class="h-4 w-4" />
				Back
			</button>

			{#if currentStep === 4}
				<!-- Final step: Begin Story -->
				<button
					class="flex items-center gap-2 rounded-xl bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] px-8 py-3 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] transition-all hover:shadow-lg hover:shadow-[rgba(212,168,83,0.3)]
						{saving ? 'opacity-70 cursor-not-allowed' : ''}"
					disabled={saving}
					onclick={beginStory}>
					{#if saving}
						<Loader2 class="h-4 w-4 animate-spin" />
						Saving...
					{:else}
						<Play class="h-4 w-4" />
						Begin Story
					{/if}
				</button>
			{:else}
				<button
					class="flex items-center gap-2 rounded-xl px-6 py-3 font-display text-sm tracking-wide transition-all
						{canProceed
							? 'bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] font-semibold text-[var(--bg-primary)] hover:shadow-lg hover:shadow-[rgba(212,168,83,0.3)]'
							: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] cursor-not-allowed'}"
					disabled={!canProceed}
					onclick={next}>
					Next
					<ChevronRight class="h-4 w-4" />
				</button>
			{/if}
		</div>
	</div>
</div>
