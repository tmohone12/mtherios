export interface ParallelPovRequest {
	character: string;
	direction: string | null;
}

/** Source metadata survives immediate and deferred extraction; scene prose is not a mode switch. */
export function isParallelPovEntry(entry: { type?: string; content?: string; metadata?: unknown }): boolean {
	const metadata = entry.metadata && typeof entry.metadata === 'object'
		? entry.metadata as Record<string, unknown> : {};
	const request = metadata.parallelPov;
	return metadata.narrativeMode === 'parallel_pov'
		|| metadata.actionType === 'pov'
		|| Boolean(request && typeof request === 'object' && typeof (request as Record<string, unknown>).character === 'string')
		|| (['player', 'user_action'].includes(entry.type ?? '') && Boolean(parseParallelPovCommand(entry.content ?? '')));
}

export function latestNarrationForPov<T extends { id: string; type: string; content: string; parentId?: string | null; metadata?: unknown }>(entries: T[], pov?: ParallelPovRequest | null, sources: T[] = entries): T | undefined {
	const byId = new Map(sources.map(entry => [entry.id, entry]));
	return entries.findLast(entry => {
		if (entry.type !== 'narration') return false;
		const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
		const parallel = isParallelPovEntry(entry) || Boolean(parent && isParallelPovEntry(parent));
		if (!pov) return !parallel;
		if (!parallel) return false;
		for (const source of [entry, parent]) {
			const meta = source?.metadata as Record<string, unknown> | undefined;
			const saved = meta?.parallelPov as ParallelPovRequest | undefined;
			const request = saved ?? (source?.type === 'user_action' ? parseParallelPovCommand(source.content) : null);
			if (request?.character?.trim().toLowerCase() === pov.character.trim().toLowerCase()) return true;
		}
		return false;
	});
}

function compact(value: string, limit: number): string {
	return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function parseParallelPovCommand(input: string): ParallelPovRequest | null {
	const slash = input.match(/^\s*\/pov(?:\s+|:\s*)([\s\S]+?)\s*$/i);
	const legacy = input.match(/^\s*parallel\s+write\s+for\s+this\s+character\s*:\s*([\s\S]+?)\s*$/i);
	const body = (slash?.[1] ?? legacy?.[1] ?? '').trim();
	if (!body) return null;
	if (/^(?:gm|game\s+master|narrator)\b/i.test(body)) return null;

	const separator = body.match(/\s*(?:\||—|–|:|\r?\n)\s*/);
	const action = !separator ? body.match(/^(.+?)\s+(asks?|does?|doing|talks?|speaks?|meets?|visits?|goes?|thinks?|reacts?|watches?|finds?|continues?)\b/i) : null;
	const character = compact(separator ? body.slice(0, separator.index) : action ? action[1] : body, 120);
	const direction = separator
		? compact(body.slice((separator.index ?? 0) + separator[0].length), 600)
		: action ? compact(body.slice(action[1].length).trim(), 600) : '';
	if (!character) return null;

	return { character, direction: direction || null };
}

export function renderParallelPovDirective(input: string): string {
	const request = parseParallelPovCommand(input);
	if (!request) return '';

	return [
		'PARALLEL WRITE COMMAND — ONE TURN ONLY:',
		`Requested POV character: ${request.character}.`,
		request.direction ? `Requested focus: ${request.direction}` : '',
		'This is an explicit OOC exception to normal player authority. For this response, the GM fully controls the requested character: their actions, dialogue, choices, perceptions, thoughts, fears, and mistakes. The player still controls only the primary player character.',
		'Write a secondary arc in close third-person limited through the requested character, parallel to the last two primary turns. Match the story tone and tense. After the mandatory time/location header, add the line "### Parallel POV — [character name]".',
		'Ground the scene in that character\'s canon, affiliations, current state, location, goals, event memory, retrieved memory, wiki context, and recent history. Their knowledge remains local, delayed, and fallible; narrator-only facts may shape events but cannot enter their thoughts unless they plausibly know them.',
		'Do not advance, decide, narrate, or reveal the primary player character\'s private actions, dialogue, decisions, or thoughts. Keep them off-stage unless the POV character can directly observe their outward behavior.',
		'Resolve NPC uncertainty as the GM; never request a player-character dice roll or emit a player roll marker during this interlude. Developments in this scene are real canon and should flow through normal world-state extraction.',
		'If natural, end with a possible connecting point to the primary arc: a clue, messenger, rumor, arrival, object, overheard line, political consequence, or scene pressure. Do not force a connection merely to make the interlude feel important.',
		'This authority expires after this response. The next ordinary player input resumes the primary player-character POV.',
		'The output is GM narration prose, not analysis, a checklist, JSON, or an OOC explanation.',
	].filter(Boolean).join('\n');
}
