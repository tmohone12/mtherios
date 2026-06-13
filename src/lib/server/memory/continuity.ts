import type { WorldStateUpdate } from '$lib/services/ai/tools/schemas';
import {
	continuityWarnings,
	facts,
	patchProposals,
	sourceRefs,
} from '$lib/server/db/schema';

type JsonRecord = Record<string, unknown>;

function nowIso(): string {
	return new Date().toISOString();
}

function id(prefix: string): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function compact(value: string | null | undefined, max = 120): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 72) || 'continuity';
}

function unique(values: Array<string | null | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())) )];
}

function normalizeLookup(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function lookupEntityId(entityNameToId: Record<string, string> | undefined, name: string): string | null {
	if (!entityNameToId) return null;
	return entityNameToId[name]
		?? entityNameToId[normalizeLookup(name)]
		?? entityNameToId[name.toLowerCase()]
		?? null;
}

function buildSourceRefRows(input: {
	storyId: string;
	targetTable: string;
	targetRecordId: string;
	targetRecordField?: string | null;
	sourceField?: string | null;
	confidence?: number;
	rationale?: string | null;
	notes?: string | null;
	sourceEntryIds?: string[];
	sourceEventIds?: string[];
	sourcePatchIds?: string[];
	serverVersion: number;
	now: string;
}): Array<typeof sourceRefs.$inferInsert> {
	const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
		? Math.max(0, Math.min(1, input.confidence))
		: 1;
	const rationale = input.rationale ?? null;
	const notes = input.notes ?? null;
	const buildRows = (sourceType: string, ids: string[]) => ids.map((sourceId) => ({
		id: id('sourceref'),
		storyId: input.storyId,
		sourceType,
		sourceId,
		targetTable: input.targetTable,
		targetRecordId: input.targetRecordId,
		targetRecordField: input.targetRecordField ?? null,
		sourceField: input.sourceField ?? null,
		confidence,
		rationale,
		notes,
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	}));

	return [
		...buildRows('story_entry', unique(input.sourceEntryIds ?? [])),
		...buildRows('story_event', unique(input.sourceEventIds ?? [])),
		...buildRows('state_patch', unique(input.sourcePatchIds ?? [])),
	];
}

function updateOperationPath(targetTable: string, targetRecordId: string): string {
	return `/${targetTable}/${targetRecordId}`;
}

export interface ContinuityStoryTextExampleInput {
	storyId: string;
	sourceEntryId: string;
	text: string;
	entityNameToId?: Record<string, string>;
	serverVersion?: number;
	now?: string;
}

export interface ContinuityLedgerSummaryInput {
	storyId: string;
	assistantEntryId: string;
	playerEntryId?: string | null;
	narration: string;
	update: WorldStateUpdate;
	affectedEntityIds: string[];
	sourceEventIds?: string[];
	sourcePatchIds?: string[];
	parseWarnings?: string[];
	serverVersion: number;
	now?: string;
}

export interface ContinuityLedgerBundle {
	facts: Array<typeof facts.$inferInsert>;
	patchProposals: Array<typeof patchProposals.$inferInsert>;
	continuityWarnings: Array<typeof continuityWarnings.$inferInsert>;
	sourceRefs: Array<typeof sourceRefs.$inferInsert>;
}

export function proposeContinuityChangeFromStoryText(input: ContinuityStoryTextExampleInput): ContinuityLedgerBundle | null {
	const now = input.now ?? nowIso();
	const serverVersion = input.serverVersion ?? 1;
	const text = compact(input.text, 500);
	const match = text.match(/^([A-Z][A-Za-z0-9' -]*?)\s+(?:now\s+)?(?:carries|holds|wears|guards|keeps|hides|protects)\s+(?:the\s+)?(.+?)(?:[.!?])?$/i);
	if (!match) return null;

	const subjectName = match[1].trim();
	const objectName = match[2].trim();
	const definiteObjectName = /^(?:the|a|an)\s+/i.test(objectName) ? objectName : `the ${objectName}`;
	const subjectEntityId = lookupEntityId(input.entityNameToId, subjectName);
	const factId = id(`fact_${slugify(subjectName)}_${slugify(objectName)}`);
	const proposalId = id(`proposal_${slugify(subjectName)}_${slugify(objectName)}`);
	const confidence = 0.94;
	const fact = {
		id: factId,
		storyId: input.storyId,
		type: 'observation' as const,
		subjectEntityId,
		targetEntityId: null,
		title: `${subjectName} and ${definiteObjectName}`,
		statement: `${subjectName} now carries ${definiteObjectName}.`,
		confidence,
		status: 'active' as const,
		visibility: 'player_known' as const,
		firstSeenEntryId: input.sourceEntryId,
		sourceEntryIds: [input.sourceEntryId],
		sourceEventIds: [],
		sourcePatchIds: [],
		metadata: {
			sourceType: 'deterministic_story_text_example',
			sourceText: text,
			subjectName,
			objectName,
		},
		serverVersion,
		createdAt: now,
		updatedAt: now,
	};
	const patchProposal = {
		id: proposalId,
		storyId: input.storyId,
		proposalType: 'fact_upsert',
		targetTable: 'facts',
		targetRecordId: factId,
		proposedBy: 'narration',
		operations: [{
			op: 'upsert',
			path: updateOperationPath('facts', factId),
			value: fact,
		}],
		reason: `Narration states that ${subjectName} now carries ${definiteObjectName}.`,
		suggestion: 'Merge the fact into canon after review.',
		status: 'pending' as const,
		decision: null,
		validatedBy: null,
		affectedEntityIds: subjectEntityId ? [subjectEntityId] : [],
		confidence,
		sourceEntryIds: [input.sourceEntryId],
		sourceEventIds: [],
		sourcePatchIds: [],
		metadata: {
			sourceType: 'deterministic_story_text_example',
			sourceText: text,
			subjectName,
			objectName,
		},
		serverVersion,
		createdAt: now,
		updatedAt: now,
	};
	const sourceRefRows = [
		...buildSourceRefRows({
			storyId: input.storyId,
			targetTable: 'facts',
			targetRecordId: factId,
			targetRecordField: 'statement',
			sourceField: 'text',
			confidence,
			rationale: 'Deterministic story-text continuity example.',
			sourceEntryIds: [input.sourceEntryId],
			serverVersion,
			now,
		}),
		...buildSourceRefRows({
			storyId: input.storyId,
			targetTable: 'patch_proposals',
			targetRecordId: proposalId,
			targetRecordField: 'operations',
			sourceField: 'text',
			confidence,
			rationale: 'Deterministic story-text continuity example.',
			sourceEntryIds: [input.sourceEntryId],
			serverVersion,
			now,
		}),
	];

	return {
		facts: [fact],
		patchProposals: [patchProposal],
		continuityWarnings: [],
		sourceRefs: sourceRefRows,
	};
}

export function summarizeTurnContinuity(input: ContinuityLedgerSummaryInput): ContinuityLedgerBundle {
	const now = input.now ?? nowIso();
	const parseWarnings = input.parseWarnings ?? [];
	const updateSummaryParts = [
		input.update.characters.length ? `${input.update.characters.length} character update(s)` : '',
		input.update.locations.length ? `${input.update.locations.length} location update(s)` : '',
		input.update.items.length ? `${input.update.items.length} item update(s)` : '',
		input.update.relationships.length ? `${input.update.relationships.length} relationship change(s)` : '',
		input.update.conversations.length ? `${input.update.conversations.length} belief update(s)` : '',
		input.update.agreements.length ? `${input.update.agreements.length} agreement change(s)` : '',
		input.update.story_beats.length ? `${input.update.story_beats.length} story beat(s)` : '',
		input.update.lorebook_entries.length ? `${input.update.lorebook_entries.length} lore entry update(s)` : '',
		input.update.player_reputation ? 'player reputation updated' : '',
		input.update.time_delta ? `time advanced (${compact(input.update.time_delta, 60)})` : '',
	].filter(Boolean);
	const summaryText = updateSummaryParts.length
		? `Turn update recorded ${updateSummaryParts.join('; ')}.`
		: 'Turn update recorded no explicit structured state changes.';
	const confidence = parseWarnings.length > 0 ? 0.8 : 0.92;
	const factId = id('fact_turn_summary');
	const proposalId = id('proposal_turn_summary');
	const fact = {
		id: factId,
		storyId: input.storyId,
		type: 'event' as const,
		subjectEntityId: null,
		targetEntityId: null,
		title: 'Turn continuity summary',
		statement: `${summaryText} Narration: ${compact(input.narration, 800)}.`,
		confidence,
		status: 'active' as const,
		visibility: 'player_known' as const,
		firstSeenEntryId: input.playerEntryId ?? input.assistantEntryId,
		sourceEntryIds: unique([input.playerEntryId, input.assistantEntryId]),
		sourceEventIds: unique(input.sourceEventIds ?? []),
		sourcePatchIds: unique(input.sourcePatchIds ?? []),
		metadata: {
			sourceType: 'turn_summary',
			affectedEntityIds: [...new Set(input.affectedEntityIds)],
			parseWarnings,
		},
		serverVersion: input.serverVersion,
		createdAt: now,
		updatedAt: now,
	};
	const proposal = {
		id: proposalId,
		storyId: input.storyId,
		proposalType: 'turn_summary',
		targetTable: 'facts',
		targetRecordId: factId,
		proposedBy: 'narration',
		operations: [{
			op: 'upsert',
			path: updateOperationPath('facts', factId),
			value: fact,
		}],
		reason: summaryText,
		suggestion: 'Review the extracted turn summary before merging it into long-term continuity.',
		status: 'pending' as const,
		decision: null,
		validatedBy: null,
		affectedEntityIds: [...new Set(input.affectedEntityIds)],
		confidence,
		sourceEntryIds: unique([input.playerEntryId, input.assistantEntryId]),
		sourceEventIds: unique(input.sourceEventIds ?? []),
		sourcePatchIds: unique(input.sourcePatchIds ?? []),
		metadata: {
			sourceType: 'turn_summary',
			narration: compact(input.narration, 1000),
			parseWarnings,
			updateCounts: {
				characters: input.update.characters.length,
				locations: input.update.locations.length,
				items: input.update.items.length,
				relationships: input.update.relationships.length,
				conversations: input.update.conversations.length,
				agreements: input.update.agreements.length,
				storyBeats: input.update.story_beats.length,
				lorebookEntries: input.update.lorebook_entries.length,
			},
		},
		serverVersion: input.serverVersion,
		createdAt: now,
		updatedAt: now,
	};
	const continuityWarningRows = parseWarnings.map((warning, index) => {
		const warningId = id(`warning_turn_${index + 1}`);
		return {
			id: warningId,
			storyId: input.storyId,
			warningType: 'turn_extraction',
			level: 'warning' as const,
			title: `Turn extraction warning ${index + 1}`,
			status: 'open' as const,
			details: warning,
			entityIds: [...new Set(input.affectedEntityIds)],
			factionIds: [],
			threadIds: [],
			actorIds: [],
			sourceEntryIds: unique([input.playerEntryId, input.assistantEntryId]),
			sourceEventIds: unique(input.sourceEventIds ?? []),
			sourcePatchIds: unique(input.sourcePatchIds ?? []),
			resolutionNotes: null,
			resolvedBy: null,
			resolvedAt: null,
			metadata: {
				sourceType: 'turn_summary',
				sourceWarning: warning,
			},
			serverVersion: input.serverVersion,
			createdAt: now,
			updatedAt: now,
		};
	});

	return {
		facts: [fact],
		patchProposals: [proposal],
		continuityWarnings: continuityWarningRows,
		sourceRefs: [
			...buildSourceRefRows({
				storyId: input.storyId,
				targetTable: 'facts',
				targetRecordId: factId,
				targetRecordField: 'statement',
				sourceField: 'narration',
				confidence,
				rationale: 'Derived from the structured turn update.',
				sourceEntryIds: unique([input.playerEntryId, input.assistantEntryId]),
				sourceEventIds: unique(input.sourceEventIds ?? []),
				sourcePatchIds: unique(input.sourcePatchIds ?? []),
				serverVersion: input.serverVersion,
				now,
			}),
			...buildSourceRefRows({
				storyId: input.storyId,
				targetTable: 'patch_proposals',
				targetRecordId: proposalId,
				targetRecordField: 'operations',
				sourceField: 'narration',
				confidence,
				rationale: 'Derived from the structured turn update.',
				sourceEntryIds: unique([input.playerEntryId, input.assistantEntryId]),
				sourceEventIds: unique(input.sourceEventIds ?? []),
				sourcePatchIds: unique(input.sourcePatchIds ?? []),
				serverVersion: input.serverVersion,
				now,
			}),
			...continuityWarningRows.flatMap((warning) => buildSourceRefRows({
				storyId: input.storyId,
				targetTable: 'continuity_warnings',
				targetRecordId: warning.id,
				targetRecordField: 'details',
				sourceField: 'parseWarnings',
				confidence: 1,
				rationale: 'Derived from structured validation warnings.',
				sourceEntryIds: warning.sourceEntryIds,
				sourceEventIds: warning.sourceEventIds,
				sourcePatchIds: warning.sourcePatchIds,
				serverVersion: input.serverVersion,
				now,
			})),
		],
	};
}
