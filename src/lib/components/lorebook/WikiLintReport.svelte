<script lang="ts">
	import { X, AlertTriangle, AlertCircle, Info, FileQuestion, Lightbulb, CheckCircle2, Loader2 } from 'lucide-svelte';
	import { fade } from 'svelte/transition';
	import type { WikiLintResult } from '$lib/services/ai/sdk/schemas/wikiLint';

	interface Props {
		result: WikiLintResult | null;
		loading: boolean;
		error: string | null;
		onClose: () => void;
	}

	let { result, loading, error, onClose }: Props = $props();

	function severityClass(s: 'minor' | 'moderate' | 'major'): string {
		if (s === 'major') return 'text-rose-400';
		if (s === 'moderate') return 'text-amber-400';
		return 'text-[var(--text-muted)]';
	}

	const totalIssues = $derived(
		result
			? result.contradictions.length +
			  result.staleClaims.length +
			  result.orphans.length +
			  result.missingEntries.length +
			  result.gapSuggestions.length
			: 0,
	);
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
	<button class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={onClose} aria-label="Close"></button>

	<div class="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-2xl">
		<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-5 py-3">
			<div class="flex items-center gap-2">
				<AlertCircle class="h-4 w-4 text-amber-400" />
				<h3 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Wiki Health Check</h3>
				{#if result}
					<span class="text-xs text-[var(--text-muted)]">· {totalIssues} item{totalIssues === 1 ? '' : 's'}</span>
				{/if}
			</div>
			<button onclick={onClose} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
				<X class="h-4 w-4" />
			</button>
		</div>

		<div class="flex-1 overflow-y-auto px-5 py-4 space-y-4">
			{#if loading}
				<div class="flex items-center justify-center gap-2 py-12 text-[var(--text-muted)]">
					<Loader2 class="h-5 w-5 animate-spin" />
					<span class="text-sm">Auditing the wiki…</span>
				</div>
			{:else if error}
				<div class="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-sm text-rose-300">
					{error}
				</div>
			{:else if result}
				<p class="text-sm leading-relaxed text-[var(--text-primary)]">{result.summary}</p>

				{#if totalIssues === 0}
					<div class="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-sm text-emerald-400">
						<CheckCircle2 class="h-4 w-4" /> No issues found.
					</div>
				{/if}

				{#if result.contradictions.length > 0}
					<section>
						<h4 class="mb-2 flex items-center gap-1.5 font-display text-xs uppercase tracking-wider text-rose-400">
							<AlertTriangle class="h-3.5 w-3.5" /> Contradictions ({result.contradictions.length})
						</h4>
						<ul class="space-y-1.5">
							{#each result.contradictions as c}
								<li class="rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs">
									<div class="flex items-baseline gap-2">
										<span class="font-semibold text-[var(--text-primary)]">{c.entryName}</span>
										<span class={`text-[10px] uppercase ${severityClass(c.severity)}`}>{c.severity}</span>
									</div>
									<p class="mt-0.5 text-[var(--text-muted)] leading-relaxed">{c.issue}</p>
									{#if c.conflictsWith}
										<p class="mt-0.5 text-[10px] text-[var(--text-muted)]">conflicts with: {c.conflictsWith}</p>
									{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if result.staleClaims.length > 0}
					<section>
						<h4 class="mb-2 flex items-center gap-1.5 font-display text-xs uppercase tracking-wider text-amber-400">
							<Info class="h-3.5 w-3.5" /> Stale Claims ({result.staleClaims.length})
						</h4>
						<ul class="space-y-1.5">
							{#each result.staleClaims as s}
								<li class="rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs">
									<div class="font-semibold text-[var(--text-primary)]">{s.entryName}</div>
									<p class="mt-0.5 text-[var(--text-muted)] leading-relaxed">claims: {s.claim}</p>
									<p class="mt-0.5 text-[10px] text-amber-300/80">superseded by: {s.supersededBy}</p>
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if result.missingEntries.length > 0}
					<section>
						<h4 class="mb-2 flex items-center gap-1.5 font-display text-xs uppercase tracking-wider text-cyan-400">
							<FileQuestion class="h-3.5 w-3.5" /> Missing Entries ({result.missingEntries.length})
						</h4>
						<ul class="space-y-1.5">
							{#each result.missingEntries as m}
								<li class="rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs">
									<div class="flex items-baseline gap-2">
										<span class="font-semibold text-[var(--text-primary)]">{m.suggestedName}</span>
										<span class="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] capitalize text-[var(--text-muted)]">{m.suggestedType}</span>
									</div>
									<p class="mt-0.5 text-[var(--text-muted)] leading-relaxed">{m.reason}</p>
									<p class="mt-0.5 text-[10px] text-cyan-300/80">mentioned in: {m.mentionedIn}</p>
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if result.orphans.length > 0}
					<section>
						<h4 class="mb-2 flex items-center gap-1.5 font-display text-xs uppercase tracking-wider text-[var(--text-muted)]">
							Orphans ({result.orphans.length})
						</h4>
						<ul class="space-y-1.5">
							{#each result.orphans as o}
								<li class="rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs">
									<div class="font-semibold text-[var(--text-primary)]">{o.entryName}</div>
									<p class="mt-0.5 text-[var(--text-muted)] leading-relaxed">{o.reason}</p>
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if result.gapSuggestions.length > 0}
					<section>
						<h4 class="mb-2 flex items-center gap-1.5 font-display text-xs uppercase tracking-wider text-violet-400">
							<Lightbulb class="h-3.5 w-3.5" /> Gap Suggestions ({result.gapSuggestions.length})
						</h4>
						<ul class="space-y-1.5">
							{#each result.gapSuggestions as g}
								<li class="rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs">
									<div class="font-semibold text-[var(--text-primary)]">{g.topic}</div>
									<p class="mt-0.5 text-[var(--text-muted)] leading-relaxed">{g.suggestion}</p>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/if}
		</div>
	</div>
</div>
