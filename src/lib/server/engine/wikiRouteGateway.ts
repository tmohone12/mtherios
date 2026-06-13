import { executeLegacyEngineCommand } from './routeCompatibility';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export function wikiCommandStoryId(input: unknown): string {
	const record = asRecord(input);
	const storyId = typeof record.storyId === 'string' ? record.storyId.trim() : '';
	return storyId || '__wiki__';
}

export async function executeWikiRouteCommand(command: string, input: unknown): Promise<unknown> {
	const args = asRecord(input);
	return await executeLegacyEngineCommand({
		storyId: wikiCommandStoryId(args),
		command,
		args,
	});
}
