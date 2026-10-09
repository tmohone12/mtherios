import { indexedDbImportResponseSchema } from '$lib/contracts/memory';
import { worldDatabaseImportResponseSchema } from '$lib/contracts/worldDatabase';
import { updateStory } from '$lib/services/database';

interface EngineCommandResponse {
	status?: string;
	result?: unknown;
	error?: string | null;
}

/** A reached backend rejected the import; this must not become offline success. */
export class BackendImportRejectedError extends Error {}

async function postEngineCommand(storyId: string, command: string, args: unknown): Promise<unknown> {
	const response = await fetch('/api/engine/command', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ storyId, command, args }),
	});
	const body = await response.json().catch(() => ({})) as EngineCommandResponse;
	if (!response.ok) {
		const message = typeof body.error === 'string' ? body.error : `Terminal request failed: ${response.status}`;
		if (response.status >= 400 && response.status < 500) throw new BackendImportRejectedError(message);
		throw new Error(message);
	}
	if (body.status !== 'succeeded') {
		throw new BackendImportRejectedError(body.error ?? `Engine command failed: ${command}`);
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

function isFullDatabaseBundle(bundle: unknown): boolean {
	return Boolean(bundle && typeof bundle === 'object' && !Array.isArray(bundle)
		&& ('worldDatabase' in bundle || 'backendCanon' in bundle));
}

export async function importStoryBundleToBackend(
	bundle: unknown,
	localStoryId: string,
	merge?: { sourceProjectId: string; destinationProjectId: string },
): Promise<{
	serverStoryId: string;
	serverVersion: number;
	counts: Record<string, number>;
}> {
	const fullDatabase = isFullDatabaseBundle(bundle);
	const raw = await postEngineCommand(
		storyIdFromImportBundle(bundle),
		fullDatabase ? 'database.importWorldBundle' : 'story.importIndexedDb',
		fullDatabase
			? { bundle, options: { preserveIds: false, replaceExisting: false, syncWiki: true, ...(merge ?? {}) } }
			: { bundle, options: { preserveIds: true, rebuildMemoryNodes: true } },
	);
	const imported = fullDatabase
		? worldDatabaseImportResponseSchema.parse(raw)
		: indexedDbImportResponseSchema.parse(raw);
	await updateStory(localStoryId, {
		serverStoryId: imported.storyId,
		serverVersion: imported.serverVersion,
		...(fullDatabase && 'projectId' in imported && imported.projectId ? { shelfId: imported.projectId } : {}),
		syncStatus: 'synced',
	});
	return {
		serverStoryId: imported.storyId,
		serverVersion: imported.serverVersion,
		counts: imported.counts,
	};
}
