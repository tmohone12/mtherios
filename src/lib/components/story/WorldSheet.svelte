<script lang="ts">
	import CampaignFacts from './CampaignFacts.svelte';
	import CommitmentManager from './CommitmentManager.svelte';
	import ThreadManager from './ThreadManager.svelte';
	import { isCurrentAgreement } from '$lib/contracts/agreements';
	import { ArrowLeft, BookOpen, Camera, Clock, Flag, HeartHandshake, Loader2, MapPin, Minus, Package, Pencil, Plus, Save, ScrollText, Sparkles, UserMinus, UserPlus, Users, X } from 'lucide-svelte';
	import { readBackendPortraitImageStatus, requestBackendPortraitImage, type BackendPortraitJobStatus } from '$lib/services/backendAgentRuns';
	import { uuid } from '$lib/utils/uuid';
	import { story } from '$lib/stores/story.svelte';
	import type { Character, CharacterEntryState, Entry, FactionEntryState } from '$lib/types';
	import { DND_ABILITIES, abilityModifier, normalizePlayerSheet, type DndAbility, type PlayerSheet } from '$lib/utils/playerSheet';
	import PlotDirectorPanel from './PlotDirectorPanel.svelte';
	import MemoryProcessingStatus from './MemoryProcessingStatus.svelte';
	import PlayerCapabilities from './PlayerCapabilities.svelte';

	type Tab = 'character' | 'party' | 'now' | 'people' | 'places' | 'factions' | 'threads' | 'inventory' | 'director';
	type NpcSection = 'overview' | 'relationships' | 'gm';
	interface Props { open: boolean; onClose: () => void; onOpenLore: () => void; }
	interface NpcDraft {
		name: string;
		description: string;
		relationship: string;
		status: Character['status'];
		traits: string;
		factionTags: string;
		appearance: string;
		voice: string;
		partyRole: string;
	}
	interface ProjectedFactionState extends FactionEntryState {
		canonicalFactionId?: string;
		operational?: boolean;
		pressure?: number;
		projects?: Array<{ id: string; project: string; progress: number; status: string; dueTurn?: number | null }>;
	}
	let { open, onClose, onOpenLore }: Props = $props();
	let tab = $state<Tab>('now');
	let editingStats = $state(false);
	let statsDraft = $state<PlayerSheet>(normalizePlayerSheet(null));
	let savingStats = $state(false);
	let statsSaveError = $state<string | null>(null);
	let managingParty = $state(false);
	let partyBusyId = $state<string | null>(null);
	let generatingPortraitId = $state<string | null>(null);
	let partyError = $state<string | null>(null);
	let portraitDrafts = $state<Record<string, string>>({});
	let portraitJobs = $state<Record<string, BackendPortraitJobStatus | null>>({});
	let portraitJobGameId = '';
	let roleDrafts = $state<Record<string, string>>({});
	let selectedNpcId = $state<string | null>(null);
	let npcReturnTab = $state<Tab>('people');
	let npcSection = $state<NpcSection>('overview');
	let editingNpc = $state(false);
	let savingNpc = $state(false);
	let npcError = $state<string | null>(null);
	let npcDraft = $state<NpcDraft>({ name: '', description: '', relationship: '', status: 'active', traits: '', factionTags: '', appearance: '', voice: '', partyRole: '' });

	const currentLocation = $derived(story.locations.find(location => location.current) ?? null);
	const protagonist = $derived(story.protagonist ?? null);
	const protagonistDescription = $derived(protagonist ? publicCharacterDescription(protagonist) : '');
	const protagonistMetadata = $derived(protagonist?.metadata && typeof protagonist.metadata === 'object' ? protagonist.metadata as Record<string, unknown> : {});
	const selectedNpc = $derived(story.characters.find(character => character.id === selectedNpcId && character.relationship !== 'self') ?? null);
	const selectedNpcEntry = $derived(selectedNpc ? story.lorebookEntries.find(entry => entry.type === 'character' && (entry.id === selectedNpc.id || entry.name.toLowerCase() === selectedNpc.name.toLowerCase())) ?? null : null);
	const selectedNpcState = $derived(selectedNpcEntry?.state?.type === 'character' ? selectedNpcEntry.state as CharacterEntryState : null);
	const selectedNpcRelationships = $derived(selectedNpcEntry ? story.entryRelationships.filter(connection => connection.sourceEntryId === selectedNpcEntry.id || connection.targetEntryId === selectedNpcEntry.id) : []);
	const playerSheet = $derived(normalizePlayerSheet(protagonistMetadata.playerSheet));
	const hasSavedPlayerSheet = $derived(Boolean(protagonistMetadata.playerSheet && typeof protagonistMetadata.playerSheet === 'object' && !Array.isArray(protagonistMetadata.playerSheet)));
	const playerAssets = $derived(Array.isArray(protagonistMetadata.assets) ? protagonistMetadata.assets.filter((asset): asset is string => typeof asset === 'string' && asset.trim().length > 0) : []);
	const activeCharacters = $derived(story.characters.filter(character => character.status === 'active' && character.relationship !== 'self'));
	const partyMembers = $derived([
		...(protagonist ? [protagonist] : []),
		...activeCharacters.filter(character => characterMetadata(character).partyMember === true),
	]);
	const availablePartyCharacters = $derived(activeCharacters.filter(character => characterMetadata(character).partyMember !== true));
	const presentCharacters = $derived(activeCharacters.filter(character =>
		character.status === 'active' && character.relationship !== 'self'
		&& (!currentLocation || character.metadata?.lastSeenLocation === currentLocation.name)
	));
	const nowCharacters = $derived(presentCharacters);
	const visibleMeters = $derived((story.currentStory?.meters ?? []).filter(meter => meter.visible));
	const factionReferences = $derived(story.lorebookEntries.filter(entry => entry.type === 'faction' && !entry.deleted));
	const factionEntries = $derived(factionReferences.filter(entry => factionState(entry).operational === true).slice(0, 20));
	const knownSchemes = $derived(story.schemes.filter(scheme => scheme.secrecy !== 'secret' && !['resolved', 'foiled', 'abandoned'].includes(scheme.status)));
	const activeAgreements = $derived(story.agreements.filter(agreement => isCurrentAgreement(agreement) && agreement.secrecy !== 'secret'));
	const pastAgreements = $derived(story.agreements.filter(agreement => !isCurrentAgreement(agreement) && agreement.secrecy !== 'secret').sort((a, b) => b.updatedAt - a.updatedAt));
	const time = $derived.by(() => {
		const canonical = story.campaignProjection?.story.currentWorldTime;
		if (typeof canonical === 'string' && canonical.trim()) return canonical.trim();
		const value = story.currentStory?.timeTracker;
		if (!value) return null;
		return `Day ${value.years ? `${value.years}·` : ''}${value.days}, ${String(value.hours).padStart(2, '0')}:${String(value.minutes).padStart(2, '0')}`;
	});
	const tabs = $derived([
		{ id: 'character' as const, label: 'Character', show: Boolean(protagonist) },
		{ id: 'party' as const, label: 'Party', show: Boolean(protagonist) || activeCharacters.length > 0 },
		{ id: 'now' as const, label: 'Now', show: true },
		{ id: 'people' as const, label: 'People', show: story.characters.length > 0 },
		{ id: 'places' as const, label: 'Places', show: story.locations.length > 0 },
		{ id: 'factions' as const, label: 'Factions', show: factionReferences.length > 0 },
		{ id: 'threads' as const, label: 'Threads', show: true },
		{ id: 'inventory' as const, label: 'Inventory', show: story.items.length > 0 },
		{ id: 'director' as const, label: 'Director', show: Boolean(story.currentStory?.serverStoryId) },
	].filter(item => item.show));

	function factionState(entry: Entry): ProjectedFactionState {
		return entry.state as ProjectedFactionState;
	}

	function latestFactionMove(name: string) {
		return [...story.factionActions]
			.filter(action => action.factionName.toLowerCase() === name.toLowerCase())
			.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
	}

	function characterMetadata(character: Character): Record<string, unknown> {
		return character.metadata && typeof character.metadata === 'object' ? character.metadata : {};
	}

	function characterInitials(name: string): string {
		return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || '?';
	}

	function characterPartyRole(character: Character): string {
		const value = characterMetadata(character).partyRole;
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (character.relationship === 'self') return 'Player character';
		const relationship = character.relationship?.trim();
		return relationship && !['unknown', 'neutral'].includes(relationship.toLowerCase()) ? relationship : 'Companion';
	}

	function portraitValue(character: Character): string {
		return portraitDrafts[character.id] ?? character.portrait ?? '';
	}

	function portraitJobMessage(characterId: string): string {
		const job = portraitJobs[characterId];
		if (!job) return '';
		if (generatingPortraitId === characterId) return 'Generating image…';
		if (job.status === 'failed') return job.error || 'Portrait generation failed.';
		if (job.imageResult?.reason === 'character_changed') return 'The character changed during generation; the newer portrait was kept.';
		return job.imageResult?.applied ? 'Portrait ready.' : '';
	}

	function portraitJobPending(characterId: string): boolean {
		return ['queued', 'retry', 'running'].includes(portraitJobs[characterId]?.status ?? '');
	}

	async function refreshPortraitJob(characterId: string) {
		const current = story.currentStory;
		if (!current?.serverStoryId || !current.shelfId) return;
		const status = await readBackendPortraitImageStatus({ projectId: current.shelfId, gameId: current.serverStoryId, characterId });
		if (story.currentStory?.id !== current.id) return;
		portraitJobs = { ...portraitJobs, [characterId]: status };
		if (status?.status === 'complete' && status.imageResult?.applied && status.imageResult.url
			&& story.characters.find(character => character.id === characterId)?.portrait !== status.imageResult.url)
			await story.refreshCampaignProjection();
	}

	function metadataString(character: Character, key: string): string {
		const value = characterMetadata(character)[key];
		return typeof value === 'string' ? value.trim() : '';
	}

	function metadataList(character: Character, key: string): string[] {
		const value = characterMetadata(character)[key];
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
	}

	function characterFactionTags(character: Character): string[] {
		return [...new Set([...metadataList(character, 'factionTags'), metadataString(character, 'factionName')].filter(Boolean))];
	}

	function characterAppearance(character: Character): string {
		return metadataString(character, 'appearance') || Object.values(character.visualDescriptors ?? {}).filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(', ');
	}

	function publicCharacterDescription(character: Character): string {
		const description = character.description?.replace(/\\n/g, '\n') ?? '';
		return description.split(/\n?\s*\[(?:gm[- ]?only|hidden|secret)[^\]]*\][:\s]*/i)[0]?.trim() ?? '';
	}

	function openCharacterSheet(character: Character, returnTab: Tab = tab) {
		if (character.relationship === 'self') {
			selectedNpcId = null;
			tab = 'character';
			return;
		}
		selectedNpcId = character.id;
		npcReturnTab = returnTab;
		npcSection = 'overview';
		editingNpc = false;
		npcError = null;
	}

	function closeNpcSheet() {
		selectedNpcId = null;
		editingNpc = false;
		npcError = null;
		tab = npcReturnTab;
	}

	function beginNpcEdit(character: Character) {
		npcDraft = {
			name: character.name,
			description: character.description?.replace(/\\n/g, '\n') ?? '',
			relationship: metadataString(character, 'currentDisposition') || character.relationship || '',
			status: character.status,
			traits: character.traits.join(', '),
			factionTags: characterFactionTags(character).join(', '),
			appearance: characterAppearance(character),
			voice: metadataString(character, 'voice'),
			partyRole: characterPartyRole(character),
		};
		npcError = null;
		editingNpc = true;
		npcSection = 'gm';
	}

	async function saveNpcDetails(character: Character) {
		if (savingNpc) return;
		savingNpc = true;
		npcError = null;
		try {
			await story.updateCharacterDetails(character.id, {
				name: npcDraft.name,
				description: npcDraft.description,
				relationship: npcDraft.relationship,
				status: npcDraft.status,
				traits: npcDraft.traits.split(',').map(value => value.trim()).filter(Boolean),
				factionTags: npcDraft.factionTags.split(',').map(value => value.trim()).filter(Boolean),
				appearance: npcDraft.appearance,
				voice: npcDraft.voice,
			});
			if (npcDraft.partyRole !== characterPartyRole(character)) {
				await story.updateCharacterParty(character.id, { role: npcDraft.partyRole });
			}
			editingNpc = false;
			npcSection = 'overview';
		} catch (error) {
			npcError = error instanceof Error ? error.message : 'Could not save the NPC sheet.';
		}
		savingNpc = false;
	}

	function relatedEntryName(entryId: string): string {
		return story.lorebookEntries.find(entry => entry.id === entryId)?.name ?? 'Unknown entry';
	}

	async function setPartyMembership(character: Character, member: boolean) {
		if (partyBusyId) return;
		partyBusyId = character.id;
		partyError = null;
		try {
			await story.updateCharacterParty(character.id, { member, ...(member ? {} : { role: null }) });
		} catch (error) {
			partyError = error instanceof Error ? error.message : 'Could not update the party.';
		}
		partyBusyId = null;
	}

	async function savePartyDetails(character: Character, portrait?: string | null) {
		if (partyBusyId) return;
		partyBusyId = character.id;
		partyError = null;
		try {
			await story.updateCharacterParty(character.id, {
				role: roleDrafts[character.id] ?? characterPartyRole(character),
				...(portrait !== undefined ? { portrait } : { portrait: portraitValue(character) }),
			});
			portraitDrafts = { ...portraitDrafts, [character.id]: portrait ?? portraitValue(character) };
		} catch (error) {
			partyError = error instanceof Error ? error.message : 'Could not save party details.';
		}
		partyBusyId = null;
	}

	async function loadPortraitFile(event: Event, character: Character) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		if (!file.type.startsWith('image/')) {
			partyError = 'Choose an image file.';
			return;
		}
		if (file.size > 3_000_000) {
			partyError = 'Portrait files must be 3 MB or smaller.';
			return;
		}
		try {
			const portrait = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result ?? ''));
				reader.onerror = () => reject(new Error('Could not read that portrait.'));
				reader.readAsDataURL(file);
			});
			portraitDrafts = { ...portraitDrafts, [character.id]: portrait };
			await savePartyDetails(character, portrait);
		} catch (error) {
			partyError = error instanceof Error ? error.message : 'Could not read that portrait.';
		}
	}

	async function generatePortrait(character: Character) {
		if (partyBusyId) return;
		partyBusyId = character.id;
		generatingPortraitId = character.id;
		partyError = null;
		try {
			const current = story.currentStory;
			if (!current?.serverStoryId || !current.shelfId) throw new Error('Save this game before generating a portrait.');
			const generated = await requestBackendPortraitImage({ projectId: current.shelfId, gameId: current.serverStoryId,
				characterId: character.id, callId: uuid() });
			if (story.currentStory?.id === current.id) {
				portraitJobs = { ...portraitJobs, [character.id]: { ...generated, error: null } };
				if (generated.imageResult.applied) await story.refreshCampaignProjection();
			}
		} catch (error) {
			partyError = error instanceof Error ? error.message : 'Could not generate that portrait.';
		}
		generatingPortraitId = null;
		partyBusyId = null;
	}

	function adjustAbility(ability: DndAbility, amount: number) {
		statsDraft = { ...statsDraft, abilities: { ...statsDraft.abilities, [ability]: Math.max(1, Math.min(30, statsDraft.abilities[ability] + amount)) } };
	}

	function adjustStat(stat: 'armorClass' | 'speed' | 'proficiencyBonus', amount: number) {
		const maximum = stat === 'armorClass' ? 99 : stat === 'speed' ? 300 : 20;
		statsDraft = { ...statsDraft, [stat]: Math.max(0, Math.min(maximum, statsDraft[stat] + amount)) };
	}

	function adjustHitPoints(part: 'current' | 'max', amount: number) {
		const next = { ...statsDraft.hitPoints, [part]: Math.max(part === 'max' ? 1 : 0, Math.min(999, statsDraft.hitPoints[part] + amount)) };
		if (part === 'max') next.current = Math.min(next.current, next.max);
		statsDraft = { ...statsDraft, hitPoints: next };
	}

	async function saveStats() {
		if (!protagonist || savingStats) return;
		savingStats = true;
		statsSaveError = null;
		try {
			const playerSheet = normalizePlayerSheet(statsDraft);
			playerSheet.hitPoints.current = Math.min(playerSheet.hitPoints.current, playerSheet.hitPoints.max);
			await story.saveProtagonist({ name: protagonist.name, description: protagonist.description, traits: protagonist.traits, playerSheet });
			editingStats = false;
		} catch (error) {
			statsSaveError = error instanceof Error ? error.message : 'Could not save player stats.';
		}
		savingStats = false;
	}

	function cancelStats() {
		statsDraft = normalizePlayerSheet(protagonistMetadata.playerSheet);
		statsSaveError = null;
		editingStats = false;
	}

	$effect(() => { if (!open) { tab = 'now'; selectedNpcId = null; editingStats = false; managingParty = false; partyError = null; npcError = null; } });
	$effect(() => { if (!editingStats) statsDraft = normalizePlayerSheet(protagonistMetadata.playerSheet); });
	$effect(() => { const gameId = story.currentStory?.serverStoryId ?? ''; if (gameId !== portraitJobGameId) { portraitJobGameId = gameId; portraitJobs = {}; } });
	$effect(() => {
		const characterId = selectedNpc?.id ?? (tab === 'character' ? protagonist?.id : undefined);
		if (!open || !story.currentStory?.serverStoryId || !characterId) return;
		void refreshPortraitJob(characterId).catch(() => undefined);
	});
	$effect(() => {
		if (!open || !managingParty || !story.currentStory?.serverStoryId) return;
		for (const member of partyMembers) void refreshPortraitJob(member.id).catch(() => undefined);
	});
