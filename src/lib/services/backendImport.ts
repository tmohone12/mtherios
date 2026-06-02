import { indexedDbImportResponseSchema } from '$lib/contracts/memory';
import { updateStory } from '$lib/services/database';

async function postJson(url: string, payload: unknown): Promise<unknown> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(typeof body.error === 'string' ? body.error : `Terminal request failed: ${response.status}`);
	}
	return response.json();
}

export async function importStoryBundleToBackend(
	bundle: unknown,
	localStoryId: string,
): Promise<{
	serverStoryId: string;
	serverVersion: number;
	counts: Record<string, number>;
}> {
	const raw = await postJson('/api/import/indexeddb', {
		bundle,
		options: { preserveIds: true, rebuildMemoryNodes: true },
	});
	const imported = indexedDbImportResponseSchema.parse(raw);
	await updateStory(localStoryId, {
		serverStoryId: imported.storyId,
		serverVersion: imported.serverVersion,
		syncStatus: 'synced',
	});
	return {
		serverStoryId: imported.storyId,
		serverVersion: imported.serverVersion,
		counts: imported.counts,
	};
}
