import { z } from 'zod';

export type DialogueSpan = { index: number; start: number; end: number; text: string; quote: '"' | '“'; speakerId?: string; speakerName?: string };

/** Only skip unmistakably routine greetings; uncertain exchanges keep the configured dialogue pass. */
export function selectNpcDialogueSpans(spans: DialogueSpan[], input: {
	mode: 'all' | 'important'; playerAction: string; consequentialActorIds: ReadonlySet<string>;
}): DialogueSpan[] {
	if (input.mode === 'all') return spans;
	const routine = /^(?:hi|hello|hey|greetings|good morning|good afternoon|good evening|how are you|nice to meet you)[!.,? ]*$/i;
	if (!routine.test(input.playerAction.trim())) return spans;
	return spans.filter(span => (span.speakerId && input.consequentialActorIds.has(span.speakerId)) || !routine.test(span.text.trim()))
		.map((span, index) => ({ ...span, index }));
}

/** A speech editor only needs the nearby scene, present actors, and recent exchanges. */
export function buildNpcDialoguePrompt(input: {
	draft: string;
	spans: DialogueSpan[];
	playerAction: string;
	context: string;
	contextRecords: Array<{ kind: string; id?: string; start: number; end: number }>;
	actorCards?: Array<{ id: string; name: string; text: string }>;
	messages: Array<{ role: string; content: string }>;
	gmToolObservations: string;
	speakerDecision?: { psychology?: import('$lib/contracts/actorPsychology').ActorPsychology; immediateAction: string | null; sourceIds: string[]; selectedMemory?: { id: string; text: string } | null;
		recentOffer?: { sourceEntryId: string; speech: string } } | null;
}): string {
	const relevantSpeech = input.spans.map(span => input.draft.slice(Math.max(0, span.start - 140), Math.min(input.draft.length, span.end + 140))).join(' ');
	const actors = (input.actorCards ?? input.contextRecords.filter(record => record.kind === 'requiredActors').map(record => {
		const text = input.context.slice(record.start, record.end);
		const name = /^Character\s+\S+\s*\/\s*([^\n]+)/m.exec(text)?.[1]?.trim() ?? '';
		return { id: record.id ?? '', name, text };
	})).filter(actor => !input.spans.some(span => span.speakerId) || input.spans.some(span => span.speakerId === actor.id))
		.sort((a, b) => Number(Boolean(b.name && relevantSpeech.includes(b.name))) - Number(Boolean(a.name && relevantSpeech.includes(a.name))));
	const actorContext = [
		...input.contextRecords.filter(record => record.kind === 'requiredScene')
			.slice(0, 1).map(record => `requiredScene: ${input.context.slice(record.start, record.end).slice(0, 1_600)}`),
		...actors.slice(0, 8).map(actor => `requiredActors [${actor.id}]: ${actor.text.length <= 2_200
			? actor.text : `${actor.text.slice(0, 1_700)}\n[Actor card middle omitted]\n${actor.text.slice(-300)}`}`),
		...actors.flatMap(actor => input.contextRecords.filter(record => record.kind === 'beliefs')
			.map(record => input.context.slice(record.start, record.end))
			.filter(text => actor.name && text.startsWith(`- ${actor.name}`))
			.slice(0, 4).map(text => `beliefs [${actor.id}]: ${text.slice(0, 260)}`)),
	];
	return JSON.stringify({
		playerAction: input.playerAction.slice(0, 1_200),
		actorContext,
		gmToolObservations: input.gmToolObservations.slice(0, 2_500),
		speakerDecision: input.speakerDecision ?? null,
		psychologyDirection: input.speakerDecision?.psychology ? 'Let the evaluated psychology influence word choice, restraint and observable expression. A null immediateAction means no action was chosen; do not invent a decision from psychology alone. Keep private judgments private; no internal monologue, spoken scores or automatic relationship updates. Do not turn a confrontational style into unsupported violence or reopen accepted terms.' : null,
		recentExchanges: input.messages.filter(message => !message.content.startsWith('[PRIVATE THOUGHT'))
			.slice(-4).map(message => ({ role: message.role, content: message.content.slice(-1_200) })),
		utterances: input.spans.map(span => ({
			index: span.index,
			speakerId: span.speakerId ?? null,
			speakerName: span.speakerName ?? null,
			speech: span.text,
			sceneExcerpt: input.draft.slice(Math.max(0, span.start - 180), Math.min(input.draft.length, span.end + 180)),
		})),
	});
}

