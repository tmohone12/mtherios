type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asRecordArray(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : [];
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function compact(value: unknown, limit = 80): string {
	const text = asString(value);
	if (!text) return '';
	return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function namedOperationValue(proposal: JsonRecord): JsonRecord {
	return asRecordArray(proposal.operations)
		.map((operation) => asRecord(operation.value))
		.find((value) => asString(value.name).length > 0) ?? {};
}

function stateOperationValue(proposal: JsonRecord): JsonRecord {
	return asRecordArray(proposal.operations)
		.map((operation) => {
			const record = asRecord(operation);
			return asString(record.op) === 'replace' && asString(record.path).endsWith('/state')
				? asRecord(record.value)
				: {};
		})
		.find((value) => Object.keys(value).length > 0) ?? {};
}

function characterReferenceName(proposal: JsonRecord): string {
	const metadata = asRecord(proposal.metadata);
	const operationValue = namedOperationValue(proposal);
	return asString(metadata.sourceName, asString(operationValue.name, asString(proposal.targetRecordId, asString(proposal.id, 'Unresolved character'))));
}

function characterReferenceContext(proposal: JsonRecord): string {
	const metadata = asRecord(proposal.metadata);
	const referenceContext = asString(metadata.referenceContext);
	if (!referenceContext) return '';
	const detail = asString(metadata.agreementCategory)
		|| asString(metadata.factionName)
		|| asString(metadata.timelineTitle);
	return detail ? `${referenceContext}/${compact(detail, 60)}` : referenceContext;
}

function firstSourceEntry(proposal: JsonRecord): string {
	const sourceEntryIds = Array.isArray(proposal.sourceEntryIds)
		? proposal.sourceEntryIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
		: [];
	return sourceEntryIds[0] ?? '';
}

function characterContextName(proposal: JsonRecord): string {
	const metadata = asRecord(proposal.metadata);
	return asString(metadata.characterName, asString(proposal.targetRecordId, 'Character'));
}

function firstListItem(value: unknown): string {
	return Array.isArray(value)
		? value.find((item): item is string => typeof item === 'string' && item.trim().length > 0) ?? ''
		: '';
}

function eventMemoryPreview(value: unknown): string {
	const memory = asRecord(value);
	for (const key of ['did', 'saw', 'knew', 'knows']) {
		const item = firstListItem(memory[key]);
		if (item) return `${key}: ${item}`;
	}
	return '';
}

function characterContextDescription(proposal: JsonRecord): string {
	const state = stateOperationValue(proposal);
	const parts = [
		asString(state.currentLocation) ? `location: ${asString(state.currentLocation)}` : '',
		asString(state.currentAction) ? `action: ${asString(state.currentAction)}` : '',
		asString(state.emotionalState) ? `emotion: ${asString(state.emotionalState)}` : '',
		asString(state.relationship) ? `relationship: ${asString(state.relationship)}` : '',
		firstListItem(state.goals) ? `goal: ${firstListItem(state.goals)}` : '',
		eventMemoryPreview(state.eventMemory),
	].filter(Boolean);
	return compact(parts.join(' / '), 240) || compact(proposal.reason, 180);
}

export function formatProposalSummary(proposal: JsonRecord): string {
	if (proposal.proposalType === 'character_reference_review') {
		const name = characterReferenceName(proposal);
		const context = characterReferenceContext(proposal);
		return `${name} (not yet canon${context ? `, ${context}` : ''})`;
	}
	if (proposal.proposalType === 'character_context_update') {
		return `${characterContextName(proposal)} context update`;
	}
	return compact(proposal.proposalType, 120) || compact(proposal.id, 120) || 'Patch proposal';
}

export function formatProposalSubline(proposal: JsonRecord): string {
	const parts = [
		asString(proposal.status),
		asString(proposal.proposalType),
		firstSourceEntry(proposal) ? `source ${firstSourceEntry(proposal)}` : '',
	].filter(Boolean);
	if (parts.length > 0) return parts.join(' / ');
	return [asString(proposal.targetTable), asString(proposal.targetRecordId)].filter(Boolean).join(' / ');
}

export function formatProposalDescription(proposal: JsonRecord): string {
	if (proposal.proposalType === 'character_reference_review') {
		const operationValue = namedOperationValue(proposal);
		return compact(operationValue.description, 180) || compact(proposal.reason, 180);
	}
	if (proposal.proposalType === 'character_context_update') {
		return characterContextDescription(proposal);
	}
	return compact(proposal.reason, 180) || compact(proposal.suggestion, 180);
}
