<script lang="ts">
	import { onMount } from 'svelte';
	import { agentSettingLabels, type AgentSettingKey, type AgentSettingsDocument } from '$lib/contracts/agentTools';
	import type { ProjectImageStyle } from '$lib/contracts/imageStyle';
	import SourceMountSettings from './SourceMountSettings.svelte';

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
	const groups: Array<{ title: string; description: string; keys: AgentSettingKey[] }> = [
		{ title: 'Run your conversations', description: 'Choose how the Assistant runs its tools. GM turns always use the recoverable runtime; saved runs keep their original runtime and selected model.', keys: ['assistantPiRuntime'] },
		{ title: 'At the game table', description: 'Give the GM tools to investigate the world and involve you in the scene.', keys: ['gmResearch', 'gmAdaptiveResearch', 'gmNames', 'gmPlayerRolls', 'gmQuestions'] },
		{ title: 'Your writing Assistant', description: 'Control how the Assistant asks for direction and works on project material.', keys: ['assistantQuestions', 'assistantSubagents'] },
		{ title: 'Illustrate your world', description: 'Chat images and automatic project covers are independent choices.', keys: ['gmImages', 'assistantImages', 'automaticCovers'] },
	];
	const descriptions: Partial<Record<AgentSettingKey, string>> = {
		assistantPiRuntime: 'Saves tool activity so a run can recover after a restart. Off uses the older Assistant runtime.',
		gmResearch: 'Allow research into available story and world sources.',
		gmAdaptiveResearch: 'Extra research for turns sent straight to the server (CLI and scripts). Turns from the story composer already plan their own research.',
		gmNames: 'Let the GM use the name generator.',
		gmPlayerRolls: 'Let the GM request a roll from you. GM dice remain available independently.',
		gmQuestions: 'Let the GM pause and ask you a question before continuing.',
		assistantQuestions: 'Let the Assistant pause for your answer.',
		assistantSubagents: 'Let the Assistant delegate batches of authoring work to helpers.',
		gmImages: 'Allow the GM to request artwork during a conversation.',
		assistantImages: 'Allow the Assistant to request artwork during a conversation.',
		automaticCovers: 'Project-wide cover generation. Change this in Project defaults.',
	};

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

