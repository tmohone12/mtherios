<script lang="ts">
	import { Handshake, Flame, Users, AlertTriangle, MessageCircle } from 'lucide-svelte';
	import { story } from '$lib/stores/story.svelte';
	import type { Entry, CharacterEntryState, FactionEntryState, Meter, Agreement, WorldEvent, RumorRecord, FactionActionRecord } from '$lib/types';

	interface Props {
		entry: Entry;
	}

	let { entry }: Props = $props();

	// ── Your standing (from entry.state for character/faction) ──
	const standing = $derived.by((): { label: string; value: number } | null => {
		if (!entry?.state) return null;
		if (entry.type === 'character') {
			const s = entry.state as CharacterEntryState;
			const level = s?.relationship?.level;
			if (typeof level === 'number') return { label: 'Your standing', value: level };
		}
		if (entry.type === 'faction') {
			const s = entry.state as FactionEntryState;
			if (typeof s?.playerStanding === 'number') return { label: 'Player standing', value: s.playerStanding };
		}
		return null;
	});

	// ── Meters relevant to this entity ──
	// Match by substring (case-insensitive) against meter name: e.g. a faction
	// named "Lannisters" picks up a meter "reputation:Lannisters".
	const relevantMeters = $derived.by((): Meter[] => {
		const meters = story.currentStory?.meters ?? [];
		if (meters.length === 0) return [];
		const aliases = [entry.name, ...(entry.aliases ?? [])].filter(Boolean).map((s) => s.toLowerCase());
		return meters.filter((m) =>
			aliases.some((a) => m.name.toLowerCase().includes(a)),
		);
	});

	// ── Active agreements this entity is party to ──
	const activeAgreements = $derived.by((): Agreement[] => {
		const name = entry.name?.toLowerCase() ?? '';
		const aliases = (entry.aliases ?? []).map((a) => a.toLowerCase());
		const match = (p: string) => {
			const pl = p.toLowerCase();
			return pl === name || aliases.includes(pl) || pl.includes(name);
		};
		return story.agreements
			.filter((a) => a.status === 'active' && a.parties.some(match))
			.slice(0, 20);
	});

	// ── Recent world events involving this entity (last 5) ──
	const recentEvents = $derived.by((): WorldEvent[] => {
		const name = entry.name?.toLowerCase() ?? '';
		const aliases = (entry.aliases ?? []).map((a) => a.toLowerCase());
		const mentions = (t: string) => {
			const tl = t.toLowerCase();
			return tl.includes(name) || aliases.some((a) => tl.includes(a));
		};
		return story.worldEvents
			.filter(
				(e) =>
					e.sourceEntityId === entry.id ||
					mentions(e.name) ||
					mentions(e.description),
			)
			.sort((a, b) => (b.appliedAt ?? b.createdAt) - (a.appliedAt ?? a.createdAt))
			.slice(0, 5);
	});

	// ── Rumors mentioning or related to this entity ──
	const relatedRumors = $derived.by((): RumorRecord[] => {
		const name = entry.name?.toLowerCase() ?? '';
		const aliases = (entry.aliases ?? []).map((a) => a.toLowerCase());
		return story.rumors
			.filter((r) => {
				if (r.status === 'stale' || r.status === 'debunked') return false;
				if (r.relatedFaction && r.relatedFaction.toLowerCase() === name) return true;
				const content = r.content.toLowerCase();
				return content.includes(name) || aliases.some((a) => content.includes(a));
			})
			.slice(0, 5);
	});

	// ── Faction-only: recent actions ──
	const recentFactionActions = $derived.by((): FactionActionRecord[] => {
		if (entry.type !== 'faction') return [];
		const name = entry.name?.toLowerCase() ?? '';
		return story.factionActions
			.filter((a) => a.factionName.toLowerCase() === name)
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, 5);
	});

	const hasAnything = $derived(
		!!standing ||
			relevantMeters.length > 0 ||
			activeAgreements.length > 0 ||
			recentEvents.length > 0 ||
			relatedRumors.length > 0 ||
			recentFactionActions.length > 0,
	);

	function standingColor(v: number): string {
		if (v >= 50) return 'bg-emerald-500';
		if (v >= 0) return 'bg-amber-500';
		if (v >= -50) return 'bg-orange-500';
		return 'bg-rose-500';
	}

	function truthLabel(t: number): string {
		if (t >= 0.7) return 'reliable';
		if (t >= 0.4) return 'uncertain';
		return 'dubious';
	}
</script>

