import { beforeEach, describe, expect, it, vi } from 'vitest';
import { turnSubmissionResponseSchema } from '$lib/contracts/memory';

const owners = vi.hoisted(() => ({ submit: vi.fn(), start: vi.fn(), resume: vi.fn(), source: vi.fn() }));
vi.mock('./agentRuns', () => ({ submitAgentTurn: owners.submit, startAgentRun: owners.start,
  getAgentRun: vi.fn(), getCurrentAgentRun: vi.fn(), getAgentRunHistory: vi.fn(), respondAgentRun: vi.fn(), cancelAgentRun: vi.fn(), retryFailedAgentRun: vi.fn() }));
vi.mock('./assistantConversations', () => ({ resumeAssistantRun: owners.resume, answerAssistantQuestion: vi.fn(), cancelAssistantConversationBatch: vi.fn(), cancelAssistantRun: vi.fn(), createAssistantConversation: vi.fn(), listAssistantConversations: vi.fn(), readAssistantConversation: vi.fn(), reviewAssistantApproval: vi.fn(), sendAssistantMessage: vi.fn() }));
vi.mock('./sourceFiles', () => ({ readRunSourceFile: owners.source, sourceMountsCommand: vi.fn() }));
import { executeEngineCommand } from './command';
import { executeTurnSubmitCommand } from './turnFacade';
import { POST as legacyTurn } from '../../../routes/api/turn/+server';

const turn = { storyId: 'game', clientTurnId: 'turn', playerText: 'Cross the bridge.', localVersion: 0 };
const pending = { status: 'awaiting_input' as const, runId: 'run', storyId: 'game', clientTurnId: 'turn', interactions: [{ id: 'choice', status: 'pending' }] };
beforeEach(() => { vi.clearAllMocks(); owners.submit.mockResolvedValue(pending); owners.start.mockResolvedValue({ id: 'run', status: 'running' }); });

describe('shared durable admission', () => {
  it('routes engine/CLI/MCP turn.submit through the run owner and preserves typed pending results', async () => {
    const response = await executeEngineCommand({ storyId: 'game', command: 'turn.submit', args: turn });
    expect(response.status).toBe('succeeded');
    expect(turnSubmissionResponseSchema.parse(response.result)).toEqual(pending);
    expect(owners.submit).toHaveBeenCalledExactlyOnceWith(turn, expect.objectContaining({ onGmActivity: expect.any(Function) }));
  });
  it('uses the same owner for the compatibility facade and HTTP endpoint', async () => {
    expect(await executeTurnSubmitCommand(turn)).toEqual(pending);
    const response = await legacyTurn({ request: new Request('http://local/api/turn', { method: 'POST', body: JSON.stringify(turn) }) } as any);
    expect(await response.json()).toEqual(pending);
    expect(owners.submit).toHaveBeenCalledTimes(2);
  });
  it('keeps browser admission and callback options on that owner', async () => {
    const signal = new AbortController().signal;
    await executeEngineCommand({ storyId: 'game', command: 'agent.run.start', args: { turn, wait: false } }, { agentTurnOptions: { signal } });
    expect(owners.start).toHaveBeenCalledWith({ turn, wait: false }, 'game', { signal });
  });
  it('binds source viewers and Assistant recovery to the declared game scope', async () => {
    const args = { projectId: 'project', gameId: 'other', runId: 'run', sourceRef: 'content:rule' };
    expect((await executeEngineCommand({ storyId: 'game', command: 'source.file.read', args })).status).toBe('failed');
    expect(owners.source).not.toHaveBeenCalled();
    await executeEngineCommand({ storyId: 'other', command: 'source.file.read', args });
    expect(owners.source).toHaveBeenCalledWith(args);
    await executeEngineCommand({ storyId: 'other', command: 'assistant.run.resume', args: { projectId: 'project', gameId: 'other', conversationId: 'conversation', runId: 'run' } });
    expect(owners.resume).toHaveBeenCalledOnce();
  });
});