<section class="agent-preferences" aria-label="Agent tool preferences" aria-busy={busy}>
	<div class="scope">
		<label>Project<select bind:value={projectId} onchange={selectProject} disabled={busy}>{#each projects as project}<option value={project.id}>{project.name ?? project.title ?? project.id}</option>{/each}</select></label>
		<label>Game override<select bind:value={gameId} onchange={loadScope} disabled={busy || !projectId}><option value="">Project defaults</option>{#each games as game}<option value={game.id}>{game.title}</option>{/each}</select></label>
	</div>
	<p class="scope-note">{gameId ? 'Editing this game only. Inherited choices follow your project preferences.' : 'Editing defaults for this project. Individual games can override these choices.'}</p>
	{#if view}
		{#each groups as group}
			<fieldset class="preference-group">
				<legend>{group.title}</legend>
				<p class="group-description">{group.description}</p>
				{#each group.keys as setting}
					<label class="setting"><span class="setting-copy"><strong>{agentSettingLabels[setting]}</strong><small id={`agent-setting-hint-${setting}`}>{descriptions[setting]}</small><span class="effective" class:enabled={view.effective[setting]}>Saved: {view.effective[setting] ? 'On' : 'Off'} <span>· {view.sources[setting] === 'default' ? 'shipped default' : view.sources[setting]}</span></span></span>
						<select aria-label={agentSettingLabels[setting]} aria-describedby={`agent-setting-hint-${setting}`} bind:value={choices[setting]} disabled={busy || (!!gameId && setting === 'automaticCovers')}>
							<option value="inherit">{gameId ? 'Use project default' : 'Use shipped default'}</option><option value="true">On</option><option value="false">Off</option>
						</select>
					</label>
				{/each}
			</fieldset>
		{/each}
		<div class="actions"><button class="primary" onclick={save} disabled={busy}>Save tool preferences</button><button onclick={loadScope} disabled={busy}>Reload saved preferences</button></div>
		<p class="save-status" role="status">{busy ? 'Updating preferences…' : message}</p>
		<div class="model-note"><strong>Models are configured separately</strong><p>Assistant: {view.profiles.find(profile => profile.service_id === 'assistant' && profile.enabled)?.model ?? 'Configuration required'}<br />Batch helpers: {view.profiles.find(profile => profile.service_id === 'batchAuthoring' && profile.enabled)?.model ?? 'Configuration required'}</p><small>Choose these models in AI Services. Tool availability also follows those service profiles.</small></div>
		<details class="image-style"><summary>Project image style</summary>
			<label>Project image style instructions <small>Revision {view.imageStyle.revision}. Applies to automatic covers and image tools in this project. Chat image switches and automatic covers remain independent.</small>
				<textarea aria-label="Project image style instructions" bind:value={stylePrompt} maxlength="800" rows="4" disabled={busy}></textarea>
			</label>
			<button onclick={saveStyle} disabled={busy || stylePrompt === view.imageStyle.prompt}>Save project image style</button>
		</details>
		<SourceMountSettings {projectId} />
	{:else if !busy && !projectId && !message}
		<p class="empty-state">Create a project in the Library to set GM and Assistant preferences.</p>
	{/if}
	{#if !view}<p class="save-status" role="status">{busy ? 'Loading preferences…' : message}</p>{/if}
</section>

<style>
	.agent-preferences { display: grid; gap: 1.2rem; padding: 0; }
	p, small { color: var(--text-secondary); line-height: 1.65; }
	.scope { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; padding: 1rem; border: 1px solid var(--border-primary); border-radius: .75rem; background: var(--bg-primary); }
	.scope-note { margin-top: -.5rem; font-size: .78rem; }
	label { display: grid; gap: .5rem; min-width: 0; font-size: .82rem; }
	.preference-group { min-width: 0; padding: 1rem 1.1rem .2rem; border: 1px solid var(--border-primary); border-radius: .75rem; }
	legend { padding: 0 .45rem; font: 1.2rem/1.3 var(--font-display); color: var(--text-primary); }
	.group-description { margin-bottom: .5rem; font-size: .78rem; }
	.setting { display: flex; justify-content: space-between; align-items: center; gap: 1.25rem; padding: 1rem 0; border-bottom: 1px solid var(--border-primary); }
	.setting:last-child { border: 0; }
	.setting-copy { min-width: 0; }
	.setting strong { font-size: .82rem; font-weight: 550; }
	.setting small { margin-top: .25rem; }
	small { display: block; font-size: .75rem; }
	.effective { display: inline-block; margin-top: .5rem; padding: .15rem .45rem; border-radius: .3rem; background: var(--bg-tertiary); color: var(--text-secondary); font-size: .68rem; }
	.effective.enabled { color: var(--text-accent); }
	.effective span { color: var(--text-muted); }
	select, textarea, button { min-height: 42px; padding: .6rem .7rem; border: 1px solid var(--border-primary); border-radius: .5rem; background: var(--bg-primary); color: inherit; font-size: .78rem; }
	select { max-width: 100%; }
	.setting select { flex-shrink: 0; width: 175px; }
	textarea { width: 100%; resize: vertical; margin-bottom: .75rem; }
	button { cursor: pointer; }
	button:hover:not(:disabled) { border-color: var(--text-accent); }
	.primary { background: var(--text-accent); color: var(--bg-primary); font-weight: 600; }
	.actions { display: flex; flex-wrap: wrap; gap: .65rem; }
	.model-note { padding: 1rem; border-left: 2px solid var(--text-accent); background: var(--bg-primary); font-size: .8rem; overflow-wrap: anywhere; }
	.model-note p { margin: .45rem 0; }
	.image-style { padding: 1rem; border: 1px solid var(--border-primary); border-radius: .75rem; }
	summary { cursor: pointer; font-size: .86rem; }
	.image-style[open] summary { margin-bottom: 1rem; }
	.save-status { min-height: 1.4rem; font-size: .8rem; }
	.empty-state { padding: 2rem 1rem; text-align: center; }
	:where(button, select, textarea, summary):focus-visible { outline: 2px solid var(--text-accent); outline-offset: 3px; }
	button:disabled, select:disabled, textarea:disabled { opacity: .5; }
	@media (max-width: 700px) {
		.scope { grid-template-columns: 1fr; }
		.setting { align-items: flex-start; flex-direction: column; gap: .65rem; }
		.setting select { width: 100%; }
		select, textarea { font-size: 16px; }
	}
</style>