// Keep the GM's scene and turn mechanics byte-for-byte; the second model only fills quoted speech.
export function npcDialogueSpans(draft: string, playerText: string, actors: Array<{ id: string; name: string }> = []): DialogueSpan[] {
	const spans: DialogueSpan[] = [];
	const playerWords = playerText.toLowerCase();
	for (const match of draft.matchAll(/“([^”\n]{1,1200})”|"([^"\n]{1,1200})"/g)) {
		const speech = match[1] ?? match[2];
		if (playerWords && playerWords.includes(speech.trim().toLowerCase())) continue;
		let speaker: { id: string; name: string } | undefined;
		if (actors.length) {
			const before = draft.slice(Math.max(0, match.index - 900), match.index);
			const after = draft.slice(match.index + match[0].length, match.index + match[0].length + 100);
			const speechVerb = /\b(?:says?|said|asks?|asked|replies?|replied|answers?|answered|whispers?|murmurs?|shouts?|calls?|tells?|repeats?|repeated)\b/i;
			const followingAttribution = /^\s*(?:,\s*)?(?:he|she|they)\s+(?:says?|said|asks?|asked|replies?|replied|answers?|answered|whispers?|murmurs?|shouts?|calls?|tells?|repeats?|repeated)\b/.test(after)
				|| (!/[.!?]$/.test(speech) && /^\s*(?:,\s*)?[A-Z][a-z]+\s+(?:says?|said|asks?|asked|replies?|replied|answers?|answered|whispers?|murmurs?|shouts?|calls?|tells?|repeats?|repeated)\b/.test(after));
			const paragraphs = before.split(/\n\s*\n/);
			const previousParagraph = paragraphs.at(-2)?.trim() ?? '';
			const paragraphActors = paragraphs.at(-1)?.trim() ? [] : actors.filter(actor => actor.name
				&& previousParagraph.toLowerCase().startsWith(actor.name.toLowerCase())
				&& !/\b(?:reads?|quotes?|recites?|shows?|inscription|label|title)\b/i.test(previousParagraph));
			const paragraphActor = paragraphActors.length === 1 ? paragraphActors[0] : undefined;
			const attributed = speechVerb.test(before.slice(-45)) || followingAttribution || Boolean(paragraphActor);
			if (!attributed) continue;
			const mentioned = actors.map(actor => ({ actor, position: actor.name ? before.toLowerCase().lastIndexOf(actor.name.toLowerCase()) : -1 }))
				.filter(item => item.position >= 0 && before.length - item.position - item.actor.name.length <= 120)
				.sort((a, b) => b.position - a.position);
			if (!paragraphActor && (!mentioned.length || (mentioned[1] && mentioned[0].position === mentioned[1].position))) continue;
			speaker = paragraphActor ?? mentioned[0].actor;
		}
		spans.push({ index: spans.length, start: match.index, end: match.index + match[0].length, text: speech,
			quote: match[1] === undefined ? '"' : '“', ...(speaker ? { speakerId: speaker.id, speakerName: speaker.name } : {}) });
	}
	return spans.length <= 12 ? spans : [];
}

const responseSchema = z.object({ lines: z.array(z.object({
	index: z.number().int().min(0),
	text: z.string().trim().min(1).max(1200).refine(value => !/[\n\r"“”]|\{\{|\}\}/.test(value)),
}).strict()).max(12) }).strict();

export function validatedNpcDialogueLines(spans: DialogueSpan[], raw: unknown): string[] {
	const { lines } = responseSchema.parse(raw);
	if (lines.length !== spans.length || lines.some((line, index) => line.index !== index)) throw new Error('Dialogue model did not return one ordered line per NPC utterance.');
	for (const [index, span] of spans.entries()) {
		if (span.text.endsWith(',') && !lines[index].text.endsWith(',')) throw new Error('Dialogue model changed punctuation needed by the GM attribution.');
		const numbers = (value: string) => value.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [];
		if (JSON.stringify(numbers(span.text)) !== JSON.stringify(numbers(lines[index].text))) throw new Error('Dialogue model changed a stated number.');
		const commitments = /\b(?:accept|agree|promise|swear|refuse|decline|deny|never|cannot|can't|won't|will not)\b/gi;
		const commitmentWords = (value: string) => (value.match(commitments) ?? []).map(word => word.toLowerCase()).sort();
		if (JSON.stringify(commitmentWords(span.text)) !== JSON.stringify(commitmentWords(lines[index].text))) throw new Error('Dialogue model changed an agreement or refusal.');
		const internalNames = (value: string) => [...value.matchAll(/(?<![\p{L}\p{M}])\p{Lu}[\p{L}\p{M}'’-]*/gu)]
			.filter(match => match[0] !== 'I' && match.index > 0 && !/[.!?]\s*$/.test(value.slice(0, match.index)))
			.map(match => match[0]).sort();
		if (JSON.stringify(internalNames(span.text)) !== JSON.stringify(internalNames(lines[index].text))) throw new Error('Dialogue model changed a named person or place.');
	}
	return lines.map(line => line.text);
}

export function applyNpcDialogue(draft: string, spans: DialogueSpan[], raw: unknown): string {
	const lines = validatedNpcDialogueLines(spans, raw);
	let result = draft;
	for (let index = spans.length - 1; index >= 0; index -= 1) {
		const span = spans[index];
		const close = span.quote === '“' ? '”' : '"';
		result = result.slice(0, span.start) + span.quote + lines[index] + close + result.slice(span.end);
	}
	return result;
}
