<script lang="ts">
	import { ChevronDown, ChevronUp, RotateCcw, Save, Trash2, Loader2, Search } from 'lucide-svelte';
	import { settings, SERVICE_DEFINITIONS, SERVICE_PROFILES, type ServiceConfig } from '$lib/stores/settings.svelte';
	import { story } from '$lib/stores/story.svelte';
	import { getProceduralRules, deleteProceduralRule } from '$lib/services/database';
	import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
	import type { APIProfile, ProviderType } from '$lib/types';

	interface Props {
		onBack: () => void;
	}

	let { onBack }: Props = $props();

	let expandedProfile = $state<string | null>(null);
	let expandedService = $state<string | null>(null);
	let editingConfigs = $state<Record<string, ServiceConfig>>({});
	let editingProfileModels = $state<Record<string, string>>({});
	let profileModelSearch = $state<Record<string, string>>({});
	let serviceModelSearch = $state<Record<string, string>>({});
	let saving = $state(false);

	// ── CASS / Procedural Memory state ──
	let cassRuleCount = $state<number | null>(null);
	let cassFlushing = $state(false);
	let cassStatus = $state('');

	async function loadCassRules() {
		if (!story.currentStory) { cassRuleCount = 0; return; }
		const rules = await getProceduralRules(story.currentStory.id);
		cassRuleCount = rules.length;
	}

	async function flushCassRules(filter: 'deprecated' | 'all') {
		if (!story.currentStory) return;
		cassFlushing = true;
		cassStatus = filter === 'all' ? 'Flushing all rules...' : 'Flushing deprecated rules...';
		try {
			const rules = await getProceduralRules(story.currentStory.id);
			const toDelete = filter === 'all' ? rules : rules.filter(r => r.maturity === 'deprecated' || r.effectiveScore < 0.2);
			for (const rule of toDelete) {
				await deleteProceduralRule(rule.id);
			}
			cassStatus = `Flushed ${toDelete.length} rule(s).`;
			cassRuleCount = (cassRuleCount ?? rules.length) - toDelete.length;
		} catch (e) {
			cassStatus = `Failed: ${e instanceof Error ? e.message : String(e)}`;
		}
		cassFlushing = false;
	}

	function getConfig(serviceId: string): ServiceConfig {
		return editingConfigs[serviceId] ?? settings.getServiceConfig(serviceId);
	}

	function getRawConfig(serviceId: string): ServiceConfig {
		const def = SERVICE_DEFINITIONS[serviceId];
		return editingConfigs[serviceId] ?? settings.serviceConfigs[serviceId] ?? {
			model: '',
			temperature: def?.defaultTemp ?? 0.5,
			maxTokens: def?.defaultMaxTokens ?? 4096,
			systemPromptOverride: '',
			enabled: true,
			profileId: '',
		};
	}

	function getProfileModel(profileId: string): string {
		return editingProfileModels[profileId] ?? settings.getProfileModel(profileId);
	}

	function getServiceModelOverride(serviceId: string): string {
		return getRawConfig(serviceId).model ?? '';
	}

	function getServiceProfileId(serviceId: string): string {
		return getRawConfig(serviceId).profileId ?? '';
	}

	function getProfileLabel(profileId: string): string {
		if (!profileId) {
			const active = settings.activeProfile;
			return active ? `Active: ${active.name}` : 'Active provider';
		}
		const profile = settings.profiles.find(p => p.id === profileId);
		return profile ? `${profile.name} (${profile.providerType})` : 'Missing profile';
	}

	function getApiProfile(profileId: string): APIProfile | null {
		if (!profileId) return settings.activeProfile;
		return settings.profiles.find(p => p.id === profileId) ?? null;
	}

	function modelOptionsForProfileProvider(profileId: string): string[] {
		if (profileId === '__mixed__') return [];
		const profile = getApiProfile(profileId);
		const provider = profile ? PROVIDERS[profile.providerType as ProviderType] : settings.activeProvider;
		const hidden = new Set(profile?.hiddenModels ?? []);
		const ordered = [
			...(profile?.favoriteModels ?? []),
			...(profile?.fetchedModels ?? []),
			...(profile?.customModels ?? []),
			...(provider?.fallbackModels ?? []),
		];
		return Array.from(new Set(ordered)).filter(id => id && !hidden.has(id));
	}

	function filterModelOptions(models: string[], query: string): string[] {
		const q = query.trim().toLowerCase();
		if (!q) return models;
		return models.filter(id => id.toLowerCase().includes(q));
	}

	function updateProfileModelSearch(profileId: string, query: string) {
		profileModelSearch = { ...profileModelSearch, [profileId]: query };
	}

	function updateServiceModelSearch(serviceId: string, query: string) {
		serviceModelSearch = { ...serviceModelSearch, [serviceId]: query };
	}

	function getGroupProfileId(profile: { serviceIds: string[] }): string {
		const ids = [...new Set(profile.serviceIds.map(id => getServiceProfileId(id)))];
		return ids.length === 1 ? ids[0] : '__mixed__';
	}

	function updateProfileProvider(profile: { serviceIds: string[] }, profileId: string) {
		if (profileId === '__mixed__') return;
		for (const serviceId of profile.serviceIds) {
			updateConfig(serviceId, { profileId });
		}
	}

	function updateProfileModel(profileId: string, model: string) {
		editingProfileModels = { ...editingProfileModels, [profileId]: model };
	}

	function updateConfig(serviceId: string, updates: Partial<ServiceConfig>) {
		const def = SERVICE_DEFINITIONS[serviceId];
		const existing = editingConfigs[serviceId] ?? settings.serviceConfigs[serviceId] ?? {
			model: '',
			temperature: def?.defaultTemp ?? 0.5,
			maxTokens: def?.defaultMaxTokens ?? 4096,
			systemPromptOverride: '',
			enabled: true,
			profileId: '',
		};
		editingConfigs = { ...editingConfigs, [serviceId]: { ...existing, ...updates } };
	}

	function resetService(serviceId: string) {
		const def = SERVICE_DEFINITIONS[serviceId];
		editingConfigs = {
			...editingConfigs,
			[serviceId]: {
				model: '',
				temperature: def.defaultTemp,
				maxTokens: def.defaultMaxTokens,
				systemPromptOverride: '',
				enabled: true,
				profileId: '',
			},
		};
	}

	function resetProfile(profileId: string) {
		editingProfileModels = { ...editingProfileModels, [profileId]: '' };
		const profile = SERVICE_PROFILES.find(p => p.id === profileId);
		if (profile) {
			for (const serviceId of profile.serviceIds) {
				resetService(serviceId);
			}
		}
	}

	async function saveAll() {
		saving = true;
		// Save profile models
		for (const [profileId, model] of Object.entries(editingProfileModels)) {
			await settings.setProfileModel(profileId, model);
		}
		// Save per-service configs
		for (const [id, config] of Object.entries(editingConfigs)) {
			await settings.setServiceConfig(id, config);
		}
		editingConfigs = {};
		editingProfileModels = {};
		saving = false;
	}

	const hasChanges = $derived(
		Object.keys(editingConfigs).length > 0 || Object.keys(editingProfileModels).length > 0
	);
