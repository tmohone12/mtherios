import type { RecordPatchRequest } from '$lib/contracts/engine';

export class MutationError extends Error {
	constructor(public code: string, message: string, public details: Record<string, unknown> = {}) {
		super(message);
		this.name = 'MutationError';
	}
}

// Supplied only by a server owner, never parsed from a model or HTTP payload.
export interface MutationActor {
	role: 'human' | 'client' | 'gm' | 'assistant' | 'research' | 'batch';
	id: string;
	runId?: string;
	instructionId?: string;
}

export function assertExpectedRevision(record: Record<string, unknown>, request: RecordPatchRequest, versioned = true) {
	const expected = versioned ? request.expectedVersion : request.expectedUpdatedAt;
	const actual = versioned ? Number(record.server_version) : record.updated_at;
	if (expected === undefined) throw new MutationError('REVISION_REQUIRED', 'Read the record again and supply its expected revision before saving.', { field: versioned ? 'expectedVersion' : 'expectedUpdatedAt' });
	if (expected !== actual) throw new MutationError('REVISION_CONFLICT', 'This record changed since it was loaded. Refresh it and reapply your changes.', { expected, actual });
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertSafeJson(value: unknown, depth = 0): void {
	if (depth > 32) throw new MutationError('INVALID_FIELD', 'Structured data exceeds the nesting limit.');
	if (typeof value === 'number' && !Number.isFinite(value)) throw new MutationError('INVALID_FIELD', 'Numbers must be finite.');
	if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
		if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new MutationError('INVALID_FIELD', `Unsupported structured key: ${key}`);
		assertSafeJson(child, depth + 1);
	}
}

// Objects merge recursively; arrays and explicit null replace. Omitted fields survive.
export function mergeJsonUpdate(previous: unknown, update: unknown): unknown {
	assertSafeJson(update);
	if (!isObject(update)) return update;
	const result = { ...(isObject(previous) ? previous : {}) };
	for (const [key, value] of Object.entries(update)) result[key] = mergeJsonUpdate(result[key], value);
	return result;
}

const objectColumns = new Set(['state', 'metadata', 'settings', 'resources', 'costs', 'gains', 'memory_impact']);
const structuredArrays = new Set(['operations', 'npc_knowledge_changes']);
const numberColumns = new Set(['current_turn', 'amount', 'priority', 'progress', 'pressure', 'due_turn', 'created_turn', 'occurred_turn', 'scheduled_turn', 'number', 'confidence', 'evidence_strength', 'importance', 'strength']);
const nullableColumns = new Set(['description', 'genre', 'settings', 'header_prompt', 'current_location_id', 'current_world_time', 'parent_id', 'branch_id', 'label', 'rank', 'location_id', 'due_turn', 'world_time', 'closed_at', 'closure_reason', 'subject_entity_id', 'target_entity_id', 'first_seen_entry_id', 'target_record_field', 'source_field', 'rationale', 'notes', 'suggestion', 'decision', 'validated_by', 'resolution_notes', 'resolved_by', 'resolved_at', 'title', 'summary', 'scene_outcome', 'overall_tone', 'last_error', 'error', 'occurred_turn', 'scheduled_turn']);

export function validateRecordField(type: string, column: string, value: unknown, json: boolean): unknown {
	assertSafeJson(value);
	const fail = () => { throw new MutationError('INVALID_FIELD', `Invalid value for ${type}.${column}.`); };
	if (value === null) {
		if (!nullableColumns.has(column) && !(column === 'metadata' && type === 'transcript')) fail();
		return value;
	}
	if (json) {
		if (objectColumns.has(column)) { if (!isObject(value)) fail(); }
		else if (!Array.isArray(value) || value.some(item => structuredArrays.has(column) ? !isObject(item) : typeof item !== 'string')) fail();
	} else if (numberColumns.has(column)) {
		if (typeof value !== 'number' || !Number.isFinite(value)) fail();
		if ((column.endsWith('_turn') || column === 'number') && (!Number.isInteger(value) || (value as number) < 0)) fail();
	} else if (column === 'bidirectional') { if (typeof value !== 'boolean') fail(); }
	else if (typeof value !== 'string') fail();
	return value;
}
