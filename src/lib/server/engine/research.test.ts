import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ command: vi.fn(), execute: vi.fn() }));
vi.mock('./command', () => ({ executeEngineCommand: mocks.command }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => ({ execute: mocks.execute }) }));
import { researchQuote, runCompactResearch, selectResearchQuotes, validateResearchClaims } from './research';

describe('local Research citation validation', () => {
  const sources = [{ id: 'entry_one', kind: 'entry' as const, excerpt: 'The harbor gate opens at dawn.', revision: '7' }];
  it('selects a short quoted answer for a rule, stat, location, or old narration', () => {
    const file = 'Fixture. Rules and stats. The cedar bridge rule requires one rope for each traveler. The ranger strength stat is 14. The cedar bridge is east of the forest clearing.';
    expect(researchQuote(file, 'What is the cedar bridge rule?')).toBe('The cedar bridge rule requires one rope for each traveler.');
    expect(researchQuote(file, 'What is the ranger strength stat?')).toBe('The ranger strength stat is 14.');
    expect(researchQuote(file, 'Where is the cedar bridge?')).toBe('The cedar bridge is east of the forest clearing.');
    expect(researchQuote('The room answers your look. Pale grey walls are held with visible screws.', 'What was on the walls of the room?')).toBe('Pale grey walls are held with visible screws.');
  });
  it('does not promote an unrelated numeric or directional sentence into an answer', () => {
    expect(researchQuote('The swordsman has 12 health.', 'What is the ranger strength stat?')).toBeNull();
    expect(researchQuote('The lake is north of camp.', 'Where is the cedar bridge?')).toBeNull();
  });
  it('quotes the requested wall description instead of a room timestamp and introduction', () => {
    const source = '[ 🕰️ Time 09:12 | Room 4 | [Interior] Cool, 15°C ] The room answers your look with an inventory of absences. It has walls of pale grey panels seamed with screws.';
    expect(researchQuote(source, 'What did the early room walls look like?')).toBe('It has walls of pale grey panels seamed with screws.');
  });
  it('keeps strongly matching wall evidence and drops a pale-grey stone distraction', () => {
    const question = 'What did the pale grey wall panels and visible screws look like in the early room?';
    expect(selectResearchQuotes([
      { id: 'walls', excerpt: "It's a rectangle, maybe four meters by five, walls of pale grey panels seamed together with visible screws." },
      { id: 'stones', excerpt: 'The stones are still there, pale grey smudges under starlight.' },
    ], question)).toEqual([{ sourceId: 'walls', statement: "It's a rectangle, maybe four meters by five, walls of pale grey panels seamed together with visible screws." }]);
  });
  it('accepts only an exact returned excerpt at its live revision', async () => {
    const result = await validateResearchClaims([{ sourceId: 'entry_one', statement: sources[0].excerpt }], sources, async () => '7');
    expect(result.status).toBe('answered');
    expect(result.statements[0]?.sourceId).toBe('entry_one');
  });
  it('rejects fabricated, deleted, changed, and cross-story citations', async () => {
    const claims = [
      { sourceId: 'foreign_entry', statement: sources[0].excerpt },
      { sourceId: 'entry_one', statement: 'The gate opens at noon.' },
    ];
    expect((await validateResearchClaims(claims, sources, async () => '7')).status).toBe('insufficient_evidence');
    expect((await validateResearchClaims([{ sourceId: 'entry_one', statement: sources[0].excerpt }], sources, async () => null)).status).toBe('insufficient_evidence');
    expect((await validateResearchClaims([{ sourceId: 'entry_one', statement: sources[0].excerpt }], sources, async () => '8')).status).toBe('insufficient_evidence');
    expect((await validateResearchClaims([{ sourceId: 'entry_one', statement: 'The harbor gate opens at noon.' }], sources, async () => '7')).status).toBe('insufficient_evidence');
  });
});


