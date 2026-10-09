import { describe, expect, it } from 'vitest';
import { legacyStoryScopedCollection, storyScopedCollection, storyScopedSegment } from './storyIdentity';

describe('storyScopedCollection', () => {
	it('keeps a readable stable name while separating punctuation-equivalent story ids', () => {
		const first = storyScopedCollection('mtherios_wiki', 'story-a');
		const second = storyScopedCollection('mtherios_wiki', 'story_a');

		expect(first).toMatch(/^mtherios_wiki_story_a_[a-f0-9]{16}$/);
		expect(second).toMatch(/^mtherios_wiki_story_a_[a-f0-9]{16}$/);
		expect(first).not.toBe(second);
		expect(storyScopedCollection('mtherios_wiki', 'story-a')).toBe(first);
		expect(storyScopedSegment('story-a')).not.toBe(storyScopedSegment('story_a'));
	});

	it('recognizes collision-prone legacy names for diagnostics without using them as active identities', () => {
		expect(legacyStoryScopedCollection('mtherios_wiki', 'story-a')).toBe('mtherios_wiki_story_a');
		expect(legacyStoryScopedCollection('mtherios_wiki', 'story_a')).toBe('mtherios_wiki_story_a');
		expect(storyScopedCollection('mtherios_wiki', 'story-a')).not.toBe(
			legacyStoryScopedCollection('mtherios_wiki', 'story-a'),
		);
	});
});