{#if hasAnything}
	<div class="border-t border-[var(--border-primary)] pt-3 space-y-3">
		<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Reputation</div>

		{#if standing}
			{@const pct = (standing.value + 100) / 2}
			<div class="space-y-1">
				<div class="flex items-center justify-between text-xs">
					<span class="text-[var(--text-muted)]">{standing.label}</span>
					<span class="tabular-nums text-[var(--text-primary)]">{standing.value}</span>
				</div>
				<div class="relative h-1.5 overflow-hidden rounded-full bg-[var(--border-primary)]">
					<div class="absolute top-0 bottom-0 left-1/2 w-px bg-[var(--bg-primary)]"></div>
					<div
						class="h-full transition-all {standingColor(standing.value)}"
						style="width: {pct}%"
					></div>
				</div>
			</div>
		{/if}

		{#if relevantMeters.length > 0}
			<div>
				<div class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
					<Flame class="h-3 w-3" /> Related meters
				</div>
				<div class="space-y-1">
					{#each relevantMeters as m}
						{@const p = m.max > 0 ? Math.round((m.value / m.max) * 100) : 0}
						<div class="flex items-center gap-2 text-xs">
							<span class="w-32 truncate text-[var(--text-muted)]">{m.name}</span>
							<div class="h-1 flex-1 overflow-hidden rounded-full bg-[var(--border-primary)]">
								<div class="h-full bg-[var(--color-gold-400)] transition-all" style="width: {p}%"></div>
							</div>
							<span class="tabular-nums text-[var(--text-primary)]">{m.value}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		{#if activeAgreements.length > 0}
			<div>
				<div class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
					<Handshake class="h-3 w-3" /> Active agreements ({activeAgreements.length})
				</div>
				<ul class="space-y-1">
					{#each activeAgreements as a}
						<li class="rounded-md bg-[var(--bg-primary)] px-2 py-1.5 text-xs">
							<div class="flex items-baseline gap-1.5">
								<span class="text-[10px] uppercase tracking-wider text-[var(--text-accent)]">{a.category}</span>
								{#if a.secrecy !== 'public'}
									<span class="rounded bg-[var(--bg-tertiary)] px-1 text-[9px] text-[var(--text-muted)]">{a.secrecy}</span>
								{/if}
							</div>
							<div class="mt-0.5 text-[var(--text-primary)]">{a.parties.join(' ↔ ')}</div>
							<div class="mt-0.5 line-clamp-2 text-[var(--text-muted)] text-[11px]">{a.terms}</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if recentEvents.length > 0}
			<div>
				<div class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
					<AlertTriangle class="h-3 w-3" /> Recent events
				</div>
				<ul class="space-y-1">
					{#each recentEvents as ev}
						<li class="rounded-md bg-[var(--bg-primary)] px-2 py-1.5 text-xs">
							<div class="flex items-baseline gap-1.5">
								<span class="font-semibold text-[var(--text-primary)]">{ev.name}</span>
								<span class="rounded bg-[var(--bg-tertiary)] px-1 text-[9px] uppercase text-[var(--text-muted)]">{ev.severity}</span>
							</div>
							<div class="mt-0.5 line-clamp-2 text-[var(--text-muted)] text-[11px]">{ev.description}</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if relatedRumors.length > 0}
			<div>
				<div class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
					<MessageCircle class="h-3 w-3" /> Rumors
				</div>
				<ul class="space-y-1">
					{#each relatedRumors as r}
						<li class="rounded-md bg-[var(--bg-primary)] px-2 py-1.5 text-xs">
							<div class="flex items-baseline gap-1.5">
								<span class="text-[10px] uppercase tracking-wider text-[var(--text-accent)]">{truthLabel(r.truthfulness)}</span>
								<span class="text-[9px] text-[var(--text-muted)]">· {r.spreadRadius}</span>
							</div>
							<div class="mt-0.5 text-[var(--text-primary)] text-[11px]">{r.content}</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if recentFactionActions.length > 0}
			<div>
				<div class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
					<Users class="h-3 w-3" /> Recent faction moves
				</div>
				<ul class="space-y-1">
					{#each recentFactionActions as fa}
						<li class="rounded-md bg-[var(--bg-primary)] px-2 py-1.5 text-xs">
							<div class="flex items-baseline gap-1.5">
								<span class="text-[10px] uppercase tracking-wider text-[var(--text-accent)]">{fa.actionType}</span>
								<span class="text-[9px] text-[var(--text-muted)]">· urgency {fa.urgency}</span>
							</div>
							<div class="mt-0.5 text-[var(--text-primary)] text-[11px]">{fa.action}</div>
							{#if fa.motivation}
								<div class="mt-0.5 text-[10px] italic text-[var(--text-muted)]">motive: {fa.motivation}</div>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>
{/if}
