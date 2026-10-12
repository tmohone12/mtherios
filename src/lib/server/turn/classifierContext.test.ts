import { expect, it } from 'vitest';
import { buildCharacterCreationInstructions, buildStateExtractionPrompt } from './promptPacket';
import { buildStateExtractionRepairPrompt, buildStateExtractionResponseSchema } from './orchestrator';
import { buildDeferredStateExtractionPrompt } from '$lib/server/jobs/processor';
import { worldStateCharacterSchema } from '$lib/services/ai/tools/schemas';

it('does not load unrelated houses from a generic scene word', () => {
	const factions = [
		{ id: 'belmore', name: 'House Belmore' },
		{ id: 'tyrell', name: 'House Tyrell' },
		{ id: 'spicers', name: 'Spicers Guild' },
	];
	const generic = buildCharacterCreationInstructions(factions, 'They leave the house and pass the guild hall.');
	expect(generic).not.toContain('Canonical faction names');
	const specific = buildCharacterCreationInstructions(factions, 'A Tyrell factor speaks inside the house.');
	expect(specific).toContain('"id":"tyrell"');
	expect(specific).not.toContain('"id":"belmore"');
});

it('keeps scene actors but omits zero-score character records from extraction context', () => {
	const characters = [
		{ id: 'player', name: 'Aurion', state: { isProtagonist: true } },
		{ id: 'mara', name: 'Mara', state: { currentGoal: 'Reach the harbor.' } },
		{ id: 'serra', name: 'Serra', state: { present: true, currentGoal: 'Watch the passage.' } },
		{ id: 'remote', name: 'Zhen Shuo', state: { currentGoal: 'Count western ships.' } },
	];
	const prompt = buildStateExtractionPrompt('I ask Mara about the tide.', 'Mara answers while Serra watches.', {}, characters);
	expect(prompt).toContain('"entityId":"player"');
	expect(prompt).toContain('"entityId":"mara"');
	expect(prompt).toContain('"entityId":"serra"');
	expect(prompt).not.toContain('"entityId":"remote"');
});

it('carries current NPC intent and completed-move evidence rules through initial and retry extraction', () => {
	const state = { currentGoal: 'Keep her brother out of royal service.', currentPlan: 'Secure an apprenticeship.', lastIndependentAction: 'Mira asked her cousin for a berth.', nextOpportunity: 'Meet her cousin tomorrow.', constraint: 'Do not accuse her husband.' };
	const characters = [{ id: 'mira', name: 'Mira', state }];
	const playerText = 'I ask about her brother.';
	const narration = 'Mira folds the letter.';
	const responseSchema = buildStateExtractionResponseSchema().schema;
	for (const prompt of [buildStateExtractionPrompt(playerText, narration, responseSchema, characters), buildStateExtractionRepairPrompt({ playerText, narration, characters }), ...[1, 2].map(attemptCount => buildDeferredStateExtractionPrompt({ playerText, narration, characters, responseSchema, attemptCount }).prompt)]) {
		for (const value of Object.values(state)) expect(prompt).toContain(value);
		expect(prompt).toContain('Plans and opportunities are intentions, never completed facts');
		expect(prompt).toContain('independentActionEvidence');
	}
});

it('carries current and resolved agreement IDs through initial extraction and every recovery prompt', () => {
	const agreements = [{ id: 'bell_promise', parties: ['Mira', 'Valen'], category: 'promise', terms: 'Return the silver bell', status: 'fulfilled', secrecy: 'secret' }];
	const playerText = 'I remember the silver bell.';
	const narration = 'Mira confirms the debt is already paid.';
	const responseSchema = buildStateExtractionResponseSchema().schema;
	for (const prompt of [buildStateExtractionPrompt(playerText, narration, responseSchema, [], agreements),
		buildStateExtractionRepairPrompt({ playerText, narration, agreements }),
		...[1, 2].map(attemptCount => buildDeferredStateExtractionPrompt({ playerText, narration, responseSchema, agreements, attemptCount }).prompt)]) {
		expect(prompt).toContain('"id":"bell_promise"');
		expect(prompt).toContain('"status":"fulfilled"');
		expect(prompt).toContain('not current duties');
	}
});

it('keeps canonical IDs, aliases and legacy character details through initial and retry extraction', () => {
	const characters = [{ id: 'zhen', name: 'Vermillion Zhen Lian', state: { aliases: ['Zhen'], background: 'The empress', traits: ['calculating'], appearance: 'Dark eyes', voice: 'Measured' } }];
	const playerText = 'I ask Zhen to wait.';
	const narration = 'Zhen closes her fan.';
	const schema = buildStateExtractionResponseSchema().schema;
	const prompts = [buildStateExtractionPrompt(playerText, narration, schema, characters), buildStateExtractionRepairPrompt({ playerText, narration, characters }), ...[1, 2].map(attemptCount => buildDeferredStateExtractionPrompt({ playerText, narration, characters, responseSchema: schema, attemptCount }).prompt)];
	for (const prompt of prompts) {
		expect(prompt).toContain('"entityId":"zhen"');
		expect(prompt).toContain('"aliases":["Zhen"]');
		expect(prompt).toContain('"bio":"The empress"');
		expect(prompt).toContain('"personality":"calculating"');
		expect(prompt).toContain('"speechStyle":"Measured"');
	}
	const update = { name: 'Vermillion Zhen Lian', entityId: 'zhen', personality: 'Calculating', presentation: 'White robe', rank: 'Empress' };
	expect(worldStateCharacterSchema.parse(update)).toMatchObject(update);
});

it('gives every extraction prompt the whole narration, including its middle', () => {
	const playerText = 'I follow Maera into the corridor.';
	const opening = 'Maera gives Aurion the silver key before they finish speaking.';
	const transition = 'They leave the study together and enter the north corridor.';
	const promise = 'Maera promises to keep the key hidden until Aurion returns, even if the harbor watch demands it.';
	const middle = 'Halfway through, Maera drinks the last healing potion and her wound closes.';
	const narration = `[Time: 8:00 PM | Location: the private study | Weather: ${'rain against the windows, '.repeat(45)}]\n\n${opening}\n\n${'The fire flickers as the conversation continues. '.repeat(95)}\n\n${middle}\n\n${'The fire flickers as the conversation continues. '.repeat(95)}\n\n${transition}\n\n${promise}`;
	const schema = buildStateExtractionResponseSchema().schema;
	const prompts = [
		buildStateExtractionPrompt(playerText, narration, schema),
		buildStateExtractionRepairPrompt({ playerText, narration }),
		...[1, 2].map(attemptCount => buildDeferredStateExtractionPrompt({ playerText, narration, responseSchema: schema, attemptCount }).prompt),
	];

	for (const prompt of prompts) {
		const evidence = prompt.slice(prompt.indexOf('\nNarration:') + '\nNarration:'.length).split('\n\nPrior output:')[0].trim();
		expect(evidence).toContain('Time: 8:00 PM');
		expect(evidence).toContain(opening);
		expect(evidence).toContain(transition);
		expect(evidence).toContain(promise);
		expect(evidence).toContain(middle);
		expect(evidence).toBe(narration.trim());
	}
});
