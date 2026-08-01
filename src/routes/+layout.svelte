<script>
	import '../app.css';
	import OnboardingWizard from '$lib/components/wizard/OnboardingWizard.svelte';
	import StoryView from '$lib/components/story/StoryView.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { story } from '$lib/stores/story.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { onMount } from 'svelte';

	let { children } = $props();

	onMount(async () => {
		await settings.init();
		await app.init();
	});

	// Load story when currentStoryId changes
	$effect(() => {
		const id = app.currentStoryId;
		if (id && (!story.currentStory || story.currentStory.id !== id)) {
			story.loadStory(id).catch(() => {
				// Story doesn't exist (deleted or DB cleared) — clear stale reference
				app.closeStory();
			});
		}
	});
</script>

<svelte:head>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;800&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
	<meta name="theme-color" content="#08090c" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
</svelte:head>

{#if app.loading}
	<!-- Loading splash -->
	<div class="flex h-[100dvh] items-center justify-center bg-[#08090c]">
		<svg viewBox="0 0 48 48" fill="none" class="h-12 w-12 animate-pulse text-[#d4a853]">
			<path d="M24 4L6 14v20l18 10 18-10V14L24 4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
			<circle cx="24" cy="24" r="5" fill="currentColor" opacity="0.6"/>
		</svg>
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
{:else if app.currentStoryId && story.currentStory}
	<StoryView />
{:else if app.currentStoryId && story.loading}
	<!-- Story is loading from DB — show loading state instead of flashing AppShell -->
	<div class="flex h-[100dvh] items-center justify-center bg-[#08090c]">
		<svg viewBox="0 0 48 48" fill="none" class="h-12 w-12 animate-pulse text-[#d4a853]">
			<path d="M24 4L6 14v20l18 10 18-10V14L24 4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
			<circle cx="24" cy="24" r="5" fill="currentColor" opacity="0.6"/>
		</svg>
	</div>
{:else}
	{@render children()}
{/if}
