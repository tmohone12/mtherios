const TIMELINE_PROJECTION_PREFIX = /^(?:agreement|alliance|betrayal|clue[_ -]discovery|correction|deadline|death|faction[_ -](?:move|signal)|imported[_ -]memory|injury|marriage|promise|relationship[_ -]shift|reveal|rumor|scene[_ -]transition|scheme|world[_ -]tick)\s*:/i;
const FUTURE_PROJECTION_LANGUAGE = /\b(?:will|tomorrow|tonight|before dawn|after dawn|not yet|pending|next (?:day|morning|night|week|month|turn))\b/i;

export function isDurableCharacterEventMemoryLine(value: unknown): value is string {
	return typeof value === 'string'
		&& value.trim().length > 0
		&& !TIMELINE_PROJECTION_PREFIX.test(value.trim());
}

export function durableCharacterEventMemoryList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isDurableCharacterEventMemoryLine).map(item => item.trim());
}

export function durableCharacterKnownFactList(value: unknown): string[] {
	return durableCharacterEventMemoryList(value).filter(item => !FUTURE_PROJECTION_LANGUAGE.test(item));
}
