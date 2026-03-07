/**
 * StyleReviewerService — Mtherios
 * 
 * Reviews AI-generated narrative for POV consistency, tense shifts,
 * repetition, pacing, and tone. Can optionally produce revised text.
 */

import { BaseAIService } from '../BaseAIService';
import { styleReviewSchema, type StyleReview } from '../sdk/schemas/style';

export class StyleReviewerService extends BaseAIService {
	constructor() {
		super('styleReviewer');
	}

	async review(
		narrative: string,
		pov = 'second', tense = 'present', tone = '',
		revise = false,
	): Promise<StyleReview> {
		const system = `You are a fiction editor reviewing AI-generated narrative.
Check for:
- POV breaks (story should be ${pov} person throughout)
- Tense shifts (should be ${tense} tense)
- Character voice consistency
- Repetition (repeated words, phrases, or sentence structures)
- Pacing issues (too rushed or too slow)
- Tone mismatches${tone ? ` (expected tone: ${tone})` : ''}

${revise ? 'If issues are found, provide a revised version of the text that fixes them.' : 'Do NOT provide revised text.'}

Respond with JSON: {
  "approved": boolean,
  "issues": [{ "type": "pov_break"|"tense_shift"|"character_voice"|"repetition"|"pacing"|"tone_mismatch", "description": string, "severity": "minor"|"moderate"|"major", "suggestion": string }],
  ${revise ? '"revisedText": string,' : ''}
  "overallQuality": "poor"|"fair"|"good"|"excellent"
}`;

		return this.generateStructured(styleReviewSchema, system, `Review this narrative:\n\n${narrative}`);
	}
}
