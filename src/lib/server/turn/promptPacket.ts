import type { TurnContext } from './context';
import type { RetrievedMemoryPacket } from '$lib/contracts/memory';

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function compact(value: string | null | undefined, max = 360): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
}

function renderEntries(ctx: TurnContext, currentEntryId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
	const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
	for (const entry of ctx.recentEntries) {
		if (entry.id === currentEntryId) continue;
		if (entry.type === 'user_action') messages.push({ role: 'user', content: entry.content });
		if (entry.type === 'narration') messages.push({ role: 'assistant', content: entry.content });
	}
	return messages.slice(-24);
}

export function buildServerTurnPrompt(
	ctx: TurnContext,
	retrieved: RetrievedMemoryPacket,
	currentEntryId: string,
): { system: string; prompt: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
	const storyHeader = ctx.story.headerPrompt?.trim();
	const metadata = ctx.story.metadata && typeof ctx.story.metadata === 'object' ? ctx.story.metadata as Record<string, unknown> : {};
	const playerReputation = typeof metadata.playerReputation === 'string' ? metadata.playerReputation : '';
	const currentLocation = ctx.entities.find((entity) => entity.type === 'location' && (entity.state as Record<string, unknown> | null)?.current === true);
	const presentEntities = ctx.entities.filter((entity) => {
		const state = entity.state as Record<string, unknown> | null;
		return state?.present === true || state?.current === true || entity.id === currentLocation?.id;
	}).slice(0, 16);

	const factionLines = ctx.factions.slice(0, 12).map((faction) => {
		const normalizedGoals = ctx.factionGoals
			.filter((goal) => goal.factionId === faction.id && goal.status !== 'closed')
			.sort((a, b) => b.priority - a.priority)
			.slice(0, 3)
			.map((goal) => goal.goal)
			.join('; ');
		const normalizedMembers = ctx.factionMemberships
			.filter((membership) => membership.factionId === faction.id && membership.status === 'active')
			.slice(0, 8)
			.map((membership) => membership.entityId ?? String((membership.metadata as Record<string, unknown>).memberNameOrId ?? 'unknown'))
			.join(', ');
		const normalizedResources = ctx.factionResources
			.filter((resource) => resource.factionId === faction.id)
			.slice(0, 8)
			.map((resource) => `${resource.name}${resource.amount != null ? `=${resource.amount}` : ''}`)
			.join(', ');
		const goals = normalizedGoals || asStringArray(faction.goals).slice(0, 3).join('; ');
		const members = normalizedMembers || asStringArray(faction.memberEntityIds).slice(0, 8).join(', ');
		const resources = normalizedResources || compact(JSON.stringify(faction.resources), 220);
		return `- ${faction.name}: pressure ${faction.pressure}; goals: ${goals || 'unknown'}; members: ${members || 'unknown'}; resources: ${resources || 'unknown'}`;
	});

	const beliefLines = ctx.beliefs.slice(0, 16).map((belief) =>
		`- ${belief.believerEntityId}${belief.subjectEntityId ? ` about ${belief.subjectEntityId}` : ''}: ${compact(belief.belief, 220)} (${Math.round(belief.confidence * 100)}% confidence)`
	);

	const threadLines = ctx.threads.slice(0, 16).map((thread) =>
		`- ${thread.status}/${thread.significance}: ${compact(thread.description, 220)}`
	);

	const agreementLines = ctx.agreements.slice(0, 12).map((agreement) =>
		`- ${agreement.status} ${agreement.category}: ${agreement.parties.join(' + ')} - ${compact(agreement.terms, 220)}`
	);

	const eventLines = ctx.events.slice(0, 12).map((event) =>
		`- ${event.type}: ${event.title} - ${compact(event.body, 220)}`
	);

	const entityLines = presentEntities.map((entity) =>
		`- ${entity.type}: ${entity.name}${entity.description ? ` - ${compact(entity.description, 220)}` : ''}`
	);

	const system = [
		storyHeader ? `Story-specific preamble:\n${storyHeader}` : '',
		'You are the server-side narrator for a text adventure.',
		'Write direct, playable text adventure narration. Do not write like an interactive novel chapter.',
		'Resolve the immediate player action, show consequences, and keep the player able to act next.',
		'NPC knowledge is limited by senses, access, intelligence, rumor delay, and what they personally learned. They cannot see through doors, know private scenes, or instantly learn distant events.',
		'Use narrator truth for narration, but never make a present NPC act on secret canon unless their belief packet or the scene gives them a source.',
		'Political pressure should build gradually. Avoid constant twists; prefer slow escalation, debts, rumors, small moves, and delayed consequences.',
	].filter(Boolean).join('\n\n');

	const prompt = [
		`Story: ${ctx.story.title}`,
		ctx.story.description ? `Setting: ${ctx.story.description}` : '',
		playerReputation ? `Player reputation:\n${playerReputation}` : '',
		currentLocation ? `Current location:\n${currentLocation.name}: ${compact(currentLocation.description, 500)}` : '',
		entityLines.length ? `Present or active entities:\n${entityLines.join('\n')}` : '',
		factionLines.length ? `Faction canon:\n${factionLines.join('\n')}` : '',
		beliefLines.length ? `Actor belief limits:\n${beliefLines.join('\n')}` : '',
		agreementLines.length ? `Agreements and obligations:\n${agreementLines.join('\n')}` : '',
		threadLines.length ? `Open plot ledger:\n${threadLines.join('\n')}` : '',
		eventLines.length ? `Recent source-linked events:\n${eventLines.join('\n')}` : '',
		retrieved.packet,
		'Return only the narration prose for the player action. Do not include JSON in this response.',
	].filter(Boolean).join('\n\n');

	return {
		system,
		prompt,
		messages: renderEntries(ctx, currentEntryId),
	};
}

export function buildStateExtractionPrompt(playerText: string, narration: string): string {
	return [
		'Return a JSON object with a single key "update".',
		'The value of "update" must contain only facts that clearly changed or became known in this turn.',
		'Use these optional keys when applicable: characters, locations, items, time_delta, mood, player_reputation, conversations, relationships, story_beats, meter_changes, agreements, lorebook_entries.',
		'Do not invent extra facts. Do not summarize prose. Do not mark NPCs as knowing things they could not perceive or learn.',
		'Player action:',
		playerText,
		'Narration:',
		narration,
	].join('\n\n');
}
