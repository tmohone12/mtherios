import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('runtime-required turn submission boundary', () => {
	it('does not queue local turns when terminal generation fails', () => {
		const source = readFileSync(resolve('src/lib/components/story/ActionInput.svelte'), 'utf8');

		expect(source).not.toContain('queueOfflineBackendTurn');
		expect(source).not.toContain('queued turn command');
		expect(source).toContain('submitBackendTurn');
	});

	it('blocks backend-bound input while the terminal runtime is unavailable', () => {
		const source = readFileSync(resolve('src/lib/components/story/ActionInput.svelte'), 'utf8');

		expect(source).toContain('terminalRuntimeUnavailable');
		expect(source).toContain('Terminal agent runtime required. Start the terminal process to use this campaign.');
		expect(source).toContain('Terminal agent runtime required');
		expect(source).not.toContain('transcript is available');
	});
});
