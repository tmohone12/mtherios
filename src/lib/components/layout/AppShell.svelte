<script lang="ts">
	import { Library, Settings, Server, Cpu, ChevronRight, Plus, Compass, Ellipsis, Feather } from 'lucide-svelte';
	import { app } from '$lib/stores/app.svelte';
	import { onMount } from 'svelte';
	import SettingsModal from '$lib/components/settings/SettingsModal.svelte';
	import ContentWorkspace from '$lib/components/content/ContentWorkspace.svelte';
	import LibraryPanel from '$lib/components/library/LibraryPanel.svelte';
	import WorldExplorer from '$lib/components/database/WorldExplorer.svelte';
	import EnginePanel from '$lib/components/system/EnginePanel.svelte';
	import TerminalPanel from '$lib/components/system/TerminalPanel.svelte';

	type Panel = 'content' | 'library' | 'database' | 'engine' | 'terminal';
	let activePanel = $derived(app.workspacePanel);
	onMount(() => app.registerNavigationGuard(canLeaveLore));
	let libraryVisit = $state(0);
	let settingsOpen = $state(false);
	let mobileToolsOpen = $state(false);
	let loreDirty = $state(false);
	let navigationNotice = $state('');
	const workspaceItems = [
		{ id: 'library' as const, icon: Library, label: 'Stories & shelves', shortLabel: 'Library' },
		{ id: 'content' as const, icon: Feather, label: 'Lore studio', shortLabel: 'Lore studio' },
	];
	const systemItems = [
		{ id: 'database' as const, icon: Compass, label: 'World explorer' },
		{ id: 'engine' as const, icon: Server, label: 'Runtime status' },
		{ id: 'terminal' as const, icon: Cpu, label: 'Terminal sync' },
	];
	const activeLabel = $derived([...workspaceItems, ...systemItems].find(item => item.id === activePanel)?.label ?? 'Story library');
	function selectPanel(id: Panel) {
		if (id !== activePanel && !canLeaveLore()) return;
		const revisitLibrary = id === 'library' && activePanel === 'library';
		if (!app.selectWorkspace(id)) return;
		if (revisitLibrary) libraryVisit += 1;
		mobileToolsOpen = false;
	}
	function canLeaveLore() {
		if (!loreDirty) return true;
		navigationNotice = 'Save or discard your changes before leaving this workspace.';
		return false;
	}
	function startNewStory() {
		if (canLeaveLore()) app.startNewStory();
	}
	function updateLoreDirty(dirty: boolean) {
		loreDirty = dirty;
		if (!dirty) navigationNotice = '';
	}
</script>

<svelte:head><title>{activeLabel} · MythEngine</title></svelte:head>

