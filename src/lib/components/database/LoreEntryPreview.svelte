<script lang="ts">
	import { characterStateView } from '$lib/utils/characterState';
	import { formatProposalDescription, formatProposalSummary } from '$lib/services/canonProposalDisplay';

	let { record }: { record: Record<string, unknown> } = $props();
	const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
	const lines = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
	const state = $derived(object(record.state));
	const character = $derived(characterStateView(record.state));
	const isCharacter = $derived(record.type === 'character');
	const isProposal = $derived(Boolean(record.proposalType || record.proposal_type));
	const description = $derived(isCharacter ? text(character.bio || record.description) : isProposal ? formatProposalDescription(record) : text(record.description || record.summary || record.content || record.terms || record.goal));
	const traits = $derived(isCharacter ? [
		{ label: 'Appearance', value: text(character.appearance) },
		{ label: 'Personality', value: text(character.personality) },
		{ label: 'Current presentation', value: text(character.presentation) },
		{ label: 'Voice & speech', value: text(character.speechStyle) },
	] : [
		{ label: 'Region', value: text(state.region) },
		{ label: 'Location', value: text(state.location) },
		{ label: 'Purpose', value: text(state.purpose) },
		{ label: 'Outcome', value: text(record.outcome) },
	]);
	const lists = $derived(isCharacter ? [
		{ label: 'Goals', values: lines(character.motivations) },
		{ label: 'Known facts', values: lines(character.knownFacts) },
	] : [
		{ label: 'Connections', values: lines(state.connections) },
		{ label: 'Known facts', values: lines(state.knownFacts) },
	]);
</script>

<article class="entry-preview">
	{#if isCharacter && (character.rank || character.currentDisposition || typeof object(character.relationship).level === 'number')}
		<dl class="at-a-glance">
			{#if character.rank}<div><dt>Rank</dt><dd>{text(character.rank)}</dd></div>{/if}
			{#if character.currentDisposition}<div class="disposition"><dt>Disposition</dt><dd>{text(character.currentDisposition)}</dd></div>{/if}
			{#if typeof object(character.relationship).level === 'number'}<div><dt>Affinity</dt><dd class="affinity">{Number(object(character.relationship).level) > 0 ? '+' : ''}{text(object(character.relationship).level)}</dd></div>{/if}
		</dl>
	{/if}
	<section class="overview">
		<h3>{isCharacter ? 'Biography' : isProposal ? formatProposalSummary(record) : 'Overview'}</h3>
		{#if description}
			<p class="description">{description}</p>
		{:else}
			<p class="empty-description">No description yet. Edit this entry to add what matters.</p>
		{/if}
	</section>
	{#if traits.some((trait) => trait.value)}
		<div class="traits">
			{#each traits.filter((trait) => trait.value) as trait}
				<section><h3>{trait.label}</h3><p>{trait.value}</p></section>
			{/each}
		</div>
	{/if}
	{#each lists.filter((list) => list.values.length) as list}
		<section class="fact-list"><h3>{list.label}</h3><ul>{#each list.values as value}<li>{value}</li>{/each}</ul></section>
	{/each}
	{#if isCharacter && lines(character.factionTags).length}
		<section><h3>Factions</h3><div class="tags">{#each lines(character.factionTags) as tag}<span>{tag}</span>{/each}</div></section>
	{/if}
	{#if record.type === 'concept'}
		<dl class="at-a-glance">
			<div><dt>Knowledge</dt><dd>{state.revealed === true ? 'Revealed to player' : 'Unrevealed'}</dd></div>
			<div><dt>Comprehension</dt><dd>{text(state.comprehensionLevel) || 'Unknown'}</dd></div>
		</dl>
	{/if}
</article>

<style>
	.entry-preview { display: grid; gap: 28px; min-width: 0; }
	h3, dt { color: var(--text-muted); font: 500 11px/1.5 var(--font-ui); letter-spacing: .09em; text-transform: uppercase; margin: 0 0 10px; }
	p { color: var(--text-secondary); font-size: 14px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
	.description { font-family: var(--font-story); font-size: 18px; line-height: 1.85; color: var(--text-primary); }
	.empty-description { color: var(--text-muted); font-style: italic; }
	.at-a-glance { display: flex; flex-wrap: wrap; gap: 20px 32px; padding-bottom: 22px; border-bottom: 1px solid var(--border-secondary); margin: 0; }
	.at-a-glance > div { flex: 1; min-width: 90px; }
	dt { margin-bottom: 6px; }
	dd { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
	.affinity { color: var(--text-accent); font-variant-numeric: tabular-nums; }
	.traits { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 26px; padding-top: 24px; border-top: 1px solid var(--border-secondary); }
	.fact-list { border-top: 1px solid var(--border-secondary); padding-top: 24px; }
	ul { display: grid; gap: 10px; margin: 0; padding-left: 18px; color: var(--text-secondary); font-size: 14px; line-height: 1.75; }
	li { padding-left: 4px; overflow-wrap: anywhere; }
	li::marker { color: var(--text-accent); }
	.tags { display: flex; flex-wrap: wrap; gap: 8px; }
	.tags span { color: var(--text-accent); border: 1px solid var(--border-primary); background: rgba(212,174,104,.05); border-radius: 5px; padding: 5px 10px; font-size: 12px; }
	@media (max-width: 640px) { .traits { grid-template-columns: 1fr; } .description { font-size: 17px; } .at-a-glance .disposition { flex-basis: 100%; order: 1; } }
</style>
