<script lang="ts">
	import { ArrowDown, ArrowUp, Copy, Download, Plus, Save, Trash2, Upload } from 'lucide-svelte';
	import { PROMPT_VARIABLES, REQUIRED_PROMPT_ENGINE_BLOCKS, type PromptPresetDocument, type PromptPresetSection, type PromptPresetSummary, type PromptPresetUse } from '$lib/contracts/promptPresets';

	interface Props { storyId: string | null; storyTitle?: string | null }
	let { storyId, storyTitle = null }: Props = $props();

	type ListResult = { presets: PromptPresetSummary[]; story: { storyId: string; selection: { presetId: string; revision: number } | null; effective: PromptPresetUse | null; newerRevision: boolean } | null };
	type PresetResult = { preset: PromptPresetSummary; revision: number; document: PromptPresetDocument; revisions: Array<{ revision: number; note: string; createdAt: string }> };
	type PreviewSection = { id: string; label: string; source: 'engine' | 'preset'; included: boolean; omittedReason: string | null; tokens: number; text: string };
	type Preview = { sections: PreviewSection[]; totalTokens: number };

	let list = $state<ListResult | null>(null);
	let editing = $state<PresetResult | null>(null);
	let draft = $state<PromptPresetDocument | null>(null);
	let draftName = $state('');
	let preview = $state<Preview | null>(null);
	let error = $state('');
	let status = $state('');
	let busy = $state(false);
	let importInput = $state<HTMLInputElement | null>(null);

	const variableNames = Object.keys(PROMPT_VARIABLES);

	async function command<T>(name: string, args: Record<string, unknown> = {}, scope = '__app__'): Promise<T> {
		const response = await fetch('/api/engine/command', { method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ storyId: scope, command: name, args }) });
		const body = await response.json().catch(() => ({}));
		if (!response.ok || body.status !== 'succeeded') throw new Error(body.error ?? `HTTP ${response.status}`);
		return body.result as T;
	}

	async function run(action: () => Promise<void>, message = '') {
		busy = true; error = ''; status = '';
		try { await action(); status = message; } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); } finally { busy = false; }
	}

	async function loadList() { list = await command<ListResult>('prompts.presets.list', storyId ? { storyId } : {}); }

	async function openPreset(presetId: string, revision?: number) {
		editing = await command<PresetResult>('prompts.presets.get', { presetId, ...(revision ? { revision } : {}) });
		draft = $state.snapshot(editing.document) as PromptPresetDocument;
		draftName = editing.preset.name;
		await refreshPreview();
	}

	async function refreshPreview() {
		if (!draft) return;
		try { preview = await command<Preview>('prompts.presets.preview', { document: $state.snapshot(draft), ...(storyId ? { storyId } : {}) }); }
		catch (caught) { preview = null; error = caught instanceof Error ? caught.message : String(caught); }
	}

	$effect(() => {
		storyId;
		void run(async () => {
			await loadList();
			const current = list?.story?.effective?.presetId ?? list?.presets.find(preset => preset.isDefault)?.id ?? list?.presets[0]?.id;
			if (current) await openPreset(current, list?.story?.effective?.presetId === current ? list?.story?.effective?.revision : undefined);
		});
	});

	function selectForStory(presetId: string | null, revision?: number) {
		if (!storyId) return;
		void run(async () => {
			list = await command<ListResult>('prompts.presets.select', { storyId, presetId, ...(revision ? { revision } : {}) }, storyId);
		}, presetId ? `This story now uses the selected preset revision. Other stories are unchanged.` : 'This story now follows the default preset.');
	}

	function moveSection(index: number, delta: number) {
		if (!draft) return;
		const sections = [...draft.sections];
		const [section] = sections.splice(index, 1);
		sections.splice(Math.max(0, Math.min(sections.length, index + delta)), 0, section);
		draft.sections = sections;
		void refreshPreview();
	}

	function updateSection(index: number, change: Partial<PromptPresetSection>) {
		if (!draft) return;
		draft.sections[index] = { ...draft.sections[index], ...change } as PromptPresetSection;
	}

	function addSection() {
		if (!draft) return;
		const id = `style-${draft.sections.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
		draft.sections = [...draft.sections, { kind: 'text', id, label: 'New style section', template: '', literal: false, enabled: true }];
	}

	function removeSection(index: number) {
		if (!draft) return;
		draft.sections = draft.sections.filter((_, position) => position !== index);
		void refreshPreview();
	}

	function saveRevision() {
		if (!editing || !draft) return;
		const presetId = editing.preset.id;
		void run(async () => {
			editing = await command<PresetResult>('prompts.presets.save', { presetId, expectedRevision: editing!.preset.currentRevision, name: draftName, document: $state.snapshot(draft) });
			draft = $state.snapshot(editing.document) as PromptPresetDocument;
			await loadList();
		}, 'Saved a new revision. Stories keep their current revision until you apply this one.');
	}

	function duplicate() {
		if (!editing) return;
		void run(async () => {
			const copy = await command<PresetResult>('prompts.presets.duplicate', { presetId: editing!.preset.id, revision: editing!.revision, name: `${draftName} (copy)` });
			await loadList();
			await openPreset(copy.preset.id);
		}, 'Duplicated the preset.');
	}

	function makeDefault() {
		if (!editing) return;
		void run(async () => {
			await command('prompts.presets.setDefault', { presetId: editing!.preset.id, revision: editing!.revision });
			await loadList();
		}, 'Stories without their own choice now use this revision.');
	}

	function exportPreset() {
		if (!editing) return;
		void run(async () => {
			const payload = await command<Record<string, unknown>>('prompts.presets.export', { presetId: editing!.preset.id, revision: editing!.revision });
			const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
			const link = Object.assign(document.createElement('a'), { href: url, download: `${editing!.preset.name.replace(/[^\w-]+/g, '-')}-r${editing!.revision}.json` });
			link.click();
			URL.revokeObjectURL(url);
		});
	}

	async function importPreset(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file) return;
		await run(async () => {
			const imported = await command<PresetResult>('prompts.presets.import', JSON.parse(await file.text()));
			await loadList();
			await openPreset(imported.preset.id);
		}, 'Imported the preset.');
		if (importInput) importInput.value = '';
	}

	const effective = $derived(list?.story?.effective ?? null);
	const effectivePreset = $derived(list?.presets.find(preset => preset.id === effective?.presetId) ?? null);
	const defaultPreset = $derived(list?.presets.find(preset => preset.isDefault) ?? null);
	const previewById = $derived(new Map((preview?.sections ?? []).map(section => [section.id, section])));
</script>

<div class="space-y-3">
	<div class="space-y-2 rounded-lg border border-[var(--border-secondary)] px-3 py-2.5 text-xs">
		{#if storyId}
			<p class="text-[var(--text-secondary)]">Narrator preset for <strong>{storyTitle ?? storyId}</strong>:
				{#if effective && effectivePreset}<strong>{effectivePreset.name}</strong> revision {effective.revision} ({effective.source === 'story' ? 'chosen for this story' : 'default'}){:else}built-in{/if}</p>
			{#if list?.story?.newerRevision && effectivePreset}
				<button class="min-h-9 rounded-lg border border-[var(--color-gold-600)]/50 px-3 text-xs text-[var(--text-accent)]" disabled={busy}
					onclick={() => selectForStory(effectivePreset.id, effectivePreset.currentRevision)}>Apply revision {effectivePreset.currentRevision} to this story</button>
			{/if}
			<label class="block space-y-1"><span class="text-[10px] text-[var(--text-muted)]">Use for this story</span>
				<select class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]" disabled={busy}
					value={list?.story?.selection?.presetId ?? ''} onchange={(event) => selectForStory((event.target as HTMLSelectElement).value || null)}>
					<option value="">Follow the default{defaultPreset ? ` (${defaultPreset.name} r${defaultPreset.defaultRevision})` : ''}</option>
					{#each list?.presets ?? [] as preset (preset.id)}<option value={preset.id}>{preset.name} (latest r{preset.currentRevision})</option>{/each}
				</select>
			</label>
		{:else}
			<p class="text-[var(--text-muted)]">Open a story to choose its preset. Stories without a choice use the default{defaultPreset ? `: ${defaultPreset.name} revision ${defaultPreset.defaultRevision}` : ''}.</p>
		{/if}
	</div>

	<div class="flex flex-wrap items-end gap-2">
		<label class="min-w-[12rem] flex-1 space-y-1"><span class="text-[10px] text-[var(--text-muted)]">Edit preset</span>
			<select class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]" disabled={busy}
				value={editing?.preset.id ?? ''} onchange={(event) => void run(() => openPreset((event.target as HTMLSelectElement).value))}>
				{#each list?.presets ?? [] as preset (preset.id)}<option value={preset.id}>{preset.name}{preset.isDefault ? ' — default' : ''}</option>{/each}
			</select>
		</label>
		{#if editing}
			<label class="space-y-1"><span class="text-[10px] text-[var(--text-muted)]">Revision</span>
				<select class="rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)]" disabled={busy}
					value={editing.revision} onchange={(event) => void run(() => openPreset(editing!.preset.id, Number((event.target as HTMLSelectElement).value)))}>
					{#each editing.revisions as revision (revision.revision)}<option value={revision.revision}>r{revision.revision}</option>{/each}
				</select>
			</label>
			<button class="inline-flex min-h-9 items-center gap-1 rounded-lg border border-[var(--border-secondary)] px-2.5 text-xs text-[var(--text-secondary)]" disabled={busy} onclick={duplicate}><Copy class="h-3.5 w-3.5" />Duplicate</button>
			<button class="inline-flex min-h-9 items-center gap-1 rounded-lg border border-[var(--border-secondary)] px-2.5 text-xs text-[var(--text-secondary)]" disabled={busy} onclick={exportPreset}><Download class="h-3.5 w-3.5" />Export</button>
		{/if}
		<button class="inline-flex min-h-9 items-center gap-1 rounded-lg border border-[var(--border-secondary)] px-2.5 text-xs text-[var(--text-secondary)]" disabled={busy} onclick={() => importInput?.click()}><Upload class="h-3.5 w-3.5" />Import</button>
		<input bind:this={importInput} type="file" accept="application/json" class="hidden" onchange={importPreset} />
	</div>

	{#if error}<p role="alert" class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>{/if}
	{#if status}<p class="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{status}</p>{/if}

	{#if editing && draft}
		<label class="block space-y-1"><span class="text-[10px] text-[var(--text-muted)]">Preset name</span>
			<input class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]" bind:value={draftName} /></label>
		<p class="text-[10px] text-[var(--text-muted)]">Engine rules are locked and always follow current engine contracts. Style sections may use {variableNames.map(name => `{{${name}}}`).join(', ')}; a section built only from empty variables is left out.</p>
		<ol class="space-y-2">
			{#each draft.sections as section, index (section.id)}
				{@const rendered = previewById.get(section.id)}
				{@const locked = section.kind === 'engine' && REQUIRED_PROMPT_ENGINE_BLOCKS.includes(section.engineBlock)}
				<li class="space-y-1.5 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)]/40 p-2.5">
					<div class="flex flex-wrap items-center gap-2 text-xs">
						<input type="checkbox" aria-label="Include {section.label}" checked={section.enabled} disabled={busy || locked}
							onchange={(event) => { updateSection(index, { enabled: (event.target as HTMLInputElement).checked }); void refreshPreview(); }} />
						<span class="font-medium text-[var(--text-primary)]">{section.label}</span>
						<span class="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">{section.kind === 'engine' ? (locked ? 'engine · required' : 'engine') : section.kind === 'text' && section.literal ? 'text · literal' : 'style'}</span>
						<span class="ml-auto text-[10px] text-[var(--text-muted)]">{rendered ? (rendered.included ? `${rendered.tokens} tokens` : `omitted (${rendered.omittedReason})`) : ''}</span>
						<button class="p-1 text-[var(--text-muted)]" aria-label="Move {section.label} up" disabled={busy || index === 0} onclick={() => moveSection(index, -1)}><ArrowUp class="h-3.5 w-3.5" /></button>
						<button class="p-1 text-[var(--text-muted)]" aria-label="Move {section.label} down" disabled={busy || index === draft.sections.length - 1} onclick={() => moveSection(index, 1)}><ArrowDown class="h-3.5 w-3.5" /></button>
						{#if section.kind === 'text'}<button class="p-1 text-[var(--text-muted)]" aria-label="Remove {section.label}" disabled={busy} onclick={() => removeSection(index)}><Trash2 class="h-3.5 w-3.5" /></button>{/if}
					</div>
					{#if section.kind === 'text'}
						<textarea class="min-h-[4.5rem] w-full resize-y rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-primary)]"
							value={section.template} spellcheck={false} disabled={busy}
							oninput={(event) => updateSection(index, { template: (event.target as HTMLTextAreaElement).value })} onchange={() => void refreshPreview()}></textarea>
					{:else if rendered?.text}
						<details><summary class="cursor-pointer text-[10px] text-[var(--text-muted)]">Show engine text</summary><pre class="whitespace-pre-wrap text-[10px] text-[var(--text-muted)]">{rendered.text}</pre></details>
					{/if}
				</li>
			{/each}
		</ol>
		<div class="flex flex-wrap items-center gap-2">
			<button class="inline-flex min-h-9 items-center gap-1 rounded-lg border border-[var(--border-secondary)] px-2.5 text-xs text-[var(--text-secondary)]" disabled={busy} onclick={addSection}><Plus class="h-3.5 w-3.5" />Add style section</button>
			<button class="inline-flex min-h-9 items-center gap-1 rounded-lg bg-[var(--color-gold-400)]/20 px-3 text-xs font-semibold text-[var(--text-accent)]" disabled={busy} onclick={saveRevision}><Save class="h-3.5 w-3.5" />Save as revision {editing.preset.currentRevision + 1}</button>
			{#if !editing.preset.isDefault || editing.preset.defaultRevision !== editing.revision}
				<button class="min-h-9 rounded-lg border border-[var(--border-secondary)] px-2.5 text-xs text-[var(--text-secondary)]" disabled={busy} onclick={makeDefault}>Make r{editing.revision} the default</button>
			{/if}
			{#if preview}<span class="ml-auto text-[10px] text-[var(--text-muted)]">Rendered: {preview.totalTokens.toLocaleString()} tokens</span>{/if}
		</div>
	{/if}
</div>
