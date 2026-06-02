<script lang="ts">
	import { BookOpen, Database, Library, ScrollText, Settings } from 'lucide-svelte';
	import SettingsModal from '$lib/components/settings/SettingsModal.svelte';
	import LibraryPanel from '$lib/components/library/LibraryPanel.svelte';
	import LorebookPanel from '$lib/components/lorebook/LorebookPanel.svelte';
	import StoryMemoryPanel from '$lib/components/memory/StoryMemoryPanel.svelte';
	import WorldExplorer from '$lib/components/database/WorldExplorer.svelte';

	let activePanel = $state<'library' | 'chapters' | 'wiki' | 'database' | 'settings'>('library');
	let settingsOpen = $state(false);

	const navItems = [
		{ id: 'library' as const, icon: Library, label: 'Library' },
		{ id: 'chapters' as const, icon: BookOpen, label: 'Chapters' },
		{ id: 'wiki' as const, icon: ScrollText, label: 'Wiki' },
		{ id: 'database' as const, icon: Database, label: 'World DB' },
		{ id: 'settings' as const, icon: Settings, label: 'Settings', action: () => settingsOpen = true },
	];
</script>

<div class="app-shell relative flex h-[100dvh] w-screen flex-col bg-[var(--bg-primary)]">
	<div class="grain-overlay"></div>
	<div class="cathedral-glow"></div>

	<!-- Header (desktop) -->
	<header class="relative z-10 hidden h-14 items-center justify-between border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 sm:flex">
		<div class="flex items-center gap-3">
			<svg viewBox="0 0 48 48" fill="none" class="h-6 w-6 text-[var(--text-accent)]">
				<path d="M24 4L6 14v20l18 10 18-10V14L24 4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
				<circle cx="24" cy="24" r="5" fill="currentColor" opacity="0.6"/>
			</svg>
			<span class="font-display text-lg font-semibold tracking-wide text-[var(--text-accent)]">Mtherios</span>
		</div>

		<nav class="flex items-center gap-1">
			{#each navItems as item}
				<button
					class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors
						{activePanel === item.id
							? 'bg-[rgba(212,168,83,0.12)] text-[var(--text-accent)]'
							: 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}"
					onclick={() => item.action ? item.action() : (activePanel = item.id)}
				>
					<item.icon class="h-4 w-4" />
					<span class="font-display text-xs tracking-wider uppercase">{item.label}</span>
				</button>
			{/each}
		</nav>

		<div class="w-32"></div>
	</header>

	<!-- Main content -->
	<main class="relative z-[1] flex-1 overflow-hidden">
		{#if activePanel === 'library'}
			<LibraryPanel />
		{:else if activePanel === 'chapters'}
			<StoryMemoryPanel />
		{:else if activePanel === 'wiki'}
			<LorebookPanel />
		{:else if activePanel === 'database'}
			<WorldExplorer />
		{:else if activePanel === 'settings'}
			<div class="flex h-full items-center justify-center">
				<button class="rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] px-6 py-3 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)]"
					onclick={() => settingsOpen = true}>
					Open Settings
				</button>
			</div>
		{/if}
	</main>

	<!-- Mobile bottom nav -->
	<nav class="relative z-10 flex items-center justify-around border-t border-[var(--border-primary)] bg-[var(--bg-tertiary)] pb-[env(safe-area-inset-bottom)] sm:hidden">
		{#each navItems as item}
			<button
				class="flex flex-col items-center gap-1 px-3 py-3 transition-colors
					{activePanel === item.id ? 'text-[var(--text-accent)]' : 'text-[var(--text-muted)]'}"
				onclick={() => item.action ? item.action() : (activePanel = item.id)}
			>
				<item.icon class="h-5 w-5" />
				<span class="text-[10px] font-display tracking-wider uppercase">{item.label}</span>
			</button>
		{/each}
	</nav>
</div>

<SettingsModal open={settingsOpen} onClose={() => settingsOpen = false} />

<style>
	.app-shell { padding-top: env(safe-area-inset-top, 0px); }
</style>
