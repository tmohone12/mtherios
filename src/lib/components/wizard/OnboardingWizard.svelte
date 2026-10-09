<script lang="ts">
	import { Sword, Feather, ChevronLeft, ChevronRight, Globe, Zap, Play, Plus, X, Upload, Loader2, Sparkles, Check, Eye, EyeOff } from 'lucide-svelte';
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
		{ title: 'Connect', heading: 'Meet your creative partner.', subtitle: 'Connect an AI provider to bring your stories to life.' },
		{ title: 'Mode', heading: 'Find your way into the story.', subtitle: 'Step into a character’s shoes, or take the author’s chair.' },
		{ title: 'World', heading: 'Give your imagination a place.', subtitle: 'A name, a mood, a spark of conflict. Start with what you know.' },
		{ title: 'Character', heading: 'Someone to follow.', subtitle: 'Introduce a protagonist, or let one emerge along the way.' },
		{ title: 'Lore', heading: 'A world with a history.', subtitle: 'Add the people, places, and ideas your story should remember.' },
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

<input
	bind:this={storyFileInput}
	type="file"
	accept=".json,application/json"
	class="hidden"
	aria-label="Import story or world database file"
	onchange={handleStoryFileImport}
/>

<div class="app-shell wizard-shell">

	<!-- Header -->
	<header class="wizard-header">
		<div class="flex items-center gap-3">
			<svg viewBox="0 0 48 48" fill="none" class="h-6 w-6 text-[var(--text-accent)]">
				<path d="M24 4L6 14v20l18 10 18-10V14L24 4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
				<circle cx="24" cy="24" r="5" fill="currentColor" opacity="0.6"/>
			</svg>
			<span class="wizard-wordmark">MythEngine<span>A living story</span></span>
		</div>
		{#if onSkip}
			<button class="wizard-exit" onclick={onSkip}>
				Back to library <X class="h-4 w-4" />
			</button>
		{/if}
	</header>

	<div class="wizard-layout">
	<aside class="wizard-sidebar">
		<div class="wizard-introduction">
			<span class="wizard-eyebrow">The beginning</span>
			<h1>Every world<br />starts with<br /><em>a story.</em></h1>
			<p>Lay the first stones. There is room for everything else to grow.</p>
		</div>
	<nav class="wizard-steps" aria-label="Story creation steps">
		{#each steps as s, i}
			<button
				class="wizard-step"
				class:current={i === currentStep}
				class:complete={i < currentStep}
				aria-label={`Go to ${s.title}`}
				aria-current={i === currentStep ? 'step' : undefined}
				disabled={i > currentStep}
				onclick={() => i <= currentStep ? goTo(i) : null}
			>
				<span class="wizard-step-number">{#if i < currentStep}<Check class="h-3.5 w-3.5" />{:else}0{i + 1}{/if}</span>
				<span>{s.title}</span>
				{#if i === currentStep}<ChevronRight class="wizard-step-arrow h-3.5 w-3.5" />{/if}
			</button>
		{/each}
	</nav>
		<div class="wizard-sidebar-note"><Feather class="h-4 w-4" /><span>Your first chapter is waiting.</span></div>
	</aside>

	<!-- Content -->
	<div class="wizard-main">
	<div class="wizard-content">
		<div class="wizard-form">
			<header class="wizard-step-heading">
				<span class="wizard-eyebrow">Chapter 0{currentStep + 1} / {steps[currentStep].title}</span>
				<h2>{steps[currentStep].heading}</h2>
				<p>{steps[currentStep].subtitle}</p>
			</header>

		{#if currentStep === 0}
		<!-- Step 0: Provider Setup -->
		<div class="space-y-6" in:fly={{ x: direction * 200, duration: 250 }}>
			<div class="grid grid-cols-2 gap-3">
				{#each [
					{ id: 'nanogpt', name: 'NanoGPT', desc: 'Affordable multi-model', icon: Zap },
					{ id: 'openrouter', name: 'OpenRouter', desc: '100+ models', icon: Globe },
				] as p}
					<button class="wizard-provider flex flex-col items-center gap-3 rounded-xl border p-5 text-center transition-all
						{provider === p.id ? 'border-[var(--color-gold-400)] bg-[rgba(212,168,83,0.1)]' : 'border-[var(--border-primary)] hover:border-[var(--color-gold-600)]'}"
						aria-pressed={provider === p.id}
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
						class="w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-4 pr-12 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none focus:ring-1 focus:ring-[var(--color-gold-600)]"
					/>
					<button class="wizard-key-toggle" aria-label={showKey ? 'Hide API key' : 'Show API key'} onclick={() => showKey = !showKey}>
						{#if showKey}<EyeOff class="h-4 w-4" />{:else}<Eye class="h-4 w-4" />{/if}
					</button>
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

			<button
				class="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-primary)] py-4 text-sm text-[var(--text-muted)] transition-colors hover:border-[var(--color-gold-600)] hover:text-[var(--text-accent)]"
				disabled={importingStory}
				onclick={() => storyFileInput?.click()}
			>
				{#if importingStory}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Upload class="h-4 w-4" />{/if}
				{importingStory ? 'Importing...' : 'Import Story or World Database'}
			</button>
			<p class="text-center text-xs text-[var(--text-muted)]">Accepts MythEngine, legacy .mtherios.json, and .world-db.json bundles.</p>
		</div>

		{:else if currentStep === 1}
		<!-- Step 1: Story Mode -->
		<div class="space-y-4" in:fly={{ x: direction * 200, duration: 250 }}>
			<button class="wizard-mode w-full text-left" aria-pressed={storyMode === 'adventure'} onclick={() => storyMode = 'adventure'}>
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

			<button class="wizard-mode w-full text-left" aria-pressed={storyMode === 'creative-writing'} onclick={() => storyMode = 'creative-writing'}>
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

			<div class="flex items-center gap-4 py-1">
				<div class="h-px flex-1 bg-[var(--border-primary)]"></div>
				<span class="font-display text-xs tracking-wider uppercase text-[var(--text-muted)]">or start with a world</span>
				<div class="h-px flex-1 bg-[var(--border-primary)]"></div>
			</div>

			<button
				class="flex w-full items-center gap-4 rounded-xl border border-dashed border-[var(--color-gold-600)] bg-[rgba(212,168,83,0.06)] p-5 text-left transition-colors hover:bg-[rgba(212,168,83,0.12)]"
				disabled={importingStory}
				onclick={() => storyFileInput?.click()}
			>
				<div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[rgba(212,168,83,0.14)] text-[var(--text-accent)]">
					{#if importingStory}<Loader2 class="h-6 w-6 animate-spin" />{:else}<Upload class="h-6 w-6" />{/if}
				</div>
				<div>
					<div class="font-display text-base font-semibold text-[var(--text-primary)]">{importingStory ? 'Importing database…' : 'Import World Database'}</div>
					<p class="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">Create the story with its characters, factions, relationships, timeline, lore, and memory already loaded.</p>
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
							<span class="text-lg" aria-hidden="true">{g.emoji}</span>
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
	<footer class="wizard-footer">
		<div class="wizard-footer-inner">
			<button
				class="wizard-back flex items-center gap-2 rounded-xl px-4 py-3 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]
					{currentStep === 0 ? 'invisible' : ''}"
				onclick={prev}>
				<ChevronLeft class="h-4 w-4" />
				Back
			</button>

			{#if currentStep === 4}
				<!-- Final step: Begin Story -->
				<button
					class="wizard-next"
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
					class="wizard-next"
					disabled={!canProceed}
					onclick={next}>
					Continue
					<ChevronRight class="h-4 w-4" />
				</button>
			{/if}
		</div>
	</footer>
	</div>
	</div>
</div>

<style>
	.wizard-shell { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; min-height: 0; overflow: hidden; background: var(--bg-primary); }
	.wizard-header { display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; min-height: 90px; padding: 18px 42px; border-bottom: 1px solid var(--border-primary); }
	.wizard-wordmark { color: var(--text-primary); font: 24px/1.1 var(--font-display); letter-spacing: -.025em; }
	.wizard-wordmark > span { display: block; margin-top: 5px; font: 8px/1.4 var(--font-ui); letter-spacing: .2em; text-transform: uppercase; color: var(--text-muted); }
	.wizard-exit { display: flex; align-items: center; gap: 13px; min-height: 42px; padding: 0 12px; border-radius: 8px; color: var(--text-muted); font-size: 12px; }
	.wizard-exit:hover { color: var(--text-primary); background: var(--bg-tertiary); }
	.wizard-layout { display: grid; grid-template-columns: 330px minmax(0, 1fr); width: min(1240px, 100%); min-height: 0; margin-inline: auto; flex: 1; }
	.wizard-sidebar { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow-y: auto; padding: 45px 35px 28px; border-right: 1px solid var(--border-primary); }
	.wizard-eyebrow { display: block; color: var(--text-accent); font: 10px/1.5 var(--font-ui); font-weight: 600; letter-spacing: .17em; text-transform: uppercase; }
	.wizard-introduction h1 { margin-top: 20px; font: 43px/1.05 var(--font-display); letter-spacing: -.035em; color: var(--text-primary); }
	.wizard-introduction h1 em { color: var(--text-accent); font-weight: 400; }
	.wizard-introduction p { margin-top: 19px; max-width: 215px; font-size: 12px; line-height: 1.9; color: var(--text-muted); }
	.wizard-steps { display: flex; flex-direction: column; gap: 6px; margin-top: 35px; }
	.wizard-step { display: flex; align-items: center; gap: 14px; min-height: 47px; padding: 9px 13px; border: 1px solid transparent; border-radius: 9px; color: var(--text-muted); font-size: 12px; text-align: left; transition: background 150ms, border-color 150ms, color 150ms; }
	.wizard-step-number { display: flex; align-items: center; justify-content: center; min-width: 23px; height: 23px; font: 10px var(--font-mono); color: var(--text-muted); }
	.wizard-step.current { background: color-mix(in srgb, var(--text-accent) 8%, transparent); border-color: color-mix(in srgb, var(--text-accent) 22%, transparent); color: var(--text-primary); }
	.wizard-step.current .wizard-step-number { color: var(--text-accent); }
	.wizard-step.complete .wizard-step-number { color: #a9bea4; }
	.wizard-step:not(:disabled):hover { background: var(--bg-tertiary); }
	.wizard-step:disabled { opacity: .55; }
	.wizard-step :global(.wizard-step-arrow) { margin-left: auto; color: var(--text-accent); }
	.wizard-sidebar-note { display: flex; align-items: center; gap: 10px; margin-top: auto; padding-top: 30px; color: var(--text-muted); font-size: 10px; }
	.wizard-main { display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--bg-secondary); }
	.wizard-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-gutter: stable; }
	.wizard-form { width: 100%; max-width: 720px; margin-inline: auto; padding: 47px 44px 44px; }
	.wizard-step-heading { margin-bottom: 32px; }
	.wizard-step-heading h2 { max-width: 560px; margin-top: 14px; color: var(--text-primary); font: 37px/1.13 var(--font-display); letter-spacing: -.03em; }
	.wizard-step-heading p { margin-top: 14px; color: var(--text-muted); font-size: 13px; line-height: 1.8; }
	.wizard-form :global(input:not([type='file'])), .wizard-form :global(textarea) { min-width: 0; border-radius: 9px; background: var(--bg-primary); font-size: 14px; line-height: 1.7; }
	.wizard-form :global(textarea) { resize: vertical; }
	.wizard-form :global(input:focus-visible), .wizard-form :global(textarea:focus-visible) { outline: 2px solid color-mix(in srgb, var(--text-accent) 40%, transparent); outline-offset: 3px; }
	.wizard-form :global(label.font-display) { display: inline-block; padding-bottom: 3px; font: 12px/1.5 var(--font-ui); font-weight: 600; letter-spacing: .01em; }
	.wizard-provider { position: relative; flex-direction: row; text-align: left; gap: 14px; padding: 22px 18px; background: var(--bg-primary); }
	.wizard-provider[aria-pressed='true'] { background: color-mix(in srgb, var(--text-accent) 8%, var(--bg-primary)); }
	.wizard-provider :global(.font-display) { font-family: var(--font-ui); }
	.wizard-provider :global(.h-12) { height: 36px; width: 36px; background: transparent; flex-shrink: 0; }
	.wizard-mode > div { padding: 25px 22px; border-radius: 12px; background: var(--bg-primary); }
	.wizard-mode[aria-pressed='true'] > div { background: color-mix(in srgb, var(--text-accent) 7%, var(--bg-primary)); }
	.wizard-mode :global(.font-display) { font: 23px/1.3 var(--font-display); font-weight: 400; }
	.wizard-mode p { font-size: 12px; line-height: 1.8; }
	.wizard-mode :global(.h-12) { flex-shrink: 0; }
	.wizard-key-toggle { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; color: var(--text-muted); border-radius: 6px; }
	.wizard-key-toggle:hover { color: var(--text-primary); background: var(--bg-tertiary); }
	.wizard-footer { flex-shrink: 0; padding: 20px 44px max(env(safe-area-inset-bottom), 20px); border-top: 1px solid var(--border-primary); background: var(--bg-secondary); }
	.wizard-footer-inner { display: flex; align-items: center; justify-content: space-between; gap: 16px; max-width: 632px; margin-inline: auto; }
	.wizard-back { padding-left: 0; font-size: 12px; }
	.wizard-next { display: flex; align-items: center; justify-content: center; gap: 16px; min-width: 144px; min-height: 46px; padding: 12px 22px; border: 1px solid var(--text-accent); border-radius: 8px; color: var(--bg-primary); background: var(--text-accent); font: 600 12px/1.5 var(--font-ui); transition: background 150ms, transform 150ms; }
	.wizard-next:not(:disabled):hover { background: color-mix(in srgb, var(--text-accent) 82%, white); transform: translateY(-1px); }
	.wizard-next:disabled { color: var(--text-muted); background: var(--bg-tertiary); border-color: var(--border-primary); cursor: not-allowed; }
	@media (max-height: 850px) and (min-width: 801px) {
		.wizard-header { min-height: 75px; }
		.wizard-sidebar { padding-top: 30px; }
		.wizard-introduction h1 { font-size: 36px; margin-top: 12px; }
		.wizard-introduction p { margin-top: 12px; }
		.wizard-steps { margin-top: 22px; gap: 2px; }
		.wizard-step { min-height: 41px; padding-block: 7px; }
		.wizard-form { padding-top: 34px; }
	}
	@media (max-width: 1000px) {
		.wizard-layout { grid-template-columns: 270px minmax(0, 1fr); }
		.wizard-sidebar { padding-inline: 26px; }
		.wizard-introduction h1 { font-size: 38px; }
		.wizard-form { padding: 34px 30px; }
		.wizard-step-heading h2 { font-size: 32px; }
		.wizard-provider { flex-direction: column; align-items: flex-start; padding: 17px; gap: 7px; }
		.wizard-footer { padding-inline: 30px; }
	}
	@media (max-width: 800px) {
		.wizard-header { min-height: 76px; padding: 14px 22px; }
		.wizard-layout { display: flex; flex-direction: column; }
		.wizard-sidebar { flex-shrink: 0; padding: 0; border-right: 0; border-bottom: 1px solid var(--border-primary); }
		.wizard-introduction, .wizard-sidebar-note { display: none; }
		.wizard-steps { flex-direction: row; gap: 4px; margin: 0; padding: 11px 18px; overflow-x: auto; }
		.wizard-step { flex: 1; flex-shrink: 0; justify-content: center; min-width: max-content; min-height: 42px; gap: 7px; padding: 8px 11px; font-size: 11px; }
		.wizard-step-number { min-width: 17px; font-size: 9px; }
		.wizard-step :global(.wizard-step-arrow) { display: none; }
		.wizard-main { flex: 1; }
		.wizard-form { max-width: 650px; padding: 32px 28px; }
		.wizard-step-heading { margin-bottom: 27px; }
		.wizard-step-heading h2 { max-width: 460px; font-size: 33px; }
		.wizard-provider { flex-direction: row; align-items: center; gap: 12px; }
		.wizard-footer { padding: 14px 28px max(env(safe-area-inset-bottom), 14px); }
	}
	@media (max-width: 480px) {
		.wizard-header { padding-inline: 18px; }
		.wizard-wordmark { font-size: 22px; }
		.wizard-exit { font-size: 11px; gap: 10px; padding-right: 0; }
		.wizard-steps { padding: 9px 12px; gap: 3px; }
		.wizard-step { flex-direction: column; gap: 1px; padding: 7px; font-size: 10px; min-width: 56px; }
		.wizard-step-number { height: 17px; }
		.wizard-form { padding: 28px 20px; }
		.wizard-step-heading h2 { font-size: 31px; }
		.wizard-step-heading p { font-size: 12px; }
		.wizard-provider { flex-direction: column; align-items: flex-start; gap: 8px; padding: 17px; }
		.wizard-mode > div { padding: 21px 17px; }
		.wizard-mode :global(.h-12) { height: 36px; width: 36px; }
		.wizard-mode :global(.font-display) { font-size: 21px; }
		.wizard-form :global(input:not([type='file'])), .wizard-form :global(textarea) { font-size: 16px; }
		.wizard-footer { padding-inline: 20px; }
		.wizard-next { min-height: 46px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.wizard-shell :global(*) { transition-duration: 0ms !important; animation-duration: 0ms !important; }
	}
</style>
