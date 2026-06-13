<script lang="ts">
	import { BookOpen, Database, Library, Scale, Settings, Server, Cpu, ChevronDown, X } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import SettingsModal from '$lib/components/settings/SettingsModal.svelte';
	import LibraryPanel from '$lib/components/library/LibraryPanel.svelte';
	import StoryMemoryPanel from '$lib/components/memory/StoryMemoryPanel.svelte';
	import WorldExplorer from '$lib/components/database/WorldExplorer.svelte';
	import CanonRepairCockpit from '$lib/components/canon/CanonRepairCockpit.svelte';
	import EnginePanel from '$lib/components/system/EnginePanel.svelte';
	import TerminalPanel from '$lib/components/system/TerminalPanel.svelte';

	type MainPanel = 'library' | 'chapters';
	type ToolPanel = 'database' | 'canon' | 'engine' | 'terminal' | null;

	let activeMain = $state<MainPanel>('library');
	let activeTool = $state<ToolPanel>(null);
	let settingsOpen = $state(false);
	let systemOpen = $state(false);
	let systemDropdownEl = $state<HTMLDivElement | null>(null);

	const mainNavItems = [
		{ id: 'library' as const, icon: Library, label: 'Shelves' },
		{ id: 'chapters' as const, icon: BookOpen, label: 'Chapters' },
	];

	const systemItems = [
		{ id: 'database' as const, icon: Database, label: 'Database Viewer' },
		{ id: 'canon' as const, icon: Scale, label: 'Canon' },
		{ id: 'engine' as const, icon: Server, label: 'Engine Core' },
		{ id: 'terminal' as const, icon: Cpu, label: 'Terminal Sync' },
	];

	function selectMain(id: MainPanel) {
		activeMain = id;
		activeTool = null;
	}

	function selectTool(id: ToolPanel) {
		activeTool = id;
		systemOpen = false;
	}

	function openSettings() {
		settingsOpen = true;
		systemOpen = false;
	}

	function closeTool() {
		activeTool = null;
	}

	function handleClickOutside(event: MouseEvent) {
		if (systemDropdownEl && !systemDropdownEl.contains(event.target as Node)) {
			systemOpen = false;
		}
	}

	onMount(() => {
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	});
</script>

<div class="app-shell relative flex h-[100dvh] w-screen flex-col bg-[var(--bg-primary)]">
	<div class="grain-overlay"></div>
	<div class="cathedral-glow"></div>

	<!-- Header (desktop) -->
	<header class="parchment-surface relative z-10 hidden h-16 items-center justify-between border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-5 sm:flex">
		<div class="flex items-center gap-3">
			<svg viewBox="0 0 48 48" fill="none" class="h-7 w-7 text-[var(--text-accent)]">
				<path d="M24 4L6 14v20l18 10 18-10V14L24 4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
				<circle cx="24" cy="24" r="5" fill="currentColor" opacity="0.6"/>
			</svg>
			<span class="font-display text-lg font-semibold tracking-wide text-[var(--text-accent)]">Mtherios</span>
		</div>

		<!-- Main nav -->
		<nav class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-1 rounded-xl border border-[var(--border-secondary)] bg-[var(--bg-primary)] p-1 shadow-sm">
			{#each mainNavItems as item}
				{@const isActive = activeMain === item.id && !activeTool}
				<button
					class="group relative flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm transition-all duration-200
						{isActive
							? 'text-[var(--text-accent)]'
							: 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}"
					onclick={() => selectMain(item.id)}
				>
					{#if isActive}
						<span class="absolute inset-0 rounded-lg bg-[var(--bg-tertiary)]" aria-hidden="true"></span>
						<span class="absolute -bottom-[5px] left-1/2 h-[2px] w-4 -translate-x-1/2 rounded-full bg-[var(--text-accent)]" aria-hidden="true"></span>
					{/if}
					<span class="relative flex items-center gap-2">
						<item.icon class="h-4 w-4" />
						<span class="font-display text-xs tracking-wider">{item.label}</span>
					</span>
				</button>
			{/each}
		</nav>

		<!-- System menu -->
		<div class="relative flex items-center gap-2" bind:this={systemDropdownEl}>
			{#if activeTool}
				<div class="flex items-center gap-2 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-1.5">
					<span class="font-display text-xs tracking-wider text-[var(--text-accent)]">
						{systemItems.find(i => i.id === activeTool)?.label ?? activeTool}
					</span>
					<button onclick={closeTool} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
						<X class="h-3.5 w-3.5" />
					</button>
				</div>
			{/if}
			<button
				class="flex items-center gap-1.5 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-secondary)]"
				onclick={() => systemOpen = !systemOpen}
			>
				<Settings class="h-4 w-4" />
				<span class="font-display text-xs tracking-wider">System</span>
				<ChevronDown class="h-3 w-3 transition-transform {systemOpen ? 'rotate-180' : ''}" />
			</button>

			{#if systemOpen}
				<div class="absolute right-0 top-full mt-2 w-56 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-1.5 shadow-xl">
					{#each systemItems as item}
						<button
							class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
							onclick={() => selectTool(item.id)}
						>
							<item.icon class="h-4 w-4 text-[var(--text-muted)]" />
							<span class="font-display text-xs tracking-wider">{item.label}</span>
						</button>
					{/each}
					<div class="my-1 border-t border-[var(--border-secondary)]"></div>
					<button
						class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
						onclick={openSettings}
					>
						<Settings class="h-4 w-4 text-[var(--text-muted)]" />
						<span class="font-display text-xs tracking-wider">Settings</span>
					</button>
				</div>
			{/if}
		</div>
	</header>

	<!-- Main content -->
	<main class="relative z-[1] flex-1 overflow-hidden">
		{#if activeTool === 'database'}
			<WorldExplorer />
		{:else if activeTool === 'canon'}
			<CanonRepairCockpit />
		{:else if activeTool === 'engine'}
			<EnginePanel />
		{:else if activeTool === 'terminal'}
			<TerminalPanel />
		{:else if activeMain === 'library'}
			<LibraryPanel />
		{:else if activeMain === 'chapters'}
			<StoryMemoryPanel />
		{/if}
	</main>

	<!-- Mobile bottom nav -->
	<nav class="relative z-10 flex items-center justify-around border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] pb-[env(safe-area-inset-bottom)] sm:hidden">
		{#each mainNavItems as item}
			{@const isActive = activeMain === item.id && !activeTool}
			<button
				class="relative flex flex-col items-center gap-1 px-3 py-3 transition-colors duration-200
					{isActive ? 'text-[var(--text-accent)]' : 'text-[var(--text-muted)]'}"
				onclick={() => selectMain(item.id)}
			>
				{#if isActive}
					<span class="absolute -top-[1px] left-1/2 h-[2px] w-6 -translate-x-1/2 rounded-b-full bg-[var(--text-accent)]" aria-hidden="true"></span>
				{/if}
				<item.icon class="h-5 w-5" />
				<span class="text-[10px] font-display tracking-wider">{item.label}</span>
			</button>
		{/each}
		<button
			class="relative flex flex-col items-center gap-1 px-3 py-3 text-[var(--text-muted)] transition-colors"
			onclick={() => { settingsOpen = true; }}
		>
			<Settings class="h-5 w-5" />
			<span class="text-[10px] font-display tracking-wider">System</span>
		</button>
	</nav>
</div>

<SettingsModal open={settingsOpen} onClose={() => settingsOpen = false} />

<style>
	.app-shell { padding-top: env(safe-area-inset-top, 0px); }
</style>
