import { describe, expect, it } from 'vitest';
import { agentToolSchema, shippedAgentSettings, resolveAgentSettings, agentSettingsPatchSchema } from '$lib/contracts/agentTools';
import { allowedAgentTools, assertAgentToolAllowed } from './agentPolicy';
import { readAgentDocument } from './agentSettings';

describe('agent policy and inheritance', () => {
	const tools = agentToolSchema.options;
	it('keeps helpers read-only or assigned, with no nested spawning', () => {
		expect(allowedAgentTools('research', shippedAgentSettings, tools)).toEqual(['read', 'search', 'list']);
		expect(allowedAgentTools('batch', shippedAgentSettings, tools)).toEqual(['read', 'search', 'list', 'write', 'update']);
		const authority = { role: 'batch' as const, projectId: 'p', gameId: 'g', assignedTargetIds: ['one'], readableTargetIds: ['reference'] };
		expect(() => assertAgentToolAllowed(authority, 'read', { projectId: 'p', gameId: 'g', id: 'reference' }, shippedAgentSettings, tools)).not.toThrow();
		expect(() => assertAgentToolAllowed(authority, 'update', { projectId: 'p', gameId: 'g', id: 'reference' }, shippedAgentSettings, tools)).toThrow('assigned targets');
		expect(() => assertAgentToolAllowed(authority, 'read', { projectId: 'other', gameId: 'g', id: 'one' }, shippedAgentSettings, tools)).toThrow('outside');
		expect(() => assertAgentToolAllowed(authority, 'read', { projectId: 'p', gameId: 'other', id: 'one' }, shippedAgentSettings, tools)).toThrow('outside');
	});
	it('applies the same tool matrix at discovery and execution, with independent GM dice', () => {
		const settings = { ...shippedAgentSettings, gmPlayerRolls: false, gmQuestions: false };
		expect(allowedAgentTools('gm', { ...settings, gmResearch: false }, tools)).toEqual(expect.arrayContaining(['read', 'search', 'list']));
		expect(allowedAgentTools('gm', { ...settings, gmResearch: false }, tools)).not.toContain('research');
		expect(allowedAgentTools('gm', { ...settings, gmResearch: false }, tools)).not.toContain('recall');
		expect(allowedAgentTools('gm', settings, tools)).toContain('recall');
		expect(allowedAgentTools('research', settings, tools)).not.toContain('recall');
		expect(allowedAgentTools('gm', settings, tools)).toContain('gmRollDice');
		expect(allowedAgentTools('gm', settings, tools)).toContain('askJev');
		expect(allowedAgentTools('assistant', settings, tools)).not.toContain('askJev');
		expect(allowedAgentTools('gm', settings, tools)).not.toContain('askPlayerToRoll');
		expect(allowedAgentTools('gm', { ...settings, gmNames: false }, tools)).not.toContain('generateNames');
		expect(() => assertAgentToolAllowed({ role: 'gm', projectId: 'p', gameId: 'g' }, 'generateNames', { projectId: 'p', gameId: 'g' }, { ...settings, gmNames: false }, tools)).toThrow('not available');
		expect(allowedAgentTools('assistant', settings, tools)).toContain('askUserQuestion');
		expect(allowedAgentTools('assistant', settings, tools)).toContain('saveType');
		expect(allowedAgentTools('assistant', { ...settings, assistantSubagents: false }, tools)).not.toContain('subagent');
		expect(() => assertAgentToolAllowed({ role: 'assistant', projectId: 'p', gameId: null }, 'subagent',
			{ projectId: 'p', gameId: null }, { ...settings, assistantSubagents: false }, tools)).toThrow('not available');
		expect(allowedAgentTools('batch', settings, tools)).not.toContain('saveType');
		expect(allowedAgentTools('gm', settings, [])).toEqual([]);
		expect(() => assertAgentToolAllowed({ role: 'gm', projectId: 'p', gameId: 'g' }, 'askPlayerToRoll', { projectId: 'p', gameId: 'g' }, settings, tools)).toThrow('not available');
	});
	it('preserves explicit false and resolves engine > game > project > shipped', () => {
		const project = readAgentDocument({ agentTools: { schemaVersion: 1, revision: 1, overrides: { gmResearch: false, gmNames: false, automaticCovers: true } } });
		const game = readAgentDocument({ agentTools: { schemaVersion: 1, revision: 2, overrides: { gmNames: true, gmImages: true, automaticCovers: false } } });
		const resolved = resolveAgentSettings(project, game, ['gmImages']);
		expect(resolved.effective).toMatchObject({ gmResearch: false, gmNames: true, gmImages: false, automaticCovers: true, gmPlayerRolls: true });
		expect(resolved.sources).toMatchObject({ gmResearch: 'project', gmNames: 'game', gmImages: 'engine', automaticCovers: 'project', gmPlayerRolls: 'default' });
		expect(resolveAgentSettings(readAgentDocument({})).effective).toEqual(shippedAgentSettings);
		expect(agentSettingsPatchSchema.parse({ gmResearch: null })).toEqual({ gmResearch: null });
		expect(() => agentSettingsPatchSchema.parse({ grantShell: true })).toThrow();
	});
});
