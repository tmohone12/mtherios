/**
 * Inter-faction relation normalization shared by the world views and wiki export.
 */

function clamp(val: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, val));
}

// Pre-F4 stores `number` (standing-only); post-F4 stores FactionRelation.
// All readers MUST go through this normalizer.

export interface NormalizedRelation {
	standing: number;
	affinity: number;
	history: { event: string; delta: number; chapter: number }[];
}

export function normalizeRelation(v: unknown): NormalizedRelation {
	if (v == null) return { standing: 0, affinity: 0, history: [] };
	if (typeof v === 'number') {
		// Legacy numeric form: derive a conservative affinity floor — assume the
		// affinity tracks recent standing but is bounded so a fresh +90 ally
		// doesn't read as "deeply trusted" until events bear it out.
		return { standing: v, affinity: clamp(v, -50, 50), history: [] };
	}
	if (typeof v === 'object') {
		const o = v as Partial<NormalizedRelation>;
		return {
			standing: typeof o.standing === 'number' ? o.standing : 0,
			affinity: typeof o.affinity === 'number' ? o.affinity : 0,
			history: Array.isArray(o.history) ? o.history.slice(-5) : [],
		};
	}
	return { standing: 0, affinity: 0, history: [] };
}
