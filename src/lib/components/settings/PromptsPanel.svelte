<script lang="ts">
	import { AlertCircle, Check, RefreshCw, RotateCcw, Save, Search } from 'lucide-svelte';
	import type { LlmServiceSetting } from '$lib/contracts/engine';
	import { SERVICE_DEFINITIONS, settings } from '$lib/stores/settings.svelte';
	import {
		buildPromptOverridePatch,
		loadTerminalPromptSettings,
		normalizePromptOverride,
		promptOverrideDrafts,
		saveTerminalPromptOverrides,
	} from '$lib/services/promptSettings';

	const SERVICE_ORDER = [
		'narrative',
		'classifier',
		'worldSimulation',
		'memory',
		'arcCondensation',
		'sagaCondensation',
		'proceduralMemory',
		'loreManagement',
		'entryRefinement',
		'styleReviewer',
		'suggestions',
		'actionChoices',
		'wikiLint',
		'imageGeneration',
	];

	let rows = $state<LlmServiceSetting[]>([]);
	let drafts = $state<Record<string, string>>({});
	let selectedServiceId = $state('narrative');
	let query = $state('');
	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let status = $state('');
	let initialized = false;

	$effect(() => {
		if (initialized) return;
		initialized = true;
		void reload();
	});

	const orderedRows = $derived.by(() => {
		const order = new Map(SERVICE_ORDER.map((serviceId, index) => [serviceId, index]));
		const q = query.trim().toLowerCase();
		return [...rows]
			.sort((a, b) => (order.get(a.serviceId) ?? 999) - (order.get(b.serviceId) ?? 999) || a.serviceId.localeCompare(b.serviceId))
			.filter((row) => {
				if (!q) return true;
				const label = serviceLabel(row.serviceId).toLowerCase();
				return row.serviceId.toLowerCase().includes(q) || label.includes(q) || (row.model ?? '').toLowerCase().includes(q);
			});
	});

	const selectedRow = $derived.by(() =>
		rows.find((row) => row.serviceId === selectedServiceId) ?? orderedRows[0] ?? null
	);

	const changedRows = $derived.by(() => buildPromptOverridePatch(rows, drafts));

	function serviceLabel(serviceId: string): string {
		return SERVICE_DEFINITIONS[serviceId]?.label ?? serviceId;
	}

	function serviceDescription(serviceId: string): string {
		return SERVICE_DEFINITIONS[serviceId]?.description ?? 'Terminal LLM service';
	}

	function draftFor(serviceId: string): string {
		return drafts[serviceId] ?? '';
	}

	function hasOverride(serviceId: string): boolean {
		return Boolean(normalizePromptOverride(draftFor(serviceId)));
	}

	function setDraft(serviceId: string, value: string): void {
		drafts = { ...drafts, [serviceId]: value };
		status = '';
	}

	async function reload(): Promise<void> {
		loading = true;
		error = '';
		status = '';
		try {
			const nextRows = await loadTerminalPromptSettings();
			rows = nextRows;
			drafts = promptOverrideDrafts(nextRows);
			const narrative = nextRows.find((row) => row.serviceId === 'narrative');
			if (!nextRows.some((row) => row.serviceId === selectedServiceId)) {
				selectedServiceId = narrative?.serviceId ?? nextRows[0]?.serviceId ?? '';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load prompt settings.';
		} finally {
			loading = false;
		}
	}

	async function save(): Promise<void> {
		const patch = changedRows;
		if (patch.length === 0) {
			status = 'No prompt changes to save.';
			return;
		}
		saving = true;
		error = '';
		status = '';
		try {
			const savedRows = await saveTerminalPromptOverrides(rows, drafts);
			const savedByService = new Map(savedRows.map((row) => [row.serviceId, row]));
			rows = rows.map((row) => savedByService.get(row.serviceId) ?? row);
			for (const row of patch) {
				await settings.setServiceConfig(row.serviceId, {
					systemPromptOverride: normalizePromptOverride(drafts[row.serviceId]) ?? '',
				});
			}
			drafts = promptOverrideDrafts(rows);
			status = `Saved ${patch.length} prompt override${patch.length === 1 ? '' : 's'}.`;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save prompt settings.';
		} finally {
			saving = false;
		}
	}
</script>

<div class="grid min-h-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
	<aside class="min-h-0 space-y-3">
		<div class="flex items-center gap-2">
			<div class="relative flex-1">
				<Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
				<input
					type="text"
					bind:value={query}
					placeholder="Search prompts"
					class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] py-2 pl-8 pr-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
				/>
			</div>
			<button
				class="rounded-lg border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-accent)] disabled:opacity-50"
				onclick={reload}
				disabled={loading || saving}
				title="Reload terminal prompts"
			>
				<RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
			</button>
		</div>

		<div class="max-h-[52vh] overflow-y-auto rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)]">
			{#if loading && rows.length === 0}
				<div class="px-3 py-4 text-xs text-[var(--text-muted)]">Loading prompts...</div>
			{:else if orderedRows.length === 0}
				<div class="px-3 py-4 text-xs text-[var(--text-muted)]">No prompt services found.</div>
			{:else}
				{#each orderedRows as row}
					<button
						class="w-full border-b border-[var(--border-secondary)] px-3 py-2.5 text-left last:border-b-0 hover:bg-[rgba(212,168,83,0.06)]
							{selectedRow?.serviceId === row.serviceId ? 'bg-[rgba(212,168,83,0.1)]' : ''}"
						onclick={() => selectedServiceId = row.serviceId}
					>
						<div class="flex items-center justify-between gap-2">
							<span class="truncate text-xs font-medium text-[var(--text-primary)]">{serviceLabel(row.serviceId)}</span>
							<span class="shrink-0 rounded border border-[var(--border-secondary)] px-1.5 py-0.5 text-[9px] {hasOverride(row.serviceId) ? 'text-amber-300' : 'text-emerald-300'}">
								{hasOverride(row.serviceId) ? 'Override' : 'Built-in'}
							</span>
						</div>
						<div class="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]">{row.model ?? 'default model'}</div>
					</button>
				{/each}
			{/if}
		</div>
	</aside>

	<section class="min-h-0 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)]">
		{#if selectedRow}
			<div class="border-b border-[var(--border-primary)] px-4 py-3">
				<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div class="min-w-0">
						<div class="flex flex-wrap items-center gap-2">
							<h4 class="font-display text-sm tracking-wide text-[var(--text-primary)]">{serviceLabel(selectedRow.serviceId)}</h4>
							<span class="rounded border border-[var(--border-secondary)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">{selectedRow.providerType}</span>
							<span class="rounded border border-[var(--border-secondary)] px-2 py-0.5 text-[10px] {hasOverride(selectedRow.serviceId) ? 'text-amber-300' : 'text-emerald-300'}">
								{hasOverride(selectedRow.serviceId) ? 'Full replacement' : 'Built-in prompt'}
							</span>
						</div>
						<div class="mt-1 truncate text-[11px] text-[var(--text-muted)]">{serviceDescription(selectedRow.serviceId)}</div>
						<div class="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]">{selectedRow.model ?? 'default model'}</div>
					</div>
					<div class="flex shrink-0 gap-2">
						<button
							class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)] disabled:opacity-50"
							onclick={() => setDraft(selectedRow.serviceId, '')}
							disabled={saving}
						>
							<RotateCcw class="h-3.5 w-3.5" />
							Use Built-in
						</button>
						<button
							class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-gold-400)]/20 px-3 py-2 text-xs font-semibold text-[var(--text-accent)] hover:bg-[var(--color-gold-400)]/30 disabled:opacity-50"
							onclick={save}
							disabled={saving || changedRows.length === 0}
						>
							<Save class="h-3.5 w-3.5" />
							{saving ? 'Saving...' : `Save ${changedRows.length || ''}`}
						</button>
					</div>
				</div>
			</div>

			<div class="space-y-3 p-4">
				<textarea
					value={draftFor(selectedRow.serviceId)}
					oninput={(e) => setDraft(selectedRow.serviceId, (e.target as HTMLTextAreaElement).value)}
					placeholder="Leave empty to use the built-in terminal prompt."
					class="min-h-[22rem] w-full resize-y rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-3 font-mono text-xs leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
				></textarea>

				<div class="flex flex-wrap items-center justify-between gap-3 text-[10px] text-[var(--text-muted)]">
					<span>{draftFor(selectedRow.serviceId).length.toLocaleString()} chars</span>
					<span>{changedRows.length.toLocaleString()} unsaved</span>
				</div>

				{#if error}
					<div class="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
						<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span>{error}</span>
					</div>
				{/if}

				{#if status}
					<div class="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
						<Check class="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span>{status}</span>
					</div>
				{/if}
			</div>
		{:else}
			<div class="p-4 text-xs {error ? 'text-red-300' : 'text-[var(--text-muted)]'}">{error || 'No prompt service selected.'}</div>
		{/if}
	</section>
</div>
