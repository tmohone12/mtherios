<script lang="ts">
	import { Sword, Feather, ChevronLeft, ChevronRight, Globe, Zap, Play, Plus, X, Sparkles, Upload } from 'lucide-svelte';
	import { fly, fade } from 'svelte/transition';
	import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
	import { getSetting, setSetting, createStory, createCharacter, createLorebookEntry } from '$lib/services/database';
	import { convertToEntries, type ImportedEntry } from '$lib/services/lorebookImporter';
	import LorebookImport from '$lib/components/lorebook/LorebookImport.svelte';
	import type { Story, Character, Entry, StoryMode, APIProfile, ProviderType } from '$lib/types';

	interface Props {
		onComplete: (storyId: string) => void;
		onSkip?: () => void;
	}

	let { onComplete, onSkip }: Props = $props();

	// ── Wizard State ──
	let currentStep = $state(0);
	let direction = $state(1);

	// Step 0: Provider
	let provider = $state<string>('nanogpt');
	let apiKey = $state('');
	let showKey = $state(false);

	// Step 1: Story Mode
	let storyMode = $state<StoryMode>('adventure');

	// Step 2: World & Setting
	let storyTitle = $state('');
	let genre = $state('fantasy');
	let worldDescription = $state('');

	// Step 3: Character
	let protagonistName = $state('');
	let protagonistDescription = $state('');

	// Step 4: Lorebook entries
	let lorebookEntries = $state<Array<{ name: string; content: string; keywords: string }>>([]);
	let importedFileEntries = $state<ImportedEntry[]>([]);

	const genres = [
		{ id: 'fantasy', label: 'Fantasy', emoji: '⚔️' },
		{ id: 'sci-fi', label: 'Sci-Fi', emoji: '🚀' },
		{ id: 'horror', label: 'Horror', emoji: '👻' },
		{ id: 'mystery', label: 'Mystery', emoji: '🔍' },
		{ id: 'romance', label: 'Romance', emoji: '💕' },
		{ id: 'historical', label: 'Historical', emoji: '🏛️' },
		{ id: 'cyberpunk', label: 'Cyberpunk', emoji: '🌆' },
		{ id: 'post-apocalyptic', label: 'Post-Apocalyptic', emoji: '☢️' },
	];

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

	async function finish() {
		// Save provider as proper APIProfile
		const profileId = crypto.randomUUID();
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

		// Create story
		const storyId = crypto.randomUUID();
		const now = Date.now();
		const story: Story = {
			id: storyId,
			title: storyTitle || 'Untitled Chronicle',
			description: worldDescription || null,
			genre: genre,
			templateId: null,
			mode: storyMode,
			createdAt: now,
			updatedAt: now,
			settings: {
				pov: storyMode === 'adventure' ? 'second' : 'third',
				tense: 'present',
				tone: genre,
				temperature: 1.0,
				maxTokens: 8192,
			},
			memoryConfig: {
				tokenThreshold: 16000,
				chapterBuffer: 10,
				autoSummarize: true,
				enableRetrieval: true,
				maxChaptersPerRetrieval: 3,
			},
			retryState: null,
			styleReviewState: null,
			timeTracker: null,
			currentBranchId: null,
			currentBgImage: null,
		};
		await createStory(story);

		// Create protagonist
		if (protagonistName) {
			const char: Character = {
				id: crypto.randomUUID(),
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
			await createCharacter(char);
		}

		// Create lorebook entries
		for (const entry of lorebookEntries) {
			if (!entry.name.trim()) continue;
			const lorebookEntry: Entry = {
				id: crypto.randomUUID(),
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
			await createLorebookEntry(lorebookEntry);
		}

		// Write buffered file-imported entries with the real storyId
		if (importedFileEntries.length > 0) {
			const converted = convertToEntries(importedFileEntries, 'import');
			for (const entry of converted) {
				const fullEntry: Entry = {
					...entry,
					id: crypto.randomUUID(),
					storyId,
					createdAt: now,
					updatedAt: now,
				} as Entry;
				await createLorebookEntry(fullEntry);
			}
		}

		await setSetting('onboardingComplete', 'true');
		await setSetting('lastStoryId', storyId);
		onComplete(storyId);
	}

	let canProceed = $derived.by(() => {
		switch (currentStep) {
			case 0: return !!apiKey.trim();
			case 1: return true;
			case 2: return !!storyTitle.trim();
			case 3: return true; // protagonist is optional
			case 4: return true; // lorebook is optional
			default: return true;
		}
	});
</script>

<div class="fixed inset-0 z-50 flex flex-col bg-[var(--bg-primary)]">
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
			<button class="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]" onclick={onSkip}>
				Skip for now
			</button>
		{/if}
	</div>

	<!-- Progress dots -->
	<div class="relative z-10 flex justify-center gap-2 py-2">
		{#each steps as s, i}
			<button
				class="h-2 rounded-full transition-all duration-300
					{i === currentStep ? 'w-8 bg-[var(--color-gold-400)]' : i < currentStep ? 'w-2 bg-[var(--color-gold-600)]' : 'w-2 bg-[var(--color-surface-700)]'}"
				onclick={() => i <= currentStep ? goTo(i) : null}
			></button>
		{/each}
	</div>

	<!-- Step title -->
	<div class="relative z-10 px-6 py-4 text-center">
		<h2 class="font-display text-2xl tracking-wide text-[var(--text-primary)]">{steps[currentStep].title}</h2>
		<p class="mt-1 text-sm text-[var(--text-muted)]">{steps[currentStep].subtitle}</p>
	</div>

	<!-- Content -->
	<div class="relative z-[1] flex-1 overflow-y-auto px-6 pb-32">
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
				<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">API Key</label>
				<div class="relative">
					<input
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
				<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Story Title</label>
				<input type="text" bind:value={storyTitle} placeholder="The Fall of Aetheron"
					class="w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-4 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
			</div>

			<div class="space-y-2">
				<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Genre</label>
				<div class="grid grid-cols-4 gap-2">
					{#each genres as g}
						<button class="flex flex-col items-center gap-1 rounded-lg border p-3 transition-all
							{genre === g.id ? 'border-[var(--color-gold-400)] bg-[rgba(212,168,83,0.08)]' : 'border-[var(--border-primary)] hover:border-[var(--color-gold-600)]'}"
							onclick={() => genre = g.id}>
							<span class="text-lg">{g.emoji}</span>
							<span class="text-xs text-[var(--text-muted)]">{g.label}</span>
						</button>
					{/each}
				</div>
			</div>

			<div class="space-y-2">
				<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">World Description <span class="text-[var(--text-muted)]">(optional)</span></label>
				<textarea bind:value={worldDescription} placeholder="A crumbling empire where ancient magic seeps through fractured ley lines..."
					rows="4"
					class="w-full resize-none rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
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
				<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Name</label>
				<input type="text" bind:value={protagonistName} placeholder="Kael Ashborne"
					class="w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-4 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
			</div>

			<div class="space-y-2">
				<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Description <span class="text-[var(--text-muted)]">(optional)</span></label>
				<textarea bind:value={protagonistDescription} placeholder="A wandering scholar with silver-streaked hair and ink-stained fingers, carrying forbidden texts from the old empire..."
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
						<button class="text-[var(--text-muted)] hover:text-[var(--color-crimson-400)]" onclick={() => removeLorebookEntry(i)}>
							<X class="h-4 w-4" />
						</button>
					</div>
					<input type="text" bind:value={entry.name} placeholder="Entry name (e.g. The Ashen Court)"
						class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
					<textarea bind:value={entry.content} placeholder="Describe this lore element..."
						rows="3"
						class="w-full resize-none rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
					<input type="text" bind:value={entry.keywords} placeholder="Keywords (comma separated): ashen, court, tribunal"
						class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
				</div>
			{/each}

			<button class="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-primary)] py-4 text-sm text-[var(--text-muted)] transition-colors hover:border-[var(--color-gold-600)] hover:text-[var(--text-accent)]"
				onclick={addLorebookEntry}>
				<Plus class="h-4 w-4" />
				Add Lore Entry
			</button>
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

			{#if currentStep === steps.length - 1}
				<button
					class="flex items-center gap-2 rounded-xl bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] px-8 py-3 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] transition-all hover:shadow-lg hover:shadow-[rgba(212,168,83,0.3)]"
					onclick={finish}>
					<Play class="h-4 w-4" />
					Begin Story
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
