import type { Story } from '$lib/types';

export type TerminalSyncTone = 'connected' | 'pending' | 'repair' | 'offline' | 'synced';

export interface TerminalSyncDisplayInput {
	syncStatus?: Story['syncStatus'];
	gatewayConnected: boolean;
	pendingCount: number;
	repairCount: number;
}

export interface TerminalSyncDisplay {
	label: string;
	tone: TerminalSyncTone;
}

export function terminalSyncDisplay(input: TerminalSyncDisplayInput): TerminalSyncDisplay {
	if (input.repairCount > 0 || input.syncStatus === 'conflict') {
		return { label: 'needs repair', tone: 'repair' };
	}
	if (input.pendingCount > 0 || input.syncStatus === 'syncing') {
		return { label: 'syncing', tone: 'pending' };
	}
	if (input.gatewayConnected) {
		return { label: 'gateway connected', tone: 'connected' };
	}
	if (input.syncStatus === 'offline') {
		return { label: 'runtime required', tone: 'offline' };
	}
	return { label: input.syncStatus?.replace('-', ' ') || 'synced', tone: 'synced' };
}

export function terminalSyncToneClass(tone: TerminalSyncTone): string {
	if (tone === 'repair') return 'text-rose-400';
	if (tone === 'pending' || tone === 'offline') return 'text-amber-400';
	return 'text-teal-400';
}
