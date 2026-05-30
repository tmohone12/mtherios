import type { CriticalPathItem, PlotMomentum } from '../sdk/schemas/worldsim';

type PlotPathKey = keyof PlotMomentum['next_beat']['critical_path'];

const ACTION_VERBS = [
	'turns away',
	'turn away',
	'goes',
	'go',
	'returns',
	'return',
	'leaves',
	'leave',
	'enters',
	'enter',
	'writes',
	'write',
	'decides',
	'decide',
	'opens',
	'open',
	'sits',
	'sit',
	'takes',
	'take',
	'crosses',
	'cross',
	'summons',
	'summon',
	'moves',
	'move',
	'walks',
	'walk',
	'steps',
	'step',
	'remembers',
	'remember',
	'realizes',
	'realize',
	'knows',
	'know',
	'orders',
	'order',
	'commands',
	'command',
];

const BASE_VERBS: Record<string, string> = {
	'turns away': 'turn away',
	'turn away': 'turn away',
	goes: 'go',
	go: 'go',
	returns: 'return',
	return: 'return',
	leaves: 'leave',
	leave: 'leave',
	enters: 'enter',
	enter: 'enter',
	writes: 'write',
	write: 'write',
	decides: 'decide',
	decide: 'decide',
	opens: 'open',
	open: 'open',
	sits: 'sit',
	sit: 'sit',
	takes: 'take',
	take: 'take',
	crosses: 'cross',
	cross: 'cross',
	summons: 'summon',
	summon: 'summon',
	moves: 'move',
	move: 'move',
	walks: 'walk',
	walk: 'walk',
	steps: 'step',
	step: 'step',
	remembers: 'remember',
	remember: 'remember',
	realizes: 'realize',
	realize: 'realize',
	knows: 'know',
	know: 'know',
	orders: 'order',
	order: 'order',
	commands: 'command',
	command: 'command',
};

function actionPattern(): RegExp {
	return new RegExp(`\\b(aurion|you|he)\\s+(${ACTION_VERBS.join('|')})\\b`, 'gi');
}

function sentenceChunks(text: string): string[] {
	return text.match(/[^.!?]+[.!?]?/g) ?? [text];
}

function isConditionalPlayerSentence(sentence: string): boolean {
	return /\bif\s+(?:aurion|he|you|the player)\b/i.test(sentence) ||
		/\bonly if\s+(?:aurion|he|you|the player)\b/i.test(sentence) ||
		/\bunless\s+(?:the\s+)?player\b/i.test(sentence) ||
		/\bplayer[- ]dependent\b/i.test(sentence);
}

function isQuestionedKnowledge(sentence: string, index: number, actor: string, verb: string): boolean {
	if (actor.toLowerCase() !== 'you' || verb.toLowerCase() !== 'knows') return false;
	const before = sentence.slice(Math.max(0, index - 24), index).toLowerCase();
	return /\b(what|whether|if|who|why|how|when|where)\s+$/.test(before);
}

export function describesForcedPlayerAction(text: string): boolean {
	for (const sentence of sentenceChunks(text)) {
		if (isConditionalPlayerSentence(sentence)) continue;
		for (const match of sentence.matchAll(actionPattern())) {
			if (isQuestionedKnowledge(sentence, match.index ?? 0, match[1], match[2])) continue;
			return true;
		}
	}
	return false;
}

function rewriteForcedPlayerPhrases(text: string): string {
	return text.replace(actionPattern(), (full, actor: string, verb: string, offset: number, source: string) => {
		if (isQuestionedKnowledge(source, offset, actor, verb)) return full;
		const baseVerb = BASE_VERBS[verb.toLowerCase()] ?? verb.toLowerCase();
		return `Aurion may choose to ${baseVerb}`;
	});
}

export function conditionalizePlayerDependentBeat(description: string): string {
	if (!describesForcedPlayerAction(description)) return description;
	const softened = rewriteForcedPlayerPhrases(description);
	return [
		`Conditional opportunity only: ${softened}`,
		"This is not settled canon and must not occur unless the player explicitly commands Aurion's movement or action.",
		'If he remains elsewhere, foreshadow through a messenger, distant sound, waiting object, document, delay, rumor, or NPC question.',
		'Do not move Aurion to reach this beat.',
	].join(' ');
}

export function applyPlotMomentumAgencyGuard(momentum: PlotMomentum): PlotMomentum {
	const nb = momentum.next_beat;
	let changed = false;
	let guardedRecommendedPath = false;
	const criticalPath = { ...nb.critical_path };

	for (const key of ['path_a', 'path_b', 'path_c', 'path_d'] as PlotPathKey[]) {
		const path: CriticalPathItem = criticalPath[key];
		if (!describesForcedPlayerAction(path.description)) continue;

		changed = true;
		guardedRecommendedPath ||= key === nb.next_turn_strategy.recommended_path;
		criticalPath[key] = {
			...path,
			description: conditionalizePlayerDependentBeat(path.description),
			action: false,
			downgraded_to_friction: true,
		};
	}

	if (!changed) return momentum;

	return {
		...momentum,
		next_beat: {
			...nb,
			critical_path: criticalPath,
			next_turn_strategy: guardedRecommendedPath
				? {
					...nb.next_turn_strategy,
					rationale: `Player-agency guard: ${nb.next_turn_strategy.rationale}`,
				}
				: nb.next_turn_strategy,
		},
	};
}
