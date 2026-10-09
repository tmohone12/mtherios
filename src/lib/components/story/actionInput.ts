import { isNarrativeControlInput } from '$lib/services/ai/context/controlInput';

export type ActionType = 'do' | 'say' | 'think' | 'story' | 'pov' | 'free';

export interface ActionDraft {
	text: string;
	actionType: ActionType;
}

const ACTION_TYPES = new Set<ActionType>(['do', 'say', 'think', 'story', 'pov', 'free']);

export function turnActionTypeForInput(rawInput: string, selectedActionType: ActionType): ActionType | 'ooc' {
	return isNarrativeControlInput(rawInput) ? 'ooc' : selectedActionType;
}

export function encodeActionDraft(draft: ActionDraft): string {
	return JSON.stringify(draft);
}

export function decodeActionDraft(value: string | null | undefined): ActionDraft {
	if (!value) return { text: '', actionType: 'do' };
	try {
		const parsed = JSON.parse(value) as Partial<ActionDraft>;
		if (parsed && typeof parsed.text === 'string' && ACTION_TYPES.has(parsed.actionType as ActionType)) {
			return { text: parsed.text, actionType: parsed.actionType as ActionType };
		}
	} catch {
		// Legacy drafts were stored as plain text.
	}
	return { text: value, actionType: 'do' };
}

const SHORTHAND_COMMANDS: Record<string, string> = {
	l: 'look around',
	i: 'check my inventory',
	z: 'wait',
	n: 'go north', s: 'go south', e: 'go east', w: 'go west',
	ne: 'go northeast', nw: 'go northwest', se: 'go southeast', sw: 'go southwest',
	u: 'go up', d: 'go down',
};

function stripOuterQuotes(value: string): string {
	const text = value.trim();
	return ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”')))
		? text.slice(1, -1).trim()
		: text;
}

function punctuate(value: string): string {
	const text = value.trimEnd();
	return /[.!?…]["'”’)]?$/.test(text) ? text : `${text}.`;
}

function thirdPersonVerb(value: string): string {
	const lower = value.toLowerCase();
	const irregular: Record<string, string> = {
		am: 'is', are: 'is', be: 'is', do: 'does', go: 'goes', have: 'has', say: 'says', try: 'tries',
	};
	if (irregular[lower]) return irregular[lower];
	if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
	if (/(?:s|x|z|ch|sh|o)$/i.test(value)) return `${value}es`;
	return `${value}s`;
}

function thirdPersonAction(value: string, name: string): string {
	const withoutLeadingI = value.replace(/^i\s+/i, '').trim();
	const match = withoutLeadingI.match(/^([\p{L}'-]+)([\s\S]*)$/u);
	if (!match) return `${name} ${withoutLeadingI}`.trim();
	const rest = match[2]
		.replace(/\bmyself\b/gi, 'themselves')
		.replace(/\bmy\b/gi, 'their')
		.replace(/\bme\b/gi, 'them')
		.replace(/\bi\b/gi, name)
		.replace(/\bam\b/gi, 'is');
	return `${name} ${thirdPersonVerb(match[1])}${rest}`;
}

function buildSayContent(text: string, thirdPerson: boolean, name: string): string {
	const spoken = stripOuterQuotes(text);
	const lastChar = spoken.slice(-1);
	const verb = lastChar === '?'
		? (thirdPerson ? 'asks' : 'ask')
		: lastChar === '!'
			? (thirdPerson ? 'yells' : 'yell')
			: (thirdPerson ? 'says' : 'say');
	return thirdPerson
		? `> ${name} ${verb}, "${spoken}"`
		: `> I ${verb}, "${spoken}"`;
}

export function buildActionContent(
	rawInput: string,
	type: ActionType,
	options: { thirdPerson: boolean; protagonistName: string },
): string {
	const { thirdPerson, protagonistName: name } = options;
	if (/^\/pov(?:\s|:|$)/i.test(rawInput)) return rawInput;
	if (rawInput.startsWith('!')) return `> ${rawInput.slice(1).trim()}`;
	if (type === 'do' && /^["“]/.test(rawInput)) return buildSayContent(rawInput, thirdPerson, name);

	if (type === 'do') {
		const lower = rawInput.toLowerCase();
		const xMatch = lower.match(/^x\s+(.+)$/);
		if (xMatch) return `> ${punctuate(thirdPerson ? `${name} examines the ${xMatch[1]}` : `I examine the ${xMatch[1]}`)}`;

		const expanded = SHORTHAND_COMMANDS[lower] ?? rawInput;
		const isWildcard = rawInput.endsWith('*') || rawInput.endsWith(',');
		const cleanInput = isWildcard ? expanded.slice(0, -1).trim() : expanded.trim();
		const action = thirdPerson
			? thirdPersonAction(cleanInput, name)
			: `I ${cleanInput.replace(/^i\s+/i, '')}`;
		return `> ${isWildcard ? action : punctuate(action)}`;
	}

	if (type === 'say') return buildSayContent(rawInput, thirdPerson, name);
	if (type === 'think') {
		const thought = stripOuterQuotes(rawInput);
		return thirdPerson
			? `> ${name} thinks: "${thought}"`
			: `> I think to myself: "${thought}"`;
	}
	if (type === 'pov') return `/pov ${rawInput}`;
	return rawInput;
}
