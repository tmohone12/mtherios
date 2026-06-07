import { describe, expect, it } from 'vitest';
import {
	getRecentEngineEvents,
	publishEngineEvent,
	resetEngineEventsForTest,
	subscribeEngineEvents,
} from './events';

describe('engine event bus', () => {
	it('delivers story-scoped events to matching subscribers only', () => {
		resetEngineEventsForTest();
		const storyEvents: unknown[] = [];
		const otherEvents: unknown[] = [];
		const unsubscribeStory = subscribeEngineEvents('story_alpha', (event) => storyEvents.push(event));
		const unsubscribeOther = subscribeEngineEvents('story_beta', (event) => otherEvents.push(event));

		const event = publishEngineEvent({
			storyId: 'story_alpha',
			type: 'command.running',
			data: { commandId: 'cmd_1' },
		});

		unsubscribeStory();
		unsubscribeOther();

		expect(storyEvents).toEqual([event]);
		expect(otherEvents).toEqual([]);
	});

	it('keeps a bounded recent event history per story for stream catch-up', () => {
		resetEngineEventsForTest();

		publishEngineEvent({ storyId: 'story_alpha', type: 'command.running', data: { commandId: 'cmd_1' } });
		publishEngineEvent({ storyId: 'story_alpha', type: 'cache.status', data: { hitCount: 3 } });
		publishEngineEvent({ storyId: 'story_beta', type: 'command.running', data: { commandId: 'cmd_2' } });

		const recent = getRecentEngineEvents('story_alpha', 10);

		expect(recent.map((event) => event.type)).toEqual(['command.running', 'cache.status']);
		expect(recent.every((event) => event.storyId === 'story_alpha')).toBe(true);
	});
});