</script>

<div class="space-y-4">
	<p class="text-xs text-[var(--text-muted)]">
		Services are grouped into profiles. Set one model per profile — all services in that group share it.
		Expand individual services to tune temperature, tokens, or prompt overrides.
	</p>

	<!-- Profile cards -->
	<div class="space-y-3">
		{#each SERVICE_PROFILES as profile}
			{@const isProfileExpanded = expandedProfile === profile.id}
			{@const profileModel = getProfileModel(profile.id)}
			{@const groupProfileId = getGroupProfileId(profile)}
			{@const allDisabled = profile.serviceIds.every(id => !getConfig(id).enabled)}
			{@const profileModelOptions = modelOptionsForProfileProvider(groupProfileId)}
			{@const visibleProfileModels = filterModelOptions(profileModelOptions, profileModelSearch[profile.id] ?? '')}

			<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] overflow-hidden
				{isProfileExpanded ? 'border-[var(--color-gold-600)]/30' : ''}">

				<!-- Profile header -->
				<button class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[rgba(212,168,83,0.02)]"
					onclick={() => expandedProfile = isProfileExpanded ? null : profile.id}>
					<span class="text-lg">{profile.icon}</span>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="text-sm font-semibold text-[var(--text-primary)]">{profile.label}</span>
							{#if allDisabled}
								<span class="rounded bg-red-500/10 px-1.5 py-0.5 text-[9px] text-red-400">OFF</span>
							{/if}
							{#if profileModel}
								<span class="truncate rounded bg-[var(--bg-primary)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-muted)]">{profileModel}</span>
							{:else}
								<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">default</span>
							{/if}
							<span class="truncate rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">
								{groupProfileId === '__mixed__' ? 'mixed providers' : getProfileLabel(groupProfileId)}
							</span>
						</div>
						<p class="text-[10px] text-[var(--text-muted)]">{profile.description}</p>
					</div>
					<div class="flex items-center gap-2">
						<span class="text-[10px] text-[var(--text-muted)]">{profile.serviceIds.length} {profile.serviceIds.length === 1 ? 'service' : 'services'}</span>
						{#if isProfileExpanded}<ChevronUp class="h-3.5 w-3.5 text-[var(--text-muted)]" />{:else}<ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
					</div>
				</button>

				{#if isProfileExpanded}
					<!-- Profile-level model setting -->
					<div class="border-t border-[var(--border-primary)] bg-[var(--bg-primary)]/30 px-4 py-3 space-y-3">
						<div class="space-y-1">
							<label for="profile-provider-{profile.id}" class="text-[10px] text-[var(--text-muted)]">Provider <span class="opacity-50">(shared by services in this profile)</span></label>
							<select
								id="profile-provider-{profile.id}"
								value={groupProfileId}
								onchange={(e) => updateProfileProvider(profile, (e.target as HTMLSelectElement).value)}
								class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"
							>
								{#if groupProfileId === '__mixed__'}
									<option value="__mixed__">Mixed providers</option>
								{/if}
								<option value="">Use active provider</option>
								{#each settings.profiles as apiProfile}
									<option value={apiProfile.id}>{apiProfile.name} ({apiProfile.providerType})</option>
								{/each}
							</select>
						</div>

						<div class="space-y-1">
							<label for="profile-model-{profile.id}" class="text-[10px] text-[var(--text-muted)]">Model <span class="opacity-50">(shared by all services in this profile)</span></label>
							<input id="profile-model-{profile.id}" type="text" value={profileModel} placeholder="Use provider default"
								oninput={(e) => updateProfileModel(profile.id, (e.target as HTMLInputElement).value)}
								class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
							{#if profileModelOptions.length > 0}
								<div class="relative">
									<Search class="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--text-muted)]" />
									<input
										type="search"
										value={profileModelSearch[profile.id] ?? ''}
										placeholder={`Search ${profileModelOptions.length} model${profileModelOptions.length === 1 ? '' : 's'}`}
										oninput={(e) => updateProfileModelSearch(profile.id, (e.target as HTMLInputElement).value)}
										class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] py-1.5 pl-7 pr-2.5 font-mono text-[10px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
									/>
								</div>
								<div class="max-h-32 overflow-y-auto rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)]/60 p-1.5">
									{#if visibleProfileModels.length > 0}
										<div class="flex flex-wrap gap-1">
											{#each visibleProfileModels as fm}
												<button
													class="max-w-full truncate rounded border border-[var(--border-secondary)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]
														{profileModel === fm ? 'border-[var(--color-gold-600)] text-[var(--text-accent)]' : ''}"
													onclick={() => updateProfileModel(profile.id, fm)}
													title={fm}
												>{fm}</button>
											{/each}
										</div>
									{:else}
										<p class="px-1 py-1.5 text-[10px] text-[var(--text-muted)]">No models match that search.</p>
									{/if}
								</div>
							{/if}
						</div>

						<!-- Reset profile -->
						<button class="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-accent)]"
							onclick={() => resetProfile(profile.id)}>
							<RotateCcw class="h-3 w-3" /> Reset profile
						</button>
					</div>

					<!-- Individual services -->
					<div class="divide-y divide-[var(--border-primary)]">
						{#each profile.serviceIds as serviceId}
							{@const def = SERVICE_DEFINITIONS[serviceId]}
							{@const config = getConfig(serviceId)}
							{@const isServiceExpanded = expandedService === serviceId}
							{@const serviceModelOptions = modelOptionsForProfileProvider(getServiceProfileId(serviceId))}
							{@const visibleServiceModels = filterModelOptions(serviceModelOptions, serviceModelSearch[serviceId] ?? '')}

							<div>
								<button class="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[rgba(212,168,83,0.02)]"
									onclick={() => expandedService = isServiceExpanded ? null : serviceId}>
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2">
											<span class="text-xs text-[var(--text-primary)]">{def.label}</span>
											{#if !config.enabled}
												<span class="rounded bg-red-500/10 px-1 py-0.5 text-[9px] text-red-400">OFF</span>
											{/if}
											<span class="truncate rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[9px] text-[var(--text-muted)]">
												{getProfileLabel(config.profileId)}
											</span>
										</div>
										<p class="text-[10px] text-[var(--text-muted)]">{def.description}</p>
									</div>
									{#if isServiceExpanded}<ChevronUp class="h-3 w-3 text-[var(--text-muted)]" />{:else}<ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />{/if}
								</button>

								{#if isServiceExpanded}
									<div class="space-y-3 border-t border-[var(--border-primary)]/50 bg-[var(--bg-primary)]/20 px-4 py-3">
										<!-- Enabled -->
										<label class="flex items-center justify-between">
											<span class="text-xs text-[var(--text-primary)]">Enabled</span>
											<input type="checkbox" checked={config.enabled}
												onchange={(e) => updateConfig(serviceId, { enabled: (e.target as HTMLInputElement).checked })}
												class="h-4 w-4 accent-[var(--color-gold-400)]" />
										</label>

										<!-- Provider -->
										<div class="space-y-1">
											<label for="service-provider-{serviceId}" class="text-[10px] text-[var(--text-muted)]">Provider</label>
											<select
												id="service-provider-{serviceId}"
												value={getServiceProfileId(serviceId)}
												onchange={(e) => updateConfig(serviceId, { profileId: (e.target as HTMLSelectElement).value })}
												class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"
											>
												<option value="">Use active provider</option>
												{#each settings.profiles as apiProfile}
													<option value={apiProfile.id}>{apiProfile.name} ({apiProfile.providerType})</option>
												{/each}
											</select>
										</div>

										<!-- Model Override -->
										<div class="space-y-1">
											<label for="service-model-{serviceId}" class="text-[10px] text-[var(--text-muted)]">Model Override</label>
											<input
												id="service-model-{serviceId}"
												type="text"
												value={getServiceModelOverride(serviceId)}
												placeholder={profileModel ? `Use profile model: ${profileModel}` : 'Use provider default'}
												oninput={(e) => updateConfig(serviceId, { model: (e.target as HTMLInputElement).value })}
												class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
											/>
											{#if serviceModelOptions.length > 0}
												<div class="relative">
													<Search class="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--text-muted)]" />
													<input
														type="search"
														value={serviceModelSearch[serviceId] ?? ''}
														placeholder={`Search ${serviceModelOptions.length} model${serviceModelOptions.length === 1 ? '' : 's'}`}
														oninput={(e) => updateServiceModelSearch(serviceId, (e.target as HTMLInputElement).value)}
														class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] py-1.5 pl-7 pr-2.5 font-mono text-[10px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
													/>
												</div>
												<div class="max-h-32 overflow-y-auto rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)]/60 p-1.5">
													{#if visibleServiceModels.length > 0}
														<div class="flex flex-wrap gap-1">
															{#each visibleServiceModels as fm}
																<button
																	class="max-w-full truncate rounded border border-[var(--border-secondary)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]
																		{getServiceModelOverride(serviceId) === fm ? 'border-[var(--color-gold-600)] text-[var(--text-accent)]' : ''}"
																	onclick={() => updateConfig(serviceId, { model: fm })}
																	title={fm}
																>{fm}</button>
															{/each}
														</div>
													{:else}
														<p class="px-1 py-1.5 text-[10px] text-[var(--text-muted)]">No models match that search.</p>
													{/if}
												</div>
											{/if}
										</div>

										<!-- Temperature -->
										<div class="space-y-1">
											<div class="flex items-center justify-between">
												<label for="service-temperature-{serviceId}" class="text-[10px] text-[var(--text-muted)]">Temperature</label>
												<span class="font-mono text-[10px] text-[var(--text-primary)]">{config.temperature.toFixed(1)}</span>
											</div>
											<input id="service-temperature-{serviceId}" type="range" min="0" max="2" step="0.1" value={config.temperature}
												oninput={(e) => updateConfig(serviceId, { temperature: parseFloat((e.target as HTMLInputElement).value) })}
												class="w-full accent-[var(--color-gold-400)]" />
										</div>

										<!-- Max Tokens -->
										<div class="space-y-1">
											<label for="service-max-tokens-{serviceId}" class="text-[10px] text-[var(--text-muted)]">Max Tokens</label>
											<input id="service-max-tokens-{serviceId}" type="number" value={config.maxTokens} min="256" max="65536" step="256"
												oninput={(e) => updateConfig(serviceId, { maxTokens: parseInt((e.target as HTMLInputElement).value) || 4096 })}
												class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
										</div>

										<!-- System Prompt Override -->
										<div class="space-y-1">
											<label for="service-prompt-{serviceId}" class="text-[10px] text-[var(--text-muted)]">System Prompt Override</label>
											<textarea id="service-prompt-{serviceId}" value={config.systemPromptOverride}
												oninput={(e) => updateConfig(serviceId, { systemPromptOverride: (e.target as HTMLTextAreaElement).value })}
												placeholder="Leave empty for built-in prompt..."
												rows="3"
												class="w-full resize-none rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
										</div>

										<!-- Reset service -->
										<button class="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-accent)]"
											onclick={() => resetService(serviceId)}>
											<RotateCcw class="h-3 w-3" /> Reset
										</button>

										<!-- ── CASS / Procedural Memory extras ── -->
										{#if serviceId === 'proceduralMemory'}
											<div class="border-t border-[var(--border-primary)]/50 pt-3 space-y-2">
												<span class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Rule Management</span>
												{#if cassRuleCount === null}
													<button class="text-xs text-[var(--text-accent)] hover:underline" onclick={loadCassRules}>Load rule count</button>
												{:else}
													<p class="text-xs text-[var(--text-muted)]">{cassRuleCount} rule(s) for current story</p>
												{/if}
												<div class="flex gap-2">
													<button class="flex items-center gap-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-400 hover:bg-amber-500/10 disabled:opacity-40"
														onclick={() => flushCassRules('deprecated')} disabled={cassFlushing || !story.currentStory}>
														{#if cassFlushing}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Trash2 class="h-3 w-3" />{/if}
														Flush Bad Rules
													</button>
													<button class="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-[10px] text-red-400 hover:bg-red-500/10 disabled:opacity-40"
														onclick={() => flushCassRules('all')} disabled={cassFlushing || !story.currentStory}>
														{#if cassFlushing}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Trash2 class="h-3 w-3" />{/if}
														Flush All
													</button>
												</div>
												{#if cassStatus}
													<p class="text-[10px] text-[var(--text-muted)]">{cassStatus}</p>
												{/if}
											</div>
										{/if}

									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Save bar -->
	{#if hasChanges}
		<div class="sticky bottom-0 flex gap-3 rounded-xl border border-[var(--color-gold-600)]/30 bg-[var(--bg-secondary)] p-3">
			<button class="flex-1 rounded-lg border border-[var(--border-primary)] py-2.5 text-xs text-[var(--text-muted)]"
				onclick={() => { editingConfigs = {}; editingProfileModels = {}; }}>
				Discard
			</button>
			<button class="flex flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2.5 font-display text-xs font-semibold tracking-wide text-[var(--bg-primary)]"
				onclick={saveAll} disabled={saving}>
				<Save class="h-3.5 w-3.5" />
				{saving ? 'Saving...' : 'Save All'}
			</button>
		</div>
	{/if}
</div>
