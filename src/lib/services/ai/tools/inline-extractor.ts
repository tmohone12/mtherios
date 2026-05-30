/**
 * Recover tool calls that the model emitted inline as text instead of via
 * the function-calling API. The cc-bridge proxy sometimes doesn't forward
 * the `tools` array to the backend, so Claude falls back to writing the
 * tool call as text using its internal Claude Code wire format. We pull
 * those blocks out, return them as structured tool calls, and strip them
 * from the prose so the player only sees narration.
 */

import type { ToolCall } from '../sdk/generate';

const KNOWN_TOOLS = new Set(['update_world_state', 'search_wiki', 'refresh_plot_momentum']);

const UPDATE_WORLD_STATE_KEYS = new Set([
	'characters', 'locations', 'items', 'time_delta', 'mood', 'player_reputation', 'player_ledger',
	'conversations', 'relationships', 'story_beats', 'meter_changes', 'agreements',
	'lorebook_entries',
]);

export interface ExtractionResult {
	cleaned: string;
	toolCalls: ToolCall[];
}

export function extractInlineToolCalls(prose: string): ExtractionResult {
	let working = prose;
	const toolCalls: ToolCall[] = [];

	// <function_calls><invoke name="X"><parameter name="K">VAL</parameter>…</invoke>…</function_calls>
	working = working.replace(
		/<function_calls>([\s\S]*?)<\/function_calls>/g,
		(_match, inner: string) => {
			const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
			let m: RegExpExecArray | null;
			while ((m = invokeRe.exec(inner)) !== null) {
				const name = m[1];
				const args: Record<string, any> = {};
				const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
				let pm: RegExpExecArray | null;
				while ((pm = paramRe.exec(m[2])) !== null) {
					const raw = pm[2].trim();
					const parsed = tryParseLooseJson(raw);
					args[pm[1]] = parsed !== undefined ? parsed : raw;
				}
				// Canonicalize malformed names (e.g. GLM 5.1 emits "update" instead
				// of "update_world_state") when the args clearly belong to a known tool.
				const canonical = KNOWN_TOOLS.has(name)
					? name
					: looksLikeUpdateWorldState(args) ? 'update_world_state' : name;
				if (canonical !== name) {
					console.warn(`[inline-extractor] Renaming malformed inline tool call "${name}" → "${canonical}"`);
				}
				toolCalls.push({ name: canonical, arguments: args });
			}
			return '';
		},
	);

	// <tool_use>{"name": "X", "input": {…}}</tool_use>  (with optional code-fence inside)
	working = working.replace(
		/<tool_use>([\s\S]*?)<\/tool_use>/g,
		(_match, inner: string) => {
			const obj = tryParseLooseJson(inner);
			if (obj !== undefined) pushIfTool(obj, toolCalls);
			return '';
		},
	);

	// ```json {…} ``` (or an unfenced JSON-shaped tool call left by some proxies)
	working = working.replace(
		/```(?:json)?\s*\n?([\s\S]*?)\n?```/g,
		(match, inner: string) => {
			const trimmed = inner.trim();
			if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return match;
			const obj = tryParseLooseJson(trimmed);
			if (obj === undefined) return match;
			if (Array.isArray(obj)) {
				const before = toolCalls.length;
				for (const item of obj) pushIfTool(item, toolCalls);
				return toolCalls.length > before ? '' : match;
			}
			return pushIfTool(obj, toolCalls) ? '' : match;
		},
	);

	return { cleaned: working.trim(), toolCalls };
}

/**
 * Parse JSON with cc-bridge tolerance: strips code fences and stray Claude
 * Code wrapper tags (`<parameter>`, `<invoke>`, `<function_calls>`) that
 * sometimes bleed into the body, normalizes smart quotes the proxy
 * occasionally emits, and clips to the first balanced `{...}` if there's
 * trailing junk after the object. Returns `undefined` if nothing parses —
 * `null` is reserved for valid JSON `null`.
 */
function tryParseLooseJson(raw: string): unknown {
	let s = raw.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '')
		.replace(/<\/?(?:parameter|invoke|function_calls)\b[^>]*>/g, '')
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.trim();
	if (!s) return undefined;
	try { return JSON.parse(s); } catch { /* fall through */ }
	const start = s.indexOf('{');
	if (start < 0) return undefined;
	const slice = balancedBraceSlice(s, start);
	if (!slice) return undefined;
	try { return JSON.parse(slice); } catch { return undefined; }
}

function balancedBraceSlice(s: string, from: number): string | null {
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = from; i < s.length; i++) {
		const c = s[i];
		if (escape) { escape = false; continue; }
		if (inString) {
			if (c === '\\') escape = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') { inString = true; continue; }
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return s.slice(from, i + 1);
		}
	}
	return null;
}

// Sentinels that strongly imply this object is an update_world_state payload
// rather than the model writing JSON for flavor (e.g. inventory listings).
const UPDATE_WORLD_STATE_SENTINELS = new Set([
	'time_delta', 'meter_changes', 'story_beats', 'agreements', 'relationships',
	'player_reputation',
	'player_ledger',
	'lorebook_entries',
]);

function looksLikeUpdateWorldState(args: Record<string, any>): boolean {
	const keys = Object.keys(args);
	if (keys.some(k => UPDATE_WORLD_STATE_SENTINELS.has(k))) return true;
	const knownKeyCount = keys.reduce((n, k) => n + (UPDATE_WORLD_STATE_KEYS.has(k) ? 1 : 0), 0);
	return knownKeyCount >= 2;
}

function pushIfTool(obj: unknown, out: ToolCall[]): boolean {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
	const o = obj as Record<string, any>;
	// Named-tool form: {"name": "update_world_state", "input": {…}}
	if (typeof o.name === 'string' && KNOWN_TOOLS.has(o.name)) {
		out.push({ name: o.name, arguments: (o.input ?? o.arguments ?? {}) as Record<string, any> });
		return true;
	}
	// Bare-params form. Be conservative — innocent JSON the narrator emits
	// for flavor (e.g. `{"items": [...], "mood": "tense"}`) shouldn't be
	// swept up as a tool call. Require either a sentinel key only used by
	// update_world_state, or at least two known param keys.
	const keys = Object.keys(o);
	const hasSentinel = keys.some(k => UPDATE_WORLD_STATE_SENTINELS.has(k));
	const knownKeyCount = keys.reduce((n, k) => n + (UPDATE_WORLD_STATE_KEYS.has(k) ? 1 : 0), 0);
	if (hasSentinel || knownKeyCount >= 2) {
		out.push({ name: 'update_world_state', arguments: o });
		return true;
	}
	return false;
}
