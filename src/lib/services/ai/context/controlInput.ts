export const NARRATIVE_CONTROL_PREFIX_PATTERN = /^\s*(?:>\s*)?(?:(?:(?:my|i)\s+)?ooc(?:\s*[:,-]|\s|$)|(?:\/pov\s+)?(?:gm|game\s+master|narrator)(?:\s*[:,-]|\s+(?=\S)))/i;
export const NARRATIVE_COMMAND_PATTERN = /^\s*\/[a-z][\w-]*(?:\s|:|$)/i;

export function isNarrativeControlInput(value: string): boolean {
	return NARRATIVE_CONTROL_PREFIX_PATTERN.test(value);
}

export function isNarrativeCommandInput(value: string): boolean {
	return NARRATIVE_COMMAND_PATTERN.test(value);
}
