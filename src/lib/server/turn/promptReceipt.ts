import type { ContextSelection } from '$lib/contracts/memory';
import type { ServerTurnPromptPacket } from './promptPacket';
import { countTokens } from '$lib/utils/tokens';

export type RetainedRange = { start: number; end: number };
export type RetainedMapping = { sourceStart: number; sourceEnd: number; targetStart: number; targetEnd: number };

/** Translate compiler source coordinates through the actual final budget pass. */
export function requestSourceSpansFromMappings(
	records: Array<{ kind: string; id: string; start: number; end: number }>,
	mappings: RetainedMapping[],
) {
	return records.flatMap(record => mappings.flatMap(mapping => {
		const start = Math.max(record.start, mapping.sourceStart);
		const end = Math.min(record.end, mapping.sourceEnd);
		return start >= end ? [] : [{ kind: record.kind, id: record.id, section: 'context' as const,
			start: mapping.targetStart + start - mapping.sourceStart,
			end: mapping.targetStart + end - mapping.sourceStart }];
	}));
}

/** Measure an exact compiler-produced block after the final context budget. */
export function retainedBlockUsage(prompt: string, block: string, ranges: RetainedRange[]) {
	const text = block.trim();
	const start = text ? prompt.indexOf(text) : -1;
	if (start < 0) return { chars: 0, tokens: 0 };
	const fragments = ranges.map(range => prompt.slice(Math.max(start, range.start), Math.max(Math.max(start, range.start), Math.min(start + text.length, range.end))));
	return { chars: fragments.reduce((sum, fragment) => sum + fragment.length, 0),
		tokens: fragments.reduce((sum, fragment) => sum + (fragment ? countTokens(fragment) : 0), 0) };
}

/** Compare known renderer spans with the ranges retained by the final budget pass. */
export function buildContextSelection(input: {
	packet: ServerTurnPromptPacket;
	ranges: RetainedRange[];
	loaded: Record<string, number>;
	includeDialogue: boolean;
	includeStable?: boolean;
	dynamicRecords?: ServerTurnPromptPacket['contextRecords'];
}): ContextSelection {
	const records = new Map<string, { kind: string; id: string; retained: number; chars: number }>();
	for (const item of input.dynamicRecords ?? input.packet.dynamicContextRecords ?? input.packet.contextRecords) {
		const key = `${item.kind}:${item.id}`;
		const retained = input.ranges.reduce((sum, range) => sum + Math.max(0, Math.min(item.end, range.end) - Math.max(item.start, range.start)), 0);
		const candidate = { kind: item.kind, id: item.id, retained, chars: item.end - item.start };
		const prior = records.get(key);
		// A repeated citation counts once; prefer its most complete occurrence.
		if (!prior || retained / candidate.chars > prior.retained / prior.chars) records.set(key, candidate);
	}
	if (input.includeStable !== false) for (const item of input.packet.stableContextRecords ?? []) {
		records.set(`${item.kind}:${item.id}`, { kind: item.kind, id: item.id, retained: item.end - item.start, chars: item.end - item.start });
	}
	const groups = Object.entries(input.loaded).map(([kind, loaded]) => {
		const items = [...records.values()].filter(item => item.kind === kind);
		const dialogueIds = kind === 'recentEntries' ? input.packet.dialogueSourceIds : [];
		const dialoguePartialIds = kind === 'recentEntries' && input.includeDialogue ? input.packet.dialoguePartialSourceIds ?? [] : [];
		const sentIds = [...new Set(kind === 'recentEntries' ? (input.includeDialogue ? dialogueIds.filter(id => !dialoguePartialIds.includes(id)) : [])
			: items.filter(item => item.retained >= item.chars).map(item => item.id))];
		const partialIds = [...dialoguePartialIds, ...items.filter(item => item.retained > 0 && item.retained < item.chars).map(item => item.id)];
		const omittedIds = kind === 'recentEntries' ? (input.includeDialogue ? [] : dialogueIds)
			: items.filter(item => item.retained === 0).map(item => item.id);
		const selected = kind === 'recentEntries' ? dialogueIds.length : items.length;
		return { kind, loaded, selected, sent: sentIds.length, partial: partialIds.length,
			omitted: Math.max(0, loaded - sentIds.length - partialIds.length), sentIds, partialIds, omittedIds };
	});
	return { version: 1, groups, sections: [], ...(input.packet.sceneCheckpoint ? { sceneCheckpoint: input.packet.sceneCheckpoint } : {}) };
}

export function promptPayloadSections(system: string, dynamic: string, messages: Array<{ content: string }>, action: string, contextAfterDialogue = false): ContextSelection['sections'] {
	const context = { id: 'context', label: 'Scene and memory', values: [dynamic] };
	const history = { id: 'history', label: 'Recent dialogue', values: messages.map(message => message.content) };
	return [
		{ id: 'system', label: 'System instructions', values: [system] },
		...(contextAfterDialogue ? [history, context] : [context, history]),
		{ id: 'action', label: 'Player action and tool observations', values: [action] },
	].map(({ id, label, values }) => ({ id, label,
		tokens: values.reduce((sum, value) => sum + (value ? countTokens(value) : 0), 0),
		chars: values.reduce((sum, value) => sum + value.length, 0),
	}));
}

/** Provider-independent text segments; excludes wire framing and provider token overhead. */
export function promptRequestSummary(id: 'primary' | 'roll_continuation', system: string, dynamic: string, messages: Array<{ content: string }>, action: string, sourceSpans: Array<{ kind: string; id: string; section: 'system' | 'context'; start: number; end: number }> = [], contextAfterDialogue = false) {
	const sections = promptPayloadSections(system, dynamic, messages, action, contextAfterDialogue);
	if (id === 'roll_continuation') {
		sections.find(section => section.id === 'history')!.label = 'Recent dialogue and pre-roll narration';
		sections.find(section => section.id === 'action')!.label = 'Resolved roll and continuation instruction';
	}
	return { id, label: id === 'primary' ? 'Primary narration request' : 'Roll continuation request', sections, sourceSpans,
		totalChars: sections.reduce((sum, section) => sum + section.chars, 0),
		totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0) };
}
