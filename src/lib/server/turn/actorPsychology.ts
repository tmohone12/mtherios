import { z } from 'zod';
import { actorPsychologySchema } from '$lib/contracts/actorPsychology';

const instructions = 'Evaluate the NPC internal response before choosing an action. Use only their saved traits, motives, relationships, commitments and personally known evidence. Treat the player action as an attempt, not a proven outcome. Do not generate dialogue or internal monologue. Calibration examples illustrate the format only and are never facts about this NPC. An insult or threat has no automatic emotional or affinity result: evaluate this particular NPC. Tactical compliance does not imply trust. Choose uncertain when evidence is missing.';
const boundedInstructions = 'Use only this NPC saved traits, motives, relationships and personally known evidence. Choose uncertain when unsupported.';
export const psychologyQuestions = {
	internal_judgment: { type: 'choice', instructions, criteria: {
		threatened: 'The action threatens something this NPC values or their control.',
		insulted: 'The action offends this NPC established pride, values or boundaries.',
		amused: 'This NPC traits support finding the action entertaining rather than threatening.',
		validated: 'The action supports this NPC established values, needs or self-image.',
		indifferent: 'The action has little personal importance to this NPC.',
		conflicted: 'Established motives support competing personal responses.',
		uncertain: 'The evidence does not establish how this NPC perceives the action.',
	} },
	emotional_intensity: { type: 'choice', instructions: boundedInstructions + ' Rate this immediate impact, not the dramatic importance of the story.', criteria: {
		'1': 'Barely affected; ordinary composure remains.', '2': 'Mild personal impact.',
		'3': 'Substantial immediate emotional impact.', '4': 'Strong disruption of usual emotional control.',
		'5': 'Exceptional impact on a deeply established core attachment or value; requires strong evidence.',
		uncertain: 'Intensity cannot be established.',
	} },
	relationship_delta: { type: 'choice', instructions: boundedInstructions + ' Estimate a possible immediate affinity change, never an applied update. Compliance does not imply trust.', criteria: {
		'-2': 'Strong supported damage to trust or regard.', '-1': 'Small supported loss of trust or regard.',
		'0': 'No supported change in trust or regard, including tactical compliance without alignment.',
		'1': 'Small supported gain in trust or regard.', '2': 'Strong supported gain in trust or regard.',
		uncertain: 'The direction or size of a relationship change is not supported.',
	} },
	action_triage: { type: 'choice', instructions: boundedInstructions + ' Choose a response style, not a completed action; aggression never authorizes violence or overrides an agreement.', criteria: {
		fight: 'Supported confrontational or assertive pushback.', flight: 'Supported deflection or withdrawal.',
		freeze: 'Supported stunned pause or difficulty responding.', fawn: 'Supported appeasing or submissive presentation.',
		controlled: 'Supported deliberate, composed or strategic response outside the stress reflexes.',
		uncertain: 'A response style is not established.',
	} },
} as const;

const answerSchema = z.object({ type: z.literal('choice'), choice: z.string(), confidence: z.number().min(0).max(1),
	probabilities: z.record(z.string(), z.number().min(0).max(1)) });
const answersSchema = z.object({ answers: z.object({ internal_judgment: answerSchema, emotional_intensity: answerSchema,
	relationship_delta: answerSchema, action_triage: answerSchema }) });

export function parseActorPsychology(response: unknown) {
	const { answers } = answersSchema.parse(response);
	const accepted: Record<string, string | null> = {};
	const confidences: number[] = [];
	for (const key of Object.keys(psychologyQuestions) as Array<keyof typeof psychologyQuestions>) {
		const answer = answers[key];
		if (!Object.hasOwn(psychologyQuestions[key].criteria, answer.choice) || answer.probabilities[answer.choice] === undefined)
			throw new Error('Psychology evaluation selected an unknown or unscored choice.');
		const confidence = Math.min(answer.confidence, answer.probabilities[answer.choice]);
		accepted[key] = answer.choice !== 'uncertain' && confidence >= 0.7 ? answer.choice : null;
		if (accepted[key] !== null) confidences.push(confidence);
	}
	return actorPsychologySchema.parse({ judgment: accepted.internal_judgment,
		emotionalIntensity: accepted.emotional_intensity === null ? null : Number(accepted.emotional_intensity),
		relationshipDelta: accepted.relationship_delta === null ? null : Number(accepted.relationship_delta),
		actionTriage: accepted.action_triage, confidence: confidences.length ? Math.min(...confidences) : 0,
		advisory: true, affinityApplied: false });
}

export const psychologyExamples = [{
	exampleOnly: true, actor: 'A proud, cornered rogue who resents being controlled.',
	playerAction: 'Help me bypass the guards or I report your admitted theft.',
	evaluation: { judgment: 'threatened', emotionalIntensity: 4, relationshipDelta: -1, actionTriage: 'fight' },
}, {
	exampleOnly: true, actor: 'A pragmatic negotiator who values a dependable bargain over status.',
	playerAction: 'I accept your previously offered terms.',
	evaluation: { judgment: 'validated', emotionalIntensity: 1, relationshipDelta: 0, actionTriage: 'controlled' },
}];
