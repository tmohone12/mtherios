import { describe, expect, it } from 'vitest';
import { containsSceneActorMention } from './sceneActorMention';

describe('current-scene actor mention evidence', () => {
	it.each([
		'Your diminished power is no longer enough to challenge Great Red.',
		'No one is as powerful as Great Red.',
		'Amaterasu compares you to Great Red.',
		"Great Red's power is beyond yours.",
		'"Great Red would crush you," Amaterasu says.',
	])('rejects reference-only mention: %s', (text) => {
		expect(containsSceneActorMention(text, 'Great Red')).toBe(false);
	});

	it.each([
		'Great Red turns toward you.',
		'Great Red coils through the rift.',
		'"Enough," Great Red says.',
		'"Enough," says Great Red.',
		'Behind Amaterasu, Great Red lowers his head.',
		'Daenerys and Viserion visibly watch from the balcony.',
		'Scene Actor 0, Scene Actor 1, and Scene Actor 2 wait around the table.',
	])('accepts concrete presence evidence: %s', (text) => {
		expect(containsSceneActorMention(text, text.includes('Scene Actor') ? 'Scene Actor 0' : text.includes('Daenerys') ? 'Daenerys' : 'Great Red')).toBe(true);
	});
});
