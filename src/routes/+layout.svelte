<script>
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import OnboardingWizard from '$lib/components/wizard/OnboardingWizard.svelte';
	import StoryView from '$lib/components/story/StoryView.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { story } from '$lib/stores/story.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { refreshTerminalLlmSettings } from '$lib/services/terminalSettings';
	import { onMount } from 'svelte';
	import PwaLifecycle from '$lib/components/pwa/PwaLifecycle.svelte';

	let { children } = $props();

	onMount(() => {
		const viewport = window.visualViewport;
		const syncViewport = () => {
			document.documentElement.style.setProperty('--visual-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
			document.documentElement.style.setProperty('--visual-viewport-offset-top', `${viewport?.offsetTop ?? 0}px`);
			document.body.classList.toggle('keyboard-open', Boolean(viewport && window.innerHeight - viewport.height > 140));
		};
		syncViewport();
		viewport?.addEventListener('resize', syncViewport);
		viewport?.addEventListener('scroll', syncViewport);
		window.addEventListener('resize', syncViewport);
		void (async () => {
			await settings.init();
			await refreshTerminalLlmSettings().catch(error => console.warn('[Settings] Terminal settings unavailable:', error));
			await app.init();
		})();
		return () => {
			app.disposeNavigation();
			viewport?.removeEventListener('resize', syncViewport);
			viewport?.removeEventListener('scroll', syncViewport);
			window.removeEventListener('resize', syncViewport);
		};
	});

	// Load story when currentStoryId changes
	$effect(() => {
		const id = app.currentStoryId;
		if (!id && (story.currentStory || story.loading)) { story.clear(); return; }
		if (id && (!story.currentStory || story.currentStory.id !== id)) {
			story.loadStory(id).catch(() => {
				// Story doesn't exist (deleted or DB cleared) — clear stale reference
				if (app.currentStoryId === id) app.closeStory({ replace: true });
			});
		}
	});
</script>

<svelte:head><link rel="icon" type="image/svg+xml" href={favicon} /></svelte:head>

<PwaLifecycle />

{#if app.loading}
	<!-- Loading splash -->
	<div class="app-shell flex flex-col items-center justify-center gap-5 bg-[var(--bg-primary)]" role="status" aria-live="polite">
		<svg viewBox="0 0 48 48" fill="none" class="h-12 w-12 animate-pulse text-[var(--text-accent)]">
			<path d="M24 4L6 14v20l18 10 18-10V14L24 4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
			<circle cx="24" cy="24" r="5" fill="currentColor" opacity="0.6"/>
		</svg>
		<p class="font-display text-2xl text-[var(--text-primary)]">Opening your workspace</p>
		<p class="text-sm text-[var(--text-muted)]">Gathering your stories and saved settings…</p>
	</div>
{:else if app.showWizard}
	<OnboardingWizard
		shelfId={app.activeShelfId}
		onComplete={(storyId) => app.completeOnboarding(storyId)}
		onSkip={async () => {
			const { setSetting } = await import('$lib/services/database');
			await setSetting('onboardingComplete', 'true');
			app.showWizard = false;
			app.onboardingComplete = true;
		}}
	/>
{:else if app.currentStoryId && story.currentStory?.id === app.currentStoryId}
	{#key app.currentStoryId}<StoryView />{/key}
{:else if app.currentStoryId}
	<!-- Story is loading from DB — show loading state instead of flashing AppShell -->
	<div class="app-shell flex flex-col items-center justify-center gap-5 bg-[var(--bg-primary)]" role="status" aria-live="polite">
		<svg viewBox="0 0 48 48" fill="none" class="h-12 w-12 animate-pulse text-[var(--text-accent)]">
			<path d="M24 4L6 14v20l18 10 18-10V14L24 4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
			<circle cx="24" cy="24" r="5" fill="currentColor" opacity="0.6"/>
		</svg>
		<p class="font-display text-2xl text-[var(--text-primary)]">Returning to your story</p>
		<p class="text-sm text-[var(--text-muted)]">Loading the latest saved chapter…</p>
	</div>
{:else}
	{@render children()}
{/if}
