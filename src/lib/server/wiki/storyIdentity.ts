import { createHash } from 'node:crypto';

export function storyScopedSegment(storyId: string): string {
	const rawStoryId = storyId.trim();
	const readable = rawStoryId.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'story';
	const hash = createHash('sha256').update(rawStoryId).digest('hex').slice(0, 16);
	return `${readable.slice(0, 90)}_${hash}`;
}

export function storyScopedCollection(baseCollection: string, storyId: string): string {
	return `${baseCollection}_${storyScopedSegment(storyId)}`;
}

// Diagnostics only: recognizes pre-hash collections so status can distinguish
// migration leftovers from truly orphaned data. Never use this for reads/writes.
export function legacyStoryScopedCollection(baseCollection: string, storyId: string): string {
	const segment = String(storyId || 'story')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 90)
		.replace(/-/g, '_') || 'story';
	return `${baseCollection}_${segment}`;
}