</script>

{#if open}
	<div class="fixed inset-0 z-50 flex items-end bg-black/50 sm:items-stretch sm:justify-end sm:bg-black/25" role="presentation" onkeydown={(event) => event.key === 'Escape' && (selectedNpc ? closeNpcSheet() : onClose())}>
		<button class="absolute inset-0" onclick={onClose} aria-label="Close world sheet"></button>
		<div class="world-panel relative z-10 flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-[1.75rem] border border-[var(--border-primary)] bg-[var(--bg-secondary)] pb-[env(safe-area-inset-bottom)] shadow-2xl sm:h-full sm:max-h-none sm:max-w-[36rem] sm:rounded-none sm:border-y-0 sm:border-r-0 sm:pb-0" class:world-panel-portrait={Boolean(selectedNpc || tab === 'character')} role="dialog" aria-modal="true" aria-labelledby="world-sheet-title">
			<div class="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_20%_0%,rgba(198,166,108,0.14),transparent_70%)]"></div>
			<div class="mx-auto mt-2 h-1 w-10 rounded-full bg-white/20 sm:hidden"></div>
			<header class="world-panel-header relative shrink-0 flex items-center justify-between gap-4 px-5 py-5">
				<div class="min-w-0"><p class="text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--text-accent)]">Your chronicle</p><h2 id="world-sheet-title" class="mt-1 font-display text-3xl text-[var(--text-primary)]">{selectedNpc ? 'Character dossier' : 'Player & world'}</h2><p class="mt-1.5 text-xs leading-relaxed text-[var(--text-muted)]">{selectedNpc ? selectedNpc.name : tab === 'director' ? 'Author view · contains hidden plot information' : 'The people, places, and choices shaping your story.'}</p></div>
				<button class="flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-muted)]" onclick={onClose} aria-label="Close world sheet"><X class="h-5 w-5" /></button>
			</header>

			{#if !selectedNpc}
				<div class="shrink-0 border-y border-[var(--border-secondary)] px-4 py-2 sm:hidden">
					<label class="sr-only" for="world-section-picker">Player menu section</label>
					<select id="world-section-picker" class="min-h-11 w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 text-sm font-medium text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" bind:value={tab}>
						{#each tabs as item}<option value={item.id}>{item.label}</option>{/each}
					</select>
				</div>
				<nav class="world-section-nav hidden shrink-0 flex-wrap gap-1 border-y border-[var(--border-secondary)] px-4 py-2 sm:flex" aria-label="World sections">
					{#each tabs as item}
						<button class="min-h-10 shrink-0 rounded-lg px-3 text-xs {tab === item.id ? 'bg-[var(--text-accent)]/12 text-[var(--text-accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}" onclick={() => tab = item.id} aria-pressed={tab === item.id}>{item.label}</button>
					{/each}
				</nav>
			{/if}

			<div class="world-panel-content min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-5">
				{#if selectedNpc}
					<button class="inline-flex min-h-10 items-center gap-2 rounded-xl px-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-white/8 hover:text-[var(--text-primary)]" onclick={closeNpcSheet}><ArrowLeft class="h-4 w-4" />Back to {npcReturnTab}</button>

					<article class="relative overflow-hidden rounded-2xl border border-[var(--text-accent)]/20 bg-[var(--bg-primary)]">
						<div class="character-portrait-stage bg-[radial-gradient(circle_at_50%_22%,rgba(198,166,108,0.18),var(--bg-primary)_68%)]">
							{#if portraitValue(selectedNpc)}<img src={portraitValue(selectedNpc)} alt={`${selectedNpc.name} portrait`} class="h-full w-full object-contain" onerror={() => npcError = `Could not load ${selectedNpc.name}'s portrait.`} />{:else}<div class="flex h-full items-center justify-center font-display text-6xl text-[var(--text-accent)]/85" aria-label={`${selectedNpc.name} has no portrait yet`}>{characterInitials(selectedNpc.name)}</div>{/if}
						</div>
						<div class="border-t border-[var(--border-secondary)] p-5"><div class="flex items-end justify-between gap-3"><div class="min-w-0"><h3 class="font-display text-2xl text-[var(--text-primary)]">{selectedNpc.name}</h3><p class="mt-1 text-sm capitalize text-[var(--text-muted)]">{metadataString(selectedNpc, 'currentDisposition') || selectedNpc.relationship || 'Known character'}</p></div>{#if characterMetadata(selectedNpc).partyMember === true}<span class="rounded-full bg-[var(--text-accent)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-on-accent)]">Party</span>{/if}</div></div>
					</article>

					<nav class="grid grid-cols-3 rounded-xl bg-[var(--bg-tertiary)] p-1" aria-label="NPC sheet sections">
						{#each [{ id: 'overview' as const, label: 'Overview' }, { id: 'relationships' as const, label: 'Relations' }, { id: 'gm' as const, label: 'GM Edit' }] as item}<button class="min-h-10 rounded-lg px-2 text-xs font-semibold {npcSection === item.id ? 'bg-[var(--bg-primary)] text-[var(--text-accent)]' : 'text-[var(--text-muted)]'}" onclick={() => npcSection = item.id}>{item.label}</button>{/each}
					</nav>

					{#if npcSection === 'overview'}
						<div class="grid grid-cols-2 gap-2">
							<article class="rounded-xl bg-[var(--bg-tertiary)] p-3"><p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Status</p><p class="mt-1 text-sm font-semibold capitalize text-[var(--text-primary)]">{selectedNpc.status}</p></article>
							<article class="rounded-xl bg-[var(--bg-tertiary)] p-3"><p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Last known</p><p class="mt-1 truncate text-sm font-semibold text-[var(--text-primary)]">{metadataString(selectedNpc, 'lastSeenLocation') || selectedNpcState?.lastSeenLocation || 'Unknown'}</p></article>
						</div>
						{#if publicCharacterDescription(selectedNpc)}<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4"><h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]">About</h4><p class="mt-2 whitespace-pre-line text-sm leading-relaxed text-[var(--text-secondary)]">{publicCharacterDescription(selectedNpc)}</p></article>{/if}
						{#if characterAppearance(selectedNpc) || metadataString(selectedNpc, 'voice')}<article class="space-y-3 rounded-2xl bg-[var(--bg-tertiary)] p-4">{#if characterAppearance(selectedNpc)}<div><h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]">Appearance</h4><p class="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{characterAppearance(selectedNpc)}</p></div>{/if}{#if metadataString(selectedNpc, 'voice')}<div class="border-t border-[var(--border-secondary)] pt-3"><h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]">Voice</h4><p class="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{metadataString(selectedNpc, 'voice')}</p></div>{/if}</article>{/if}
						{#if selectedNpc.traits.length}<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4"><h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]">Traits</h4><div class="mt-2 flex flex-wrap gap-1.5">{#each selectedNpc.traits as trait}<span class="rounded-full bg-[var(--bg-primary)]/75 px-2.5 py-1 text-xs text-[var(--text-secondary)]">{trait}</span>{/each}</div></article>{/if}
						{#if metadataList(selectedNpc, 'motivations').length || metadataList(selectedNpc, 'pressures').length}<article class="space-y-3 rounded-2xl bg-[var(--bg-tertiary)] p-4">{#if metadataList(selectedNpc, 'motivations').length}<div><h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]">Motivations</h4><ul class="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">{#each metadataList(selectedNpc, 'motivations') as item}<li>• {item}</li>{/each}</ul></div>{/if}{#if metadataList(selectedNpc, 'pressures').length}<div class="border-t border-[var(--border-secondary)] pt-3"><h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]">Active pressures</h4><ul class="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">{#each metadataList(selectedNpc, 'pressures') as item}<li>• {item}</li>{/each}</ul></div>{/if}</article>{/if}
					{:else if npcSection === 'relationships'}
						<article class="rounded-2xl border border-[var(--text-accent)]/15 bg-[linear-gradient(145deg,rgba(198,166,108,0.1),var(--bg-tertiary))] p-4"><div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]"><HeartHandshake class="h-4 w-4" />Relationship to player</div><p class="mt-2 font-display text-xl capitalize text-[var(--text-primary)]">{metadataString(selectedNpc, 'currentDisposition') || selectedNpc.relationship || 'Undetermined'}</p>{#if typeof selectedNpcState?.relationship?.level === 'number'}<div class="mt-3"><div class="flex justify-between text-[10px] uppercase tracking-wide text-[var(--text-muted)]"><span>Affinity</span><span>{selectedNpcState.relationship.level}</span></div><div class="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--bg-primary)]"><div class="h-full rounded-full bg-[var(--text-accent)]" style:width={`${Math.max(0, Math.min(100, (selectedNpcState.relationship.level + 100) / 2))}%`}></div></div></div>{/if}</article>
						<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4"><div class="flex items-center justify-between gap-2"><h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]">Faction ties</h4><Flag class="h-4 w-4 text-[var(--text-muted)]" /></div>{#if characterFactionTags(selectedNpc).length}<div class="mt-3 flex flex-wrap gap-2">{#each characterFactionTags(selectedNpc) as faction}<span class="rounded-full border border-[var(--text-accent)]/20 bg-[var(--bg-primary)]/60 px-3 py-1.5 text-xs text-[var(--text-primary)]">{faction}</span>{/each}</div>{:else}<p class="mt-2 text-sm text-[var(--text-muted)]">No explicit faction tags yet.</p>{/if}</article>
						<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4"><div class="flex items-center justify-between gap-2"><h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]">Connected lore</h4><span class="text-xs text-[var(--text-muted)]">{selectedNpcRelationships.length}</span></div>{#if selectedNpcRelationships.length}<div class="mt-2 space-y-2">{#each selectedNpcRelationships as connection}{@const peerId = connection.sourceEntryId === selectedNpcEntry?.id ? connection.targetEntryId : connection.sourceEntryId}<div class="rounded-xl bg-[var(--bg-primary)]/55 px-3 py-2"><p class="text-sm font-semibold text-[var(--text-primary)]">{relatedEntryName(peerId)}</p><p class="mt-0.5 text-xs text-[var(--text-muted)]">{connection.label || connection.type.replaceAll('-', ' ')}</p></div>{/each}</div>{:else}<p class="mt-2 text-sm text-[var(--text-muted)]">No explicit lore links yet. Faction tags and party membership still give the GM usable context.</p>{/if}</article>
						<article class="flex items-center justify-between gap-3 rounded-2xl bg-[var(--bg-tertiary)] p-4"><div><h4 class="font-semibold text-[var(--text-primary)]">Active party</h4><p class="mt-1 text-xs text-[var(--text-muted)]">{characterMetadata(selectedNpc).partyMember === true ? characterPartyRole(selectedNpc) : 'Not traveling with the player'}</p></div><button class="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold {characterMetadata(selectedNpc).partyMember === true ? 'bg-rose-400/10 text-rose-300' : 'bg-[var(--text-accent)] text-[var(--text-on-accent)]'} disabled:opacity-50" onclick={() => setPartyMembership(selectedNpc, characterMetadata(selectedNpc).partyMember !== true)} disabled={partyBusyId !== null}>{#if partyBusyId === selectedNpc.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else if characterMetadata(selectedNpc).partyMember === true}<UserMinus class="h-3.5 w-3.5" />Remove{:else}<UserPlus class="h-3.5 w-3.5" />Add to party{/if}</button></article>
					{:else}
						{#if !editingNpc}<button class="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--text-accent)] px-4 text-sm font-semibold text-[var(--text-on-accent)]" onclick={() => beginNpcEdit(selectedNpc)}><Pencil class="h-4 w-4" />Edit NPC details</button>{/if}
						{#if editingNpc}
							<form class="space-y-3 rounded-2xl bg-[var(--bg-tertiary)] p-4" onsubmit={(event) => { event.preventDefault(); saveNpcDetails(selectedNpc); }}>
								<div class="grid grid-cols-2 gap-3"><label class="text-xs text-[var(--text-muted)]">Name<input class="mt-1 min-h-10 w-full rounded-lg border border-[var(--border-primary)] bg-black/30 px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" bind:value={npcDraft.name} required /></label><label class="text-xs text-[var(--text-muted)]">Status<select class="mt-1 min-h-10 w-full rounded-lg border border-[var(--border-primary)] bg-black/30 px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" bind:value={npcDraft.status}><option value="active">Active</option><option value="inactive">Inactive</option><option value="deceased">Deceased</option></select></label></div>
								<label class="block text-xs text-[var(--text-muted)]">Disposition toward player<input class="mt-1 min-h-10 w-full rounded-lg border border-[var(--border-primary)] bg-black/30 px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" bind:value={npcDraft.relationship} placeholder="wary ally, rival, trusted friend…" /></label>
								<label class="block text-xs text-[var(--text-muted)]">About<textarea class="mt-1 min-h-28 w-full resize-y rounded-lg border border-[var(--border-primary)] bg-black/30 px-3 py-2 text-sm leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" bind:value={npcDraft.description}></textarea></label>
								<label class="block text-xs text-[var(--text-muted)]">Appearance<textarea class="mt-1 min-h-20 w-full resize-y rounded-lg border border-[var(--border-primary)] bg-black/30 px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" bind:value={npcDraft.appearance}></textarea></label>
								<label class="block text-xs text-[var(--text-muted)]">Voice<input class="mt-1 min-h-10 w-full rounded-lg border border-[var(--border-primary)] bg-black/30 px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" bind:value={npcDraft.voice} placeholder="Low, clipped, never hurried…" /></label>
								<label class="block text-xs text-[var(--text-muted)]">Traits <span class="text-[var(--text-faint)]">· comma separated</span><input class="mt-1 min-h-10 w-full rounded-lg border border-[var(--border-primary)] bg-black/30 px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" bind:value={npcDraft.traits} /></label>
								<label class="block text-xs text-[var(--text-muted)]">Faction tags <span class="text-[var(--text-faint)]">· comma separated</span><input class="mt-1 min-h-10 w-full rounded-lg border border-[var(--border-primary)] bg-black/30 px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" bind:value={npcDraft.factionTags} placeholder="House Balaerys, Harbor Watch…" /></label>
								<label class="block text-xs text-[var(--text-muted)]">Party role<input class="mt-1 min-h-10 w-full rounded-lg border border-[var(--border-primary)] bg-black/30 px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" bind:value={npcDraft.partyRole} placeholder="Scout, guide, healer…" /></label>
								<div class="flex gap-2"><button type="submit" class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--text-accent)] px-4 text-sm font-semibold text-[var(--text-on-accent)] disabled:opacity-50" disabled={savingNpc}>{#if savingNpc}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Save class="h-4 w-4" />{/if}Save NPC</button><button type="button" class="min-h-11 rounded-xl px-4 text-sm text-[var(--text-secondary)] hover:bg-white/8" onclick={() => editingNpc = false} disabled={savingNpc}>Cancel</button></div>
							</form>
						{/if}
						<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4"><div><h4 class="font-semibold text-[var(--text-primary)]">Portrait</h4><p class="mt-1 text-xs text-[var(--text-muted)]">Generate from this NPC's canon, upload an image, or paste a URL.</p></div><div class="mt-3 flex flex-wrap gap-2"><button class="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[var(--text-accent)] px-3 text-xs font-semibold text-[var(--text-on-accent)] disabled:opacity-50" onclick={() => generatePortrait(selectedNpc)} disabled={partyBusyId !== null || portraitJobPending(selectedNpc.id)}>{#if generatingPortraitId === selectedNpc.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Sparkles class="h-3.5 w-3.5" />{/if}Generate</button><label class="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg bg-white/8 px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-white/12"><Camera class="h-3.5 w-3.5" />Upload<input class="sr-only" type="file" accept="image/*" onchange={(event) => loadPortraitFile(event, selectedNpc)} /></label><input class="min-h-10 min-w-0 flex-1 rounded-lg border border-[var(--border-primary)] bg-black/30 px-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" value={portraitValue(selectedNpc)} oninput={(event) => portraitDrafts = { ...portraitDrafts, [selectedNpc.id]: event.currentTarget.value }} aria-label={`${selectedNpc.name} portrait URL`} placeholder="https://… portrait URL" /><button class="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-white/8 px-3 text-xs font-semibold text-[var(--text-primary)] disabled:opacity-50" onclick={() => savePartyDetails(selectedNpc)} disabled={partyBusyId !== null}><Save class="h-3.5 w-3.5" />Save</button>{#if selectedNpc.portrait}<button class="min-h-10 rounded-lg px-2 text-xs text-[var(--text-muted)] hover:bg-white/8" onclick={() => savePartyDetails(selectedNpc, null)} disabled={partyBusyId !== null}>Clear</button>{/if}</div></article>
					{/if}
						{#if selectedNpc && portraitJobMessage(selectedNpc.id)}<p role="status" class="rounded-xl bg-white/5 px-3 py-2 text-xs text-[var(--text-secondary)]">{portraitJobMessage(selectedNpc.id)}</p>{/if}
						{#if npcError || partyError}<p class="rounded-xl bg-rose-400/10 px-3 py-2 text-xs text-rose-300">{npcError || partyError}</p>{/if}
				{:else if tab === 'character' && protagonist}
					<article class="overflow-hidden rounded-2xl border border-[var(--text-accent)]/20 bg-[var(--bg-tertiary)]">
						<div class="character-portrait-stage bg-[radial-gradient(circle_at_50%_22%,rgba(198,166,108,0.18),var(--bg-primary)_68%)]">
							{#if portraitValue(protagonist)}<img src={portraitValue(protagonist)} alt={`${protagonist.name} portrait`} class="h-full w-full object-contain" onerror={() => partyError = `Could not load ${protagonist.name}'s portrait.`} />{:else}<div class="flex h-full items-center justify-center font-display text-6xl text-[var(--text-accent)]/85" aria-label={`${protagonist.name} has no portrait yet`}>{characterInitials(protagonist.name)}</div>{/if}
						</div>
						<div class="border-t border-[var(--border-secondary)] px-5 pt-5"><p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-accent)]">Player character</p><h3 class="mt-1 font-display text-3xl text-[var(--text-primary)]">{protagonist.name}</h3></div>
						<div class="p-4">{#if protagonistDescription}<p class="overflow-hidden text-sm leading-relaxed text-[var(--text-secondary)]" style="display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical">{protagonistDescription}</p>{/if}{#if protagonist.traits.length}<div class="mt-3 flex flex-wrap gap-1.5">{#each protagonist.traits as trait}<span class="rounded-full bg-[var(--bg-primary)]/75 px-2.5 py-1 text-xs text-[var(--text-secondary)]">{trait}</span>{/each}</div>{/if}<div class="mt-3 flex flex-wrap gap-2"><button class="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[var(--text-accent)] px-3 text-xs font-semibold text-[var(--text-on-accent)] disabled:opacity-50" onclick={() => generatePortrait(protagonist)} disabled={partyBusyId !== null || portraitJobPending(protagonist.id)}>{#if generatingPortraitId === protagonist.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Sparkles class="h-3.5 w-3.5" />{/if}Generate portrait</button><label class="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg bg-white/8 px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-white/12"><Camera class="h-3.5 w-3.5" />Upload<input class="sr-only" type="file" accept="image/*" onchange={(event) => loadPortraitFile(event, protagonist)} /></label></div>{#if partyError}<p class="mt-2 text-xs text-rose-300">{partyError}</p>{/if}</div>
					</article>
						{#if portraitJobMessage(protagonist.id)}<p role="status" class="rounded-xl bg-white/5 px-3 py-2 text-xs text-[var(--text-secondary)]">{portraitJobMessage(protagonist.id)}</p>{/if}
						{#if !hasSavedPlayerSheet}<p role="status" class="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">No ability scores saved. These are default values. Edit and save your stats to apply ability modifiers to GM checks.</p>{/if}
					{#if editingStats}
						<article class="rounded-2xl border border-[var(--text-accent)]/25 bg-[var(--bg-tertiary)] p-4">
							<div class="flex items-center justify-between gap-3"><div><h3 class="font-semibold text-[var(--text-primary)]">Edit stats</h3><p class="text-xs text-[var(--text-muted)]">Tap − or +, then save once.</p></div><Pencil class="h-4 w-4 text-[var(--text-accent)]" /></div>
							<div class="mt-3 grid grid-cols-3 gap-2">{#each DND_ABILITIES as ability}{@const score = statsDraft.abilities[ability.id]}<div class="rounded-xl border border-[var(--border-secondary)] bg-[var(--bg-primary)]/50 px-2 py-2 text-center"><p class="text-[10px] font-semibold tracking-wide text-[var(--text-accent)]">{ability.label}</p><div class="mt-1 flex items-center justify-center gap-1"><button class="flex h-8 w-8 items-center justify-center rounded-full bg-white/8 text-[var(--text-secondary)] hover:bg-white/15" onclick={() => adjustAbility(ability.id, -1)} aria-label={`Decrease ${ability.name}`}><Minus class="h-3.5 w-3.5" /></button><span class="w-7 text-lg font-semibold text-[var(--text-primary)]">{score}</span><button class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-accent)] text-[var(--text-on-accent)] hover:brightness-110" onclick={() => adjustAbility(ability.id, 1)} aria-label={`Increase ${ability.name}`}><Plus class="h-3.5 w-3.5" /></button></div><p class="mt-0.5 text-xs text-[var(--text-muted)]">{abilityModifier(score) >= 0 ? '+' : ''}{abilityModifier(score)}</p></div>{/each}</div>
							<div class="mt-3 grid grid-cols-2 gap-2">
								{#each [{ label: 'Armor Class', value: statsDraft.armorClass, change: (amount: number) => adjustStat('armorClass', amount) }, { label: 'Speed', value: statsDraft.speed, suffix: 'ft.', change: (amount: number) => adjustStat('speed', amount) }, { label: 'HP current', value: statsDraft.hitPoints.current, change: (amount: number) => adjustHitPoints('current', amount) }, { label: 'HP maximum', value: statsDraft.hitPoints.max, change: (amount: number) => adjustHitPoints('max', amount) }, { label: 'Proficiency', value: statsDraft.proficiencyBonus, prefix: '+', change: (amount: number) => adjustStat('proficiencyBonus', amount) }] as stat}<div class="rounded-xl bg-[var(--bg-primary)]/50 px-2 py-2"><p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{stat.label}</p><div class="mt-1 flex items-center justify-between gap-1"><button class="flex h-8 w-8 items-center justify-center rounded-full bg-white/8 text-[var(--text-secondary)] hover:bg-white/15" onclick={() => stat.change(-1)} aria-label={`Decrease ${stat.label}`}><Minus class="h-3.5 w-3.5" /></button><span class="text-base font-semibold text-[var(--text-primary)]">{stat.prefix ?? ''}{stat.value}{stat.suffix ? ` ${stat.suffix}` : ''}</span><button class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-accent)] text-[var(--text-on-accent)] hover:brightness-110" onclick={() => stat.change(1)} aria-label={`Increase ${stat.label}`}><Plus class="h-3.5 w-3.5" /></button></div></div>{/each}</div>
							<div class="mt-4 flex items-center gap-2"><button class="flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--text-accent)] px-3 text-sm font-semibold text-[var(--text-on-accent)] disabled:opacity-50" onclick={saveStats} disabled={savingStats}>{#if savingStats}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Save class="h-4 w-4" />{/if}Save stats</button><button class="min-h-10 rounded-xl px-3 text-sm text-[var(--text-secondary)] hover:bg-white/8" onclick={cancelStats} disabled={savingStats}>Cancel</button></div>{#if statsSaveError}<p class="mt-2 text-xs text-rose-300">{statsSaveError}</p>{/if}
						</article>
					{:else}
						<div class="grid grid-cols-2 gap-2"><article class="rounded-2xl bg-[var(--bg-tertiary)] p-3"><p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Armor Class</p><p class="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{playerSheet.armorClass}</p></article><article class="rounded-2xl bg-[var(--bg-tertiary)] p-3"><p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Hit Points</p><p class="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{playerSheet.hitPoints.current}<span class="text-sm text-[var(--text-muted)]"> / {playerSheet.hitPoints.max}</span></p></article><article class="rounded-2xl bg-[var(--bg-tertiary)] p-3"><p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Speed</p><p class="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{playerSheet.speed}<span class="text-sm text-[var(--text-muted)]"> ft.</span></p></article><article class="rounded-2xl bg-[var(--bg-tertiary)] p-3"><p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Proficiency</p><p class="mt-1 text-2xl font-semibold text-[var(--text-primary)]">+{playerSheet.proficiencyBonus}</p></article></div>
						<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4"><div class="flex items-baseline justify-between gap-3"><div><h3 class="font-semibold text-[var(--text-primary)]">Ability Scores</h3><span class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">D&D style</span></div><button class="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-[var(--text-accent)] hover:bg-white/8" onclick={() => { statsDraft = normalizePlayerSheet(protagonistMetadata.playerSheet); statsSaveError = null; editingStats = true; }} aria-label="Edit player stats"><Pencil class="h-3.5 w-3.5" />Edit</button></div><div class="mt-3 grid grid-cols-3 gap-2">{#each DND_ABILITIES as ability}{@const score = playerSheet.abilities[ability.id]}{@const modifier = abilityModifier(score)}<div class="rounded-xl border border-[var(--border-secondary)] bg-[var(--bg-primary)]/50 px-2 py-2 text-center" title={ability.name}><p class="text-[10px] font-semibold tracking-wide text-[var(--text-accent)]">{ability.label}</p><p class="mt-0.5 text-lg font-semibold text-[var(--text-primary)]">{score}</p><p class="text-xs text-[var(--text-muted)]">{modifier >= 0 ? '+' : ''}{modifier}</p></div>{/each}</div></article>
					{/if}
					{#if story.currentStory?.playerReputation || playerAssets.length}<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4"><h3 class="font-semibold text-[var(--text-primary)]">Your standing</h3>{#if story.currentStory?.playerReputation}<p class="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{story.currentStory.playerReputation}</p>{/if}{#if playerAssets.length}<div class="mt-3 border-t border-[var(--border-secondary)] pt-3"><p class="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-accent)]">Assets</p><div class="mt-2 flex flex-wrap gap-1.5">{#each playerAssets as asset}<span class="rounded-full bg-[var(--bg-primary)]/70 px-2.5 py-1 text-xs text-[var(--text-secondary)]">{asset}</span>{/each}</div></div>{/if}</article>{/if}
					{#key protagonist.id}<PlayerCapabilities character={protagonist} />{/key}
				{:else if tab === 'party'}
					<article class="overflow-hidden rounded-2xl border border-[var(--text-accent)]/20 bg-[linear-gradient(145deg,rgba(198,166,108,0.12),var(--bg-tertiary))] p-4">
						<div class="flex items-start justify-between gap-3">
							<div><p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-accent)]">Active party</p><h3 class="mt-1 font-display text-2xl text-[var(--text-primary)]">Traveling Company</h3><p class="mt-1 text-xs text-[var(--text-muted)]">The GM keeps these companions in working memory.</p></div>
							<span class="rounded-full bg-[var(--bg-primary)]/70 px-2.5 py-1 text-xs text-[var(--text-secondary)]">{partyMembers.length}</span>
						</div>
						<div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
							{#each partyMembers as member}
								{@const portrait = portraitValue(member)}
								<button class="relative overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)]/65 text-left transition hover:border-[var(--text-accent)]/55" onclick={() => openCharacterSheet(member, 'party')} aria-label={`Open ${member.name} character sheet`}>
									<div class="aspect-[4/5] overflow-hidden bg-[radial-gradient(circle_at_50%_22%,rgba(198,166,108,0.3),var(--bg-primary)_68%)]">
										{#if portrait}<img src={portrait} alt={`${member.name} portrait`} class="h-full w-full object-cover" onerror={() => partyError = `Could not load ${member.name}'s portrait.`} />{:else}<div class="flex h-full items-center justify-center font-display text-3xl text-[var(--text-accent)]/85" aria-label={`${member.name} has no portrait yet`}>{characterInitials(member.name)}</div>{/if}
									</div>
									<div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/85 to-transparent px-2.5 pb-2.5 pt-8"><p class="truncate text-sm font-semibold text-white">{member.name}</p><p class="truncate text-[10px] text-white/65">{characterPartyRole(member)}</p></div>
								</button>
							{/each}
							{#each Array(Math.max(0, 4 - partyMembers.length)) as _}
								<button class="flex aspect-[4/5] min-h-24 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-[var(--bg-primary)]/35 text-xs text-[var(--text-muted)] hover:border-[var(--text-accent)]/45 hover:text-[var(--text-accent)]" onclick={() => managingParty = true}><UserPlus class="h-5 w-5" />Add</button>
							{/each}
						</div>
					</article>

					<button class="flex min-h-11 w-full items-center justify-between rounded-xl bg-[var(--bg-tertiary)] px-4 text-left text-sm font-semibold text-[var(--text-primary)]" onclick={() => managingParty = !managingParty}><span class="flex items-center gap-2"><Users class="h-4 w-4 text-[var(--text-accent)]" />{managingParty ? 'Close party controls' : 'Manage party'}</span><span class="text-xs font-normal text-[var(--text-muted)]">Add · remove · portraits</span></button>

					{#if managingParty}
						<article class="space-y-3 rounded-2xl border border-[var(--border-secondary)] bg-[var(--bg-tertiary)] p-4">
							<div><h3 class="font-semibold text-[var(--text-primary)]">Party details</h3><p class="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">Upload a portrait or paste an image URL. Roles help the GM understand what each companion contributes.</p></div>
							{#each partyMembers as member}
								{@const portrait = portraitValue(member)}
								<div class="rounded-xl border border-[var(--border-secondary)] bg-[var(--bg-primary)]/45 p-3">
									<div class="flex gap-3">
										<div class="h-16 w-14 shrink-0 overflow-hidden rounded-lg bg-[radial-gradient(circle_at_50%_20%,rgba(198,166,108,0.3),var(--bg-primary)_70%)]">{#if portrait}<img src={portrait} alt="" class="h-full w-full object-cover" />{:else}<div class="flex h-full items-center justify-center font-display text-lg text-[var(--text-accent)]">{characterInitials(member.name)}</div>{/if}</div>
										<div class="min-w-0 flex-1"><div class="flex items-center justify-between gap-2"><p class="truncate text-sm font-semibold text-[var(--text-primary)]">{member.name}</p>{#if member.relationship === 'self'}<span class="text-[10px] uppercase tracking-wide text-[var(--text-accent)]">You</span>{:else}<button class="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs text-rose-300 hover:bg-rose-400/10 disabled:opacity-50" onclick={() => setPartyMembership(member, false)} disabled={partyBusyId !== null}><UserMinus class="h-3.5 w-3.5" />Remove</button>{/if}</div><input class="mt-1.5 min-h-9 w-full rounded-lg border border-[var(--border-primary)] bg-black/30 px-2.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" value={roleDrafts[member.id] ?? characterPartyRole(member)} oninput={(event) => roleDrafts = { ...roleDrafts, [member.id]: event.currentTarget.value }} aria-label={`${member.name} party role`} placeholder="Party role" /></div>
									</div>
									<div class="mt-2 flex flex-wrap gap-2"><button class="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--text-accent)] px-3 text-xs font-semibold text-[var(--text-on-accent)] disabled:opacity-50" onclick={() => generatePortrait(member)} disabled={partyBusyId !== null || portraitJobPending(member.id)}>{#if generatingPortraitId === member.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Sparkles class="h-3.5 w-3.5" />{/if}Generate</button><label class="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-white/8 px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-white/12"><Camera class="h-3.5 w-3.5" />Upload<input class="sr-only" type="file" accept="image/*" onchange={(event) => loadPortraitFile(event, member)} /></label><input class="min-h-9 min-w-0 flex-1 rounded-lg border border-[var(--border-primary)] bg-black/30 px-2.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)]" value={portrait} oninput={(event) => portraitDrafts = { ...portraitDrafts, [member.id]: event.currentTarget.value }} aria-label={`${member.name} portrait URL`} placeholder="https://… portrait URL" /><button class="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-white/8 px-3 text-xs font-semibold text-[var(--text-primary)] disabled:opacity-50" onclick={() => savePartyDetails(member)} disabled={partyBusyId !== null}>{#if partyBusyId === member.id && generatingPortraitId !== member.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Save class="h-3.5 w-3.5" />{/if}Save</button>{#if member.portrait}<button class="min-h-9 rounded-lg px-2 text-xs text-[var(--text-muted)] hover:bg-white/8" onclick={() => savePartyDetails(member, null)} disabled={partyBusyId !== null}>Clear</button>{/if}</div>
					{#if portraitJobMessage(member.id)}<p role="status" class="mt-2 text-xs text-[var(--text-secondary)]">{portraitJobMessage(member.id)}</p>{/if}
								</div>
							{/each}
						</article>

						<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4">
							<div class="flex items-center justify-between gap-2"><h3 class="font-semibold text-[var(--text-primary)]">Add a known character</h3><span class="text-xs text-[var(--text-muted)]">{availablePartyCharacters.length} available</span></div>
							{#if availablePartyCharacters.length}
								<div class="mt-3 space-y-2">{#each availablePartyCharacters as character}<div class="flex items-center gap-3 rounded-xl bg-[var(--bg-primary)]/45 p-2"><div class="h-12 w-10 shrink-0 overflow-hidden rounded-lg bg-[radial-gradient(circle_at_50%_20%,rgba(198,166,108,0.3),var(--bg-primary)_70%)]">{#if character.portrait}<img src={character.portrait} alt="" class="h-full w-full object-cover" />{:else}<div class="flex h-full items-center justify-center font-display text-sm text-[var(--text-accent)]">{characterInitials(character.name)}</div>{/if}</div><div class="min-w-0 flex-1"><p class="truncate text-sm font-semibold text-[var(--text-primary)]">{character.name}</p><p class="truncate text-xs text-[var(--text-muted)]">{character.relationship ?? 'Known character'}</p></div><button class="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-white/8 px-3 text-xs font-semibold text-[var(--text-accent)] hover:bg-white/12 disabled:opacity-50" onclick={() => setPartyMembership(character, true)} disabled={partyBusyId !== null}>{#if partyBusyId === character.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<UserPlus class="h-3.5 w-3.5" />{/if}Add</button></div>{/each}</div>
							{:else}<p class="mt-3 text-sm text-[var(--text-muted)]">Every active character is already traveling with the party.</p>{/if}
						</article>
					{/if}
					{#if partyError}<p class="rounded-xl bg-rose-400/10 px-3 py-2 text-xs text-rose-300">{partyError}</p>{/if}
				{:else if tab === 'now'}
					<CampaignFacts />
					{#if story.currentStory?.serverStoryId}<MemoryProcessingStatus storyId={story.currentStory.serverStoryId} />{/if}
					{#if currentLocation}<article class="relative overflow-hidden rounded-2xl border border-[var(--text-accent)]/15 bg-[linear-gradient(145deg,rgba(198,166,108,0.11),var(--bg-tertiary))] p-4"><div class="flex items-center justify-between gap-3 text-[var(--text-accent)]"><span class="flex items-center gap-2 text-xs font-semibold"><MapPin class="h-4 w-4" />Current scene</span>{#if time}<span class="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><Clock class="h-3.5 w-3.5" />{time}</span>{/if}</div><h3 class="mt-3 font-display text-2xl text-[var(--text-primary)]">{currentLocation.name}</h3>{#if currentLocation.description}<p class="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{currentLocation.description}</p>{/if}</article>{:else if time}<div class="flex items-center gap-2 rounded-xl bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-secondary)]"><Clock class="h-4 w-4 text-[var(--text-accent)]" />{time}</div>{/if}
					<div class="grid grid-cols-3 gap-2">
						<div class="rounded-xl bg-[var(--bg-tertiary)] px-3 py-2.5"><p class="text-lg font-semibold text-[var(--text-primary)]">{nowCharacters.length}</p><p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">In scene</p></div>
						<div class="rounded-xl bg-[var(--bg-tertiary)] px-3 py-2.5"><p class="text-lg font-semibold text-[var(--text-primary)]">{knownSchemes.length + activeAgreements.length}</p><p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Threads</p></div>
						<div class="rounded-xl bg-[var(--bg-tertiary)] px-3 py-2.5"><p class="text-lg font-semibold text-[var(--text-primary)]">{story.items.length}</p><p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Items</p></div>
					</div>
					{#if nowCharacters.length}<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4"><div class="flex items-center gap-2 text-xs font-semibold text-[var(--text-accent)]"><Users class="h-4 w-4" />Present</div><div class="mt-2 flex flex-wrap gap-2">{#each nowCharacters as character}<button class="rounded-full bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:text-[var(--text-accent)]" onclick={() => openCharacterSheet(character, 'now')}>{character.name}</button>{/each}</div></article>{/if}
					{#if visibleMeters.length}<article class="space-y-3 rounded-2xl bg-[var(--bg-tertiary)] p-4">{#each visibleMeters as meter}{@const percent = Math.max(0, Math.min(100, meter.value / Math.max(1, meter.max) * 100))}<div><div class="flex justify-between text-xs text-[var(--text-secondary)]"><span>{meter.name}</span><span>{meter.value}/{meter.max}</span></div><div class="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--bg-primary)]"><div class="h-full rounded-full bg-[var(--text-accent)]" style:width={`${percent}%`}></div></div></div>{/each}</article>{/if}
					{#if knownSchemes.length || activeAgreements.length}<button class="flex min-h-11 w-full items-center justify-between rounded-xl bg-[var(--bg-tertiary)] px-4 text-left text-sm text-[var(--text-secondary)]" onclick={() => tab = 'threads'}><span>{knownSchemes.length + activeAgreements.length} active {knownSchemes.length + activeAgreements.length === 1 ? 'thread' : 'threads'}</span><ScrollText class="h-4 w-4" /></button>{/if}
				{:else if tab === 'people'}
					{#each story.characters.filter(character => character.status === 'active') as character}<button class="flex w-full gap-3 rounded-2xl bg-[var(--bg-tertiary)] p-3 text-left transition hover:bg-white/8" onclick={() => openCharacterSheet(character, 'people')}><div class="h-20 w-16 shrink-0 overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_20%,rgba(198,166,108,0.3),var(--bg-primary)_70%)]">{#if character.portrait}<img src={character.portrait} alt={`${character.name} portrait`} class="h-full w-full object-cover" />{:else}<div class="flex h-full items-center justify-center font-display text-xl text-[var(--text-accent)]">{characterInitials(character.name)}</div>{/if}</div><div class="min-w-0 flex-1"><div class="flex items-center justify-between gap-2"><h3 class="truncate font-semibold text-[var(--text-primary)]">{character.name}</h3><span class="text-xs text-[var(--text-muted)]">{characterMetadata(character).partyMember === true ? 'party' : character.relationship ?? 'known'}</span></div>{#if publicCharacterDescription(character)}<p class="mt-1 overflow-hidden text-sm leading-relaxed text-[var(--text-secondary)]" style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical">{publicCharacterDescription(character)}</p>{/if}</div></button>{/each}
				{:else if tab === 'places'}
					{#each story.locations.filter(location => location.visited || location.current) as location}<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4"><h3 class="flex items-center gap-2 font-semibold {location.current ? 'text-[var(--text-accent)]' : 'text-[var(--text-primary)]'}"><MapPin class="h-4 w-4" />{location.name}</h3>{#if location.description}<p class="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{location.description}</p>{/if}</article>{/each}
				{:else if tab === 'factions'}
					{#if factionEntries.length === 0}
						<article class="rounded-2xl border border-dashed border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-5">
							<h3 class="font-semibold text-[var(--text-primary)]">No active faction engines yet</h3>
							<p class="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{factionReferences.length} faction-like lore references remain available in the archive, but they will not make background moves until they have a tracked goal, project, member, territory, resource, or are explicitly enabled.</p>
						</article>
					{:else}
					{#each factionEntries as entry}
						{@const state = factionState(entry)}
						{@const move = latestFactionMove(entry.name)}
						<article class="rounded-2xl bg-[var(--bg-tertiary)] p-4">
							<div class="flex items-center justify-between gap-2"><h3 class="flex items-center gap-2 font-semibold text-[var(--text-primary)]"><Flag class="h-4 w-4 text-[var(--text-accent)]" />{entry.name}</h3><span class="text-xs capitalize text-[var(--text-muted)]">{state.disposition ?? state.status ?? 'tracked'}</span></div>
							{#if state.goals?.[0]}<p class="mt-2 text-sm text-[var(--text-secondary)]">Goal: {state.goals[0].description}</p>{:else if entry.description}<p class="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{entry.description}</p>{/if}
							{#if typeof state.pressure === 'number'}<div class="mt-3"><div class="flex justify-between text-[10px] uppercase tracking-wide text-[var(--text-muted)]"><span>World pressure</span><span>{state.pressure}/100</span></div><div class="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--bg-primary)]"><div class="h-full rounded-full bg-[var(--text-accent)]" style:width={`${Math.max(0, Math.min(100, state.pressure))}%`}></div></div></div>{/if}
							{#if state.projects?.[0]}<p class="mt-2 text-xs text-[var(--text-muted)]">Project: {state.projects[0].project} · {Math.round(state.projects[0].progress * 100)}%</p>{/if}
							{#if move}<div class="mt-3 rounded-xl bg-[var(--bg-primary)]/70 px-3 py-2"><p class="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-accent)]">Latest background move</p><p class="mt-1 text-sm text-[var(--text-primary)]">{move.action}</p>{#if move.motivation}<p class="mt-1 text-xs text-[var(--text-muted)]">Why: {move.motivation}</p>{/if}</div>{/if}
						</article>
					{/each}
					{/if}
				{:else if tab === 'threads'}
					<ThreadManager />
					<CommitmentManager />
				{:else if tab === 'director'}
					<PlotDirectorPanel />
				{:else}
					{#each story.items as item}<article class="flex gap-3 rounded-2xl bg-[var(--bg-tertiary)] p-4"><Package class="mt-0.5 h-4 w-4 text-[var(--text-accent)]" /><div><h3 class="font-semibold text-[var(--text-primary)]">{item.name}{item.quantity > 1 ? ` ×${item.quantity}` : ''}</h3>{#if item.description}<p class="mt-1 text-sm text-[var(--text-secondary)]">{item.description}</p>{/if}{#if item.equipped}<p class="mt-1 text-xs text-[var(--text-accent)]">Equipped</p>{/if}</div></article>{/each}
				{/if}
			</div>
			<footer class="shrink-0 border-t border-[var(--border-primary)] px-5 py-4"><button class="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--text-accent)]/50" onclick={onOpenLore}><BookOpen class="h-4 w-4 text-[var(--text-accent)]" />Open full lore archive</button></footer>
		</div>
	</div>
{/if}

<style>
	.character-portrait-stage { height: clamp(18rem, 52dvh, 40rem); padding: 1rem; }
	@media (min-width: 1024px) {
		.world-panel-portrait { max-width: 44rem; }
		.character-portrait-stage { height: clamp(18rem, calc(100dvh - 22rem), 44rem); }
	}
	.world-panel-content { scrollbar-gutter: stable; }
	.world-panel-content article { box-shadow: 0 1px 0 var(--border-secondary); }
	.world-panel-content h3:not(.font-display) { font-family: var(--font-display); font-size: 1.15rem; line-height: 1.4; font-weight: 500; }
	.world-panel-content h4 { letter-spacing: 0.025em; }
	.world-section-nav button { flex: 1 0 auto; transition: color 150ms ease, background 150ms ease; }
	.world-panel-header button:hover { background: var(--bg-tertiary); color: var(--text-primary); }
	@media (max-width: 639px) {
		.world-panel-header { padding-top: 0.9rem; padding-bottom: 1rem; }
		.world-panel-header h2 { font-size: 1.65rem; }
		.world-panel-content { padding: 1rem; }
	}
</style>
