<script lang="ts">
	import type { ContextSelection } from '$lib/contracts/memory';
	let { selection, projectId, gameId }: { selection: ContextSelection; projectId?: string; gameId?: string } = $props();
	const sourceHref = (id: string) => {
		if (!projectId || !gameId || !/^(content:[^@]+|canonical:[^:]+:[^@]+)@\d+/.test(id)) return '';
		const params = new URLSearchParams({ source: id, project: projectId, game: gameId });
		return `/?${params}`;
	};
	const labels: Record<string, string> = { playerCorrections: 'Player corrections', requiredPlayer: 'Required player state', requiredScene: 'Required current scene', requiredActors: 'Required active actors', requiredBeliefs: 'Required NPC beliefs', contentPinned: 'Authored pinned full text', contentPartial: 'Authored partial directory', recentEntries: 'Dialogue', sceneCheckpointNotes: 'Scene continuity notes', memoryNodes: 'Retrieved memories', timelineEvents: 'Timeline', chapters: 'Chapters', arcs: 'Arcs', sagas: 'Sagas', factionSheets: 'Factions', beliefs: 'NPC beliefs', agreements: 'Agreements', threads: 'Open threads', wikiBlocks: 'Wiki blocks', locationPlaces: 'Containing places', locationLore: 'Location lore' };
	const checkpointGroup = $derived(selection.groups.find(group => group.kind === 'sceneCheckpointNotes'));
</script>

<details class="mt-3 text-xs text-[var(--text-secondary)]">
	<summary class="cursor-pointer font-medium text-[var(--text-primary)]">What reached the narrator</summary>
	<p class="my-2 text-[var(--text-muted)]">Primary request selection. Sent counts fully retained excerpts. Partial excerpts lost text to the final budget. Omitted includes records excluded during selection.</p>
	{#if selection.requests?.length}
		<div class="my-3 space-y-2">
			{#each selection.requests as request (request.id)}
				<div class="flex flex-wrap justify-between gap-x-3 gap-y-1"><span>{request.label}</span><span class="tabular-nums">~{request.totalTokens.toLocaleString()} tokens · {request.totalChars.toLocaleString()} text characters</span></div>
			{/each}
			<p class="text-[var(--text-muted)]">Local estimates exclude provider framing. Roll continuation reuses the same scene and memory, adding pre-roll narration and the resolved roll.</p>
		</div>
	{/if}
	{#if selection.retrievals?.length}<details class="my-2"><summary>Query-driven lore retrieval</summary>{#each selection.retrievals as retrieval}<p>{retrieval.reason}. {retrieval.sent ? 'Sent' : 'Not sent after budgeting'} from {retrieval.sourceIds.length} scoped sources.</p><p>Query: {retrieval.query}</p><p class="break-all">Sources: {retrieval.sourceIds.join(', ')}</p>{/each}</details>{/if}
	<div class="overflow-x-auto">
		<table class="w-full min-w-[370px] text-left text-[11px] tabular-nums">
			<thead><tr class="border-b border-[var(--border-primary)]"><th class="py-1">Source</th><th>Loaded</th><th>Selected</th><th>Sent</th><th>Partial</th><th>Omitted</th></tr></thead>
			<tbody>
				{#each selection.groups.filter(group => group.loaded || group.selected) as group (group.kind)}
					<tr class="border-b border-[var(--border-secondary)]" title={[...group.partialIds.map(id => `Partial: ${id}`), ...group.omittedIds.map(id => `Budget omitted: ${id}`)].join('\n')}>
						<td class="py-1 pr-2">{labels[group.kind] ?? group.kind}</td><td>{group.loaded}</td><td>{group.selected}</td><td>{group.sent}</td><td>{group.partial}</td><td>{group.omitted}</td>
					</tr>
					{#if group.sentIds.length || group.partialIds.length || group.omittedIds.length}
						<tr class="border-b border-[var(--border-secondary)]">
							<td colspan="6" class="pb-2 pt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">
								{#if group.sentIds.length}<span>Sent: {#each group.sentIds as id, index}{#if index}, {/if}{#if sourceHref(id)}<a href={sourceHref(id)} class="underline">{id}</a>{:else}{id}{/if}{/each}</span>{/if}
								{#if group.partialIds.length}<span class="ml-2">Partial: {group.partialIds.join(', ')}</span>{/if}
								{#if group.omittedIds.length}<span class="ml-2">Omitted: {group.omittedIds.join(', ')}</span>{/if}
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>
	{#if selection.sceneCheckpoint}
		<details class="mt-3 rounded-lg border border-[var(--border-primary)] p-3">
			<summary class="cursor-pointer font-medium text-[var(--text-primary)]">Scene continuity · {checkpointGroup?.sent ?? 0} notes sent</summary>
			<p class="my-2">Primary POV{selection.sceneCheckpoint.scene ? ` · ${selection.sceneCheckpoint.scene}` : ''}. Checkpoint reviewed {selection.sceneCheckpoint.sourceCount} source entries, positions {selection.sceneCheckpoint.sourceStart}–{selection.sceneCheckpoint.sourceEnd}. Excerpts are selective; the original transcript is preserved.</p>
			<p class="mb-2 text-[var(--text-muted)]">Earlier narration can describe an old promise or an answered question. Current canon and later dialogue take precedence.</p>
			<ul class="space-y-3">
				{#each selection.sceneCheckpoint.notes as note (note.id)}
					<li>
						<div class="text-[var(--text-muted)]">Position {note.position} · {checkpointGroup?.sentIds.includes(note.id) ? 'Sent' : checkpointGroup?.partialIds.includes(note.id) ? 'Partially sent' : 'Omitted by budget'}</div>
						<blockquote class="my-1 border-l-2 border-[var(--border-primary)] pl-2">{note.text}</blockquote>
						<code class="break-all text-[10px] text-[var(--text-muted)]">{note.sourceEntryId}</code>
					</li>
				{/each}
			</ul>
		</details>
	{/if}
</details>