<div class="app-shell workspace-shell">
	<a class="skip-link" href="#workspace-content">Skip to content</a>
	<aside class="workspace-sidebar" aria-label="Workspace sidebar">
		<button class="workspace-brand" onclick={() => selectPanel('library')} aria-label="MythEngine story library">
			<span class="brand-mark"><Feather size={23} strokeWidth={1.3} /></span>
			<span class="brand-wordmark">MythEngine<span>THE STORY WORKSPACE</span></span>
		</button>
		<button class="sidebar-create" onclick={startNewStory} title="New story"><Plus size={17} /><span>New story</span></button>
		<nav class="sidebar-navigation" aria-label="Workspace">
			<p class="nav-eyebrow">Your workspace</p>
			{#each workspaceItems as item}
				<button class="sidebar-link" class:active={activePanel === item.id} aria-current={activePanel === item.id ? 'page' : undefined} onclick={() => selectPanel(item.id)} title={item.label}>
					<item.icon size={18} strokeWidth={1.6} /><span>{item.label}</span>
					{#if activePanel === item.id}<span class="active-dot" aria-hidden="true"></span>{/if}
				</button>
			{/each}
			<p class="nav-eyebrow system-eyebrow">World & tools</p>
			{#each systemItems as item}
				<button class="sidebar-link" class:active={activePanel === item.id} aria-current={activePanel === item.id ? 'page' : undefined} onclick={() => selectPanel(item.id)} title={item.label}>
					<item.icon size={18} strokeWidth={1.6} /><span>{item.label}</span>
					{#if activePanel === item.id}<span class="active-dot" aria-hidden="true"></span>{/if}
				</button>
			{/each}
		</nav>
		<div class="sidebar-footer">
			<div class="sidebar-note"><Feather size={19} strokeWidth={1.2} /><p>Your next chapter<br /><span>starts here.</span></p></div>
			<button class="sidebar-link" onclick={() => settingsOpen = true} title="Settings"><Settings size={18} strokeWidth={1.6} /><span>Settings</span></button>
		</div>
	</aside>
	<div class="workspace-body">
		<header class="workspace-topbar">
			<div class="workspace-breadcrumb"><span class="desktop-crumb">Workspace</span><ChevronRight class="desktop-crumb" size={13} /><span class="mobile-wordmark">MythEngine<span>/</span></span><strong>{activeLabel}</strong></div>
			<div class="topbar-actions"><span class="workspace-edition">The story workspace</span><button class="topbar-settings" onclick={() => settingsOpen = true} aria-label="Open settings"><Settings size={18} strokeWidth={1.6} /></button></div>
		</header>
		{#if navigationNotice}<p class="navigation-notice" role="alert">{navigationNotice}</p>{/if}
		<main id="workspace-content" class="workspace-content" tabindex="-1">
			{#if activePanel === 'library'}{#key libraryVisit}<LibraryPanel />{/key}
			{:else if activePanel === 'content'}<ContentWorkspace onDirtyChange={updateLoreDirty} />
			{:else if activePanel === 'database'}<WorldExplorer title="World explorer" onDirtyChange={updateLoreDirty} />
			{:else if activePanel === 'engine'}<EnginePanel />
			{:else if activePanel === 'terminal'}<TerminalPanel />{/if}
		</main>
	</div>
	<nav class="workspace-mobile-nav" aria-label="Mobile workspace">
		{#each workspaceItems as item}
			<button class:active={activePanel === item.id} aria-current={activePanel === item.id ? 'page' : undefined} onclick={() => selectPanel(item.id)}><item.icon size={20} strokeWidth={1.6} /><span>{item.shortLabel}</span></button>
		{/each}
		<details class="mobile-tools" bind:open={mobileToolsOpen}>
			<summary class:active={systemItems.some(item => item.id === activePanel)}><Ellipsis size={21} /><span>More</span></summary>
			<div class="mobile-tools-menu">
				<button onclick={() => { mobileToolsOpen = false; startNewStory(); }}><Plus size={17} />New story</button>
				{#each systemItems as item}<button class:active={activePanel === item.id} onclick={() => selectPanel(item.id)}><item.icon size={17} />{item.label}</button>{/each}
				<button onclick={() => { mobileToolsOpen = false; settingsOpen = true; }}><Settings size={17} />Settings</button>
			</div>
		</details>
	</nav>
</div>
<SettingsModal open={settingsOpen} onClose={() => settingsOpen = false} />

<style>
	.navigation-notice { flex-shrink: 0; margin: 0; padding: 12px 20px; color: var(--text-accent); background: var(--bg-secondary); border-bottom: 1px solid var(--border-primary); font-size: 12px; }
	.workspace-shell { display: flex; width: 100%; overflow: hidden; background: var(--bg-primary); }
	.skip-link { position: fixed; left: 16px; top: -60px; z-index: 100; padding: 12px 20px; background: var(--primary); color: var(--primary-foreground); border-radius: 8px; }
	.skip-link:focus { top: 12px; }
	.workspace-sidebar { width: 248px; flex-shrink: 0; display: flex; flex-direction: column; padding: 32px 18px 20px; background: var(--bg-secondary); border-right: 1px solid var(--border-secondary); }
	.workspace-brand { display: flex; align-items: center; gap: 12px; padding: 0 10px; text-align: left; }
	.brand-mark { display: grid; place-items: center; width: 36px; height: 42px; color: var(--text-accent); border: 1px solid color-mix(in srgb, var(--primary) 32%, transparent); border-radius: 16px 16px 5px 5px; }
	.brand-wordmark { font-family: var(--font-display); font-size: 25px; line-height: 1; letter-spacing: -.035em; color: var(--text-primary); }
	.brand-wordmark > span { display: block; margin-top: 9px; font: 8px var(--font-ui); letter-spacing: .17em; color: var(--text-muted); }
	.sidebar-create { margin: 34px 0 29px; display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 42px; border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--primary) 9%, transparent); color: var(--text-accent); font-size: 13px; font-weight: 600; transition: background 150ms; }
	.sidebar-create:hover { background: color-mix(in srgb, var(--primary) 16%, transparent); }
	.sidebar-navigation { flex: 1; overflow-y: auto; }
	.nav-eyebrow { padding: 0 12px; margin-bottom: 12px; text-transform: uppercase; letter-spacing: .15em; font-size: 9px; font-weight: 600; color: var(--text-muted); }
	.system-eyebrow { margin-top: 35px; }
	.sidebar-link { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; margin: 5px 0; padding: 12px; border-radius: 8px; font-size: 13px; text-align: left; color: var(--text-secondary); transition: background 150ms, color 150ms; }
	.sidebar-link > :global(svg) { color: var(--text-muted); flex-shrink: 0; }
	.sidebar-link:hover { background: var(--bg-tertiary); color: var(--text-primary); }
	.sidebar-link.active { background: color-mix(in srgb, var(--primary) 10%, transparent); color: var(--text-accent); box-shadow: inset 2px 0 var(--text-accent); }
	.sidebar-link.active > :global(svg) { color: var(--text-accent); }
	.active-dot { margin-left: auto; width: 5px; height: 5px; border-radius: 50%; background: var(--primary); }
	.sidebar-footer { margin-top: 24px; border-top: 1px solid var(--border-secondary); padding-top: 14px; }
	.sidebar-note { display: flex; gap: 12px; align-items: flex-start; padding: 12px 12px 24px; color: var(--text-muted); }
	.sidebar-note p { font-family: var(--font-story); font-size: 12px; line-height: 1.6; }
	.sidebar-note p span { color: var(--text-secondary); }
	.workspace-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.workspace-topbar { min-height: 67px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 35px; border-bottom: 1px solid var(--border-secondary); }
	.workspace-breadcrumb { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text-muted); }
	.workspace-breadcrumb strong { font-weight: 500; color: var(--text-secondary); }
	.topbar-actions { display: flex; align-items: center; gap: 16px; }
	.workspace-edition { font-family: var(--font-story); font-size: 12px; font-style: italic; color: var(--text-muted); }
	.topbar-settings { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 8px; color: var(--text-secondary); }
	.topbar-settings:hover { background: var(--bg-tertiary); color: var(--text-accent); }
	.workspace-content { position: relative; min-height: 0; flex: 1; overflow: hidden; }
	.mobile-wordmark, .workspace-mobile-nav { display: none; }
	@media (min-width: 640px) and (max-width: 1023px) {
		.workspace-sidebar { width: 76px; padding: 24px 12px 12px; }
		.workspace-brand { padding: 0; justify-content: center; }
		.brand-wordmark, .sidebar-create span, .sidebar-link span, .nav-eyebrow, .sidebar-note { display: none; }
		.sidebar-link { justify-content: center; padding: 12px; }
		.sidebar-create { margin-top: 28px; }
		.sidebar-link:nth-of-type(4) { margin-top: 28px; }
		.workspace-topbar { padding-inline: 24px; }
	}
	@media (max-width: 639px) {
		.workspace-shell { flex-direction: column; }
		.workspace-sidebar, .desktop-crumb, .workspace-edition { display: none; }
		.workspace-breadcrumb > :global(svg) { display: none; }
		.workspace-body { min-height: 0; }
		.workspace-topbar { min-height: 56px; padding: 8px 16px; }
		.workspace-breadcrumb { gap: 9px; font-size: 10px; }
		.mobile-wordmark { display: inline-flex; gap: 12px; align-items: center; color: var(--text-primary); font-family: var(--font-display); font-size: 20px; }
		.mobile-wordmark span { font: 13px var(--font-ui); color: var(--border-primary); }
		.workspace-mobile-nav { position: relative; display: flex; justify-content: space-around; flex-shrink: 0; padding: 6px 8px max(6px, env(safe-area-inset-bottom)); border-top: 1px solid var(--border-primary); background: var(--bg-secondary); z-index: 10; }
		.workspace-mobile-nav > button, .mobile-tools > summary { display: flex; min-width: 64px; min-height: 50px; flex-direction: column; justify-content: center; align-items: center; gap: 5px; color: var(--text-muted); font-size: 10px; border-radius: 6px; cursor: pointer; }
		.workspace-mobile-nav .active { color: var(--text-accent); }
		.mobile-tools > summary { list-style: none; }
		.mobile-tools > summary::-webkit-details-marker { display: none; }
		.mobile-tools-menu { position: absolute; right: 12px; bottom: calc(100% + 8px); width: 215px; padding: 6px; border-radius: 10px; border: 1px solid var(--border-primary); background: var(--popover); box-shadow: var(--shadow-panel); }
		.mobile-tools-menu > button { display: flex; align-items: center; gap: 12px; width: 100%; padding: 13px 12px; text-align: left; font-size: 13px; border-radius: 5px; color: var(--text-secondary); }
		.mobile-tools-menu > button:hover { background: var(--bg-elevated); }
	}
</style>
