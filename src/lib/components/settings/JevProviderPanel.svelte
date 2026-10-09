<script lang="ts">
	import { onMount } from 'svelte';
	import { decisionModel, decisionModels, isDecisionModel, modelForDecisionProvider } from '$lib/contracts/decisionModels';
	import { settings } from '$lib/stores/settings.svelte';
	import { patchTerminalLlmSettings, refreshTerminalLlmSettings } from '$lib/services/terminalSettings';
	let enabled = $state(false);
	let provider = $state<'openrouter' | 'nanogpt' | 'openai-compatible'>('openrouter');
	let model = $state('typesafe/jev-1.13');
	let localUrl = $state('http://127.0.0.1:8008/v1');
	let keyRef = $state('env:OPENROUTER_API_KEY');
	let apiKey = $state('');
	let busy = $state(true);
	let message = $state('');
	let failed = $state(false);
	const availableModels = $derived(decisionModels(provider));
	const contextWindowTokens = $derived(decisionModel(provider, model)?.contextWindowTokens ?? 32000);
	const defaultKeyRef = (selected: 'openrouter' | 'nanogpt' | 'openai-compatible') => selected === 'openai-compatible' ? '' : selected === 'nanogpt' ? 'env:NANOGPT_API_KEY' : 'env:OPENROUTER_API_KEY';
	function selectProvider(selected: 'openrouter' | 'nanogpt' | 'openai-compatible') {
		provider = selected;
		model = modelForDecisionProvider(selected, model);
		keyRef = settings.profiles.find(p => p.providerType === selected)?.terminalApiKeyRef || defaultKeyRef(selected);
		apiKey = '';
	}
	onMount(() => {
		void refreshTerminalLlmSettings().then(() => {
			const config = settings.getServiceConfig('actorDecision');
			const profile = settings.getServiceProfile('actorDecision');
			const usesJev = isDecisionModel(config.model);
			enabled = usesJev && config.enabled;
			if (profile?.providerType === 'openrouter' || profile?.providerType === 'nanogpt' || (profile?.providerType === 'openai-compatible' && config.model === 'kev-latest')) provider = profile.providerType;
			if (usesJev) model = config.model === 'kev-latest' ? 'kev-latest' : config.model.includes('jev-latest') ? provider === 'nanogpt' ? 'typesafe/jev-latest' : '~typesafe/jev-latest' : config.model;
			if (provider === 'openai-compatible' && profile?.baseUrl) localUrl = profile.baseUrl;
			const selectedProfile = profile?.providerType === provider ? profile : settings.profiles.find(p => p.providerType === provider);
			keyRef = selectedProfile?.terminalApiKeyRef || defaultKeyRef(provider);
		}).catch(error => { failed = true; message = String(error); }).finally(() => busy = false);
	});
	async function save() {
		busy = true; message = ''; failed = false;
		try {
			await patchTerminalLlmSettings([{ serviceId: 'actorDecision', providerType: provider,
				baseUrl: provider === 'openai-compatible' ? localUrl.trim() : provider === 'nanogpt' ? 'https://nano-gpt.com/api/v1' : 'https://openrouter.ai/api/v1', model, enabled, apiKeyRef: provider === 'openai-compatible' ? null : keyRef.trim(),
				reasoningEffort: 'off', contextWindowTokens }],
				provider !== 'openai-compatible' && apiKey.trim() ? [{ ref: keyRef.trim(), value: apiKey.trim() }] : []);
			apiKey = '';
			await refreshTerminalLlmSettings();
			message = enabled ? 'Decision model enabled and saved on the server.' : 'Decision model disabled and saved on the server.';
		} catch (error) { failed = true; message = String(error); }
		finally { busy = false; }
	}
</script>

<section class="space-y-3 rounded-lg border border-[var(--border-primary)] p-4" aria-labelledby="jev-heading">
	<h3 id="jev-heading" class="font-display text-sm text-[var(--text-primary)]">World decisions</h3>
	<p class="text-xs text-[var(--text-muted)]">Uses evidence-bound NPC reactions, faction moves, and off-screen NPC preparation. GameMaster writes the story; uncertain decisions use the existing fallback or wait. Saving configures the Actor Decisions tool.</p>
	{#if provider === 'openrouter' && model.includes('typesafe/jev-')}<p class="text-xs text-[var(--text-muted)]">TypeSafe must be allowed in your <a href="https://openrouter.ai/settings/privacy" target="_blank" rel="noreferrer" class="underline">OpenRouter provider settings</a>. Background moves run through the server job worker when it is enabled.</p>{/if}
	<label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={enabled} disabled={busy} /> Enable world decisions</label>
	<label class="block text-xs">Decision provider
		<select aria-label="Decision provider" value={provider} onchange={(event) => selectProvider(event.currentTarget.value as 'openrouter' | 'nanogpt' | 'openai-compatible')} disabled={busy} class="mt-1 w-full rounded bg-[var(--bg-tertiary)] p-2">
			<option value="openrouter">OpenRouter</option>
			<option value="nanogpt">NanoGPT</option>
			<option value="openai-compatible">Local Kev</option>
		</select>
	</label>
	<label class="block text-xs">Decision model
		<select aria-label="Decision model" bind:value={model} disabled={busy} class="mt-1 w-full rounded bg-[var(--bg-tertiary)] p-2">
			{#if !availableModels.some(candidate => candidate.id === model)}<option value={model}>{model} (saved)</option>{/if}
			{#each availableModels as candidate}<option value={candidate.id}>{candidate.name}</option>{/each}
		</select>
	</label>
	{#if contextWindowTokens < 32000}<p class="text-xs text-[var(--text-muted)]">This provider limits the selected model to {contextWindowTokens.toLocaleString()} tokens. Decisions with more evidence use the existing fallback.</p>{/if}
	{#if provider === 'openai-compatible'}
		<label class="block text-xs">Local Kev endpoint<input aria-label="Local Kev endpoint" bind:value={localUrl} disabled={busy} class="mt-1 w-full rounded bg-[var(--bg-tertiary)] p-2" /></label>
	{:else}
	<label class="block text-xs">Server key reference
		<input aria-label="Jev server key reference" bind:value={keyRef} disabled={busy} class="mt-1 w-full rounded bg-[var(--bg-tertiary)] p-2" />
	</label>
	<label class="block text-xs">{provider === 'nanogpt' ? 'NanoGPT' : 'OpenRouter'} API key (optional replacement)
		<input aria-label="Jev {provider === 'nanogpt' ? 'NanoGPT' : 'OpenRouter'} API key" type="password" autocomplete="new-password" bind:value={apiKey} disabled={busy} placeholder="Leave blank to use the saved server key" class="mt-1 w-full rounded bg-[var(--bg-tertiary)] p-2" />
	</label>
	{/if}
	<button type="button" onclick={save} disabled={busy || (provider === 'openai-compatible' ? !localUrl.trim() : !keyRef.trim())} class="rounded bg-[var(--bg-tertiary)] px-3 py-2 text-sm">{busy ? 'Loading…' : 'Save decision settings'}</button>
	{#if message}<p role="status" class:text-red-400={failed} class="text-xs">{message}</p>{/if}
</section>
