<script lang="ts">
	import { X, Users, MapPin, Swords, ScrollText, BookOpen, ChevronDown, ChevronRight, Gauge, Loader2, Layers, Download } from 'lucide-svelte';
	import { story } from '$lib/stores/story.svelte';
	import { getChapters, getArcs, createArc } from '$lib/services/database';
	import { ai } from '$lib/services/ai';
	import { uuid } from '$lib/utils/uuid';
	import type { Arc } from '$lib/types';
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
</script>

{#if open}
<div class="fixed inset-0 z-40 flex justify-end" transition:fly={{ x: 0, duration: 0 }}>
	<button class="absolute inset-0 bg-black/40" onclick={onClose}></button>

	<div class="relative z-10 flex h-full w-80 flex-col border-l border-[var(--border-primary)] bg-[var(--bg-secondary)]"
		transition:fly={{ x: 320, duration: 200 }}>

		<!-- Header -->
		<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-4 py-3">
			<span class="font-display text-sm tracking-wide text-[var(--text-accent)]">World State</span>
			<button onclick={onClose} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
				<X class="h-5 w-5" />
			</button>
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

			<!-- Current Location -->
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