describe('local Research correction priority', () => {
  it('reads the full old entry when a transcript search snippet covers only one query term', async () => {
    const updatedAt = '2026-09-22T00:00:00.000Z';
    mocks.execute.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ updated_at: updatedAt, metadata: {}, content: 'The room has walls of pale grey panels.' }]);
    mocks.command.mockReset().mockImplementation(async ({ command }: { command: string }) => ({
      status: 'succeeded',
      result: command === 'memory.retrieve' ? { nodes: [
        { id: 'transcript_old_room', title: 'Earlier narration', sourceEntryIds: ['old_room'], content: 'The room answers your look.', visibility: 'player_known', updatedAt, metadata: { sourcePosition: 1 } },
      ] } : command === 'campaign.entriesAround' ? { entries: [
        { id: 'old_room', type: 'narration', content: 'The room has walls of pale grey panels.', updatedAt, position: 1, metadata: {} },
      ] } : { results: [] },
    }));
    const answer = await runCompactResearch({ storyId: 'test_story', projectId: 'test_project', question: 'What did the early room walls look like?', runId: 'test', callId: 'snippet' });
    expect(answer.neighborRead).toBe(true);
    expect(answer.statements).toEqual([{ statement: 'The room has walls of pale grey panels.', sourceId: 'old_room', revision: updatedAt, kind: 'entry' }]);
  });
  it('does not cite a retrieved GM-only transcript node', async () => {
    mocks.execute.mockReset().mockResolvedValue([]);
    mocks.command.mockReset().mockImplementation(async ({ command }: { command: string }) => ({
      status: 'succeeded',
      result: command === 'memory.retrieve' ? { nodes: [
        { id: 'hidden_memory', sourceEntryIds: ['hidden_entry'], content: 'The harbor gate opens at midnight.', visibility: 'gm_only', updatedAt: '2026-09-22T00:00:00.000Z', metadata: { sourcePosition: 12 } },
      ] } : { results: [] },
    }));
    const answer = await runCompactResearch({ storyId: 'test_story', projectId: 'test_project', question: 'When does the harbor gate open?', runId: 'test', callId: 'hidden' });
    expect(answer.status).toBe('insufficient_evidence');
    expect(answer.searchedSourceIds).toEqual([]);
  });
  it('does not turn a pending player correction request into accepted canon', async () => {
    const updatedAt = '2026-09-22T00:00:00.000Z';
    mocks.execute.mockReset().mockResolvedValueOnce([{ updated_at: updatedAt, source_entry_ids: ['old_entry'], metadata: { syncOpId: 'pending_sync' } }]).mockResolvedValue([]);
    mocks.command.mockReset().mockImplementation(async ({ command }: { command: string }) => ({
      status: 'succeeded',
      result: command === 'memory.retrieve' ? { nodes: [
        { id: 'event_memory_pending', sourceEventIds: ['pending'], content: 'The harbor gate opens at noon.', visibility: 'player_known', updatedAt, metadata: { eventType: 'correction', status: 'committed' } },
      ] } : { results: [] },
    }));
    const answer = await runCompactResearch({ storyId: 'test_story', projectId: 'test_project', question: 'When does the harbor gate open?', runId: 'test', callId: 'pending' });
    expect(answer.status).toBe('insufficient_evidence');
    expect(answer.searchedSourceIds).toEqual([]);
  });
  it('cites a live correction and excludes the transcript entry it supersedes', async () => {
    const updatedAt = '2026-09-22T00:00:00.000Z';
    const event = { updated_at: updatedAt, source_entry_ids: ['old_entry'], metadata: {} };
    mocks.execute.mockReset().mockResolvedValueOnce([event]).mockResolvedValueOnce([{ ...event, id: 'correction', body: 'The harbor gate opens at noon.' }]).mockResolvedValueOnce([]).mockResolvedValueOnce([event]);
    mocks.command.mockReset().mockImplementation(async ({ command }: { command: string }) => ({
      status: 'succeeded',
      result: command === 'memory.retrieve' ? { nodes: [
        { id: 'event_memory_correction', sourceEventIds: ['correction'], content: 'The harbor gate opens at noon.', visibility: 'public', updatedAt, metadata: { eventType: 'correction', status: 'committed' } },
        { id: 'old_memory', title: 'Earlier player action', sourceEntryIds: ['old_entry'], content: 'The harbor gate opens at dawn.', visibility: 'public', updatedAt, metadata: { sourcePosition: 12 } },
      ] } : command === 'campaign.entriesAround' ? { entries: [] } : { results: [] },
    }));
    const answer = await runCompactResearch({ storyId: 'test_story', projectId: 'test_project', question: 'When does the harbor gate open?', runId: 'test', callId: 'correction' });
    expect(answer.status).toBe('answered');
    expect(answer.statements).toEqual([{ statement: 'The harbor gate opens at noon.', sourceId: 'correction', revision: updatedAt, kind: 'event' }]);
    expect(answer.searchedSourceIds).not.toContain('old_entry');
  });
});
