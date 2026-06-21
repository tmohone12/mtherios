<script lang="ts">
	import { onMount } from 'svelte';
	import {
		AlertTriangle,
		BookOpen,
		Check,
		ClipboardList,
		FileText,
		GitMerge,
		Plus,
		RefreshCw,
		Search,
		X,
	} from 'lucide-svelte';
	import { listBackendStories, sendEngineCommand } from '$lib/services/serverStories';
	import {
		type ResolverApplyResult,
		addEntityAlias,
		createEntityThroughResolver,
		lintCanonWiki,
		mergeEntities,
		previewEntityResolution,
		readCanonPage,
		reviewPatchProposal,
		runContinuityAudit,
		searchCanonPages,
		type CanonRepairCandidate,
	} from '$lib/services/canonRepair';
	import {
		formatProposalDescription,
		formatProposalSubline,
		formatProposalSummary,
	} from '$lib/services/canonProposalDisplay';

	type JsonRecord = Record<string, unknown>;
	type Mode = 'pages' | 'resolver' | 'proposals' | 'merge' | 'audit';
	type StorySummary = {
		id: string;
		title?: string | null;
		serverVersion?: number | null;
		updatedAt?: string | number | null;
	};

	const tabs: Array<{
		id: Mode;
		label: string;
		icon: typeof BookOpen | typeof Search | typeof ClipboardList | typeof GitMerge | typeof AlertTriangle;
	}> = [
		{ id: 'pages', label: 'Pages', icon: BookOpen },
		{ id: 'resolver', label: 'Resolver', icon: Search },
		{ id: 'proposals', label: 'Proposals', icon: ClipboardList },
		{ id: 'merge', label: 'Merge', icon: GitMerge },
		{ id: 'audit', label: 'Audit', icon: AlertTriangle },
	];

	let stories = $state<StorySummary[]>([]);
	let selectedStoryId = $state('');
	let activeMode = $state<Mode>('pages');
	let status = $state('');
	let busy = $state(false);

	let pageQuery = $state('');
	let pageResults = $state<JsonRecord[]>([]);
	let selectedPage = $state<JsonRecord | null>(null);

	let entityQuery = $state('');
	let entityResults = $state<JsonRecord[]>([]);
	let selectedEntity = $state<JsonRecord | null>(null);

	let proposalQuery = $state('');
	let proposalRows = $state<JsonRecord[]>([]);
	let selectedProposal = $state<JsonRecord | null>(null);

	let resolverId = $state('');
	let resolverType = $state('character');
	let resolverName = $state('');
	let resolverAliases = $state('');
	let resolverDescription = $state('');
	let resolverSourceEntryIds = $state('');
	let resolverSourceEventIds = $state('');
	let resolverSourcePatchIds = $state('');
	let resolverPreview = $state<JsonRecord | null>(null);
	let resolverCreateResult = $state<ResolverApplyResult | null>(null);

	let aliasEntityId = $state('');
	let aliasValue = $state('');
	let mergeKeepId = $state('');
	let mergeSourceId = $state('');
	let mergeReason = $state('Duplicate entity merged through the cockpit.');

	let wikiLintReport = $state<JsonRecord | null>(null);
	let continuityAuditReport = $state<JsonRecord | null>(null);

	const selectedStory = $derived(stories.find((story) => story.id === selectedStoryId) ?? null);
	const pendingProposalRows = $derived.by(() =>
		proposalRows.filter((proposal) => ['pending', 'needs_review'].includes(String(proposal.status ?? ''))),
	);
	const resolverResolution = $derived.by(() => asRecord(resolverPreview?.resolution));

	function asRecord(value: unknown): JsonRecord | null {
		return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
	}

	function asRecordArray(value: unknown): JsonRecord[] {
		return Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonRecord => Boolean(item)) : [];
	}

	function preview(value: unknown): string {
		if (value == null) return '';
		if (typeof value === 'string') return value.length > 180 ? `${value.slice(0, 177)}...` : value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		const text = JSON.stringify(value, null, 2);
		return text.length > 180 ? `${text.slice(0, 177)}...` : text;
	}

	function displayText(value: unknown): string {
		if (value == null) return '';
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		return JSON.stringify(value, null, 2);
	}

	function splitList(value: string): string[] {
		return value
			.split(/[\n,]/g)
			.map((item) => item.trim())
			.filter(Boolean);
	}

	function buildResolverCandidate(): CanonRepairCandidate {
		return {
			id: resolverId.trim() || null,
			type: resolverType.trim() || 'character',
			name: resolverName.trim(),
			aliases: splitList(resolverAliases),
			description: resolverDescription.trim() || null,
			sourceEntryIds: splitList(resolverSourceEntryIds),
			sourceEventIds: splitList(resolverSourceEventIds),
			sourcePatchIds: splitList(resolverSourcePatchIds),
		};
	}

	function resolverDecisionFromPreview(preview: JsonRecord | null): 'update' | 'ask' | 'create' | 'merge' | null {
		const resolution = asRecord(preview?.resolution);
		const decision = resolution?.decision;
		if (decision === 'update' || decision === 'ask' || decision === 'create' || decision === 'merge') {
			return decision;
		}
		return null;
	}

	function resolverApplyButtonLabel(preview: JsonRecord | null): string {
		switch (resolverDecisionFromPreview(preview)) {
			case 'update':
				return 'Update matched entity';
			case 'merge':
				return 'Merge + apply';
			case 'create':
				return 'Create new entity';
			default:
				return 'Apply resolver output';
		}
	}

	async function runCommand(command: string, args: JsonRecord = {}, storyId = selectedStoryId || '__app__'): Promise<JsonRecord> {
		const response = await sendEngineCommand({ storyId, command, args });
		if (response.status !== 'succeeded') {
			throw new Error(response.error ?? `Engine command failed: ${command}`);
		}
		return asRecord(response.result) ?? {};
	}

	async function loadStories() {
		stories = await listBackendStories();
		if (!selectedStoryId && stories[0]) selectedStoryId = stories[0].id;
	}

	async function loadPages() {
		if (!selectedStoryId || !pageQuery.trim()) return;
		busy = true;
		status = '';
		try {
			const result = await searchCanonPages(selectedStoryId, pageQuery.trim(), 12);
			pageResults = asRecordArray(result.results);
			selectedPage = pageResults[0] ?? null;
			if (selectedPage) {
				const page = await readCanonPage(selectedStoryId, String(selectedPage.path ?? selectedPage.title ?? selectedPage.page ?? ''));
				selectedPage = asRecord(page) ?? selectedPage;
			}
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function selectPage(page: JsonRecord) {
		selectedPage = page;
		if (!selectedStoryId) return;
		const pageRef = String(page.path ?? page.title ?? page.page ?? '');
		if (!pageRef) return;
		busy = true;
		status = '';
		try {
			selectedPage = asRecord(await readCanonPage(selectedStoryId, pageRef)) ?? page;
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function loadEntities() {
		if (!selectedStoryId || !entityQuery.trim()) return;
		busy = true;
		status = '';
		try {
			const result = await runCommand('world.search', {
				q: entityQuery.trim(),
				type: 'entities',
				limit: 20,
				includeSemantic: true,
			});
			entityResults = asRecordArray(result.results);
			selectedEntity = entityResults[0] ?? null;
			if (selectedEntity?.recordType && selectedEntity?.recordId) {
				const detail = await runCommand('world.record.get', {
					type: String(selectedEntity.recordType),
					recordId: String(selectedEntity.recordId),
				});
				selectedEntity = asRecord(detail.record) ?? selectedEntity;
			}
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function selectEntity(row: JsonRecord) {
		selectedEntity = row;
		const recordId = String(row.id ?? row.recordId ?? '');
		if (!recordId) return;
		busy = true;
		status = '';
		try {
			const detail = await runCommand('world.record.get', { type: 'entities', recordId });
			selectedEntity = asRecord(detail.record) ?? row;
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function loadProposals() {
		if (!selectedStoryId) return;
		busy = true;
		status = '';
		try {
			const result = await runCommand('world.records', {
				type: 'patchProposals',
				q: proposalQuery.trim(),
				limit: 100,
			});
			proposalRows = asRecordArray(result.records);
			selectedProposal = proposalRows[0] ?? null;
			if (selectedProposal?.id) {
				const detail = await runCommand('world.record.get', {
					type: 'patchProposals',
					recordId: String(selectedProposal.id),
				});
				selectedProposal = asRecord(detail.record) ?? selectedProposal;
			}
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function selectProposal(row: JsonRecord) {
		selectedProposal = row;
		if (!selectedStoryId || !row.id) return;
		busy = true;
		status = '';
		try {
			const detail = await runCommand('world.record.get', {
				type: 'patchProposals',
				recordId: String(row.id),
			});
			selectedProposal = asRecord(detail.record) ?? row;
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function previewResolver() {
		if (!selectedStoryId || !resolverName.trim()) return;
		busy = true;
		status = '';
		try {
			resolverPreview = asRecord(await previewEntityResolution(selectedStoryId, buildResolverCandidate()));
			if (!resolverCreateResult || resolverCreateResult.operation !== 'review-required') {
				resolverCreateResult = null;
			}
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function applyResolverCandidate() {
		if (!selectedStoryId || !resolverName.trim()) return;
		busy = true;
		status = '';
		try {
			const result = await createEntityThroughResolver(selectedStoryId, buildResolverCandidate());
			resolverCreateResult = result;
			resolverPreview = asRecord(result.resolution ?? resolverPreview);
			const resultRecord = asRecord(result.result) ?? {};
			const resultEntity = asRecord(resultRecord.entity);
			const resultEntityId = resultEntity?.id ?? resultRecord.id ?? 'ok';
			const reviewReason = asRecord(result.resolution)?.reason;
			switch (result.operation) {
				case 'created':
					status = `Entity created: ${resultEntityId}.`;
					break;
				case 'updated':
					status = `Entity updated: ${resultEntityId}.`;
					break;
				case 'merged':
					status = 'Entities merged and resolver output applied.';
					break;
				case 'review-required':
					status = typeof reviewReason === 'string' ? reviewReason : 'Resolver requires manual review.';
					break;
				default:
					status = 'Resolver action completed.';
					break;
			}
			await loadEntities();
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function addAliasForEntity() {
		if (!selectedStoryId || !aliasEntityId.trim() || !aliasValue.trim()) return;
		busy = true;
		status = '';
		try {
			await addEntityAlias(selectedStoryId, aliasEntityId.trim(), aliasValue.trim());
			status = 'Alias added.';
			await loadEntities();
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function mergeDuplicateEntitiesFlow() {
		if (!selectedStoryId || !mergeKeepId.trim() || !mergeSourceId.trim()) return;
		busy = true;
		status = '';
		try {
			const result = await mergeEntities(selectedStoryId, mergeKeepId.trim(), mergeSourceId.trim(), mergeReason.trim() || 'Manual entity merge.');
			status = `Merged ${String(result.mergeEntityId)} into ${String(result.keepEntityId)}.`;
			await loadEntities();
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function reviewProposal(decision: 'approved' | 'rejected') {
		if (!selectedStoryId || !selectedProposal?.id) return;
		busy = true;
		status = '';
		try {
			await reviewPatchProposal(selectedStoryId, String(selectedProposal.id), decision, 'human', decision === 'approved'
				? 'Approved in the repair cockpit.'
				: 'Rejected in the repair cockpit.');
			status = `Patch proposal ${decision}.`;
			await loadProposals();
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function runWikiLint() {
		if (!selectedStoryId) return;
		busy = true;
		status = '';
		try {
			wikiLintReport = asRecord(await lintCanonWiki(selectedStoryId));
			status = 'Wiki lint complete.';
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	async function runAudit() {
		if (!selectedStoryId) return;
		busy = true;
		status = '';
		try {
			continuityAuditReport = asRecord(await runContinuityAudit(selectedStoryId, 20));
			status = 'Continuity audit complete.';
		} catch (error) {
			status = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		(async () => {
			await loadStories();
			await loadProposals();
		})();
	});
</script>

<div class="flex h-full min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
	<header class="flex flex-col gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-3 lg:flex-row lg:items-center lg:gap-3">
		<div class="flex min-w-0 items-center gap-2">
			<ClipboardList class="h-5 w-5 text-[var(--text-accent)]" />
			<div class="min-w-0">
				<div class="font-display text-sm tracking-wide text-[var(--text-accent)]">Canon Repair Cockpit</div>
				<div class="truncate text-xs text-[var(--text-muted)]">{selectedStory?.title ?? 'No story selected'}</div>
			</div>
		</div>

		<select
			bind:value={selectedStoryId}
			onchange={async () => {
				await loadProposals();
				if (activeMode === 'pages' && pageQuery.trim()) await loadPages();
				if (activeMode === 'resolver' && resolverName.trim()) await previewResolver();
				if (activeMode === 'merge' && entityQuery.trim()) await loadEntities();
			}}
			class="w-full min-w-0 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs text-[var(--text-primary)] lg:w-64"
		>
			{#each stories as item}
				<option value={item.id}>{item.title ?? item.id}</option>
			{/each}
		</select>

		<div class="flex min-w-0 flex-1 flex-wrap gap-1">
			{#each tabs as tab}
				<button
					class="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors {activeMode === tab.id
						? 'border-[var(--color-gold-600)] bg-[rgba(212,168,83,0.12)] text-[var(--text-accent)]'
						: 'border-[var(--border-primary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}"
					onclick={() => activeMode = tab.id}
				>
					<tab.icon class="h-3.5 w-3.5" />
					<span>{tab.label}</span>
				</button>
			{/each}
		</div>

		<div class="flex items-center gap-2">
			<button class="rounded-md border border-[var(--border-primary)] p-2 text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={loadProposals} title="Refresh proposals">
				<RefreshCw class="h-4 w-4" />
			</button>
		</div>
	</header>

	{#if status}
		<div class="border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-2 text-xs text-[var(--text-accent)]">{status}</div>
	{/if}

	<div class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
		<aside class="min-h-0 overflow-y-auto border-r border-[var(--border-primary)] bg-[var(--bg-secondary)]">
			{#if activeMode === 'pages'}
				<div class="space-y-3 p-4">
					<div class="space-y-2">
						<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Search canon pages</div>
						<div class="flex gap-2">
							<input bind:value={pageQuery} class="min-w-0 flex-1 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Search pages" onkeydown={(event) => event.key === 'Enter' && loadPages()} />
							<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={loadPages}>
								<Search class="h-4 w-4" />
							</button>
						</div>
					</div>

					<div class="space-y-1">
						<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Results</div>
						{#if pageResults.length === 0}
							<div class="rounded-md border border-dashed border-[var(--border-primary)] px-3 py-6 text-center text-xs text-[var(--text-muted)]">No results yet.</div>
						{:else}
							{#each pageResults as page}
								<button class="block w-full rounded-md border border-[var(--border-primary)] px-3 py-2 text-left text-xs hover:border-[var(--color-gold-600)] {selectedPage?.path === page.path ? 'bg-[rgba(212,168,83,0.08)]' : ''}" onclick={() => selectPage(page)}>
									<div class="truncate text-[var(--text-accent)]">{preview(page.title ?? page.path ?? page.id)}</div>
									<div class="truncate text-[var(--text-muted)]">{preview(page.path ?? page.id)}</div>
								</button>
							{/each}
						{/if}
					</div>
				</div>
			{:else if activeMode === 'resolver'}
				<div class="space-y-3 p-4">
					<div class="space-y-2">
						<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Resolver candidate</div>
						<div class="grid grid-cols-1 gap-2">
							<input bind:value={resolverId} class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Optional entity id" />
							<input bind:value={resolverType} class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Type" />
							<input bind:value={resolverName} class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Name" />
							<textarea bind:value={resolverAliases} class="min-h-20 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Aliases, one per line or comma separated"></textarea>
							<textarea bind:value={resolverDescription} class="min-h-24 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Description"></textarea>
							<input bind:value={resolverSourceEntryIds} class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Source entry ids" />
							<input bind:value={resolverSourceEventIds} class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Source event ids" />
							<input bind:value={resolverSourcePatchIds} class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Source patch ids" />
						</div>
						<div class="flex flex-wrap gap-2">
							<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={previewResolver}>
								<Search class="mr-1 inline h-4 w-4" /> Preview
							</button>
							<button
								class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)] disabled:opacity-50"
								onclick={applyResolverCandidate}
								disabled={resolverDecisionFromPreview(resolverPreview) === 'ask'}
								title={resolverDecisionFromPreview(resolverPreview) === 'ask' ? 'Resolver requested manual review. Review candidates first.' : 'Apply the current resolver decision'}
							>
								<Plus class="mr-1 inline h-4 w-4" /> {resolverApplyButtonLabel(resolverPreview)}
							</button>
						</div>
					</div>

					{#if resolverPreview}
						<div class="space-y-2 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
							<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Resolver result</div>
							<div class="text-xs text-[var(--text-secondary)]">
								Decision: <span class="text-[var(--text-accent)]">{resolverResolution?.decision ?? 'ask'}</span>
							</div>
							<div class="text-xs text-[var(--text-muted)]">
								Confidence: {resolverResolution?.confidence ?? 'n/a'}
							</div>
							<div class="text-xs text-[var(--text-muted)]">
								Reason: {resolverResolution?.reason ?? 'No reason provided.'}
							</div>
							<div class="text-xs text-[var(--text-muted)]">
								Match: {resolverResolution?.matchedEntityId ?? 'none'}
							</div>
							<pre class="max-h-72 overflow-auto whitespace-pre-wrap text-xs text-[var(--text-secondary)]">{JSON.stringify(resolverPreview, null, 2)}</pre>
						</div>
					{/if}

					{#if resolverCreateResult}
						<div class="space-y-2 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
							<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Resolver action result</div>
							<div class="text-xs text-[var(--text-muted)]">Operation: {resolverCreateResult.operation}</div>
							{#if resolverCreateResult.mergeResult}
								<div class="mt-2 text-xs text-[var(--text-muted)]">Merge result:</div>
								<pre class="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-[var(--text-secondary)]">{JSON.stringify(resolverCreateResult.mergeResult, null, 2)}</pre>
							{/if}
							<div class="mt-2 text-xs text-[var(--text-muted)]">Resolution payload:</div>
							<pre class="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-[var(--text-secondary)]">{JSON.stringify(resolverCreateResult.resolution, null, 2)}</pre>
							<div class="mt-2 text-xs text-[var(--text-muted)]">Record result:</div>
							<pre class="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-[var(--text-secondary)]">{JSON.stringify(resolverCreateResult, null, 2)}</pre>
						</div>
					{/if}
				</div>
			{:else if activeMode === 'proposals'}
				<div class="space-y-3 p-4">
					<div class="space-y-2">
						<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Review queue</div>
						<div class="flex gap-2">
							<input bind:value={proposalQuery} class="min-w-0 flex-1 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Filter proposals" onkeydown={(event) => event.key === 'Enter' && loadProposals()} />
							<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={loadProposals}>
								<Search class="h-4 w-4" />
							</button>
						</div>
						<div class="flex flex-wrap gap-2">
							<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={() => reviewProposal('approved')} disabled={!selectedProposal?.id}>
								<Check class="mr-1 inline h-4 w-4" /> Approve
							</button>
							<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={() => reviewProposal('rejected')} disabled={!selectedProposal?.id}>
								<X class="mr-1 inline h-4 w-4" /> Reject
							</button>
						</div>
					</div>

					<div class="space-y-1">
						<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Pending</div>
						{#if pendingProposalRows.length === 0}
							<div class="rounded-md border border-dashed border-[var(--border-primary)] px-3 py-6 text-center text-xs text-[var(--text-muted)]">No pending proposals.</div>
						{:else}
							{#each pendingProposalRows as proposal}
								<button class="block w-full rounded-md border border-[var(--border-primary)] px-3 py-2 text-left text-xs hover:border-[var(--color-gold-600)] {selectedProposal?.id === proposal.id ? 'bg-[rgba(212,168,83,0.08)]' : ''}" onclick={() => selectProposal(proposal)}>
									<div class="truncate text-[var(--text-accent)]">{formatProposalSummary(proposal)}</div>
									<div class="truncate text-[var(--text-muted)]">{formatProposalSubline(proposal)}</div>
								</button>
							{/each}
						{/if}
					</div>
				</div>
			{:else if activeMode === 'merge'}
				<div class="space-y-3 p-4">
					<div class="space-y-2">
						<div class="text-xs uppercase tracking-wide text-[var(--text-muted)]">Entity search</div>
						<div class="flex gap-2">
							<input bind:value={entityQuery} class="min-w-0 flex-1 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs" placeholder="Search entities" onkeydown={(event) => event.key === 'Enter' && loadEntities()} />
							<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={loadEntities}>
								<Search class="h-4 w-4" />
							</button>
						</div>
					</div>

					<div class="space-y-1">
						<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Matches</div>
						{#if entityResults.length === 0}
							<div class="rounded-md border border-dashed border-[var(--border-primary)] px-3 py-6 text-center text-xs text-[var(--text-muted)]">No entity matches yet.</div>
						{:else}
							{#each entityResults as entity}
								<button class="block w-full rounded-md border border-[var(--border-primary)] px-3 py-2 text-left text-xs hover:border-[var(--color-gold-600)] {selectedEntity?.id === entity.id ? 'bg-[rgba(212,168,83,0.08)]' : ''}" onclick={() => selectEntity(entity)}>
									<div class="truncate text-[var(--text-accent)]">{preview(entity.name ?? entity.title ?? entity.id)}</div>
									<div class="truncate text-[var(--text-muted)]">{preview(entity.type ?? entity.recordType)} / {preview(entity.id ?? entity.recordId)}</div>
								</button>
							{/each}
						{/if}
					</div>

					<div class="space-y-2 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
						<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Alias</div>
						<input bind:value={aliasEntityId} class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs" placeholder="Entity id" />
						<input bind:value={aliasValue} class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs" placeholder="Alias" />
						<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={addAliasForEntity}>
							<Plus class="mr-1 inline h-4 w-4" /> Add Alias
						</button>
					</div>

					<div class="space-y-2 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
						<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Merge</div>
						<input bind:value={mergeKeepId} class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs" placeholder="Keep entity id" />
						<input bind:value={mergeSourceId} class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs" placeholder="Merge entity id" />
						<textarea bind:value={mergeReason} class="min-h-20 rounded-md border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs" placeholder="Merge reason"></textarea>
						<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={mergeDuplicateEntitiesFlow}>
							<GitMerge class="mr-1 inline h-4 w-4" /> Merge
						</button>
					</div>
				</div>
			{:else if activeMode === 'audit'}
				<div class="space-y-3 p-4">
					<div class="flex flex-wrap gap-2">
						<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={runWikiLint}>
							<FileText class="mr-1 inline h-4 w-4" /> Wiki Lint
						</button>
						<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={runAudit}>
							<AlertTriangle class="mr-1 inline h-4 w-4" /> Continuity Audit
						</button>
					</div>

					{#if wikiLintReport}
						<div class="space-y-2 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
							<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Wiki lint</div>
							<pre class="max-h-72 overflow-auto whitespace-pre-wrap text-xs text-[var(--text-secondary)]">{JSON.stringify(wikiLintReport, null, 2)}</pre>
						</div>
					{/if}

					{#if continuityAuditReport}
						<div class="space-y-2 rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
							<div class="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Continuity audit</div>
							<pre class="max-h-72 overflow-auto whitespace-pre-wrap text-xs text-[var(--text-secondary)]">{JSON.stringify(continuityAuditReport, null, 2)}</pre>
						</div>
					{/if}
				</div>
			{/if}
		</aside>

		<section class="min-h-0 overflow-y-auto bg-[var(--bg-secondary)]">
			{#if activeMode === 'pages'}
				<div class="space-y-4 p-4">
					<div class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
						<div class="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Selected page</div>
						{#if selectedPage}
							<div class="text-sm text-[var(--text-accent)]">{preview(selectedPage.title ?? selectedPage.path ?? selectedPage.id)}</div>
							<div class="mt-1 text-xs text-[var(--text-muted)]">{preview(selectedPage.path ?? selectedPage.id)}</div>
							<pre class="mt-3 max-h-[70dvh] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">{displayText(selectedPage.text ?? selectedPage.body ?? selectedPage.content ?? selectedPage)}</pre>
						{:else}
							<div class="text-xs text-[var(--text-muted)]">Pick a page to inspect its canonical text.</div>
						{/if}
					</div>
				</div>
			{:else if activeMode === 'resolver'}
				<div class="space-y-4 p-4">
					<div class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
						<div class="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Resolver preview</div>
						{#if resolverPreview}
							<pre class="max-h-[70dvh] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">{JSON.stringify(resolverPreview, null, 2)}</pre>
						{:else}
							<div class="text-xs text-[var(--text-muted)]">Preview a candidate to see the backend resolver decision and matched entities.</div>
						{/if}
					</div>
					{#if resolverCreateResult}
						<div class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
							<div class="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Resolver action output</div>
							<div class="mb-1 text-xs text-[var(--text-muted)]">Operation: {resolverCreateResult.operation}</div>
							{#if resolverCreateResult.mergeResult}
								<div class="text-xs text-[var(--text-muted)]">Merge: {JSON.stringify(resolverCreateResult.mergeResult, null, 2)}</div>
							{/if}
							<pre class="max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">{JSON.stringify(resolverCreateResult, null, 2)}</pre>
						</div>
					{/if}
				</div>
			{:else if activeMode === 'proposals'}
				<div class="space-y-4 p-4">
					<div class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
						<div class="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Selected proposal</div>
						{#if selectedProposal}
							<div class="space-y-1">
								<div class="text-sm text-[var(--text-accent)]">{formatProposalSummary(selectedProposal)}</div>
								<div class="text-xs text-[var(--text-muted)]">{formatProposalSubline(selectedProposal)}</div>
								{#if formatProposalDescription(selectedProposal)}
									<div class="text-xs leading-relaxed text-[var(--text-secondary)]">{formatProposalDescription(selectedProposal)}</div>
								{/if}
							</div>
							<div class="mt-3 flex flex-wrap gap-2 text-xs text-[var(--text-muted)]">
								<span class="rounded border border-[var(--border-secondary)] px-2 py-1">{preview(selectedProposal.status)}</span>
								<span class="rounded border border-[var(--border-secondary)] px-2 py-1">{preview(selectedProposal.decision)}</span>
								<span class="rounded border border-[var(--border-secondary)] px-2 py-1">{preview(selectedProposal.proposalType)}</span>
								<span class="rounded border border-[var(--border-secondary)] px-2 py-1">{preview(selectedProposal.targetTable)}/{preview(selectedProposal.targetRecordId)}</span>
							</div>
							<div class="mt-3 flex flex-wrap gap-2">
								<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={() => reviewProposal('approved')} disabled={!selectedProposal?.id}>
									<Check class="mr-1 inline h-4 w-4" /> Approve
								</button>
								<button class="rounded-md border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]" onclick={() => reviewProposal('rejected')} disabled={!selectedProposal?.id}>
									<X class="mr-1 inline h-4 w-4" /> Reject
								</button>
							</div>
							<pre class="mt-3 max-h-[64dvh] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">{JSON.stringify(selectedProposal, null, 2)}</pre>
						{:else}
							<div class="text-xs text-[var(--text-muted)]">Choose a patch proposal to inspect its payload and review it here.</div>
						{/if}
					</div>
				</div>
			{:else if activeMode === 'merge'}
				<div class="space-y-4 p-4">
					<div class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
						<div class="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Selected entity</div>
						{#if selectedEntity}
							<pre class="max-h-[72dvh] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">{JSON.stringify(selectedEntity, null, 2)}</pre>
						{:else}
							<div class="text-xs text-[var(--text-muted)]">Search for an entity to inspect it before merging or aliasing.</div>
						{/if}
					</div>
				</div>
			{:else if activeMode === 'audit'}
				<div class="space-y-4 p-4">
					<div class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-4">
						<div class="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Audit output</div>
						{#if continuityAuditReport}
							<pre class="max-h-[72dvh] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--text-secondary)]">{JSON.stringify(continuityAuditReport, null, 2)}</pre>
						{:else}
							<div class="text-xs text-[var(--text-muted)]">Run a continuity audit to inspect open warnings and pending proposals.</div>
						{/if}
					</div>
				</div>
			{/if}
		</section>
	</div>
</div>
