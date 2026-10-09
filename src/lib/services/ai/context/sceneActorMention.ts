const ACTION = '(?:stand|stands|stood|sit|sits|sat|rest|rests|rested|wait|waits|waited|watch|watches|watched|look|looks|looked|turn|turns|turned|step|steps|stepped|move|moves|moved|hold|holds|held|lean|leans|leaned|speak|speaks|spoke|say|says|said|ask|asks|asked|reply|replies|replied|follow|follows|followed|walk|walks|walked|kneel|kneels|knelt|reach|reaches|reached|smile|smiles|smiled|nod|nods|nodded|breathe|breathes|breathed|remain|remains|remained|settle|settles|settled|lie|lies|lay|growl|growls|growled|appear|appears|appeared|arrive|arrives|arrived|enter|enters|entered|block|blocks|blocked|attack|attacks|attacked|raise|raises|raised|lower|lowers|lowered|coil|coils|coiled|hover|hovers|hovered|crouch|crouches|crouched|stare|stares|stared|gaze|gazes|gazed|glance|glances|glanced|approach|approaches|approached|advance|advances|advanced|retreat|retreats|retreated|circle|circles|circled|perch|perches|perched|land|lands|landed|lift|lifts|lifted|drop|drops|dropped|cross|crosses|crossed|gesture|gestures|gestured|take|takes|took|give|gives|gave|open|opens|opened|close|closes|closed|touch|touches|touched|grip|grips|gripped|release|releases|released|study|studies|studied|compare|compares|compared)';
const ADVERB = '(?:(?:visibly|quietly|slowly|still|already|now|then|simply|deliberately|softly|sharply|calmly|silently|finally|suddenly|immediately|carefully|steadily|nearby)\\s+)*';
const DIRECT_ACTION_AFTER = new RegExp(`^\\s+${ADVERB}${ACTION}\\b`);
const DIRECT_STATE_AFTER = /^\s+(?:is|are|was|were)\s+(?:here|there|present|nearby|beside|behind|before|standing|sitting|waiting|watching|moving|speaking|approaching|entering|leaving|kneeling|lying|resting|perched|hovering)\b/;
const ACTION_IN_SENTENCE = new RegExp(`\\b${ACTION}\\b`, 'g');
const MODAL_BETWEEN = /\b(?:could|would|might|may|should|cannot|cant|couldnt|wouldnt|shouldnt)\b/;
const SPATIAL_OR_INTERACTION_BEFORE = /\b(?:beside|behind|near|before|around|above|below|opposite|alongside|next\s+to|across\s+from|sees|saw|hears|heard|faces|faced|approaches|approached|attacks|attacked|greets|greeted|touches|touched|follows|followed|meets|met|joins|joined|watches|watched|looks\s+at|looked\s+at|turns\s+to|turned\s+to|speaks\s+to|spoke\s+to|says\s+to|said\s+to|replies\s+to|replied\s+to|says|said|replies|replied|asks|asked|answers|answered|walks\s+to|walked\s+to)\s*$/;
const REFERENCE_ONLY_BEFORE = [
	/\b(?:about|of|like|unlike|than|versus|vs|to)\s*$/,
	/\b(?:remember|remembered|recall|recalled|mention|mentioned|imagine|imagined|picture|pictured|think\s+of|thought\s+of|dream\s+of|dreamed\s+of|heard\s+of|heard\s+about|stories\s+of|rumors\s+of|rumours\s+of)\s*$/,
	/\b(?:could|would|might|may|cannot|cant|couldnt|wouldnt|not|no|without|lack|lacks|lacked|enough|power|ability|wish|wished|hope|hoped|dream|dreamed|thought|idea)(?:\s+[a-z0-9]+){0,24}\s+(?:challenge|challenging|fight|fighting|defeat|defeating|match|matching|rival|rivaling|face|facing|confront|confronting|reach|reaching|summon|summoning|contact|contacting)\s*$/,
];

function normalizeLookup(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function withoutQuotedText(text: string): string {
	return text.replace(/"[^"]*"|“[^”]*”|`[^`]*`/g, ' ');
}

/**
 * Exact-name evidence for an actor occupying the current scene. References,
 * comparisons, memories, and unrealized capabilities are not presence evidence.
 */
export function containsSceneActorMention(text: string, phrase: string): boolean {
	const needle = normalizeLookup(phrase);
	if (needle.length < 3) return false;

	for (const segment of withoutQuotedText(text).split(/[\r\n]+|(?<=[.!?])\s+/)) {
		const normalized = normalizeLookup(segment);
		let fromIndex = 0;
		while (fromIndex <= normalized.length - needle.length) {
			const index = normalized.indexOf(needle, fromIndex);
			if (index < 0) break;
			fromIndex = index + needle.length;
			const beforeBoundary = index === 0 || normalized[index - 1] === ' ';
			const afterBoundary = fromIndex === normalized.length || normalized[fromIndex] === ' ';
			if (!beforeBoundary || !afterBoundary) continue;

			const before = normalized.slice(Math.max(0, index - 240), index);
			const after = normalized.slice(fromIndex, Math.min(normalized.length, fromIndex + 240));
			if (SPATIAL_OR_INTERACTION_BEFORE.test(before)) return true;
			if (REFERENCE_ONLY_BEFORE.some((pattern) => pattern.test(before))) continue;
			if (DIRECT_ACTION_AFTER.test(after) || DIRECT_STATE_AFTER.test(after)) return true;

			ACTION_IN_SENTENCE.lastIndex = fromIndex;
			const laterAction = ACTION_IN_SENTENCE.exec(normalized);
			if (laterAction && laterAction.index - fromIndex <= 180) {
				const between = normalized.slice(fromIndex, laterAction.index);
				if (!MODAL_BETWEEN.test(between)) return true;
			}
		}
	}
	return false;
}
