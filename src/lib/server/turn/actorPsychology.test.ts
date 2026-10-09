import { describe, expect, it } from 'vitest';
import { parseActorPsychology, psychologyQuestions } from './actorPsychology';

function response(overrides: Record<string, unknown> = {}) {
	return { answers: { ...Object.fromEntries(Object.entries({internal_judgment:'threatened',emotional_intensity:'4',relationship_delta:'-1',action_triage:'fight'})
		.map(([key,choice])=>[key,{type:'choice',choice,confidence:0.95,probabilities:{[choice]:0.93}}])), ...overrides } };
}
describe('actor psychology boundaries',()=>{
	it('keeps a psychological interpretation separate from applied affinity',()=>{
		expect(parseActorPsychology(response())).toEqual({judgment:'threatened',emotionalIntensity:4,relationshipDelta:-1,actionTriage:'fight',confidence:0.93,advisory:true,affinityApplied:false});
	});
	it('leaves uncertain and weak dimensions unset without inventing a numeric shift',()=>{
		const low={type:'choice',choice:'2',confidence:0.99,probabilities:{'2':0.4}};
		const uncertain={type:'choice',choice:'uncertain',confidence:0.99,probabilities:{uncertain:0.99}};
		expect(parseActorPsychology(response({relationship_delta:low,emotional_intensity:uncertain}))).toMatchObject({relationshipDelta:null,emotionalIntensity:null,judgment:'threatened'});
	});
	it('rejects out-of-range values, missing dimensions and arbitrary provider prose',()=>{
		for(const value of ['10','kill the player'])expect(()=>parseActorPsychology(response({relationship_delta:{type:'choice',choice:value,confidence:1,probabilities:{[value]:1}}}))).toThrow();
		expect(()=>parseActorPsychology({answers:{}})).toThrow();
	});
	it('offers composure and uncertainty instead of forcing every NPC into a stress reflex',()=>{
		expect(psychologyQuestions.action_triage.criteria).toHaveProperty('controlled');
		expect(psychologyQuestions.action_triage.criteria).toHaveProperty('uncertain');
	});
});
