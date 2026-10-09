import { randomUUID } from 'node:crypto';

type JsonRecord = Record<string, unknown>;

/** Copy record identities, not provider/template IDs or arbitrary metadata identities. */
export function remapImportedRecordIds<T extends object>(bundle: T): T {
	const source = bundle as JsonRecord;
	const story = (source.story ?? {}) as JsonRecord;
	const storyId = `story_${randomUUID()}`;
	const ids = new Map<string, string>();
	if (typeof story.id === 'string') ids.set(story.id, storyId);
	for (const rows of Object.values(source)) {
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			if (row && typeof row.id === 'string' && row.id && !ids.has(row.id)) {
				ids.set(row.id, `import_${randomUUID()}`);
			}
		}
	}

	const remap = (value: unknown, key = ''): unknown => {
		if (key === 'serverStoryId' || key === 'clientStoryId') return null;
		if (key === 'syncStatus') return 'syncing';
		if (key === 'storyId') return storyId;
		if (Array.isArray(value)) return value.map((item) => remap(item, key));
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, remap(item, field)]));
		}
		if (typeof value === 'string' && (key === 'id' || key.endsWith('Id') || key.endsWith('Ids') || key === 'parties' || key === 'mergedInto')) {
			return ids.get(value) ?? value;
		}
		return value;
	};
	return { ...remap(source) as JsonRecord, story: { ...remap(story) as JsonRecord, id: storyId } } as T;
}
