import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	generate: vi.fn(), execute: vi.fn(), background: vi.fn(),
}));

vi.mock('$lib/services/ai/sdk/generate', () => ({ generateStructuredWithTools: mocks.generate }));
vi.mock('./executor', () => ({ executeToolCall: mocks.execute }));
vi.mock('$lib/services/ai/background/runner', () => ({ runBackgroundJobs: mocks.background }));
vi.mock('$lib/stores/settings.svelte', () => ({ settings: { getServiceConfig: () => ({
	model: 'classifier-test', temperature: 0, maxTokens: 512, profileId: '',
}) } }));

import { executeWorldUpdate } from './generate-with-tools';

describe('browser-only world update', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.generate.mockResolvedValue({ toolCalls: [{ name: 'update_world_state', arguments: { time_delta: '1 day' } }] });
		mocks.execute.mockResolvedValue(JSON.stringify({ success: true }));
		mocks.background.mockResolvedValue([]);
	});

	it('extracts state once and runs background maintenance without a scheme model pass', async () => {
		expect(await executeWorldUpdate('A day passes.', 'Quiet harbor.')).toEqual([]);
		expect(mocks.generate).toHaveBeenCalledOnce();
		expect(mocks.generate.mock.calls[0][0]).toMatchObject({ _service: 'world-update', model: 'classifier-test' });
		expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('update_world_state', { time_delta: '1 day' });
		expect(mocks.background).toHaveBeenCalledOnce();
	});
});
