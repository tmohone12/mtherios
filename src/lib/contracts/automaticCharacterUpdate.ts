type JsonRecord = Record<string, unknown>;
export const CHARACTER_IDENTITY_FIELDS = new Set([
	'bio', 'background', 'description', 'appearance', 'personality', 'rank',
	'speechStyle', 'nationality', 'origin', 'upbringing', 'occupation', 'role',
	'allegiance', 'secretAllegiance', 'hiddenInfo', 'traits', 'aliases', 'knownFacts',
	'voice', 'mannerisms', 'personalityDescriptors', 'visualDescriptors', 'developments',
]);

/**
 * Text the author writes and owns. No model rewrites it: a reviewed change to one of these
 * becomes a story development (below) unless the author approves it as an explicit retcon.
 */
export const CHARACTER_AUTHORED_TEXT_FIELDS = ['bio', 'background', 'description', 'personality', 'appearance', 'speechStyle'] as const;
const AUTHORED_LABELS: Record<string, string> = { personality: 'Personality', appearance: 'Appearance', speechStyle: 'Voice' };

/** What the story has established about a character since their biography: short facts, oldest first. */
export const CHARACTER_DEVELOPMENT_LIMIT = 40;

export function readCharacterDevelopments(state: unknown): string[] {
	const value = state && typeof state === 'object' && !Array.isArray(state) ? (state as JsonRecord).developments : undefined;
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()) : [];
}

const textKey = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/** Adds developments that are not already stated in the biography, personality or earlier developments. */
export function appendCharacterDevelopments(current: JsonRecord, additions: string[], description?: string | null): string[] {
	const developments = readCharacterDevelopments(current);
	const known = [description ?? '', ...CHARACTER_AUTHORED_TEXT_FIELDS.map(field => typeof current[field] === 'string' ? current[field] as string : ''), ...developments]
		.map(textKey).filter(Boolean);
	for (const raw of additions) {
		const addition = raw.replace(/\s+/g, ' ').trim();
		if (addition.length < 8) continue;
		const key = textKey(addition);
		if (known.some(existing => existing.includes(key))) continue;
		developments.push(addition);
		known.push(key);
	}
	return developments.slice(-CHARACTER_DEVELOPMENT_LIMIT);
}

/**
 * A reviewed proposal may carry a whole new bio, personality, appearance or voice (an extracted
 * fragment, a model's rewrite, or another person's description). Approving it must not delete what
 * the author wrote: the new part becomes a development and the authored field stays as it is.
 * An expansion that keeps the old text contributes only what it adds.
 */
export function foldAuthoredTextIntoDevelopments(current: JsonRecord, proposed: JsonRecord, description?: string | null): JsonRecord {
	const next = { ...proposed };
	const additions: string[] = [];
	for (const field of CHARACTER_AUTHORED_TEXT_FIELDS) {
		const value = next[field];
		delete next[field];
		if (typeof value !== 'string' || !value.trim()) continue;
		const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
		// The life story may sit in bio, background or the record description, depending on its origin.
		const previous = (field === 'bio' || field === 'background' || field === 'description'
			? text(current.bio) ?? text(current.background) ?? text(description) : text(current[field])) ?? '';
		const proposedText = value.replace(/\s+/g, ' ').trim();
		const previousText = previous.replace(/\s+/g, ' ').trim();
		// Ending punctuation differs between a sentence and its expansion ("Raised there." / "Raised there, and ...").
		const core = previousText.replace(/[\s.!?;,:]+$/u, '');
		const at = core ? proposedText.toLocaleLowerCase().indexOf(core.toLocaleLowerCase()) : -1;
		const remainder = at >= 0 ? `${proposedText.slice(0, at)} ${proposedText.slice(at + core.length)}`.replace(/\s+/g, ' ').replace(/^[\s.!?;,:\-–—]+/u, '').trim() : proposedText;
		const added = remainder ? remainder.charAt(0).toLocaleUpperCase() + remainder.slice(1) : '';
		if (!added) continue;
		additions.push(AUTHORED_LABELS[field] ? `${AUTHORED_LABELS[field]}: ${added}` : added);
	}
	const proposedDevelopments = readCharacterDevelopments(next);
	delete next.developments;
	const developments = appendCharacterDevelopments(current, [...additions, ...proposedDevelopments], description);
	if (developments.length !== readCharacterDevelopments(current).length) next.developments = developments;
	return next;
}

export function retainAutomaticCharacterIdentity(current: JsonRecord, proposed: JsonRecord): JsonRecord {
	const next = { ...proposed };
	for (const key of CHARACTER_IDENTITY_FIELDS) {
		if (Object.hasOwn(current, key)) next[key] = current[key];
		else delete next[key];
	}
	return next;
}

/** Automatic clients send a delta and original source IDs, never a biography
 * snapshot. The backend decides which fields need human continuity review. */
export function automaticCharacterUpdate(current: JsonRecord, proposed: JsonRecord, sourceEntryIds: string[]): JsonRecord {
	const patch = Object.fromEntries(Object.entries(proposed).filter(([key, value]) => value !== undefined && JSON.stringify(value) !== JSON.stringify(current[key])));
	return {
		patch,
		expected: Object.fromEntries(Object.keys(patch).map(key => [key, current[key] ?? null])),
		sourceEntryIds: [...new Set(sourceEntryIds)],
	};
}
