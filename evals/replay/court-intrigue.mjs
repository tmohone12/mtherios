// Synthetic fixture. Detectors inspect actual prompt/output/database evidence.
export const factText = { mara_present: 'blue wool scarf', poisoner_identity: 'Veyra poisoned the envoy', foreign_story_fact: 'FOREIGN_REPLAY_SENTINEL', mara_delivery_password: 'silver cranes cross at dawn', corrected_hearing: 'The harbor hearing is on Moonday afternoon', superseded_hearing: 'The harbor hearing is on Godsday morning' };

export function fixture(storyId, mutation = 'none', roll = false, kind = 'court-intrigue') {
	const ids = { mara: `${storyId}_mara`, letter: `${storyId}_letter`, player: `${storyId}_player`, hall: `${storyId}_hall` };
	const returning = kind === 'court-returning-npc';
	const corrected = kind === 'court-corrected-report';
	const recalled = returning ? ' "The delivery password is silver cranes cross at dawn," she recalls.' : corrected ? ' "The harbor hearing is on Moonday afternoon," she confirms.' : '';
	const delivered = `Mara accepts the sealed letter and tucks it safely into her satchel.${mutation === 'secret-leak' ? ' She says, "Veyra poisoned the envoy."' : ' "I will deliver it unopened," she says.'}${recalled}`;
	const data = {
		ids,
		story: { id: storyId, title: 'Disposable court intrigue replay', currentTurn: 2, currentLocationId: ids.hall, metadata: {} },
		entities: [
			{ id: ids.hall, storyId, type: 'location', name: 'Great Hall', description: 'A quiet hall.' },
			{ id: ids.player, storyId, type: 'character', name: 'Ilan', state: { relationship: 'self', present: true } },
			{ id: ids.mara, storyId, type: 'character', name: 'Mara', description: 'A returning courier.', state: { present: false, appearance: mutation === 'missing-fact' ? '' : 'Mara wears a blue wool scarf.' } },
			{ id: ids.letter, storyId, type: 'item', name: 'Sealed Letter', description: 'A sealed letter carried by Ilan.' },
		],
		entries: [{ id: `${storyId}_opening`, storyId, type: 'narration', position: 1, content: '[Great Hall]\nMara returns from the courtyard and stands beside Ilan, waiting for the sealed letter.' }],
		events: [{ id: `${storyId}_secret`, storyId, type: 'discovery', title: 'Unrevealed culprit', body: 'Veyra poisoned the envoy. Mara has no evidence identifying the culprit.', visibility: 'secret', status: 'committed', occurredTurn: 1 }],
		narration: roll ? '[Great Hall]\nMara inspects the wax seal. {{roll:1d1:0:Wisdom:Check the intact seal}}' : `[Great Hall]\n${delivered}`,
		continuation: delivered,
		extraction: { relationships: mutation === 'wrong-state' ? [] : [{ sourceName: 'Mara', targetName: 'Sealed Letter', type: 'owns' }] },
		beliefs: [], memoryNodes: [],
	};
	if (returning || corrected) {
		const oldEntryId = `${storyId}_old_scene`;
		data.story.currentTurn = 243;
		data.entries = [
			{ id: oldEntryId, storyId, type: 'narration', position: 1, content: returning
				? '[Harbor quay]\nIlan told Mara the delivery password: silver cranes cross at dawn. Mara repeated it and promised to remember.'
				: '[Harbor quay]\nA clerk gave Mara a false report: The harbor hearing is on Godsday morning.',
				metadata: corrected ? { superseded: true, supersededById: `${storyId}_hearing_correction` } : {} },
			// The source predates both bounded recent-entry windows. Intervening scenes contain no answer.
			...Array.from({ length: 240 }, (_, index) => ({ id: `${storyId}_intervening_${index}`, storyId, type: 'narration', position: index + 2,
				content: `[${['Market', 'Courtyard', 'Archive'][index % 3]}]\nIlan finishes another routine errand. The courier remains away on her journey. Scene ${index + 1}.` })),
			{ ...data.entries[0], position: 243 },
		];
		if (returning) {
			data.beliefs.push({ id: `${storyId}_delivery_belief`, storyId, believerEntityId: ids.mara, confidence: 1, visibility: 'player_known', sourceEntryIds: [oldEntryId],
				belief: `${'Conversation recap: Ilan and Mara discussed the harbor journey and local weather. '.repeat(24)}\nNPC learned: The delivery password is silver cranes cross at dawn.` });
			data.requiredBeliefId = `${storyId}_delivery_belief`;
		} else {
			const correctedText = 'The harbor hearing is on Moonday afternoon.';
			data.entities.find((row) => row.id === ids.mara).state.knownFacts = [correctedText];
			data.entries.splice(-1, 0, { id: `${storyId}_corrected_scene`, storyId, type: 'narration', position: 242, content: `[Archive]\nThe magistrate corrected the clerk's report in Mara's presence. ${correctedText}` });
			data.memoryNodes.push(
				{ id: `${storyId}_false_report`, storyId, type: 'episodic', title: 'Mara harbor hearing report', content: 'The harbor hearing is on Godsday morning.', sourceEntryIds: [oldEntryId], importance: 1, metadata: { superseded: true } },
				{ id: `${storyId}_current_report`, storyId, type: 'canonical', title: 'Corrected harbor hearing date', content: correctedText, entityIds: [ids.mara], importance: 1, metadata: { isCorrection: true, supersedesEntryIds: [oldEntryId], supersedesMemoryNodeIds: [`${storyId}_false_report`] } },
			);
			data.events.push({ id: `${storyId}_hearing_correction`, storyId, type: 'correction', title: 'Corrected hearing report', body: correctedText, status: 'committed', visibility: 'player_known', occurredTurn: 241, sourceEntryIds: [oldEntryId], metadata: { supersedesEntryIds: [oldEntryId], supersedesMemoryNodeIds: [`${storyId}_false_report`] } });
			data.supersededSourceId = oldEntryId;
		}
	}
	return data;
}

export function observedFacts(text) {
	return Object.entries(factText).filter(([, phrase]) => text.toLowerCase().includes(phrase.toLowerCase())).map(([id]) => id);
}

export function observedState(relationships, ids) {
	return { newCanonicalFacts: relationships.some((row) => row.sourceEntityId === ids.mara && row.targetEntityId === ids.letter && row.type === 'owns') ? ['mara_has_letter'] : [] };
}
