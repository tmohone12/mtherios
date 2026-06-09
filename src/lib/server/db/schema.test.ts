import { describe, expect, it } from 'vitest';
import {
	factionProjects,
	facts,
	patchProposals,
	sourceRefs,
	continuityWarnings,
} from './schema';

describe('canon database schema', () => {
	it('exposes faction projects for delayed resource-backed faction plans', () => {
		expect(factionProjects).toBeDefined();
		expect(factionProjects.storyId).toBeDefined();
		expect(factionProjects.factionId).toBeDefined();
		expect(factionProjects.project).toBeDefined();
		expect(factionProjects.status).toBeDefined();
		expect(factionProjects.costs).toBeDefined();
		expect(factionProjects.gains).toBeDefined();
		expect(factionProjects.dueTurn).toBeDefined();
		expect(factionProjects.sourceEventIds).toBeDefined();
	});

	it('exposes canonical evidence and continuity tables for fact/version locking', () => {
		expect(facts).toBeDefined();
		expect(facts.storyId).toBeDefined();
		expect(facts.type).toBeDefined();
		expect(facts.title).toBeDefined();
		expect(facts.statement).toBeDefined();
		expect(facts.confidence).toBeDefined();
		expect(facts.sourceEntryIds).toBeDefined();

		expect(sourceRefs).toBeDefined();
		expect(sourceRefs.storyId).toBeDefined();
		expect(sourceRefs.sourceType).toBeDefined();
		expect(sourceRefs.sourceId).toBeDefined();
		expect(sourceRefs.targetTable).toBeDefined();
		expect(sourceRefs.targetRecordId).toBeDefined();

		expect(patchProposals).toBeDefined();
		expect(patchProposals.storyId).toBeDefined();
		expect(patchProposals.proposalType).toBeDefined();
		expect(patchProposals.targetTable).toBeDefined();
		expect(patchProposals.targetRecordId).toBeDefined();
		expect(patchProposals.operations).toBeDefined();
		expect(patchProposals.affectedEntityIds).toBeDefined();
		expect(patchProposals.confidence).toBeDefined();

		expect(continuityWarnings).toBeDefined();
		expect(continuityWarnings.storyId).toBeDefined();
		expect(continuityWarnings.warningType).toBeDefined();
		expect(continuityWarnings.title).toBeDefined();
		expect(continuityWarnings.level).toBeDefined();
		expect(continuityWarnings.status).toBeDefined();
		expect(continuityWarnings.details).toBeDefined();
		expect(continuityWarnings.sourceEntryIds).toBeDefined();
	});
});
