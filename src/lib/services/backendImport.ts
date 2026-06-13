import { indexedDbImportResponseSchema } from '$lib/contracts/memory';
import { updateStory } from '$lib/services/database';

interface EngineCommandResponse {
	status?: string;
	result?: unknown;
	error?: string | null;
}

async function postEngineCommand(storyId: string, command: string, args: unknown): Promise<unknown> {
	const response = await fetch('/api/engine/command', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ storyId, command, args }),
	});
	const body = await response.json().catch(() => ({})) as EngineCommandResponse;
	if (!response.ok) {
		throw new Error(typeof body.error === 'string' ? body.error : `Terminal request failed: ${response.status}`);
	}
	if (body.status !== 'succeeded') {
		throw new Error(body.error ?? `Engine command failed: ${command}`);
	}
	return body.result;
}

function storyIdFromImportBundle(bundle: unknown): string {
	const story = bundle && typeof bundle === 'object' && !Array.isArray(bundle)
		&& 'story' in bundle && typeof bundle.story === 'object' && bundle.story !== null && !Array.isArray(bundle.story)
		? bundle.story as Record<string, unknown>
		: {};
	const id = typeof story.id === 'string' ? story.id.trim() : '';
	return id || 'imported_story';
}

export async function importStoryBundleToBackend(
	bundle: unknown,
	localStoryId: string,
): Promise<{
	serverStoryId: string;
	serverVersion: number;
	counts: Record<string, number>;
}> {
	const request = {
		bundle,
		options: { preserveIds: true, rebuildMemoryNodes: true },
	};
	const raw = await postEngineCommand(storyIdFromImportBundle(bundle), 'story.importIndexedDb', request);
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
