<script lang="ts">
	import { onMount } from 'svelte';
	import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
	import { supportsDecisionModel } from '$lib/contracts/decisionModels';
	import type { ModelProfile, ModelRoleDefinition, ModelRoleSetting, ModelTaskDefinition, ModelTaskOverride, ModelTaskProvenance } from '$lib/contracts/modelTasks';
	import { refreshTerminalLlmSettings } from '$lib/services/terminalSettings';

	type View = {
		revision: string;
		profiles: Array<ModelProfile & { apiKeyConfigured: boolean }>;
		roles: Array<ModelRoleDefinition & { setting: ModelRoleSetting | null }>;
		tasks: Array<{ definition: ModelTaskDefinition; override: ModelTaskOverride | null; provenance: ModelTaskProvenance }>;
	};
	type ProfileDraft = Omit<ModelProfile, 'revision' | 'updatedAt'>;

	let view = $state<View | null>(null);
	let error = $state('');
	let status = $state('');
	let saving = $state(false);
	let editingProfile = $state<ProfileDraft | null>(null);
	let showTasks = $state(false);

	const providerIds = Object.keys(PROVIDERS);

	async function command(name: string, args: Record<string, unknown> = {}): Promise<View> {
		const response = await fetch('/api/engine/command', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ storyId: '__app__', command: name, args }),
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok || body.status !== 'succeeded') throw new Error(body.error ?? `HTTP ${response.status}`);
		return body.result as View;
	}

	async function load() {
		try { view = await command('settings.models.get'); error = ''; } catch (caught) { error = String(caught instanceof Error ? caught.message : caught); }
	}

	async function save(change: Record<string, unknown>, message: string) {
		if (!view) return;
		saving = true; error = ''; status = '';
		try {
			view = await command('settings.models.save', { expectedRevision: view.revision, ...change });
			status = message;
			// Browser-run tools read the server's effective settings; inherited tasks stay inherited.
			await refreshTerminalLlmSettings().catch(() => {});
		} catch (caught) {
			error = String(caught instanceof Error ? caught.message : caught);
			if (/changed since they were loaded/.test(error)) await load();
		} finally { saving = false; }
	}

	function profileLabel(profile: { name: string; model: string; providerType: string }) {
		return profile.name === profile.model ? `${profile.model} (${profile.providerType})` : `${profile.name}`;
	}

	function roleTasks(roleId: string) { return view?.tasks.filter(task => task.definition.role === roleId) ?? []; }

	function assignRole(role: ModelRoleDefinition & { setting: ModelRoleSetting | null }, profileId: string) {
		void save({ roles: [{ role: role.id, profileId: profileId || null, fallbackProfileIds: role.setting?.fallbackProfileIds ?? [], metadata: role.setting?.metadata ?? {} }] },
			`${role.label} now uses ${profileId ? view?.profiles.find(p => p.id === profileId)?.name : 'no saved profile'}.`);
	}

	function taskOverride(task: View['tasks'][number], change: Partial<ModelTaskOverride>) {
		const current = task.override ?? { taskId: task.definition.id, profileId: null, enabled: null, parameters: {}, systemPromptOverride: null, fallbackProfileIds: [], budget: {}, metadata: {} };
		const { revision: _revision, updatedAt: _updatedAt, ...base } = current as ModelTaskOverride;
		void save({ tasks: [{ ...base, ...change }] }, `${task.definition.label} saved.`);
	}

	function setEnabled(task: View['tasks'][number], enabled: boolean) {
		// Matching the shared default stores no override, so a later default change still applies.
		taskOverride(task, { enabled: enabled === task.definition.defaultEnabled ? null : enabled });
	}

	function newProfile(): ProfileDraft {
		const providerType = providerIds.includes('openrouter') ? 'openrouter' : providerIds[0];
		return { id: `profile_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, name: 'New profile', providerType,
			baseUrl: PROVIDERS[providerType as keyof typeof PROVIDERS]?.baseUrl || null, apiKeyRef: null, model: '', contextWindowTokens: null,
			capabilities: {}, generation: {}, metadata: { source: 'settings_ui' } };
	}

	function editProfile(profile: ModelProfile) {
		const { revision: _revision, updatedAt: _updatedAt, ...draft } = profile as ModelProfile & { apiKeyConfigured?: boolean };
		delete (draft as { apiKeyConfigured?: boolean }).apiKeyConfigured;
		editingProfile = $state.snapshot(draft) as ProfileDraft;
	}

	function saveProfile() {
		if (!editingProfile?.model.trim()) { error = 'A profile needs a model.'; return; }
		const draft = $state.snapshot(editingProfile);
		editingProfile = null;
		void save({ profiles: [draft] }, `Profile "${draft.name}" saved. Roles and tasks that use it now follow it.`);
	}

	function decisionsUsable(profileId: string | null | undefined): boolean {
		const profile = view?.profiles.find(p => p.id === profileId);
		return Boolean(profile && supportsDecisionModel(profile.providerType, profile.model));
	}

	const sourceLabel: Record<string, string> = { task_override: 'override', role: 'inherits role', environment: 'environment default', none: 'not configured' };

	onMount(load);
</script>

<section class="space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4" aria-labelledby="model-roles-title">
	<div class="flex items-start justify-between gap-3">
		<div>
			<h4 id="model-roles-title" class="text-sm font-semibold text-[var(--text-primary)]">Model roles</h4>
			<p class="text-[11px] text-[var(--text-muted)]">Tasks inherit their role's profile unless you override them. Decisions only runs when enabled with a supported decision model.</p>
		</div>
		<button class="min-h-9 rounded-lg border border-[var(--border-secondary)] px-3 text-xs text-[var(--text-accent)]" onclick={() => editingProfile = newProfile()}>Add profile</button>
	</div>

	{#if error}<p role="alert" class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>{/if}
	{#if status}<p class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs text-[var(--text-accent)]">{status}</p>{/if}

	{#if !view}
		<p class="text-xs text-[var(--text-muted)]">Loading model settings…</p>
	{:else}
		<div class="grid gap-3 sm:grid-cols-2">
			{#each view.roles.filter(role => role.primary) as role (role.id)}
				{@const profileId = role.setting?.profileId ?? ''}
				{@const primaryTask = view.tasks.find(task => task.definition.id === role.primaryTaskId)}
				<div class="space-y-2 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)]/40 p-3">
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm font-semibold text-[var(--text-primary)]">{role.label}</span>
						{#if primaryTask}
							<span class="rounded px-1.5 py-0.5 text-[9px] {primaryTask.provenance.status === 'ready' ? 'bg-emerald-500/10 text-emerald-300' : primaryTask.provenance.status === 'disabled' ? 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]' : 'bg-amber-500/10 text-amber-300'}">{primaryTask.provenance.status.replace('_', ' ')}</span>
						{/if}
					</div>
					<p class="text-[10px] text-[var(--text-muted)]">{role.description}</p>
					<label class="block space-y-1">
						<span class="text-[10px] text-[var(--text-muted)]">Profile</span>
						<select class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
							value={profileId} disabled={saving} onchange={(event) => assignRole(role, (event.target as HTMLSelectElement).value)}>
							<option value="">{role.requiresExplicitProfile ? 'None' : 'Environment default'}</option>
							{#each view.profiles as profile (profile.id)}
								<option value={profile.id} disabled={role.id === 'decisions' && !supportsDecisionModel(profile.providerType, profile.model)}>{profileLabel(profile)}</option>
							{/each}
						</select>
					</label>
					{#if primaryTask?.provenance.model}
						<p class="font-mono text-[10px] text-[var(--text-secondary)]">{primaryTask.provenance.providerType} · {primaryTask.provenance.model}{primaryTask.provenance.limits.contextWindowTokens ? ` · ${primaryTask.provenance.limits.contextWindowTokens.toLocaleString()} ctx` : ''}</p>
					{/if}
					{#if primaryTask?.provenance.reason && primaryTask.provenance.status !== 'disabled'}<p class="text-[10px] text-amber-300">{primaryTask.provenance.reason}</p>{/if}
					{#if role.id === 'decisions' && primaryTask}
						<label class="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
							<input type="checkbox" checked={primaryTask.provenance.enabled} disabled={saving || (!primaryTask.provenance.enabled && !decisionsUsable(profileId))}
								onchange={(event) => setEnabled(primaryTask, (event.target as HTMLInputElement).checked)} />
							Use Decisions for NPC and faction choices
						</label>
						<label class="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
							<input type="checkbox" checked={primaryTask.override?.metadata?.decisionMode === 'psychology_then_action'} disabled={saving}
								onchange={(event) => taskOverride(primaryTask, { metadata: { ...(primaryTask.override?.metadata ?? {}),
									decisionMode: (event.target as HTMLInputElement).checked ? 'psychology_then_action' : 'action' } })} />
							Evaluate psychology first (two requests per actor; stops after one if unusable)
						</label>
					{/if}
					{#if profileId}
						<button class="text-[10px] text-[var(--text-accent)] underline" onclick={() => { const profile = view?.profiles.find(p => p.id === profileId); if (profile) editProfile(profile); }}>Edit profile (shared by {view.roles.filter(r => r.setting?.profileId === profileId).map(r => r.label).join(', ')})</button>
					{/if}
					<p class="text-[10px] text-[var(--text-muted)]">{roleTasks(role.id).length} tasks · {roleTasks(role.id).filter(task => task.provenance.source === 'task_override').length} overridden</p>
				</div>
			{/each}
		</div>

		{#if editingProfile}
			<div class="space-y-2 rounded-lg border border-[var(--color-gold-600)]/40 bg-[var(--bg-primary)]/40 p-3">
				<p class="text-xs font-semibold text-[var(--text-primary)]">Profile</p>
				<div class="grid gap-2 sm:grid-cols-2">
					<label class="space-y-1 text-[10px] text-[var(--text-muted)]">Name<input class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]" bind:value={editingProfile.name} /></label>
					<label class="space-y-1 text-[10px] text-[var(--text-muted)]">Provider<select class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]" bind:value={editingProfile.providerType}>{#each providerIds as id}<option value={id}>{id}</option>{/each}</select></label>
					<label class="space-y-1 text-[10px] text-[var(--text-muted)]">Model<input class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-xs text-[var(--text-primary)]" bind:value={editingProfile.model} /></label>
					<label class="space-y-1 text-[10px] text-[var(--text-muted)]">Base URL<input class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-xs text-[var(--text-primary)]" value={editingProfile.baseUrl ?? ''} oninput={(event) => editingProfile && (editingProfile.baseUrl = (event.target as HTMLInputElement).value || null)} /></label>
					<label class="space-y-1 text-[10px] text-[var(--text-muted)]">Key reference (env:NAME)<input class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-xs text-[var(--text-primary)]" value={editingProfile.apiKeyRef ?? ''} oninput={(event) => editingProfile && (editingProfile.apiKeyRef = (event.target as HTMLInputElement).value || null)} /></label>
					<label class="space-y-1 text-[10px] text-[var(--text-muted)]">Context window<input type="number" min="1024" class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]" value={editingProfile.contextWindowTokens ?? ''} oninput={(event) => editingProfile && (editingProfile.contextWindowTokens = Number((event.target as HTMLInputElement).value) || null)} /></label>
					<label class="space-y-1 text-[10px] text-[var(--text-muted)]">Reasoning<input class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]" value={editingProfile.generation.reasoningEffort ?? ''} oninput={(event) => editingProfile && (editingProfile.generation = { ...editingProfile.generation, reasoningEffort: (event.target as HTMLInputElement).value || null })} /></label>
					<label class="space-y-1 text-[10px] text-[var(--text-muted)]">Temperature<input type="number" step="0.05" min="0" max="2" class="w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]" value={editingProfile.generation.temperature ?? ''} oninput={(event) => editingProfile && (editingProfile.generation = { ...editingProfile.generation, temperature: (event.target as HTMLInputElement).value === '' ? null : Number((event.target as HTMLInputElement).value) })} /></label>
				</div>
				<div class="flex gap-2">
					<button class="min-h-9 rounded-lg bg-[var(--color-gold-600)] px-3 text-xs font-semibold text-black" disabled={saving} onclick={saveProfile}>Save profile</button>
					<button class="min-h-9 rounded-lg border border-[var(--border-secondary)] px-3 text-xs text-[var(--text-secondary)]" onclick={() => editingProfile = null}>Cancel</button>
				</div>
			</div>
		{/if}

		<button class="text-xs text-[var(--text-accent)] underline" onclick={() => showTasks = !showTasks}>{showTasks ? 'Hide' : 'Show'} task overrides ({view.tasks.length} tasks)</button>
		{#if showTasks}
			<div class="overflow-x-auto">
				<table class="w-full min-w-[640px] text-left text-[11px]">
					<thead class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]"><tr><th class="py-1 pr-2">Task</th><th class="pr-2">Model</th><th class="pr-2">Source</th><th class="pr-2">Profile</th><th>On</th></tr></thead>
					<tbody>
						{#each view.tasks as task (task.definition.id)}
							<tr class="border-t border-[var(--border-primary)] align-top">
								<td class="py-1.5 pr-2"><span class="text-[var(--text-primary)]">{task.definition.label}</span><br /><span class="text-[10px] text-[var(--text-muted)]">{view.roles.find(role => role.id === task.definition.role)?.label} · {task.definition.trigger.replaceAll('_', ' ')}</span>
									{#if task.provenance.reason && task.provenance.status === 'needs_configuration'}<br /><span class="text-[10px] text-amber-300">{task.provenance.reason}</span>{/if}</td>
								<td class="pr-2 font-mono text-[10px] text-[var(--text-secondary)]">{task.provenance.model ?? '—'}{task.provenance.overriddenParameters.length ? ` (${task.provenance.overriddenParameters.join(', ')})` : ''}</td>
								<td class="pr-2 text-[10px] text-[var(--text-muted)]">{sourceLabel[task.provenance.source]}</td>
								<td class="pr-2">
									<select class="rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-1.5 py-1 text-[11px] text-[var(--text-primary)]" value={task.override?.profileId ?? ''} disabled={saving}
										onchange={(event) => taskOverride(task, { profileId: (event.target as HTMLSelectElement).value || null })}>
										<option value="">Inherit role</option>
										{#each view.profiles as profile (profile.id)}<option value={profile.id}>{profileLabel(profile)}</option>{/each}
									</select>
								</td>
								<td><input type="checkbox" aria-label="Enable {task.definition.label}" checked={task.provenance.enabled} disabled={saving} onchange={(event) => setEnabled(task, (event.target as HTMLInputElement).checked)} /></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</section>
