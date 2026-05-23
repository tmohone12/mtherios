<script lang="ts">
	import { X, Users, MapPin, Swords, ScrollText, BookOpen, ChevronDown, ChevronRight, Gauge, Loader2, Layers, Download, FileArchive, Clock, Activity, Scale, Megaphone, Flag, Zap, Handshake, Play, Search } from 'lucide-svelte';
	import { WORLD_SIM_DAY_INTERVAL, normalizeRelation } from '$lib/services/ai/tools/helpers';
	import { maybeRunWorldSim } from '$lib/services/ai/tools/executor';
	import { settings } from '$lib/stores/settings.svelte';
	import { story } from '$lib/stores/story.svelte';
	import { getChapters, getArcs, createArc } from '$lib/services/database';
	import { ai } from '$lib/services/ai';
	import { uuid } from '$lib/utils/uuid';
	import { downloadStoryAsWiki } from '$lib/services/wikiExport';
	import type { Arc, Entry, FactionActionRecord, FactionEntryState } from '$lib/types';
	import { fly } from 'svelte/transition';
	import type { Chapter } from '$lib/types';

	// ── Compact context estimate ──
	const estimateTokens = (text: string) => Math.ceil(text.length / 4);
	const contextTotal = $derived.by(() => {
		if (!story.currentStory) return 0;
		let total = 250; // base overhead
		for (const c of story.characters.filter(c => c.status === 'active')) {
			total += estimateTokens(`${c.name}: ${c.description ?? ''}\n`);
		}
		for (const l of story.locations.filter(l => l.name)) {
			total += estimateTokens(`${l.name}: ${l.description ?? ''}\n`);
		}
		const recentText = story.entries.slice(-5).map(en => en.content).join(' ').toLowerCase();
		let loreCount = 0;
		for (const e of story.lorebookEntries) {
			if (e.injection.mode === 'never') continue;
			if (e.injection.mode === 'always' || e.injection.keywords.some(kw => recentText.includes(kw.toLowerCase()))) {
				total += estimateTokens(`${e.name}\n${e.description.slice(0, 400)}\n`);
				loreCount++;
				if (loreCount >= 30) break;
			}
		}
		// Context assembly budget (~7K) estimated
		total += 7000;
		for (const entry of story.entries.slice(-10)) {
			total += estimateTokens(entry.content);
		}
		return total;
	});
	const contextBudget = 200000;
	const contextPercent = $derived(Math.min((contextTotal / contextBudget) * 100, 100));
	function formatTokens(val: number): string {
		if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
		return String(val);
	}
	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	const activeChars = $derived(story.characters.filter(c => c.status === 'active'));
	const protagonist = $derived(story.protagonist);

	type FactionStatusFilter = 'all' | FactionEntryState['status'];
	type FactionSortMode = 'relevance' | 'standing' | 'resources' | 'name';
	const FACTION_PAGE_SIZE = 12;

	let factionSearch = $state('');
	let factionStatusFilter = $state<FactionStatusFilter>('all');
	let factionSortMode = $state<FactionSortMode>('relevance');
	let factionDisplayLimit = $state(FACTION_PAGE_SIZE);

	function factionState(entry: Entry): FactionEntryState {
		return entry.state as FactionEntryState;
	}

	function factionResourceAverage(state: FactionEntryState): number {
		const r = state.resources;
		if (!r) return 0;
		return Math.round((r.military + r.wealth + r.influence + r.information + r.morale) / 5);
	}

	function factionTopGoalScore(state: FactionEntryState): number {
		const activeGoals = (state.goals ?? []).filter(goal => (goal.progress ?? 0) < 100);
		if (activeGoals.length === 0) return 0;
		return Math.max(...activeGoals.map(goal => (goal.priority ?? 0) * 10 + Math.max(0, 100 - (goal.progress ?? 0)) / 5));
	}

	function latestFactionAction(name: string): FactionActionRecord | null {
		const lower = name.toLowerCase();
		return [...story.factionActions]
			.filter(action => action.factionName.toLowerCase() === lower)
			.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
	}

	function factionRelevance(entry: Entry): number {
		const state = factionState(entry);
		const lowerName = entry.name.toLowerCase();
		let score = Math.abs(state.playerStanding ?? 0);
		if (state.status === 'hostile' || state.status === 'allied') score += 30;
		if (state.disposition === 'aggressive' || state.disposition === 'desperate') score += 25;
		else if (state.disposition === 'scheming') score += 20;
		score += factionTopGoalScore(state);
		score += factionResourceAverage(state) / 4;
		if (latestFactionAction(entry.name)) score += 40;
		if (story.schemes.some(s => s.ownerType === 'faction' && s.ownerName.toLowerCase() === lowerName && !['resolved', 'foiled', 'abandoned'].includes(s.status))) score += 35;
		if ((state.territory ?? []).length > 0) score += 5;
		return score;
	}

	function factionSearchText(entry: Entry): string {
		const state = factionState(entry);
		const memberNames = (state.knownMembers ?? [])
			.map(id => story.lorebookEntries.find(e => e.id === id)?.name ?? id);
		return [
			entry.name,
			entry.description,
			entry.aliases?.join(' '),
			state.status,
			state.disposition,
			state.territory?.join(' '),
			memberNames.join(' '),
			state.goals?.map(goal => `${goal.type} ${goal.description} ${goal.deadline ?? ''}`).join(' '),
		].filter(Boolean).join(' ').toLowerCase();
	}

	function compareFactions(a: Entry, b: Entry): number {
		const aState = factionState(a);
		const bState = factionState(b);
		if (factionSortMode === 'name') return a.name.localeCompare(b.name);
		if (factionSortMode === 'standing') {
			return Math.abs(bState.playerStanding ?? 0) - Math.abs(aState.playerStanding ?? 0)
				|| a.name.localeCompare(b.name);
		}
		if (factionSortMode === 'resources') {
			return factionResourceAverage(bState) - factionResourceAverage(aState)
				|| a.name.localeCompare(b.name);
		}
		return factionRelevance(b) - factionRelevance(a)
			|| a.name.localeCompare(b.name);
	}

	function resetFactionRosterLimit() {
		factionDisplayLimit = FACTION_PAGE_SIZE;
	}

	function setFactionSearch(value: string) {
		factionSearch = value;
		resetFactionRosterLimit();
	}

	function setFactionStatus(value: FactionStatusFilter) {
		factionStatusFilter = value;
		resetFactionRosterLimit();
	}

	function setFactionSort(value: FactionSortMode) {
		factionSortMode = value;
		resetFactionRosterLimit();
	}

	// Chapters / Memory
	let chapters = $state<Chapter[]>([]);
	let expandedChapter = $state<string | null>(null);

	// Arcs
	let arcs = $state<Arc[]>([]);
	let generatingArc = $state(false);
	let expandedArc = $state<string | null>(null);

	$effect(() => {
		if (open && story.currentStory) {
			getChapters(story.currentStory.id).then(ch => {
				chapters = ch.sort((a, b) => a.number - b.number);
			});
			getArcs(story.currentStory.id).then(a => {
				arcs = a;
			});
		}
	});

	function toggleArc(id: string) {
		expandedArc = expandedArc === id ? null : id;
	}

	// Chapters not yet condensed into an arc
	const uncoveredChapters = $derived.by(() => {
		const coveredChapterIds = new Set(arcs.flatMap(a => a.chapterIds));
		return chapters.filter(c => !coveredChapterIds.has(c.id));
	});

	// Need at least 3 uncovered chapters to condense into an arc
	const condensableChapters = $derived(uncoveredChapters.length >= 3 ? uncoveredChapters : []);

	async function generateArc() {
		if (!story.currentStory || condensableChapters.length === 0) return;
		generatingArc = true;
		try {
			const chaptersToCondense = condensableChapters;
			const arcNumber = arcs.length + 1;
			const result = await ai.arcCondensation.condense(
				chaptersToCondense,
				arcNumber,
				story.storyMode,
				story.pov,
				story.tense,
				arcs,
			);

			const firstCh = chaptersToCondense[0];
			const lastCh = chaptersToCondense[chaptersToCondense.length - 1];
			const arc: Arc = {
				id: uuid(),
				storyId: story.currentStory!.id,
				arcNumber,
				title: result.title,
				summary: result.summary,
				keyPlotPoints: result.keyPlotPoints,
				characterArcs: result.characterArcs,
				unresolvedThreads: result.unresolvedThreads,
				threadIds: [],
				resolvedThreadIds: [],
				emotionalProgression: result.emotionalProgression,
				chapterIds: chaptersToCondense.map(c => c.id),
				chapterRange: `${firstCh.number}-${lastCh.number}`,
				branchId: story.currentStory!.currentBranchId ?? null,
				createdAt: Date.now(),
			};

			await createArc(arc);
			arcs = [...arcs, arc];
			console.log(`Arc ${arcNumber} created: "${arc.title}" (chapters ${arc.chapterRange})`);
		} catch (e) {
			console.error('Arc generation failed:', e);
		}
		generatingArc = false;
	}

	function exportArcsAsJson() {
		if (arcs.length === 0) return;
		const data = {
			storyTitle: story.currentStory?.title ?? 'Untitled',
			exportedAt: new Date().toISOString(),
			arcs: arcs.map(a => ({
				arcNumber: a.arcNumber,
				title: a.title,
				chapterRange: a.chapterRange,
				summary: a.summary,
				keyPlotPoints: a.keyPlotPoints,
				characterArcs: a.characterArcs,
				unresolvedThreads: a.unresolvedThreads,
				emotionalProgression: a.emotionalProgression,
			})),
			chapters: chapters.map(c => ({
				number: c.number,
				title: c.title,
				summary: c.summary,
				characters: c.characters,
				locations: c.locations,
				emotionalTone: c.emotionalTone,
				keywords: c.keywords,
				entryCount: c.entryCount,
			})),
		};
		const json = JSON.stringify(data, null, 2);
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const slug = (story.currentStory?.title ?? 'story').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${slug}-arcs.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	function toggleChapter(id: string) {
		expandedChapter = expandedChapter === id ? null : id;
	}

	// Derive presence map: location name → character names at that location
	const presenceMap = $derived.by(() => {
		const map = new Map<string, string[]>();
		for (const char of activeChars) {
			const loc = char.metadata?.lastSeenLocation as string | undefined;
			if (loc) {
				if (!map.has(loc)) map.set(loc, []);
				map.get(loc)!.push(char.name);
			}
		}
		return map;
	});

	const currentLocation = $derived(story.locations.find(l => l.current) ?? null);

	// ── Time + world-sim cadence ──
	const currentTime = $derived.by(() => {
		const t = story.currentStory?.timeTracker;
		if (!t) return null;
		const pad = (n: number) => String(n).padStart(2, '0');
		return { years: t.years, days: t.days, hms: `${pad(t.hours)}:${pad(t.minutes)}` };
	});
	const daysUntilSim = $derived.by(() => {
		const t = story.currentStory?.timeTracker;
		if (!t) return null;
		const totalDays = t.years * 365 + t.days;
		const lastSim = story.currentStory?.lastWorldSimDay ?? 0;
		const remaining = WORLD_SIM_DAY_INTERVAL - (totalDays - lastSim);
		return remaining > 0 ? remaining : 0;
	});

	// Manual world-sim trigger ─────────────────────────────────────────
	let runningWorldSim = $state(false);
	const worldSimEnabled = $derived(settings.getServiceConfig('worldSimulation').enabled);
	async function runWorldSimNow() {
		if (runningWorldSim || !worldSimEnabled || !story.currentStory) return;
		runningWorldSim = true;
		try { await maybeRunWorldSim({ force: true }); }
		catch (e) { console.error('[WorldDrawer] manual world sim failed:', e); }
		runningWorldSim = false;
	}

	// ── Meters (player only sees visible meters) ──
	const visibleMeters = $derived(
		(story.currentStory?.meters ?? []).filter(m => m.visible),
	);

	// ── Living World ──
	const activeAgreements = $derived(
		story.agreements.filter(a => a.status === 'active'),
	);
	const pastAgreements = $derived(
		story.agreements
			.filter(a => a.status !== 'active')
			.sort((a, b) => (b.resolvedChapterNumber ?? 0) - (a.resolvedChapterNumber ?? 0))
			.slice(0, 12),
	);
	const activeRumors = $derived(
		story.rumors.filter(r => r.status !== 'stale' && r.status !== 'debunked')
			.slice(0, 12),
	);
	const recentFactionActions = $derived(
		[...story.factionActions]
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, 8),
	);
	const recentWorldEvents = $derived(
		[...story.worldEvents]
			.filter(e => e.appliedAt != null)
			.sort((a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0))
			.slice(0, 5),
	);
	const allFactionEntries = $derived(
		story.lorebookEntries
			.filter(e => e.type === 'faction' && !e.deleted)
			.sort(compareFactions),
	);
	const filteredFactionEntries = $derived.by(() => {
		const query = factionSearch.trim().toLowerCase();
		return allFactionEntries.filter(entry => {
			const state = factionState(entry);
			if (factionStatusFilter !== 'all' && state.status !== factionStatusFilter) return false;
			if (!query) return true;
			return factionSearchText(entry).includes(query);
		});
	});
	const visibleFactionEntries = $derived(filteredFactionEntries.slice(0, factionDisplayLimit));
	const hiddenFactionCount = $derived(Math.max(0, filteredFactionEntries.length - visibleFactionEntries.length));

	let livingWorldCollapsed = $state(false);
	let agreementsCollapsed = $state(false);
	let alliancesCollapsed = $state(false);

	// ── Alliances: flattened, deduped inter-faction relations ──
	interface AllianceRow {
		a: string;
		b: string;
		standing: number;
		affinity: number;
		recent: { event: string; chapter: number } | null;
	}
	const alliances = $derived.by<AllianceRow[]>(() => {
		const factions = story.lorebookEntries.filter(e => e.type === 'faction' && !e.deleted);
		const byNameLower = new Map(factions.map(f => [f.name.toLowerCase(), f.name]));
		const seen = new Map<string, AllianceRow>();
		for (const f of factions) {
			const rels = (f.state as FactionEntryState | undefined)?.interFactionRelations ?? {};
			for (const [otherName, raw] of Object.entries(rels)) {
				// Resolve canonical name; skip if other faction not in lorebook.
				const canonical = byNameLower.get(otherName.toLowerCase()) ?? otherName;
				if (canonical.toLowerCase() === f.name.toLowerCase()) continue; // self-relation
				const norm = normalizeRelation(raw);
				if (Math.abs(norm.standing) < 30 && Math.abs(norm.affinity) < 30) continue;
				const pair = [f.name, canonical].sort();
				const key = pair.join('|');
				const last = norm.history.length > 0 ? norm.history[norm.history.length - 1] : null;
				const existing = seen.get(key);
				if (!existing) {
					seen.set(key, {
						a: pair[0],
						b: pair[1],
						standing: norm.standing,
						affinity: norm.affinity,
						recent: last ? { event: last.event, chapter: last.chapter } : null,
					});
				} else {
					// Reciprocal — average standing/affinity, keep newer history event
					existing.standing = Math.round((existing.standing + norm.standing) / 2);
					existing.affinity = Math.round((existing.affinity + norm.affinity) / 2);
					if (last && (!existing.recent || last.chapter > existing.recent.chapter)) {
						existing.recent = { event: last.event, chapter: last.chapter };
					}
				}
			}
		}
		return [...seen.values()]
			.sort((x, y) => (Math.abs(y.standing) + Math.abs(y.affinity)) - (Math.abs(x.standing) + Math.abs(x.affinity)))
			.slice(0, 12);
	});

	// ── Timeline: chronological log of chapters + world events + entry creations ──
	type TimelineKind = 'chapter' | 'event' | 'entry';
	interface TimelineRow {
		when: number;
		kind: TimelineKind;
		title: string;
		detail?: string;
		entryType?: string;
	}

	let timelineFilter = $state<'all' | TimelineKind>('all');
	let timelineCollapsed = $state(false);

	// Wiki export
	let exportingWiki = $state(false);

	async function handleExportWiki() {
		if (!story.currentStory || exportingWiki) return;
		exportingWiki = true;
		try {
			await downloadStoryAsWiki(story.currentStory.id);
		} catch (e) {
			console.error('[Wiki Export] failed:', e);
		}
		exportingWiki = false;
	}

	const timelineRows = $derived.by(() => {
		const rows: TimelineRow[] = [];
		for (const ch of chapters) {
			rows.push({
				when: ch.createdAt,
				kind: 'chapter',
				title: ch.title || `Chapter ${ch.number}`,
				detail: ch.summary,
			});
		}
		for (const ev of story.worldEvents) {
			rows.push({
				when: ev.appliedAt ?? ev.triggerPosition ?? Date.now(),
				kind: 'event',
				title: ev.name,
				detail: ev.description,
			});
		}
		for (const e of story.lorebookEntries) {
			if (!e.createdAt) continue;
			rows.push({
				when: e.createdAt,
				kind: 'entry',
				title: e.name,
				entryType: e.type,
				detail: (e.description ?? '').slice(0, 120),
			});
		}
		rows.sort((a, b) => b.when - a.when); // newest first
		return timelineFilter === 'all' ? rows : rows.filter(r => r.kind === timelineFilter);
	});

	const kindIcons: Record<TimelineKind, string> = { chapter: '📖', event: '⚡', entry: '✨' };
