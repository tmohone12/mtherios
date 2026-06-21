import { describe, expect, it } from 'vitest';
import { formatProposalDescription, formatProposalSubline, formatProposalSummary } from './canonProposalDisplay';

describe('canon proposal display helpers', () => {
	it('labels unresolved character review proposals with name and source context', () => {
		const agreement = {
			id: 'proposal_unknown_envoy',
			proposalType: 'character_reference_review',
			targetTable: 'entities',
			targetRecordId: 'unresolved_character_unknown_envoy',
			status: 'needs_review',
			sourceEntryIds: ['entry_oath'],
			operations: [{
				op: 'review',
				path: '/entities/character',
				value: {
					name: 'Unknown Envoy',
					description: 'Agreement party in oath: Hold the ash road until dawn.',
				},
			}],
			metadata: {
				sourceType: 'unresolved_character_reference',
				sourceName: 'Unknown Envoy',
				referenceContext: 'agreement_party',
				agreementCategory: 'oath',
			},
		};
		const faction = {
			id: 'proposal_oath_witness',
			proposalType: 'character_reference_review',
			targetTable: 'entities',
			targetRecordId: 'unresolved_character_oath_witness',
			status: 'pending',
			sourceEntryIds: ['entry_watch'],
			operations: [{
				op: 'review',
				path: '/entities/character',
				value: {
					name: 'Oath Witness',
					description: 'Faction member named in The Watch.',
				},
			}],
			metadata: {
				sourceType: 'unresolved_character_reference',
				sourceName: 'Oath Witness',
				referenceContext: 'faction_member',
				factionName: 'The Watch',
			},
		};
		const timeline = {
			id: 'proposal_hooded_envoy',
			proposalType: 'character_reference_review',
			targetTable: 'entities',
			targetRecordId: 'unresolved_character_hooded_envoy',
			status: 'needs_review',
			sourceEntryIds: ['entry_timeline'],
			operations: [{
				op: 'review',
				path: '/entities/character',
				value: {
					name: 'Hooded Envoy',
					description: 'Timeline event actor in Oath witness hunted.',
				},
			}],
			metadata: {
				sourceType: 'unresolved_character_reference',
				sourceName: 'Hooded Envoy',
				referenceContext: 'timeline_actor',
				timelineTitle: 'Oath witness hunted',
			},
		};

		expect(formatProposalSummary(agreement)).toBe('Unknown Envoy (not yet canon, agreement_party/oath)');
		expect(formatProposalSummary(faction)).toBe('Oath Witness (not yet canon, faction_member/The Watch)');
		expect(formatProposalSummary(timeline)).toBe('Hooded Envoy (not yet canon, timeline_actor/Oath witness hunted)');
		expect(formatProposalSubline(agreement)).toBe('needs_review / character_reference_review / source entry_oath');
	});

	it('labels character context update proposals with readable state changes', () => {
		const proposal = {
			id: 'proposal_mira_context',
			proposalType: 'character_context_update',
			targetTable: 'entities',
			targetRecordId: 'entity_mira',
			status: 'pending',
			sourceEntryIds: ['entry_harbor'],
			reason: 'Refresh Mira from recent harbor context.',
			operations: [{
				op: 'replace',
				path: '/characters/entity_mira/state',
				value: {
					currentLocation: 'Yin harbor counting room',
					currentAction: 'guarding the ledger',
					emotionalState: 'controlled fear',
					relationship: 'cautiously loyal to Aurion',
					goals: ['protect Aurion'],
					eventMemory: {
						knows: ['the ledger names Zhen'],
					},
				},
			}],
			metadata: {
				sourceType: 'character_context_update',
				characterName: 'Mira of the Harbor',
			},
		};

		expect(formatProposalSummary(proposal)).toBe('Mira of the Harbor context update');
		expect(formatProposalDescription(proposal)).toContain('location: Yin harbor counting room');
		expect(formatProposalDescription(proposal)).toContain('knows: the ledger names Zhen');
		expect(formatProposalSubline(proposal)).toBe('pending / character_context_update / source entry_harbor');
	});
});
