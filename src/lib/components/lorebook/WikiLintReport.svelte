<script lang="ts">
	import { X, AlertTriangle, AlertCircle, Info, FileQuestion, Lightbulb, CheckCircle2, Loader2, Wand2, Plus, Check } from 'lucide-svelte';
	import { fade } from 'svelte/transition';
	import type { WikiLintResult, WikiMissingEntry, WikiTextFix } from '$lib/services/ai/sdk/schemas/wikiLint';

	interface Props {
		result: WikiLintResult | null;
		loading: boolean;
		error: string | null;
		onClose: () => void;
		onCreateMissingEntry?: (entry: WikiMissingEntry) => Promise<void>;
		onApplyTextFix?: (fix: WikiTextFix) => Promise<void>;
	}

	let { result, loading, error, onClose, onCreateMissingEntry, onApplyTextFix }: Props = $props();
	let fixing = $state(false);
	let fixError = $state<string | null>(null);
	let fixedKeys = $state<Set<string>>(new Set());

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
			  result.gapSuggestions.length +
			  result.textFixes.length
			: 0,
	);

	const safeFixCount = $derived.by(() => {
		if (!result) return 0;
		return result.missingEntries.filter(entry => !fixedKeys.has(missingKey(entry))).length +
			result.textFixes.filter(fix => fix.safeToAutoApply && !fixedKeys.has(textFixKey(fix))).length;
	});

	function missingKey(item: WikiMissingEntry): string {
		return `missing:${item.suggestedName}:${item.suggestedType}`;
	}

	function textFixKey(item: WikiTextFix): string {
		return `text:${item.entryId}:${item.field}:${item.originalText}`;
	}

	function markFixed(key: string) {
		fixedKeys = new Set([...fixedKeys, key]);
	}

	async function applyMissing(entry: WikiMissingEntry) {
		if (!onCreateMissingEntry) return;
		const key = missingKey(entry);
		if (fixedKeys.has(key)) return;
		fixing = true;
		fixError = null;
		try {
			await onCreateMissingEntry(entry);
			markFixed(key);
		} catch (e) {
			fixError = e instanceof Error ? e.message : String(e);
		} finally {
			fixing = false;
		}
	}

	async function applyTextFix(fix: WikiTextFix) {
		if (!onApplyTextFix) return;
		const key = textFixKey(fix);
		if (fixedKeys.has(key)) return;
		fixing = true;
		fixError = null;
		try {
			await onApplyTextFix(fix);
			markFixed(key);
		} catch (e) {
			fixError = e instanceof Error ? e.message : String(e);
		} finally {
			fixing = false;
		}
	}

	async function applySafeFixes() {
		if (!result || fixing) return;
		fixing = true;
		fixError = null;
		try {
			if (onCreateMissingEntry) {
				for (const entry of result.missingEntries) {
					const key = missingKey(entry);
					if (fixedKeys.has(key)) continue;
					await onCreateMissingEntry(entry);
					markFixed(key);
				}
			}
			if (onApplyTextFix) {
				for (const fix of result.textFixes) {
					if (!fix.safeToAutoApply) continue;
					const key = textFixKey(fix);
					if (fixedKeys.has(key)) continue;
					await onApplyTextFix(fix);
					markFixed(key);
				}
			}
		} catch (e) {
			fixError = e instanceof Error ? e.message : String(e);
		} finally {
			fixing = false;
		}
	}
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
					<span class="text-xs text-[var(--text-muted)]">Â· {result.coverage.entryCount} entries audited</span>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				{#if result && safeFixCount > 0}
					<button
						onclick={applySafeFixes}
						disabled={fixing}
						class="flex items-center gap-1.5 rounded-lg bg-[rgba(212,168,83,0.12)] px-3 py-1.5 text-xs text-[var(--text-accent)] hover:bg-[rgba(212,168,83,0.2)] disabled:opacity-50"
						title="Apply safe missing-entry and text fixes"
					>
						{#if fixing}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Wand2 class="h-3.5 w-3.5" />{/if}
						Fix Safe
					</button>
				{/if}
				<button onclick={onClose} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Close">
					<X class="h-4 w-4" />
				</button>
			</div>
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
				<div class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-[10px] leading-relaxed text-[var(--text-muted)]">
					All entries included: {result.coverage.allEntriesIncluded ? 'yes' : 'no'} -
					Entries: {result.coverage.entryCount} - Relationships: {result.coverage.relationshipCount} - Chapters: {result.coverage.chapterCount}
				</div>

				{#if fixError}
					<div class="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
						{fixError}
					</div>
				{/if}

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
								{@const key = missingKey(m)}
								<li class="rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs">
									<div class="flex items-start justify-between gap-2">
										<div class="min-w-0">
											<div class="flex items-baseline gap-2">
												<span class="font-semibold text-[var(--text-primary)]">{m.suggestedName}</span>
												<span class="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] capitalize text-[var(--text-muted)]">{m.suggestedType}</span>
											</div>
											<p class="mt-0.5 text-[var(--text-muted)] leading-relaxed">{m.reason}</p>
											<p class="mt-0.5 text-[10px] text-cyan-300/80">mentioned in: {m.mentionedIn}</p>
										</div>
										{#if onCreateMissingEntry}
											<button
												onclick={() => applyMissing(m)}
												disabled={fixing || fixedKeys.has(key)}
												class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-60"
												title="Create suggested wiki entry"
											>
												{#if fixedKeys.has(key)}<Check class="h-3 w-3" /> Added{:else}<Plus class="h-3 w-3" /> Add{/if}
											</button>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if result.textFixes.length > 0}
					<section>
						<h4 class="mb-2 flex items-center gap-1.5 font-display text-xs uppercase tracking-wider text-emerald-400">
							<Wand2 class="h-3.5 w-3.5" /> Safe Text Fixes ({result.textFixes.length})
						</h4>
						<ul class="space-y-1.5">
							{#each result.textFixes as fix}
								{@const key = textFixKey(fix)}
								<li class="rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs">
									<div class="flex items-start justify-between gap-2">
										<div class="min-w-0">
											<div class="flex items-baseline gap-2">
												<span class="font-semibold text-[var(--text-primary)]">{fix.entryName}</span>
												<span class="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{fix.field}</span>
												{#if !fix.safeToAutoApply}
													<span class="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">review</span>
												{/if}
											</div>
											<p class="mt-1 text-[var(--text-muted)] leading-relaxed">{fix.reason}</p>
											<div class="mt-1 grid gap-1 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-2 font-mono text-[10px]">
												<div class="text-rose-300/80">- {fix.originalText}</div>
												<div class="text-emerald-300/80">+ {fix.correctedText}</div>
											</div>
										</div>
										{#if onApplyTextFix && fix.safeToAutoApply}
											<button
												onclick={() => applyTextFix(fix)}
												disabled={fixing || fixedKeys.has(key)}
												class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-60"
												title="Apply exact text replacement"
											>
												{#if fixedKeys.has(key)}<Check class="h-3 w-3" /> Fixed{:else}<Wand2 class="h-3 w-3" /> Apply{/if}
											</button>
										{/if}
									</div>
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