</script>

{#if open}
<div class="fixed inset-0 z-40 flex justify-end" transition:fly={{ x: 0, duration: 0 }}>
	<button class="absolute inset-0 bg-black/40" aria-label="Close world drawer" onclick={onClose}></button>

	<div class="relative z-10 flex h-full w-full max-w-[26rem] flex-col border-l border-[var(--border-primary)] bg-[var(--bg-secondary)]"
		transition:fly={{ x: 420, duration: 200 }}>

		<!-- Header -->
		<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-4 py-3">
			<span class="font-display text-sm tracking-wide text-[var(--text-accent)]">World State</span>
			<div class="flex items-center gap-1">
				<button onclick={handleExportWiki} disabled={exportingWiki || !story.currentStory}
					class="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-amber-400 disabled:opacity-40"
					title="Export wiki as Obsidian-compatible .zip">
					{#if exportingWiki}<Loader2 class="h-4 w-4 animate-spin" />{:else}<FileArchive class="h-4 w-4" />{/if}
				</button>
				<button onclick={onClose} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]" aria-label="Close world drawer">
					<X class="h-5 w-5" />
				</button>
			</div>
		</div>

		<div class="flex-1 overflow-y-auto px-4 py-4 space-y-6">
			<!-- Context Usage -->
			{#if story.currentStory}
			<div>
				<div class="mb-1.5 flex items-center justify-between">
					<div class="flex items-center gap-1.5">
						<Gauge class="h-3.5 w-3.5 text-cyan-400" />
						<span class="font-display text-[10px] tracking-wider uppercase text-cyan-400">Context</span>
					</div>
					<span class="text-[10px] tabular-nums {contextPercent > 80 ? 'text-rose-400' : contextPercent > 50 ? 'text-amber-400' : 'text-emerald-400'}">
						~{formatTokens(contextTotal)} / 200K
					</span>
				</div>
				<div class="rounded-full bg-[var(--bg-primary)] h-2 overflow-hidden">
					<div
						class="h-full transition-all duration-300 rounded-full {contextPercent > 80 ? 'bg-rose-500' : contextPercent > 50 ? 'bg-amber-500' : 'bg-cyan-500'}"
						style="width: {contextPercent}%"
					></div>
				</div>
			</div>
			{/if}

			<!-- Time + World-sim Cadence -->
			{#if currentTime}
			<div>
				<div class="mb-2 flex items-center justify-between">
					<div class="flex items-center gap-1.5">
						<Clock class="h-3.5 w-3.5 text-sky-400" />
						<span class="font-display text-[10px] tracking-wider uppercase text-sky-400">In-World Time</span>
					</div>
					{#if daysUntilSim !== null}
						<span class="text-[10px] tabular-nums text-[var(--text-muted)]" title="Days until next world simulation tick">
							sim in {daysUntilSim}d
						</span>
					{/if}
				</div>
				<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-2 flex items-baseline gap-2">
					<span class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Day</span>
					<span class="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
						{currentTime.years > 0 ? `${currentTime.years}·` : ''}{currentTime.days}
					</span>
					<span class="ml-auto text-sm tabular-nums text-[var(--text-primary)]">{currentTime.hms}</span>
				</div>
				<button
					onclick={runWorldSimNow}
					disabled={runningWorldSim || !worldSimEnabled || !story.currentStory}
					class="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-1.5 text-xs text-sky-400 transition-colors hover:bg-sky-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
					title={worldSimEnabled ? 'Run world simulation now (bypasses the 7-day cadence)' : 'World simulation is disabled in settings'}
				>
					{#if runningWorldSim}
						<Loader2 class="h-3.5 w-3.5 animate-spin" />
						<span>Running world sim…</span>
					{:else}
						<Play class="h-3.5 w-3.5" />
						<span>Run world sim now</span>
					{/if}
				</button>
			</div>
			{/if}

			<!-- Current Location (above meters so the player's "where am I" is at the top) -->
			<div>
				<div class="mb-2 flex items-center gap-2">
					<MapPin class="h-4 w-4 text-blue-400" />
					<span class="font-display text-xs tracking-wider uppercase text-blue-400">Location</span>
				</div>
				{#if currentLocation}
					{@const charsHere = presenceMap.get(currentLocation.name) ?? []}
					<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-2">
						<div class="flex items-center gap-2">
							<span class="text-xs">📍</span>
							<span class="text-sm text-[var(--text-primary)]">{currentLocation.name}</span>
						</div>
						{#if currentLocation.description}
							<p class="mt-1 text-xs text-[var(--text-muted)]">{currentLocation.description}</p>
						{/if}
						{#if charsHere.length > 0}
							<div class="mt-1 flex flex-wrap gap-1">
								{#each charsHere as name}
									<span class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-400">{name}</span>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<p class="text-xs text-[var(--text-muted)]">No current location.</p>
				{/if}
			</div>

			<!-- Meters (visible only) -->
			{#if visibleMeters.length > 0}
			<div>
				<div class="mb-2 flex items-center gap-2">
					<Activity class="h-4 w-4 text-pink-400" />
					<span class="font-display text-xs tracking-wider uppercase text-pink-400">Meters ({visibleMeters.length})</span>
				</div>
				<div class="space-y-1.5">
					{#each visibleMeters as m}
						{@const pct = Math.max(0, Math.min(100, (m.value / Math.max(1, m.max)) * 100))}
						<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-1.5">
							<div class="flex items-center justify-between text-xs">
								<span class="capitalize text-[var(--text-primary)]">{m.name}</span>
								<span class="tabular-nums text-[var(--text-muted)]">{m.value}/{m.max}</span>
							</div>
							<div class="mt-1 h-1 rounded-full bg-[var(--bg-primary)] overflow-hidden">
								<div class="h-full rounded-full bg-pink-500 transition-all" style="width: {pct}%"></div>
							</div>
						</div>
					{/each}
				</div>
			</div>
			{/if}

			<!-- Timeline -->
			{#if timelineRows.length > 0 || true}
			<div>
				<button class="mb-2 flex w-full items-center justify-between gap-2"
					onclick={() => timelineCollapsed = !timelineCollapsed}>
					<div class="flex items-center gap-2">
						<ScrollText class="h-4 w-4 text-amber-400" />
						<span class="font-display text-xs tracking-wider uppercase text-amber-400">Timeline</span>
						<span class="text-[10px] text-[var(--text-muted)]">{timelineRows.length}</span>
					</div>
					{#if timelineCollapsed}<ChevronRight class="h-3.5 w-3.5 text-[var(--text-muted)]" />
					{:else}<ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
				</button>
				{#if !timelineCollapsed}
					<div class="mb-2 flex gap-1 text-[10px]">
						{#each [{ v: 'all', l: 'All' }, { v: 'chapter', l: 'Chapters' }, { v: 'event', l: 'Events' }, { v: 'entry', l: 'Entries' }] as f}
							<button class="rounded-md px-1.5 py-0.5 tracking-wider transition-colors
								{timelineFilter === f.v ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
								onclick={() => timelineFilter = f.v as any}>{f.l}</button>
						{/each}
					</div>
					{#if timelineRows.length === 0}
						<p class="text-xs text-[var(--text-muted)] italic">Nothing here yet.</p>
					{:else}
						<div class="max-h-64 overflow-y-auto space-y-1.5 pr-1">
							{#each timelineRows.slice(0, 80) as row}
								<div class="rounded-lg bg-[var(--bg-tertiary)] px-2 py-1.5">
									<div class="flex items-baseline gap-1.5 text-[10px]">
										<span>{kindIcons[row.kind]}</span>
										<span class="truncate font-semibold text-[var(--text-primary)] text-xs">{row.title}</span>
										{#if row.entryType}
											<span class="rounded bg-[var(--bg-primary)] px-1 py-0 text-[9px] text-[var(--text-muted)]">{row.entryType}</span>
										{/if}
										<span class="ml-auto shrink-0 text-[var(--text-muted)]">{new Date(row.when).toLocaleDateString()}</span>
									</div>
									{#if row.detail}
										<p class="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-[var(--text-muted)]">{row.detail}</p>
									{/if}
								</div>
							{/each}
							{#if timelineRows.length > 80}
								<p class="text-center text-[10px] text-[var(--text-muted)]">+{timelineRows.length - 80} older entries</p>
							{/if}
						</div>
					{/if}
				{/if}
			</div>
			{/if}

			<!-- Presence Map -->
			{#if presenceMap.size > 0}
			<div>
				<div class="mb-2 flex items-center gap-2">
					<MapPin class="h-4 w-4 text-emerald-400" />
					<span class="font-display text-xs tracking-wider uppercase text-emerald-400">Presence</span>
				</div>
				<div class="space-y-1.5">
					{#each [...presenceMap.entries()] as [locName, charNames]}
						<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-2">
							<div class="flex items-center gap-1.5">
								<span class="text-xs">📍</span>
								<span class="text-xs font-semibold text-[var(--text-primary)]">{locName}</span>
							</div>
							<div class="mt-1 flex flex-wrap gap-1">
								{#each charNames as name}
									{@const char = activeChars.find(c => c.name === name)}
									<span class="group flex items-center gap-0.5 rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">
										{name}
										{#if char}
											<button
												onclick={() => story.clearPresence(char.id)}
												class="ml-0.5 inline-flex rounded-full p-0.5 text-[var(--text-muted)] hover:bg-red-500/20 hover:text-red-400 opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
												title="Remove presence"
											>
												<X class="h-2.5 w-2.5" />
											</button>
										{/if}
									</span>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</div>
			{/if}

			<!-- Characters -->
			<div>
				<div class="mb-2 flex items-center gap-2">
					<Users class="h-4 w-4 text-[var(--text-accent)]" />
					<span class="font-display text-xs tracking-wider uppercase text-[var(--text-accent)]">Characters ({activeChars.length})</span>
				</div>
				{#if activeChars.length === 0}
					<p class="text-xs text-[var(--text-muted)]">No characters yet.</p>
				{:else}
					<div class="space-y-2">
						{#each activeChars as char}
							<div class="rounded-lg bg-[var(--bg-tertiary)] p-2.5">
								<div class="flex items-center gap-2">
									<span class="text-xs">{char.relationship === 'self' ? '⭐' : '👤'}</span>
									<span class="text-sm font-semibold text-[var(--text-primary)]">{char.name}</span>
									{#if char.relationship && char.relationship !== 'self'}
										<span class="rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[9px] text-[var(--text-muted)]">{char.relationship}</span>
									{/if}
								</div>
								{#if char.description}
									<p class="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">{char.description}</p>
								{/if}
								{#if char.traits && char.traits.length > 0}
									<div class="mt-1.5 flex flex-wrap gap-1">
										{#each char.traits as trait}
											<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">{trait}</span>
										{/each}
									</div>
								{/if}
								{#if char.metadata?.lastSeenLocation}
									<div class="mt-1 flex items-center gap-1 text-[9px] text-[var(--text-muted)]">
										<MapPin class="h-2.5 w-2.5" />
										<span>{char.metadata.lastSeenLocation}</span>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Items -->
			<div>
				<div class="mb-2 flex items-center gap-2">
					<Swords class="h-4 w-4 text-amber-400" />
					<span class="font-display text-xs tracking-wider uppercase text-amber-400">Items ({story.items.length})</span>
				</div>
				{#if story.items.length === 0}
					<p class="text-xs text-[var(--text-muted)]">No items found.</p>
				{:else}
					<div class="space-y-1.5">
						{#each story.items as item}
							<div class="flex items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-2">
								<span class="text-xs">🗡️</span>
								<span class="text-sm text-[var(--text-primary)]">{item.name}</span>
								{#if item.equipped}
									<span class="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-400">equipped</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Promises & Agreements — treaties, oaths, debts, marriages, bargains -->
			{#if activeAgreements.length > 0 || pastAgreements.length > 0}
			<div>
				<button class="mb-2 flex w-full items-center justify-between gap-2"
					onclick={() => agreementsCollapsed = !agreementsCollapsed}>
					<div class="flex items-center gap-2">
						<Scale class="h-4 w-4 text-violet-400" />
						<span class="font-display text-xs tracking-wider uppercase text-violet-400">Promises & Agreements</span>
						<span class="text-[10px] text-[var(--text-muted)]">
							{activeAgreements.length + pastAgreements.length}
						</span>
					</div>
					{#if agreementsCollapsed}<ChevronRight class="h-3.5 w-3.5 text-[var(--text-muted)]" />
					{:else}<ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
				</button>

				{#if !agreementsCollapsed}
					{#if activeAgreements.length > 0}
						<div class="mb-3">
							<div class="mb-1 flex items-center gap-1.5">
								<span class="text-[9px] tracking-wider uppercase text-violet-400/80">Active ({activeAgreements.length})</span>
							</div>
							<div class="space-y-1">
								{#each activeAgreements as a}
									<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-1.5">
										<div class="flex items-baseline gap-1.5 text-[10px]">
											<span class="rounded bg-violet-500/10 px-1 py-0.5 text-violet-400 capitalize">{a.category}</span>
											<span class="text-[var(--text-primary)] truncate">{a.parties.join(' ↔ ')}</span>
											{#if a.secrecy !== 'public'}
												<span class="ml-auto rounded bg-rose-500/10 px-1 py-0 text-rose-400 italic">{a.secrecy}</span>
											{/if}
											{#if a.createdChapterNumber != null}
												<span class="text-[9px] text-[var(--text-muted)]">ch.{a.createdChapterNumber}</span>
											{/if}
										</div>
										<p class="mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)] line-clamp-2">{a.terms}</p>
										{#if a.consequences && a.consequences.length > 0}
											<p class="mt-0.5 text-[9px] italic text-[var(--text-muted)]/70 line-clamp-1">→ {a.consequences[0]}</p>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if pastAgreements.length > 0}
						<div>
							<div class="mb-1 flex items-center gap-1.5">
								<span class="text-[9px] tracking-wider uppercase text-[var(--text-muted)]">Past ({pastAgreements.length})</span>
							</div>
							<div class="space-y-1">
								{#each pastAgreements as a}
									{@const statusColor = a.status === 'fulfilled' ? 'text-emerald-400' : a.status === 'broken' ? 'text-rose-400' : 'text-[var(--text-muted)]'}
									<div class="rounded-lg bg-[var(--bg-tertiary)]/60 px-2.5 py-1.5">
										<div class="flex items-baseline gap-1.5 text-[10px]">
											<span class="rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[var(--text-muted)] capitalize">{a.category}</span>
											<span class="text-[var(--text-muted)] truncate line-through">{a.parties.join(' ↔ ')}</span>
											<span class="ml-auto italic capitalize {statusColor}">{a.status}</span>
											{#if a.resolvedChapterNumber != null}
												<span class="text-[9px] text-[var(--text-muted)]">ch.{a.resolvedChapterNumber}</span>
											{/if}
										</div>
										<p class="mt-0.5 text-[9px] leading-relaxed text-[var(--text-muted)]/70 line-clamp-1">{a.terms}</p>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				{/if}
			</div>
			{/if}

			<!-- Factions -->
			{#if allFactionEntries.length > 0}
			<div>
				<div class="mb-2 flex items-center gap-2">
					<Flag class="h-4 w-4 text-orange-400" />
					<span class="font-display text-xs tracking-wider uppercase text-orange-400">Factions ({visibleFactionEntries.length}/{allFactionEntries.length})</span>
				</div>

				<div class="mb-2 space-y-2">
					<div class="relative">
						<Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
						<input
							aria-label="Search factions"
							value={factionSearch}
							oninput={(e) => setFactionSearch((e.currentTarget as HTMLInputElement).value)}
							placeholder="Search factions..."
							class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] py-1.5 pl-8 pr-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-orange-400 focus:outline-none"
						/>
					</div>
					<div class="grid grid-cols-2 gap-2">
						<select
							aria-label="Filter factions by status"
							value={factionStatusFilter}
							onchange={(e) => setFactionStatus((e.currentTarget as HTMLSelectElement).value as FactionStatusFilter)}
							class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs text-[var(--text-primary)] focus:border-orange-400 focus:outline-none"
						>
							<option value="all">All statuses</option>
							<option value="allied">Allied</option>
							<option value="neutral">Neutral</option>
							<option value="hostile">Hostile</option>
							<option value="unknown">Unknown</option>
						</select>
						<select
							aria-label="Sort factions"
							value={factionSortMode}
							onchange={(e) => setFactionSort((e.currentTarget as HTMLSelectElement).value as FactionSortMode)}
							class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs text-[var(--text-primary)] focus:border-orange-400 focus:outline-none"
						>
							<option value="relevance">Relevance</option>
							<option value="standing">Standing</option>
							<option value="resources">Resources</option>
							<option value="name">Name</option>
						</select>
					</div>
					{#if factionSearch || factionStatusFilter !== 'all'}
						<div class="flex items-center justify-between rounded-lg bg-[var(--bg-tertiary)]/60 px-2.5 py-1 text-[10px] text-[var(--text-muted)]">
							<span>{filteredFactionEntries.length} match{filteredFactionEntries.length === 1 ? '' : 'es'}</span>
							<button
								class="text-orange-300 hover:text-orange-200"
								onclick={() => {
									factionSearch = '';
									factionStatusFilter = 'all';
									resetFactionRosterLimit();
								}}
							>
								Clear
							</button>
						</div>
					{/if}
				</div>

				<div class="space-y-2">
					{#each visibleFactionEntries as faction}
						{@const fs = faction.state as FactionEntryState}
						{@const members = (fs.knownMembers ?? []).map(id => story.lorebookEntries.find(e => e.id === id)?.name ?? id).slice(0, 5)}
						{@const topGoal = (fs.goals ?? []).filter(g => (g.progress ?? 0) < 100).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0]}
						{@const lastMove = latestFactionAction(faction.name)}
						<div class="rounded-lg bg-[var(--bg-tertiary)] p-2.5">
							<div class="flex items-center gap-1.5">
								<span class="text-sm font-semibold text-[var(--text-primary)] truncate">{faction.name}</span>
								<span class="rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[9px] capitalize text-[var(--text-muted)]">{fs.status ?? 'unknown'}</span>
								<span class="ml-auto font-mono text-[10px] text-[var(--text-muted)]">{(fs.playerStanding ?? 0) > 0 ? '+' : ''}{fs.playerStanding ?? 0}</span>
							</div>
							{#if topGoal}
								<p class="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">Goal: {topGoal.description} ({topGoal.progress ?? 0}%)</p>
							{/if}
							{#if fs.resources}
								<div class="mt-1.5 grid grid-cols-5 gap-1 text-center text-[9px] text-[var(--text-muted)]">
									<span title="Military">mil {fs.resources.military}</span>
									<span title="Wealth">wel {fs.resources.wealth}</span>
									<span title="Influence">inf {fs.resources.influence}</span>
									<span title="Information">spy {fs.resources.information}</span>
									<span title="Morale">mor {fs.resources.morale}</span>
								</div>
							{/if}
							{#if members.length > 0}
								<p class="mt-1 text-[10px] text-[var(--text-muted)] line-clamp-1">Members: {members.join(', ')}</p>
							{/if}
							{#if lastMove}
								<p class="mt-1 text-[10px] text-orange-300/80 line-clamp-1">Last move: {lastMove.action}</p>
							{/if}
						</div>
					{/each}
				</div>

				{#if filteredFactionEntries.length === 0}
					<p class="rounded-lg bg-[var(--bg-tertiary)]/60 px-3 py-2 text-xs text-[var(--text-muted)]">No factions match the current filters.</p>
				{:else if hiddenFactionCount > 0 || factionDisplayLimit > FACTION_PAGE_SIZE}
					<div class="mt-2 flex flex-wrap gap-2">
						{#if hiddenFactionCount > 0}
							<button
								class="flex items-center gap-1.5 rounded-lg bg-[rgba(251,146,60,0.12)] px-2.5 py-1.5 text-[10px] text-orange-300 transition-colors hover:bg-[rgba(251,146,60,0.2)]"
								onclick={() => factionDisplayLimit = Math.min(filteredFactionEntries.length, factionDisplayLimit + FACTION_PAGE_SIZE)}
							>
								<ChevronDown class="h-3 w-3" />
								Show {Math.min(FACTION_PAGE_SIZE, hiddenFactionCount)} more
							</button>
							<button
								class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[10px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
								onclick={() => factionDisplayLimit = filteredFactionEntries.length}
							>
								Show all {filteredFactionEntries.length}
							</button>
						{/if}
						{#if factionDisplayLimit > FACTION_PAGE_SIZE}
							<button
								class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[10px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
								onclick={resetFactionRosterLimit}
							>
								Collapse
							</button>
						{/if}
					</div>
				{/if}
			</div>
			{/if}

			<!-- Alliances — inter-faction relations, deduped symmetric pairs -->
			{#if alliances.length > 0}
			<div>
				<button class="mb-2 flex w-full items-center justify-between gap-2"
					onclick={() => alliancesCollapsed = !alliancesCollapsed}>
					<div class="flex items-center gap-2">
						<Handshake class="h-4 w-4 text-cyan-400" />
						<span class="font-display text-xs tracking-wider uppercase text-cyan-400">Alliances</span>
						<span class="text-[10px] text-[var(--text-muted)]">{alliances.length}</span>
					</div>
					{#if alliancesCollapsed}<ChevronRight class="h-3.5 w-3.5 text-[var(--text-muted)]" />
					{:else}<ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
				</button>

				{#if !alliancesCollapsed}
					<div class="space-y-1">
						{#each alliances as r}
							{@const standingColor =
								r.standing >= 50 ? 'text-emerald-400'
								: r.standing >= 30 ? 'text-cyan-400'
								: r.standing <= -50 ? 'text-rose-400'
								: r.standing <= -30 ? 'text-amber-400'
								: 'text-[var(--text-muted)]'}
							{@const sign = (n: number) => `${n > 0 ? '+' : ''}${n}`}
							<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-1.5">
								<div class="flex items-baseline gap-1.5 text-[10px]">
									<span class="text-[var(--text-primary)] truncate">{r.a}</span>
									<span class="text-[var(--text-muted)]">↔</span>
									<span class="text-[var(--text-primary)] truncate">{r.b}</span>
									<span class="ml-auto font-mono {standingColor}">st:{sign(r.standing)}</span>
									<span class="font-mono text-[var(--text-muted)]">af:{sign(r.affinity)}</span>
								</div>
								{#if r.recent}
									<p class="mt-0.5 text-[9px] italic text-[var(--text-muted)]/70 line-clamp-1">ch.{r.recent.chapter}: {r.recent.event}</p>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
			{/if}

			<!-- Living World — factions, rumors, world events -->
			{#if recentFactionActions.length > 0 || activeRumors.length > 0 || recentWorldEvents.length > 0}
			<div>
				<button class="mb-2 flex w-full items-center justify-between gap-2"
					onclick={() => livingWorldCollapsed = !livingWorldCollapsed}>
					<div class="flex items-center gap-2">
						<Zap class="h-4 w-4 text-violet-400" />
						<span class="font-display text-xs tracking-wider uppercase text-violet-400">Living World</span>
						<span class="text-[10px] text-[var(--text-muted)]">
							{recentFactionActions.length + activeRumors.length + recentWorldEvents.length}
						</span>
					</div>
					{#if livingWorldCollapsed}<ChevronRight class="h-3.5 w-3.5 text-[var(--text-muted)]" />
					{:else}<ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
				</button>

				{#if !livingWorldCollapsed}
					{#if recentFactionActions.length > 0}
						<div class="mb-3">
							<div class="mb-1 flex items-center gap-1.5">
								<Flag class="h-3 w-3 text-orange-400/80" />
								<span class="text-[9px] tracking-wider uppercase text-orange-400/80">Faction Moves ({recentFactionActions.length})</span>
							</div>
							<div class="space-y-1">
								{#each recentFactionActions as fa}
									<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-1.5">
										<div class="flex items-baseline gap-1.5 text-[10px]">
											<span class="text-orange-400">{fa.factionName}</span>
											<span class="rounded bg-[var(--bg-primary)] px-1 py-0 text-[var(--text-muted)] italic">{fa.actionType}</span>
											<span class="ml-auto text-[var(--text-muted)] uppercase tracking-wider {fa.urgency === 'critical' ? 'text-rose-400' : fa.urgency === 'high' ? 'text-amber-400' : ''}">{fa.urgency}</span>
										</div>
										<p class="mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)] line-clamp-2">{fa.action}</p>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if activeRumors.length > 0}
						<div class="mb-3">
							<div class="mb-1 flex items-center gap-1.5">
								<Megaphone class="h-3 w-3 text-amber-400/80" />
								<span class="text-[9px] tracking-wider uppercase text-amber-400/80">Rumors ({activeRumors.length})</span>
							</div>
							<div class="space-y-1">
								{#each activeRumors as r}
									{@const band = r.truthfulness >= 0.7 ? 'reliable' : r.truthfulness >= 0.4 ? 'uncertain' : 'dubious'}
									{@const bandColor = band === 'reliable' ? 'text-emerald-400' : band === 'uncertain' ? 'text-amber-400' : 'text-rose-400'}
									<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-1.5">
										<div class="flex items-baseline gap-1.5 text-[10px]">
											<span class="rounded bg-[var(--bg-primary)] px-1 py-0 italic {bandColor}">{band}</span>
											<span class="text-[var(--text-muted)]">{r.spreadRadius}</span>
											{#if r.status === 'mature'}
												<span class="ml-auto text-[var(--text-muted)] italic">mature</span>
											{/if}
										</div>
										<p class="mt-0.5 text-[10px] leading-relaxed text-[var(--text-primary)] line-clamp-2">{r.content}</p>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if recentWorldEvents.length > 0}
						<div>
							<div class="mb-1 flex items-center gap-1.5">
								<Zap class="h-3 w-3 text-fuchsia-400/80" />
								<span class="text-[9px] tracking-wider uppercase text-fuchsia-400/80">World Events ({recentWorldEvents.length})</span>
							</div>
							<div class="space-y-1">
								{#each recentWorldEvents as ev}
									<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-1.5">
										<div class="flex items-baseline gap-1.5 text-[10px]">
											<span class="text-fuchsia-400 truncate">{ev.name}</span>
											<span class="ml-auto rounded bg-[var(--bg-primary)] px-1 py-0 text-[var(--text-muted)] italic">{ev.severity}</span>
										</div>
										<p class="mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)] line-clamp-2">{ev.description}</p>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				{/if}
			</div>
			{/if}

			<!-- Lorebook -->
			{#if story.lorebookEntries.length > 0}
			<div>
				<div class="mb-2 flex items-center gap-2">
					<ScrollText class="h-4 w-4 text-purple-400" />
					<span class="font-display text-xs tracking-wider uppercase text-purple-400">Active Lore ({story.lorebookEntries.length})</span>
				</div>
				<div class="space-y-1.5">
					{#each story.lorebookEntries.slice(0, 10) as entry}
						<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-2">
							<div class="flex items-center gap-1.5">
								<span class="text-sm text-[var(--text-primary)]">{entry.name}</span>
								<span class="rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[9px] capitalize text-[var(--text-muted)]">{entry.type}</span>
							</div>
							<p class="mt-0.5 text-xs text-[var(--text-muted)] line-clamp-1">{entry.description}</p>
						</div>
					{/each}
				</div>
			</div>
			{/if}

			<!-- Story Memory: Arcs → Uncovered Chapters -->
			<div>
				<div class="mb-2 flex items-center justify-between">
					<div class="flex items-center gap-2">
						<Layers class="h-4 w-4 text-orange-400" />
						<span class="font-display text-xs tracking-wider uppercase text-orange-400">Story Memory</span>
					</div>
					{#if arcs.length > 0 || chapters.length > 0}
						<button onclick={exportArcsAsJson} class="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]" title="Export arcs & chapters">
							<Download class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>

				{#if arcs.length === 0 && chapters.length === 0}
					<p class="text-xs text-[var(--text-muted)]">No chapters yet. Chapters are created every ~20 messages, arcs every 5 chapters.</p>
				{/if}

				<!-- Arcs (condensed chapter groups) -->
				{#if arcs.length > 0}
					<div class="space-y-1.5 mb-3">
						{#each arcs as arc}
							<div class="rounded-lg bg-[var(--bg-tertiary)] overflow-hidden border-l-2 border-orange-500/40">
								<button
									class="flex w-full items-center gap-2 px-2.5 py-2 text-left"
									onclick={() => toggleArc(arc.id)}
								>
									{#if expandedArc === arc.id}
										<ChevronDown class="h-3 w-3 shrink-0 text-orange-400" />
									{:else}
										<ChevronRight class="h-3 w-3 shrink-0 text-orange-400" />
									{/if}
									<span class="text-[10px] font-bold text-orange-400/70">ARC {arc.arcNumber}</span>
									<span class="text-sm text-[var(--text-primary)] truncate">{arc.title}</span>
									<span class="ml-auto text-[9px] text-[var(--text-muted)]">Ch.{arc.chapterRange}</span>
								</button>

								{#if expandedArc === arc.id}
									<div class="border-t border-[var(--border-primary)] px-2.5 py-2 space-y-2">
										<p class="text-xs leading-relaxed text-[var(--text-muted)]">{arc.summary}</p>

										{#if arc.keyPlotPoints.length > 0}
											<div>
												<span class="text-[9px] font-semibold text-[var(--text-muted)]">Key Events:</span>
												<ul class="mt-0.5 space-y-0.5">
													{#each arc.keyPlotPoints as point}
														<li class="text-[10px] text-[var(--text-muted)] pl-2 border-l border-orange-500/20">{point}</li>
													{/each}
												</ul>
											</div>
										{/if}

										{#if arc.characterArcs.length > 0}
											<div class="flex flex-wrap gap-1">
												{#each arc.characterArcs as ca}
													<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]" title={ca.development}>{ca.name}</span>
												{/each}
											</div>
										{/if}

										{#if arc.unresolvedThreads.length > 0}
											<div>
												<span class="text-[9px] font-semibold text-amber-400/70">Open Threads:</span>
												<div class="mt-0.5 flex flex-wrap gap-1">
													{#each arc.unresolvedThreads as thread}
														<span class="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-400">{thread}</span>
													{/each}
												</div>
											</div>
										{/if}

										{#if arc.emotionalProgression}
											<div class="text-[9px] italic text-[var(--text-muted)]">{arc.emotionalProgression}</div>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				<!-- Uncovered Chapters (not yet in an arc) -->
				{#if uncoveredChapters.length > 0}
					<div class="mb-2 flex items-center gap-2">
						<BookOpen class="h-3.5 w-3.5 text-rose-400" />
						<span class="text-[10px] tracking-wider uppercase text-rose-400">
							Chapters not in arc ({uncoveredChapters.length})
						</span>
					</div>

					<!-- Arc Analyzer button -->
					{#if condensableChapters.length >= 3}
						<button
							onclick={generateArc}
							disabled={generatingArc}
							class="mb-2 flex w-full items-center justify-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/5 px-3 py-2 text-xs text-orange-400 transition-colors hover:bg-orange-500/10 disabled:opacity-40"
						>
							{#if generatingArc}
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
								<span>Analyzing {condensableChapters.length} chapters...</span>
							{:else}
								<Layers class="h-3.5 w-3.5" />
								<span>Analyze {condensableChapters.length} chapters → Arc {arcs.length + 1}</span>
							{/if}
						</button>
					{/if}

					<div class="space-y-1.5">
						{#each uncoveredChapters as chapter}
							<div class="rounded-lg bg-[var(--bg-tertiary)] overflow-hidden">
								<button
									class="flex w-full items-center gap-2 px-2.5 py-2 text-left"
									onclick={() => toggleChapter(chapter.id)}
								>
									{#if expandedChapter === chapter.id}
										<ChevronDown class="h-3 w-3 shrink-0 text-rose-400" />
									{:else}
										<ChevronRight class="h-3 w-3 shrink-0 text-rose-400" />
									{/if}
									<span class="text-[10px] font-bold text-rose-400/70">CH.{chapter.number}</span>
									<span class="text-sm text-[var(--text-primary)] truncate">{chapter.title ?? 'Untitled'}</span>
								</button>

								{#if expandedChapter === chapter.id}
									<div class="border-t border-[var(--border-primary)] px-2.5 py-2 space-y-2">
										<p class="text-xs leading-relaxed text-[var(--text-muted)]">{chapter.summary}</p>

										{#if chapter.emotionalTone}
											<div class="flex items-center gap-1.5">
												<span class="text-[9px] text-[var(--text-muted)]">Tone:</span>
												<span class="rounded bg-rose-500/10 px-1.5 py-0.5 text-[9px] text-rose-400">{chapter.emotionalTone}</span>
											</div>
										{/if}

										{#if chapter.characters.length > 0}
											<div class="flex flex-wrap gap-1">
												{#each chapter.characters as name}
													<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">{name}</span>
												{/each}
											</div>
										{/if}

										{#if chapter.locations.length > 0}
											<div class="flex flex-wrap gap-1">
												{#each chapter.locations as loc}
													<span class="rounded bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-400">{loc}</span>
												{/each}
											</div>
										{/if}

										<div class="text-[9px] text-[var(--text-muted)]">
											{chapter.entryCount} entries
										</div>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{:else if chapters.length > 0}
					<p class="text-xs text-[var(--text-muted)]">All {chapters.length} chapters condensed into arcs.</p>
				{/if}
			</div>
		</div>
	</div>
</div>
{/if}
