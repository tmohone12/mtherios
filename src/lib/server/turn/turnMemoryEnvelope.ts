import { z } from 'zod';
import { worldStateUpdateSchema, type WorldStateUpdate } from '$lib/services/ai/tools/schemas';

export const TURN_MEMORY_MARKER = '<turn_memory_update>';
const END_MARKER = '</turn_memory_update>';
const candidateSchema = z.object({
	kind: z.enum(['event', 'belief', 'proposal', 'uncertain']),
	quote: z.string().trim().min(8).max(1200),
	visibility: z.enum(['public', 'player_known', 'secret']),
	update: worldStateUpdateSchema.strict(),
}).strict();
const envelopeSchema = z.object({ version: z.literal(1), changes: z.array(candidateSchema).max(8) }).strict();

export type TurnMemoryEnvelope = z.infer<typeof envelopeSchema>;

export const TURN_MEMORY_INSTRUCTION = [
	'After the complete visible narration, append exactly one hidden machine footer:',
	'<turn_memory_update>{"version":1,"changes":[]}</turn_memory_update>',
	'Replace changes with at most eight source-quoted durable updates when warranted. Each change has kind (event, belief, proposal, or uncertain), quote (an exact 8-1200 character substring of your visible narration), visibility (public, player_known, or secret), and update (one sparse WorldStateUpdate object).',
	'Use event only for something that actually happened in this narration. A request, intention, prediction, rumor, or proposed bargain is not an event. Use [] if nothing durable changed. Do not repeat prior facts or put the footer inside the visible story.',
	'A named NPC hearing or expressing a belief may use belief with one conversations update; do not invent witnesses. A promise actually made may use event with one agreements create update of category promise; the promised future action has not happened. An unaccepted offer remains proposal.',
].join('\n');

export function parseTurnMemoryEnvelope(raw: string): { narration: string; envelope: TurnMemoryEnvelope | null; error: string | null } {
	const marker = raw.indexOf(TURN_MEMORY_MARKER);
	if (marker < 0) return { narration: raw.trim(), envelope: null, error: 'missing_footer' };
	const narration = raw.slice(0, marker).trim();
	const end = raw.indexOf(END_MARKER, marker + TURN_MEMORY_MARKER.length);
	if (end < 0 || raw.slice(end + END_MARKER.length).trim()) return { narration, envelope: null, error: 'incomplete_footer' };
	try {
		const parsed = envelopeSchema.parse(JSON.parse(raw.slice(marker + TURN_MEMORY_MARKER.length, end)));
		if (parsed.changes.some(change => !narration.includes(change.quote))) {
			return { narration, envelope: null, error: 'unsupported_quote' };
		}
		return { narration, envelope: parsed, error: null };
	} catch {
		return { narration, envelope: null, error: 'invalid_footer' };
	}
}

/** Hold only a marker-sized suffix so the machine footer never reaches the visible stream. */
export function createTurnMemoryStream(onText: (chunk: string) => void | Promise<void>) {
	let pending = '';
	let hidden = false;
	return {
		async push(chunk: string) {
			if (hidden) return;
			pending += chunk;
			const marker = pending.indexOf(TURN_MEMORY_MARKER);
			if (marker >= 0) {
				if (marker) await onText(pending.slice(0, marker));
				pending = '';
				hidden = true;
				return;
			}
			const safeLength = Math.max(0, pending.length - TURN_MEMORY_MARKER.length + 1);
			if (safeLength) {
				await onText(pending.slice(0, safeLength));
				pending = pending.slice(safeLength);
			}
		},
		async finish() {
			if (!hidden && pending) await onText(pending);
			pending = '';
		},
	};
}

export function mergeTurnMemoryUpdates(envelope: TurnMemoryEnvelope): WorldStateUpdate {
	const combined: Record<string, unknown> = {};
	for (const change of envelope.changes) {
		for (const [key, value] of Object.entries(change.update)) {
			if (Array.isArray(value)) combined[key] = [...(combined[key] as unknown[] ?? []), ...value];
			else if (value !== undefined && value !== null) {
				if (combined[key] !== undefined) throw new Error(`Multiple turn memory values for ${key}.`);
				combined[key] = value;
			}
		}
	}
	return worldStateUpdateSchema.strict().parse(combined);
}
