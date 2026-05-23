import { json, type RequestHandler } from '@sveltejs/kit';
import { syncPushRequestSchema } from '$lib/contracts/memory';
import { applySyncOperation, getSyncChanges } from '$lib/server/memory/canonical';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, syncPushRequestSchema);
		const appliedOpIds: string[] = [];
		const rejected: Array<{ opId: string; reason: string }> = [];
		const repairItems: Array<{ opId: string; reason: string; payload: unknown }> = [];

		for (const op of request.ops) {
			try {
				await applySyncOperation(op);
				appliedOpIds.push(op.id);
			} catch (error) {
				const reason = error instanceof Error ? error.message : 'Unknown sync failure.';
				rejected.push({ opId: op.id, reason });
				repairItems.push({ opId: op.id, reason, payload: op.payload });
			}
		}

		const changes = await getSyncChanges(request.storyId, request.localVersion);
		const serverVersion = changes.reduce((max, change) => Math.max(max, change.version), request.localVersion);
		return json({
			storyId: request.storyId,
			serverVersion,
			appliedOpIds,
			rejected,
			repairItems,
			changes,
		});
	} catch (error) {
		return apiError(error);
	}
};
