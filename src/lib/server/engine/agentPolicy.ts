import type { AgentRole, AgentTool } from '$lib/contracts/agentTools';
import { shippedAgentSettings } from '$lib/contracts/agentTools';
import { MutationError } from './mutationSafety';

const roleTools: Record<AgentRole, readonly AgentTool[]> = {
	gm: ['read', 'search', 'list', 'write', 'update', 'bash', 'map', 'askUserQuestion', 'askPlayerToRoll', 'gmRollDice', 'askJev', 'generateNames', 'research', 'recall', 'generateImage', 'generateFileImage'],
	assistant: ['read', 'search', 'list', 'write', 'update', 'saveType', 'folder', 'bash', 'map', 'askUserQuestion', 'generateImage', 'revert', 'clearLayout', 'subagent'],
	research: ['read', 'search', 'list'], batch: ['read', 'search', 'list', 'write', 'update'],
};

export function allowedAgentTools(role: AgentRole, settings: typeof shippedAgentSettings, implemented: readonly AgentTool[]): AgentTool[] {
	return roleTools[role].filter(tool => {
		if (!implemented.includes(tool)) return false;
		if (tool === 'askUserQuestion') return role === 'gm' ? settings.gmQuestions : settings.assistantQuestions;
		if (tool === 'askPlayerToRoll') return settings.gmPlayerRolls;
		if (tool === 'generateNames') return settings.gmNames;
		if (tool === 'research' || tool === 'recall') return settings.gmResearch;
		if (tool === 'subagent') return settings.assistantSubagents;
		if (tool === 'generateImage' || tool === 'generateFileImage') return role === 'gm' ? settings.gmImages : settings.assistantImages;
		return true;
	});
}

// Context is bound by the server run owner. It is never accepted in tool arguments.
export interface AgentAuthority {
	role: AgentRole;
	projectId: string;
	gameId: string | null;
	assignedTargetIds?: readonly string[];
	readableTargetIds?: readonly string[];
}

export function assertAgentToolAllowed(authority: AgentAuthority, tool: AgentTool, target: { projectId: string; gameId: string | null; id?: string }, settings: typeof shippedAgentSettings, implemented: readonly AgentTool[]) {
	if (authority.projectId !== target.projectId || (target.gameId !== null && authority.gameId !== target.gameId)) throw new MutationError('SCOPE_DENIED', 'This target is outside the run scope.');
	if (!allowedAgentTools(authority.role, settings, implemented).includes(tool)) throw new MutationError('TOOL_DENIED', 'This tool is not available to this role and settings.');
	if (authority.role === 'batch') {
		const ids = ['write', 'update'].includes(tool) ? authority.assignedTargetIds : [...(authority.assignedTargetIds ?? []), ...(authority.readableTargetIds ?? [])];
		if (!target.id || !ids?.includes(target.id)) throw new MutationError('SCOPE_DENIED', 'Batch helpers can access only their assigned targets and permitted references.');
	}
}
