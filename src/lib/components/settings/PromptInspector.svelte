<script lang="ts">
	import { Trash2, ChevronDown, ChevronUp, AlertCircle, Clock, Cpu, Thermometer, Hash } from 'lucide-svelte';
	import { getApiLog, clearApiLog, onApiLogChange, type APILogEntry } from '$lib/services/ai/sdk/generate';

	let entries = $state<APILogEntry[]>([...getApiLog()]);
	let expandedId = $state<string | null>(null);
	let filter = $state<string>('all');

	// Subscribe to log changes
	$effect(() => {
		const unsub = onApiLogChange(() => {
			entries = [...getApiLog()];
		});
		return unsub;
	});

	const filteredEntries = $derived(
		filter === 'all'
			? entries
			: filter === 'errors'
				? entries.filter(e => e.error)
				: entries.filter(e => e.service === filter)
	);

	const uniqueServices = $derived([...new Set(entries.map(e => e.service))].sort());

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function truncate(s: string, len: number): string {
		return s.length > len ? s.slice(0, len) + '...' : s;
	}
</script>

<div class="space-y-4">
	<!-- Info -->
	<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3">
		<div class="text-sm font-semibold text-[var(--text-primary)]">API Log</div>
		<p class="text-[10px] text-[var(--text-muted)]">All API calls are logged automatically. Logs clear on page reload.</p>
	</div>

	{#if entries.length === 0}
		<div class="py-8 text-center text-sm text-[var(--text-muted)]">
			No API calls yet. Generate some content to see logs here.
		</div>
	{:else}
		<!-- Filter bar + clear -->
		<div class="flex items-center gap-2">
			<select class="flex-1 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"
				bind:value={filter}>
				<option value="all">All services ({entries.length})</option>
				<option value="errors">Errors only ({entries.filter(e => e.error).length})</option>
				{#each uniqueServices as svc}
					<option value={svc}>{svc} ({entries.filter(e => e.service === svc).length})</option>
				{/each}
			</select>
			{#if entries.length > 0}
				<button class="flex items-center gap-1 rounded-lg border border-[var(--border-primary)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:text-red-400"
					onclick={() => { clearApiLog(); expandedId = null; }}>
					<Trash2 class="h-3 w-3" /> Clear
				</button>
			{/if}
		</div>

		<!-- Log entries (newest first) -->
		{#if filteredEntries.length === 0}
			<div class="py-6 text-center text-sm text-[var(--text-muted)]">
				{#if filter !== 'all'}No matching entries.{:else}No API calls captured yet. Generate some content to see logs here.{/if}
			</div>
		{:else}
			<div class="space-y-1.5 max-h-[50vh] overflow-y-auto pr-1">
				{#each [...filteredEntries].reverse() as entry (entry.id)}
					{@const isExpanded = expandedId === entry.id}
					<div class="rounded-lg border overflow-hidden
						{entry.error
							? 'border-red-500/30 bg-red-500/5'
							: 'border-[var(--border-primary)] bg-[var(--bg-tertiary)]'}">

						<!-- Entry header -->
						<button class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[rgba(212,168,83,0.02)]"
							onclick={() => expandedId = isExpanded ? null : entry.id}>
							{#if entry.error}
								<AlertCircle class="h-3 w-3 shrink-0 text-red-400" />
							{:else}
								<div class="h-2 w-2 shrink-0 rounded-full bg-emerald-400"></div>
							{/if}
							<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-accent)]">{entry.service}</span>
							<span class="flex-1 truncate text-[10px] text-[var(--text-muted)]">{truncate(entry.prompt, 60)}</span>
							<span class="shrink-0 font-mono text-[9px] text-[var(--text-muted)]">{entry.durationMs}ms</span>
							{#if isExpanded}<ChevronUp class="h-3 w-3 shrink-0 text-[var(--text-muted)]" />{:else}<ChevronDown class="h-3 w-3 shrink-0 text-[var(--text-muted)]" />{/if}
						</button>

						<!-- Expanded details -->
						{#if isExpanded}
							<div class="border-t border-[var(--border-primary)] space-y-3 px-3 py-3">
								<!-- Meta row -->
								<div class="flex flex-wrap gap-3 text-[10px] text-[var(--text-muted)]">
									<span class="flex items-center gap-1"><Clock class="h-3 w-3" /> {formatTime(entry.timestamp)}</span>
									<span class="flex items-center gap-1"><Cpu class="h-3 w-3" /> {entry.model}</span>
									<span class="flex items-center gap-1"><Thermometer class="h-3 w-3" /> {entry.temperature.toFixed(1)}</span>
									<span class="flex items-center gap-1"><Hash class="h-3 w-3" /> {entry.maxTokens} max</span>
									{#if entry.tokenEstimate}
										<span>~{entry.tokenEstimate} tokens</span>
									{/if}
								</div>

								<!-- System prompt -->
								<div class="space-y-1">
									<div class="font-mono text-[9px] uppercase tracking-widest text-[var(--text-muted)]">System Prompt</div>
									<pre class="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg-primary)] p-2 font-mono text-[10px] text-[var(--text-primary)] leading-relaxed">{entry.system}</pre>
								</div>

								<!-- Conversation history -->
								{#if entry.conversationHistory?.length}
									<div class="space-y-1">
										<div class="font-mono text-[9px] uppercase tracking-widest text-[var(--text-muted)]">Conversation History ({entry.conversationHistory.length} messages)</div>
										<div class="max-h-48 overflow-auto rounded-md bg-[var(--bg-primary)] p-2 space-y-2">
											{#each entry.conversationHistory as msg, i}
												<div>
													<span class="font-mono text-[9px] uppercase tracking-widest {msg.role === 'user' ? 'text-cyan-400' : 'text-emerald-400'}">{msg.role}</span>
													<pre class="whitespace-pre-wrap font-mono text-[10px] text-[var(--text-primary)] leading-relaxed mt-0.5">{truncate(msg.content, 500)}</pre>
												</div>
											{/each}
										</div>
									</div>
								{/if}

								<!-- User prompt -->
								<div class="space-y-1">
									<div class="font-mono text-[9px] uppercase tracking-widest text-[var(--text-muted)]">User Prompt</div>
									<pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg-primary)] p-2 font-mono text-[10px] text-[var(--text-primary)] leading-relaxed">{entry.prompt}</pre>
								</div>

								<!-- Response -->
								<div class="space-y-1">
									<div class="font-mono text-[9px] uppercase tracking-widest text-[var(--text-muted)]">Response</div>
									{#if entry.error}
										<div class="rounded-md bg-red-500/10 p-2 font-mono text-[10px] text-red-400">{entry.error}</div>
									{/if}
									{#if entry.response}
										<pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--bg-primary)] p-2 font-mono text-[10px] text-[var(--text-primary)] leading-relaxed">{entry.response}</pre>
									{:else if !entry.error}
										<div class="text-[10px] text-[var(--text-muted)] italic">Empty response</div>
									{/if}
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
