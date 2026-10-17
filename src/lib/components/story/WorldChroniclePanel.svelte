<script lang="ts">
	import { untrack } from 'svelte';
	import { Hourglass, ChevronDown, ChevronRight, Loader2, Check, Pencil, X, Eye, EyeOff } from 'lucide-svelte';
	import { story } from '$lib/stores/story.svelte';
	import { listBackendWorldChronicle, reviewBackendWorldChronicle, runBackendWorldChronicle } from '$lib/services/backendMemory';
	import type { WorldChronicleCreativity, WorldChronicleEvent, WorldChronicleEventfulness, WorldChronicleReviewAction, WorldChronicleSpan } from '$lib/contracts/worldChronicle';
	import { describeChronicleOutcome, dismissedChronicleCount, groupChronicleEvents } from './worldChronicleView';

	interface Props {
		open: boolean;
	}

	let { open }: Props = $props();

	const serverStoryId = $derived(story.currentStory?.serverStoryId?.trim() || null);
	let collapsed = $state(false);
	let span = $state<WorldChronicleSpan>('week');
	let eventfulness = $state<WorldChronicleEventfulness>('normal');
	let creativity = $state<WorldChronicleCreativity>('balanced');
	let settingsFor = $state<string | null>(null);
	let loadedFor = $state<string | null>(null);
	let events = $state<WorldChronicleEvent[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let advancing = $state(false);
	let notice = $state<{ tone: 'info' | 'error'; text: string } | null>(null);
	let showDismissed = $state(false);
	let editing = $state<{ id: string; title: string; body: string } | null>(null);
	let reviewing = $state<string | null>(null);
	let reviewError = $state<string | null>(null);

	const groups = $derived(groupChronicleEvents(events, showDismissed));
	const dismissedCount = $derived(dismissedChronicleCount(events));
	const pendingCount = $derived(events.filter(event => event.status === 'proposed').length);

	function message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	async function load(storyId: string) {
		loading = true;
		loadError = null;
		try {
			const result = await listBackendWorldChronicle(storyId);
			if (serverStoryId !== storyId) return;
			events = result.events;
			loadedFor = storyId;
			// The drawer starts from the dials the story last used.
			if (settingsFor !== storyId) {
				eventfulness = result.settings.eventfulness;
				creativity = result.settings.creativity;
				settingsFor = storyId;
			}
		} catch (error) {
			if (serverStoryId === storyId) loadError = message(error);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		const storyId = serverStoryId;
		if (!open || !storyId) return;
		untrack(() => {
			if (loadedFor !== storyId) { events = []; editing = null; notice = null; }
			void load(storyId);
		});
	});

	async function advance() {
		const storyId = serverStoryId;
		if (!storyId || advancing) return;
		advancing = true;
		notice = null;
		try {
			const outcome = await runBackendWorldChronicle(storyId, { span, eventfulness, creativity });
			if (serverStoryId !== storyId) return;
			notice = describeChronicleOutcome(outcome);
			await story.refreshCampaignProjection();
			await load(storyId);
		} catch (error) {
			if (serverStoryId === storyId) notice = { tone: 'error', text: message(error) };
		} finally {
			advancing = false;
		}
	}

	async function review(event: WorldChronicleEvent, action: WorldChronicleReviewAction, edits?: { title: string; body: string }) {
		const storyId = serverStoryId;
		if (!storyId || reviewing) return;
		reviewing = event.id;
		reviewError = null;
		try {
			await reviewBackendWorldChronicle(storyId, { eventId: event.id, action, ...(edits ? { title: edits.title.trim(), body: edits.body.trim() } : {}) });
			if (editing?.id === event.id) editing = null;
			await story.refreshCampaignProjection();
			await load(storyId);
		} catch (error) {
			reviewError = message(error);
		} finally {
			reviewing = null;
		}
	}

	function stakesClass(stakes: string | null): string {
		return stakes === 'high' ? 'bg-rose-500/15 text-rose-300' : stakes === 'medium' ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/10 text-emerald-300';
	}

	const selectClass = 'rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs text-[var(--text-primary)] focus:border-sky-400 focus:outline-none disabled:opacity-40';
</script>

<section aria-label="World Chronicle">
	<button class="mb-2 flex w-full items-center justify-between gap-2" onclick={() => collapsed = !collapsed} aria-expanded={!collapsed}>
		<div class="flex items-center gap-2">
			<Hourglass class="h-4 w-4 text-sky-400" />
			<span class="world-section-title font-display text-xs tracking-wider uppercase text-sky-400">World Chronicle</span>
			{#if pendingCount > 0}
				<span class="text-[10px] text-amber-300">{pendingCount} to review</span>
			{/if}
		</div>
		{#if collapsed}<ChevronRight class="h-3.5 w-3.5 text-[var(--text-muted)]" />
		{:else}<ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
	</button>

	{#if !collapsed}
		<p class="mb-2 text-[10px] leading-relaxed text-[var(--text-muted)]">
			Let time pass off-screen. Happenings that matter wait here for your review; low-stakes ones are accepted automatically. Accepted happenings reach the GM as recent world events.
		</p>
		{#if !serverStoryId}
			<p class="mb-2 text-[10px] text-[var(--text-muted)]">Available for stories saved on the server.</p>
		{/if}
		<div class="mb-2 grid grid-cols-3 gap-2">
			<select aria-label="Time to pass" bind:value={span} disabled={!serverStoryId || advancing} class={selectClass}>
				<option value="day">Day</option>
				<option value="week">Week</option>
				<option value="season">Season</option>
			</select>
			<select aria-label="Eventfulness" bind:value={eventfulness} disabled={!serverStoryId || advancing} class={selectClass}>
				<option value="quiet">Quiet</option>
				<option value="normal">Normal</option>
				<option value="turbulent">Turbulent</option>
			</select>
			<select aria-label="Creativity" bind:value={creativity} disabled={!serverStoryId || advancing} class={selectClass}>
				<option value="grounded">Grounded</option>
				<option value="balanced">Balanced</option>
				<option value="wild">Wild</option>
			</select>
		</div>
		<button
			onclick={advance}
			disabled={!serverStoryId || advancing}
			class="mb-2 flex w-full items-center justify-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-300 transition-colors hover:bg-sky-500/10 disabled:opacity-40"
		>
			{#if advancing}
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
				<span>The world moves on…</span>
			{:else}
				<Hourglass class="h-3.5 w-3.5" />
				<span>Advance the world</span>
			{/if}
		</button>
		{#if notice}
			<p class="mb-2 text-[11px] leading-relaxed {notice.tone === 'error' ? 'text-rose-400' : 'text-[var(--text-secondary)]'}" role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>
		{/if}
		{#if loadError}
			<p class="mb-2 text-[11px] text-rose-400" role="alert">Could not load the chronicle: {loadError}</p>
		{/if}
		{#if reviewError}
			<p class="mb-2 text-[11px] text-rose-400" role="alert">{reviewError}</p>
		{/if}

		{#if loading && events.length === 0}
			<p class="text-[10px] text-[var(--text-muted)]">Loading the chronicle…</p>
		{:else if serverStoryId && groups.length === 0}
			<p class="text-[10px] text-[var(--text-muted)]">No happenings yet. Choose a span and advance the world.</p>
		{/if}

		<div class="space-y-3">
			{#each groups as group (group.key)}
				<div>
					<div class="mb-1 text-[9px] tracking-wider uppercase text-sky-400/80">{group.label}</div>
					<div class="space-y-1">
						{#each group.entries as entry (entry.event.id)}
							{@const event = entry.event}
							<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-1.5 {event.status === 'cancelled' ? 'opacity-60' : ''}">
								<div class="flex flex-wrap items-baseline gap-1.5 text-[10px]">
									{#if entry.stakes}
										<span class="rounded px-1 uppercase tracking-wider {stakesClass(entry.stakes)}" title={entry.stakesRaised ? 'Raised for review: it involves a death or a war.' : undefined}>{entry.stakes}</span>
									{/if}
									{#if entry.kind}<span class="rounded bg-[var(--bg-primary)] px-1 italic text-[var(--text-muted)]">{entry.kind}</span>{/if}
									<span class="ml-auto text-[var(--text-muted)]">{entry.visibility}</span>
								</div>
								{#if editing?.id === event.id}
									<input
										aria-label="Happening title"
										bind:value={editing.title}
										class="mt-1 w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none focus:border-sky-400"
									/>
									<textarea
										aria-label="Happening account"
										bind:value={editing.body}
										class="mt-1 min-h-20 w-full resize-y rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs leading-relaxed text-[var(--text-primary)] outline-none focus:border-sky-400"
									></textarea>
								{:else}
									<p class="mt-0.5 text-xs text-[var(--text-primary)]">{event.title}</p>
									<p class="mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)]">{event.body}</p>
								{/if}
								{#if entry.where || entry.factions.length}
									<p class="mt-1 text-[9px] text-[var(--text-muted)]">
										{#if entry.where}<span>{entry.where}</span>{/if}{#if entry.where && entry.factions.length}<span> · </span>{/if}{#if entry.factions.length}<span>{entry.factions.join(', ')}</span>{/if}
									</p>
								{/if}
								{#if entry.reach}<p class="mt-0.5 text-[9px] italic text-[var(--text-muted)]">How word travels: {entry.reach}</p>{/if}
								{#if entry.seed}<p class="mt-0.5 text-[9px] text-[var(--text-muted)]/80">Grew from {entry.seed}</p>{/if}

								<div class="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
									{#if event.status === 'proposed'}
										{#if editing?.id === event.id}
											<button type="button" class="flex items-center gap-1 text-sky-300 hover:underline disabled:opacity-40"
												disabled={reviewing !== null || !editing.title.trim() || !editing.body.trim()}
												onclick={() => editing && review(event, 'edit', { title: editing.title, body: editing.body })}>
												<Check class="h-3 w-3" />Save
											</button>
											<button type="button" class="flex items-center gap-1 text-[var(--text-muted)] hover:underline" onclick={() => editing = null}>
												<X class="h-3 w-3" />Cancel
											</button>
										{:else}
											<button type="button" class="flex items-center gap-1 text-emerald-300 hover:underline disabled:opacity-40" disabled={reviewing !== null} onclick={() => review(event, 'accept')}>
												{#if reviewing === event.id}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Check class="h-3 w-3" />{/if}Accept
											</button>
											<button type="button" class="flex items-center gap-1 text-sky-300 hover:underline disabled:opacity-40" disabled={reviewing !== null}
												onclick={() => editing = { id: event.id, title: event.title, body: event.body }}>
												<Pencil class="h-3 w-3" />Edit
											</button>
											<button type="button" class="flex items-center gap-1 text-rose-300 hover:underline disabled:opacity-40" disabled={reviewing !== null} onclick={() => review(event, 'dismiss')}>
												<X class="h-3 w-3" />Dismiss
											</button>
										{/if}
									{:else if event.status === 'committed'}
										<span class="text-emerald-300/80">In play{event.metadata.autoAccepted === true ? ' · auto-accepted' : ''}</span>
									{:else if event.status === 'cancelled'}
										<span class="text-[var(--text-muted)]">Dismissed</span>
									{:else}
										<span class="text-[var(--text-muted)]">{event.status}</span>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>

		{#if dismissedCount > 0}
			<button type="button" class="mt-2 flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:underline" onclick={() => showDismissed = !showDismissed}>
				{#if showDismissed}<EyeOff class="h-3 w-3" />Hide dismissed{:else}<Eye class="h-3 w-3" />Show dismissed ({dismissedCount}){/if}
			</button>
		{/if}
	{/if}
</section>
