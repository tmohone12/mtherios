import { describe, expect, it } from 'vitest';
import { terminalSyncDisplay } from './terminalSyncDisplay';

describe('terminal sync display', () => {
	it('shows gateway connected instead of stale offline when no queue needs attention', () => {
		expect(terminalSyncDisplay({
			syncStatus: 'offline',
			gatewayConnected: true,
			pendingCount: 0,
			repairCount: 0,
		})).toEqual({
			label: 'gateway connected',
			tone: 'connected',
		});
	});

	it('keeps queue and repair states visible even when the gateway is connected', () => {
		expect(terminalSyncDisplay({
			syncStatus: 'offline',
			gatewayConnected: true,
			pendingCount: 2,
			repairCount: 0,
		})).toEqual({
			label: 'syncing',
			tone: 'pending',
		});
		expect(terminalSyncDisplay({
			syncStatus: 'synced',
			gatewayConnected: true,
			pendingCount: 0,
			repairCount: 1,
		})).toEqual({
			label: 'needs repair',
			tone: 'repair',
		});
	});

	it('shows runtime required when the gateway is not connected', () => {
		expect(terminalSyncDisplay({
			syncStatus: 'offline',
			gatewayConnected: false,
			pendingCount: 0,
			repairCount: 0,
		})).toEqual({
			label: 'runtime required',
			tone: 'offline',
		});
	});
});
