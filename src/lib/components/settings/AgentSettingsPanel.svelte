<script lang="ts">
	import { onMount } from 'svelte';
	import { agentSettingLabels, type AgentSettingKey, type AgentSettingsDocument } from '$lib/contracts/agentTools';
	import type { ProjectImageStyle } from '$lib/contracts/imageStyle';

	type ScopeRow = { id: string; name?: string; title?: string; shelfId?: string };
	type SettingsView = { project: AgentSettingsDocument; game: AgentSettingsDocument | null; imageStyle: ProjectImageStyle; effective: Record<AgentSettingKey, boolean>; sources: Record<AgentSettingKey, string>; profiles: Array<{ service_id: string; model: string | null; enabled: boolean }> };
	let projects = $state<ScopeRow[]>([]);
	let games = $state<ScopeRow[]>([]);
	let projectId = $state('');
	let gameId = $state('');
	let view = $state<SettingsView | null>(null);
	let choices = $state<Partial<Record<AgentSettingKey, string>>>({});
	let stylePrompt = $state('');
	let busy = $state(false);
	let message = $state('');
	let requestNumber = 0;

	async function command(name: string, args: Record<string, unknown> = {}) {
		const response = await fetch('/api/engine/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storyId: '__app__', command: name, args }) });
		const body = await response.json();
		if (!response.ok || body.status !== 'succeeded') throw new Error(body.error ?? 'Unable to load tool settings.');
		return body.result;
	}

	function setView(value: SettingsView) {
		view = value;
		stylePrompt = value.imageStyle.prompt;
		const overrides = (gameId ? value.game : value.project)?.overrides ?? {};
		choices = Object.fromEntries((Object.keys(agentSettingLabels) as AgentSettingKey[]).map(key => [key, overrides[key] === undefined ? 'inherit' : String(overrides[key])]));
	}

	async function loadScope() {
		const request = ++requestNumber;
		busy = true; view = null; message = '';
		try {
			const value = await command('settings.agent.get', { projectId, ...(gameId ? { gameId } : {}) });
			if (request === requestNumber) setView(value);
		} catch (error) { if (request === requestNumber) message = String(error); }
		finally { if (request === requestNumber) busy = false; }
	}

	async function selectProject() {
		gameId = ''; busy = true;
		try { const result = await command('story.list', { shelfId: projectId }); games = result.stories ?? []; await loadScope(); }
		catch (error) { message = String(error); busy = false; }
	}

	onMount(() => {
		void (async () => {
			busy = true;
			try { const result = await command('shelf.list'); projects = result.shelves ?? []; projectId = projects[0]?.id ?? ''; if (projectId) await selectProject(); }
			catch (error) { message = String(error); }
			finally { busy = false; }
		})();
	});

	async function save() {
		if (!view) return;
		const current = gameId ? view.game! : view.project;
		const changes: Record<string, boolean | null> = {};
		for (const key of Object.keys(agentSettingLabels) as AgentSettingKey[]) {
			if (gameId && key === 'automaticCovers') continue;
			const value = choices[key] === 'inherit' ? undefined : choices[key] === 'true';
			if (value !== current.overrides[key]) changes[key] = value ?? null;
		}
		if (!Object.keys(changes).length) { message = 'No preferences changed.'; return; }
		busy = true; message = '';
		try { setView(await command('settings.agent.save', { projectId, ...(gameId ? { gameId } : {}), expectedRevision: current.revision, changes })); message = 'Tool preferences saved.'; }
		catch (error) { message = String(error); }
		finally { busy = false; }
	}

	async function saveStyle() {
		if (!view) return;
		busy = true; message = '';
		try {
			const result = await command('settings.image.save', { projectId, expectedRevision: view.imageStyle.revision, prompt: stylePrompt });
			view = { ...view, imageStyle: result.imageStyle };
			stylePrompt = result.imageStyle.prompt;
			message = 'Project image style saved.';
		} catch (error) { message = String(error); }
		finally { busy = false; }
	}
</script>

<section aria-label="Agent tool preferences">
	<h3>GM and Assistant tools</h3>
	<p>Tool availability follows these saved preferences and the configured service profiles. Adaptive GM research uses the GameMaster model on direct turns only when needed; older Active Recall choices are inherited until you set an override here.</p>
	<div class="scope">
		<label>Project (shelf)<select bind:value={projectId} onchange={selectProject} disabled={busy}>{#each projects as project}<option value={project.id}>{project.name}</option>{/each}</select></label>
		<label>Game override<select bind:value={gameId} onchange={loadScope} disabled={busy || !projectId}><option value="">Project defaults</option>{#each games as game}<option value={game.id}>{game.title}</option>{/each}</select></label>
	</div>
	{#if view}
		{#each Object.entries(agentSettingLabels) as [key, label]}
			{@const setting = key as AgentSettingKey}
			<label class="setting"><span>{label}<small>Resolved: {view.effective[setting] ? 'On' : 'Off'} · {view.sources[setting]}</small></span>
				<select aria-label={label} bind:value={choices[setting]} disabled={busy || (!!gameId && setting === 'automaticCovers')}>
					<option value="inherit">{gameId ? 'Use project default' : 'Use shipped default'}</option><option value="true">On</option><option value="false">Off</option>
				</select>
			</label>
		{/each}
		<p>Automatic covers apply across the project independently of either chat image switch. Player roll requests do not disable GM dice.</p>
		<label>Project image style instructions <small>Revision {view.imageStyle.revision}. Applies to automatic covers and image tools in this project. Edit the shared style here; chat image switches and automatic covers remain independent.</small>
			<textarea aria-label="Project image style instructions" bind:value={stylePrompt} maxlength="800" rows="4" disabled={busy}></textarea>
		</label>
		<button onclick={saveStyle} disabled={busy || stylePrompt === view.imageStyle.prompt}>Save project image style</button>
		<p>Assistant model: {view.profiles.find(profile => profile.service_id === 'assistant' && profile.enabled)?.model ?? 'Configuration required'}. Batch model: {view.profiles.find(profile => profile.service_id === 'batchAuthoring' && profile.enabled)?.model ?? 'Configuration required'}. Configure these separately in AI Services.</p>
		<div class="actions"><button onclick={save} disabled={busy}>Save tool preferences</button><button onclick={loadScope} disabled={busy}>Reload saved preferences</button></div>
	{/if}
	<p role="status">{busy ? 'Loading…' : message}</p>
</section>

<style>
	section { display: grid; gap: 1rem; }
	h3 { font-size: 1.2rem; }
	p, small { color: var(--text-secondary); }
	.scope, .actions { display: flex; flex-wrap: wrap; gap: 1rem; }
	label { display: grid; gap: .4rem; }
	.setting { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .6rem 0; border-bottom: 1px solid var(--border-color); }
	small { display: block; font-size: .8rem; }
	select, textarea, button { padding: .5rem; border: 1px solid var(--border-color); border-radius: .35rem; background: var(--bg-secondary); color: inherit; }
	textarea { width: 100%; resize: vertical; }
	button:disabled, select:disabled, textarea:disabled { opacity: .5; }
</style>
