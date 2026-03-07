<script lang="ts">
	import { BookOpen, Library, ScrollText, Globe, Settings } from 'lucide-svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children?: Snippet } = $props();

	let activePanel = $state<'story' | 'library' | 'lorebook' | 'world' | 'settings'>('library');

	const navItems = [
		{ id: 'library' as const, icon: Library, label: 'Library' },
		{ id: 'lorebook' as const, icon: ScrollText, label: 'Lorebook' },
		{ id: 'story' as const, icon: BookOpen, label: 'Story' },
		{ id: 'world' as const, icon: Globe, label: 'World' },
		{ id: 'settings' as const, icon: Settings, label: 'Settings' },
	];
</script>

<div class="app-shell relative flex h-[100dvh] w-screen flex-col bg-[var(--bg-primary)]">
	<!-- Atmospheric effects -->
	<div class="grain-overlay"></div>
	<div class="cathedral-glow"></div>

	<!-- Header (desktop) -->
	<header class="relative z-10 hidden h-14 items-center justify-between border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 sm:flex">
		<div class="flex items-center gap-3">
			<div class="flex h-8 w-8 items-center justify-center">
				<svg viewBox="0 0 48 48" fill="none" class="h-6 w-6 text-[var(--text-accent)]">
					<path d="M24 4L6 14v20l18 10 18-10V14L24 4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
					<circle cx="24" cy="24" r="5" fill="currentColor" opacity="0.6"/>
				</svg>
			</div>
			<span class="font-display text-lg font-semibold tracking-wide text-[var(--text-accent)]">Mtherios</span>
		</div>

		<!-- Desktop nav -->
		<nav class="flex items-center gap-1">
			{#each navItems as item}
				<button
					class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors
						{activePanel === item.id
							? 'bg-[rgba(212,168,83,0.12)] text-[var(--text-accent)]'
							: 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}"
					onclick={() => activePanel = item.id}
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
			<div class="flex h-full items-center justify-center">
				<div class="text-center">
					<h2 class="font-display text-2xl text-[var(--text-accent)]">Library</h2>
					<p class="mt-2 text-[var(--text-muted)]">Your chronicles await</p>
				</div>
			</div>
		{:else if activePanel === 'story'}
			<div class="flex h-full items-center justify-center">
				<div class="text-center">
					<h2 class="font-display text-2xl text-[var(--text-accent)]">Story</h2>
					<p class="mt-2 text-[var(--text-muted)]">Select a tale to begin</p>
				</div>
			</div>
		{:else if activePanel === 'lorebook'}
			<div class="flex h-full items-center justify-center">
				<div class="text-center">
					<h2 class="font-display text-2xl text-[var(--text-accent)]">Lorebook</h2>
					<p class="mt-2 text-[var(--text-muted)]">The knowledge codex</p>
				</div>
			</div>
		{:else if activePanel === 'world'}
			<div class="flex h-full items-center justify-center">
				<div class="text-center">
					<h2 class="font-display text-2xl text-[var(--text-accent)]">World</h2>
					<p class="mt-2 text-[var(--text-muted)]">Characters, places, and artifacts</p>
				</div>
			</div>
		{:else if activePanel === 'settings'}
			<div class="flex h-full items-center justify-center">
				<div class="text-center">
					<h2 class="font-display text-2xl text-[var(--text-accent)]">Settings</h2>
					<p class="mt-2 text-[var(--text-muted)]">Configure the scriptorium</p>
				</div>
			</div>
		{/if}

		{#if children}
			{@render children()}
		{/if}
	</main>

	<!-- Mobile bottom nav -->
	<nav class="relative z-10 flex items-center justify-around border-t border-[var(--border-primary)] bg-[var(--bg-tertiary)] pb-[env(safe-area-inset-bottom)] sm:hidden">
		{#each navItems as item}
			<button
				class="flex flex-col items-center gap-1 px-3 py-3 transition-colors
					{activePanel === item.id
						? 'text-[var(--text-accent)]'
						: 'text-[var(--text-muted)]'}"
				onclick={() => activePanel = item.id}
			>
				<item.icon class="h-5 w-5" />
				<span class="text-[10px] font-display tracking-wider uppercase">{item.label}</span>
			</button>
		{/each}
	</nav>
</div>

<style>
	.app-shell {
		padding-top: env(safe-area-inset-top, 0px);
	}
</style>
