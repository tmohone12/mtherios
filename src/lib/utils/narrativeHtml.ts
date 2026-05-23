export type DialogueSpeakerInput =
	| string
	| {
		name?: string | null;
		aliases?: readonly (string | null | undefined)[];
	};

interface SpeakerCandidate {
	displayName: string;
	tone: number;
	cuePatterns: string[];
}

const DIALOGUE_TONE_COUNT = 8;

const HONORIFICS = new Set([
	'captain',
	'commander',
	'father',
	'king',
	'lady',
	'lord',
	'maester',
	'master',
	'mistress',
	'mother',
	'prince',
	'princess',
	'queen',
	'septa',
	'septon',
	'ser',
	'sir',
]);

const SPEECH_VERB_PATTERN = [
	'add(?:s|ed)?',
	'answer(?:s|ed)?',
	'ask(?:s|ed)?',
	'call(?:s|ed)?',
	'continu(?:es|ed)?',
	'declar(?:es|ed)?',
	'demand(?:s|ed)?',
	'growl(?:s|ed)?',
	'hiss(?:es|ed)?',
	'murmur(?:s|ed)?',
	'mutter(?:s|ed)?',
	'repl(?:y|ies|ied)',
	'respond(?:s|ed)?',
	'retort(?:s|ed)?',
	'say|says|said',
	'shout(?:s|ed)?',
	'snap(?:s|ped)?',
	'whisper(?:s|ed)?',
].join('|');

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(str: string): string {
	return escapeHtml(str).replace(/"/g, '&quot;');
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cuePatternForName(name: string): string | null {
	const words = name
		.trim()
		.match(/[\p{L}\p{N}'-]+/gu);

	if (!words?.length) return null;

	const inner = words.map(escapeRegExp).join(String.raw`\s+`);
	return String.raw`(?<![\p{L}\p{N}_])${inner}(?![\p{L}\p{N}_])`;
}

function nameVariants(name: string): string[] {
	const variants = new Set<string>();
	const trimmed = name.trim();
	if (!trimmed) return [];

	variants.add(trimmed);

	const words = trimmed.match(/[\p{L}\p{N}'-]+/gu) ?? [];
	const coreWords = words.filter((word) => !HONORIFICS.has(word.toLowerCase()));
	const coreName = coreWords.join(' ');

	if (coreName && coreName !== trimmed) variants.add(coreName);
	if (coreWords[0] && coreWords[0].length >= 3) variants.add(coreWords[0]);

	return [...variants];
}

function speakerName(input: DialogueSpeakerInput): string {
	return typeof input === 'string' ? input : input.name ?? '';
}

function speakerAliases(input: DialogueSpeakerInput): readonly (string | null | undefined)[] {
	return typeof input === 'string' ? [] : input.aliases ?? [];
}

function buildSpeakerCandidates(speakers: readonly DialogueSpeakerInput[]): SpeakerCandidate[] {
	const seenNames = new Set<string>();
	const claimedCues = new Set<string>();
	const candidates: SpeakerCandidate[] = [];

	for (const input of speakers) {
		const displayName = speakerName(input).trim();
		const normalizedDisplayName = displayName.toLowerCase();
		if (!displayName || seenNames.has(normalizedDisplayName)) continue;

		const cuePatterns: string[] = [];
		for (const rawCue of [displayName, ...speakerAliases(input)]) {
			if (!rawCue?.trim()) continue;
			for (const variant of nameVariants(rawCue)) {
				const normalizedCue = variant.toLowerCase();
				if (claimedCues.has(normalizedCue)) continue;

				const pattern = cuePatternForName(variant);
				if (!pattern) continue;

				claimedCues.add(normalizedCue);
				cuePatterns.push(pattern);
			}
		}

		if (cuePatterns.length === 0) continue;

		seenNames.add(normalizedDisplayName);
		candidates.push({
			displayName,
			tone: candidates.length % DIALOGUE_TONE_COUNT,
			cuePatterns,
		});
	}

	return candidates;
}

function scoreSpeakerCue(beforeQuote: string, afterQuote: string, cuePattern: string): number | null {
	const beforeSpeakerLabel = new RegExp(`${cuePattern}\\s*(?::|[-\\u2014\\u2013])\\s*$`, 'iu');
	if (beforeSpeakerLabel.test(beforeQuote)) return 0;

	const beforeSpeechVerb = new RegExp(`${cuePattern}.{0,56}\\b(?:${SPEECH_VERB_PATTERN})\\b\\s*[,;:\\u2014\\u2013-]?\\s*$`, 'isu');
	if (beforeSpeechVerb.test(beforeQuote)) return 1;

	const afterSpeechVerb = new RegExp(
		`^\\s*[,.!?;:\\u2014\\u2013-]*\\s*(?:\\b(?:${SPEECH_VERB_PATTERN})\\b\\s+${cuePattern}|${cuePattern}\\s+\\b(?:${SPEECH_VERB_PATTERN})\\b)`,
		'iu',
	);
	if (afterSpeechVerb.test(afterQuote)) return 1;

	const beforePlainSpeaker = new RegExp(`${cuePattern}\\s*[,;:\\u2014\\u2013-]?\\s*$`, 'iu');
	if (beforePlainSpeaker.test(beforeQuote)) return 3;

	return null;
}

function inferSpeaker(
	paragraph: string,
	quoteStart: number,
	quoteEnd: number,
	candidates: readonly SpeakerCandidate[],
): SpeakerCandidate | null {
	const beforeQuote = paragraph.slice(Math.max(0, quoteStart - 140), quoteStart);
	const afterQuote = paragraph.slice(quoteEnd, Math.min(paragraph.length, quoteEnd + 140));
	let best: { candidate: SpeakerCandidate; score: number } | null = null;

	for (const candidate of candidates) {
		for (const cuePattern of candidate.cuePatterns) {
			const score = scoreSpeakerCue(beforeQuote, afterQuote, cuePattern);
			if (score === null) continue;
			if (!best || score < best.score) {
				best = { candidate, score };
			}
		}
	}

	return best?.candidate ?? null;
}

function renderTextWithBreaks(text: string): string {
	return escapeHtml(text).replace(/\n/g, '<br/>');
}

function renderDialogueSpan(quote: string, tone: number, speaker: SpeakerCandidate | null): string {
	const speakerAttrs = speaker
		? ` data-speaker="${escapeHtmlAttribute(speaker.displayName)}" title="${escapeHtmlAttribute(speaker.displayName)}"`
		: '';

	return `<span class="dialogue dialogue-tone-${tone}"${speakerAttrs}>&ldquo;${escapeHtml(quote)}&rdquo;</span>`;
}

function renderParagraphWithDialogue(paragraph: string, speakers: readonly SpeakerCandidate[]): string {
	const quoteRegex = /\u201c([^\u201d]+)\u201d|"([^"]+)"|&quot;([\s\S]*?)&quot;/g;
	let html = '';
	let lastIndex = 0;
	let quoteIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = quoteRegex.exec(paragraph)) !== null) {
		const quote = match[1] ?? match[2] ?? match[3] ?? '';
		const quoteStart = match.index;
		const quoteEnd = quoteStart + match[0].length;
		const speaker = inferSpeaker(paragraph, quoteStart, quoteEnd, speakers);
		const tone = speaker?.tone ?? quoteIndex % DIALOGUE_TONE_COUNT;

		html += renderTextWithBreaks(paragraph.slice(lastIndex, quoteStart));
		html += renderDialogueSpan(quote, tone, speaker);

		lastIndex = quoteEnd;
		quoteIndex += 1;
	}

	html += renderTextWithBreaks(paragraph.slice(lastIndex));
	return html;
}

/**
 * Render a {{dice:...}} marker as a styled dice roll card.
 * Format: {{dice:notation|natural|total|dc|pass/fail|ability|description[|crit-success/crit-failure]}}
 */
function renderDiceCard(marker: string): string {
	const match = marker.match(
		/\{\{dice:([^|]+)\|(\d+)\|(\d+)\|(\d+)\|(pass|fail)\|([^|]*)\|([^|}]*)(?:\|(crit-success|crit-failure))?\}\}/,
	);
	if (!match) return `<p class="text-sm leading-relaxed text-[var(--text-primary)] mb-2">${renderTextWithBreaks(marker)}</p>`;

	const [, notation, natural, total, dc, result, ability, description, critical] = match;
	const isPass = result === 'pass';
	const isCrit = !!critical;
	const nat = parseInt(natural);
	const tot = parseInt(total);
	const mod = tot - nat;
	const modStr = mod !== 0 ? ` (${nat}${mod > 0 ? '+' : ''}${mod})` : '';

	const outcomeClass = isCrit
		? (critical === 'crit-success' ? 'dice-crit-success' : 'dice-crit-failure')
		: (isPass ? 'dice-pass' : 'dice-fail');
	const outcomeText = isCrit
		? (critical === 'crit-success' ? 'CRITICAL SUCCESS' : 'CRITICAL FAILURE')
		: (isPass ? 'SUCCESS' : 'FAILURE');
	const label = ability ? `${escapeHtml(ability)} Check` : 'Roll';

	return `<div class="dice-card ${outcomeClass}">
		<div class="dice-card-header">
			<span class="dice-card-icon">&#127922;</span>
			<span class="dice-card-label">${label}</span>
		</div>
		<div class="dice-card-body">
			<span class="dice-card-total">${escapeHtml(total)}</span>
			<span class="dice-card-detail">${escapeHtml(notation)}${escapeHtml(modStr)} vs DC ${escapeHtml(dc)}</span>
		</div>
		<div class="dice-card-outcome">${outcomeText}</div>
		${description ? `<div class="dice-card-desc">${escapeHtml(description)}</div>` : ''}
	</div>`;
}

/**
 * Format narrative text with SillyTavern-style colored dialogue and dice roll cards.
 */
export function formatNarrative(text: string, speakers: readonly DialogueSpeakerInput[] = []): string {
	const speakerCandidates = buildSpeakerCandidates(speakers);

	return text
		.split(/\n{2,}/)
		.map((paragraph) => {
			const trimmed = paragraph.trim();
			if (!trimmed) return '';

			if (trimmed.startsWith('{{dice:')) {
				return renderDiceCard(trimmed);
			}

			const html = renderParagraphWithDialogue(trimmed, speakerCandidates);
			return `<p class="text-sm leading-relaxed text-[var(--text-primary)] mb-2">${html}</p>`;
		})
		.join('');
}
