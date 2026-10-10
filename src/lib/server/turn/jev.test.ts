import { afterEach, describe, expect, it, vi } from 'vitest';
import { withServerProviderHooks } from './provider';
import { chooseJevOption, generateJevReaction, reviewJevContinuityCandidates, verifyJevTurnMemory } from './jev';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const input = { profile: { providerType: 'openrouter', apiKey: 'test-key', customModels: [], fetchedModels: [], reasoningModels: [], hiddenModels: [], favoriteModels: [] }, model: 'typesafe/jev-1.13',
	playerText: 'Will you let me in?', actorView: { knownFacts: ['The gate is closed.'] }, sourceIds: ['fact-1'] };
function answer(choice = 'refuse', confidence = 0.96) {
	return { model: 'typesafe/jev-1.13-20260917', answers: { reaction: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } },
		...Object.fromEntries(Object.entries({internal_judgment:'threatened',emotional_intensity:'3',relationship_delta:'-1',action_triage:'controlled'}).map(([key,choice]) => [key,{type:'choice',choice,confidence:0.96,probabilities:{[choice]:0.96}}])) },
		usage: { input_tokens: 250, output_tokens: 20, cost: 0.0000105 } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('Jev NPC decisions', () => {
 it('reports the selected decision model context to the shared request budget', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Response.json(answer())));
  const beforeRequest=vi.fn().mockResolvedValue(undefined);
  await withServerProviderHooks({beforeRequest}, () => generateJevReaction({ ...input, model:'cloudflare/clef', profile:{...input.profile,providerType:'nanogpt'} }));
  expect(beforeRequest).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({contextWindowTokens:1800}));
 });
	it.each([
		['openrouter', 'openai/gpt-6-luna-decisions'], ['openrouter', 'cloudflare/clef'], ['openrouter', 'cloudflare/clef-flash'],
		['openrouter', 'inception/mercury-decide:free'], ['openrouter', 'upstage/solar-decide'], ['openrouter', 'jaredpalmer/kev-4b'],
		['nanogpt', 'llmtech/decider-0.8b-fp8'], ['nanogpt', 'llmtech/decider-2b-fp8'], ['nanogpt', 'llmtech/decider-4b-nvfp4'],
		['nanogpt', 'liquid/d1'], ['nanogpt', 'cloudflare/clef-flash'], ['nanogpt', 'perplexity/pplx-decider-v1.1-27b'],
	] as const)('routes %s %s through typed decisions', async (provider, model) => {
		const fetcher = vi.fn().mockImplementation(() => Response.json({ ...answer(), model })); vi.stubGlobal('fetch', fetcher);
		const result = await generateJevReaction({ ...input, model, profile: { ...input.profile, providerType: provider } });
		expect(fetcher.mock.calls[1][0]).toBe(provider === 'nanogpt' ? 'https://nano-gpt.com/api/v1/decisions' : 'https://openrouter.ai/api/alpha/decisions');
		expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({model, questions: {reaction: {type: 'choice'}}});
		expect(JSON.parse(result.text)).toMatchObject({status: 'propose', knowledgeSourceIds: ['fact-1']});
	});
	it('rejects a model on the wrong provider and oversized evidence before dispatch', async () => {
		const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
		await expect(generateJevReaction({ ...input, model: 'openai/gpt-6-luna-decisions', profile: {...input.profile, providerType:'nanogpt'} })).rejects.toThrow('Decision model and provider do not match');
		await expect(generateJevReaction({ ...input, model: 'cloudflare/clef', profile: {...input.profile, providerType:'nanogpt'}, actorView:{knownFacts:['long evidence '.repeat(4000)]} })).rejects.toThrow('model context budget');
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('blocks local Kev before fetching when startup opt-in is off', async () => {
		vi.stubEnv('MYTHENGINE_LOCAL_KEV', 'false');
		const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
		await expect(generateJevReaction({ ...input, model: 'kev-latest', profile: {
			...input.profile, providerType: 'openai-compatible', baseUrl: 'http://127.0.0.1:8008/v1', apiKey: '',
		} })).rejects.toThrow('Local Kev is off');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('chooses a source-bound callback in the same request as the immediate action', async () => {
		const fetchMock = vi.fn().mockImplementation(() => Response.json({ model: 'typesafe/jev-1.13', answers: {
			selection: { type: 'choice', choice: 'honor', confidence: 0.91, probabilities: { honor: 0.91 } },
			memory: { type: 'choice', choice: 'belief_1', confidence: 0.88, probabilities: { belief_1: 0.88 } },
		} }));
		vi.stubGlobal('fetch', fetchMock);
		const result = await chooseJevOption({ profile: input.profile, model: input.model,
			evidence: { actor: 'captain' }, sourceIds: ['belief_1'],
			options: [{ id: 'honor', description: 'Honor passage.' }, { id: 'hold', description: 'Wait.' }],
			memoryOptions: [{ id: 'belief_1', description: 'The player saved a sailor.' },
				{ id: 'secret_other', description: 'Another actor has a private plan.' }] });
		expect(result?.memoryId).toBe('belief_1');
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(Object.keys(body.questions)).toEqual(['selection', 'memory']);
		expect(body.questions.memory.criteria).not.toHaveProperty('secret_other');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it('uses the Decisions API with actor evidence and returns an advisory, source-bound reaction', async () => {
		const fetchMock = vi.fn().mockImplementation(() => Response.json(answer())); vi.stubGlobal('fetch', fetchMock);
		const result = await generateJevReaction(input);
		const [url, request] = fetchMock.mock.calls[1];
		expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
		const body = JSON.parse(request.body);
		expect(body.state).toMatchObject({ playerAction: input.playerText, actorEvidence: input.actorView, actorPsychology:{judgment:'threatened',relationshipDelta:-1,affinityApplied:false} });
		expect(body.questions.reaction.criteria).toHaveProperty('insufficient_evidence');
		expect(body).not.toHaveProperty('messages');
		expect(JSON.parse(result.text)).toMatchObject({ status: 'propose', knowledgeSourceIds: ['fact-1'] });
		expect(result.usage.providerCostUsd).toBe(0.000021);
	});
	it('keeps an accepted offer and its source in the actor decision', async () => {
		const fetchMock = vi.fn().mockImplementation(() => Response.json(answer('cooperate'))); vi.stubGlobal('fetch', fetchMock);
		const offer = { sourceEntryId: 'entry_offer', speech: 'I offer the river path.' };
		const result = await generateJevReaction({ ...input, playerText: 'I accept.',
			actorView: { ...input.actorView, recentOffer: offer }, sourceIds: ['fact-1', offer.sourceEntryId] });
		const body = JSON.parse(fetchMock.mock.calls[1][1].body);
		expect(body.state.actorEvidence.recentOffer).toEqual(offer);
		expect(body.questions.reaction.criteria.cooperate).toContain('without reopening the same bargain');
		expect(JSON.parse(result.text)).toMatchObject({ status: 'propose', knowledgeSourceIds: ['fact-1', 'entry_offer'] });
		expect(JSON.parse(result.text).immediateAction).toContain('Honor the actor');
	});
	it.each([
		['typesafe/jev-1.13', 'typesafe/jev-1.13'],
		['~typesafe/jev-latest', 'typesafe/jev-latest'],
	])('routes %s through the NanoGPT Decisions API', async (model, expectedModel) => {
		const fetchMock = vi.fn().mockImplementation(() => Response.json(answer())); vi.stubGlobal('fetch', fetchMock);
		const result = await generateJevReaction({ ...input,
			profile: { ...input.profile, providerType: 'nanogpt' }, model });
		const [url, request] = fetchMock.mock.calls[1];
		expect(url).toBe('https://nano-gpt.com/api/v1/decisions');
		expect(request.headers.Authorization).toBe('Bearer test-key');
		expect(JSON.parse(request.body).model).toBe(expectedModel);
		expect(JSON.parse(result.text).status).toBe('propose');
	});
	it('routes local Kev through SystemOne without a cloud API key', async () => {
		vi.stubEnv('MYTHENGINE_LOCAL_KEV', 'true');
		const fetchMock = vi.fn().mockImplementation(() => Response.json({ ...answer(), model: 'kev-latest' }));
		vi.stubGlobal('fetch', fetchMock);
		const result = await generateJevReaction({ ...input, model: 'kev-latest', profile: {
			...input.profile, providerType: 'openai-compatible', baseUrl: 'http://127.0.0.1:8008/v1', apiKey: '',
		} });
		const [url, request] = fetchMock.mock.calls[1];
		expect(url).toBe('http://127.0.0.1:8008/v1/systemone');
		expect(request.headers).not.toHaveProperty('Authorization');
		expect(JSON.parse(request.body).model).toBe('kev-latest');
		expect(JSON.parse(result.text).status).toBe('propose');
	});
	it('rejects a nonlocal Kev endpoint', async () => {
		const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
		await expect(generateJevReaction({ ...input, model: 'kev-latest', profile: {
			...input.profile, providerType: 'openai-compatible', baseUrl: 'https://example.com/v1', apiKey: '',
		} })).rejects.toThrow('loopback HTTP');
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it('bounds long actor source lists so a valid reaction is accepted by the turn receipt', async () => {
		vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Response.json(answer())));
		const sources = Array.from({ length: 200 }, (_, index) => `entry_${index}`);
		const result = JSON.parse((await generateJevReaction({ ...input, sourceIds: sources })).text);
		expect(result.knowledgeSourceIds).toHaveLength(24);
		expect(result.knowledgeSourceIds).toEqual([...sources.slice(0, 3), ...sources.slice(-21)]);
	});
	it.each([['refuse', 0.4], ['insufficient_evidence', 0.99]])('abstains for %s at %s confidence', async (choice, confidence) => {
		vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Response.json(answer(choice, confidence))));
		expect(JSON.parse((await generateJevReaction(input)).text)).toMatchObject({ status: 'insufficient_evidence', immediateAction: null, objective: null });
	});
	it('rejects unrecognized reactions rather than forwarding arbitrary prose', async () => {
		vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Response.json(answer('kill the player'))));
		await expect(generateJevReaction(input)).rejects.toThrow();
	});
	it('does not expose provider response bodies or retry failed requests', async () => {
		const mock = vi.fn().mockResolvedValue(new Response('sensitive provider details', { status: 401 })); vi.stubGlobal('fetch', mock);
		await expect(generateJevReaction(input)).rejects.toThrow('Jev decision request failed (HTTP 401).');
		expect(mock).toHaveBeenCalledTimes(1);
	});
	it('forwards cancellation to the request', async () => {
		const controller = new AbortController(); controller.abort();
		vi.stubGlobal('fetch', vi.fn((_url, init) => { init.signal.throwIfAborted(); }));
		await expect(generateJevReaction({ ...input, signal: controller.signal })).rejects.toThrow();
	});
	it('explains the account provider restriction without exposing the raw error', async () => {
		vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Response.json({ error: { metadata: { failed_routing_step: 'Filter by Allowed Providers' } } }, { status: 404 })));
		await expect(generateJevReaction(input)).rejects.toThrow('Enable TypeSafe at https://openrouter.ai/settings/privacy.');
	});
});

describe('Jev bounded world choices', () => {
	const options = [{ id: 'hold', description: 'Wait for stronger evidence.' }, { id: 'diplomatic:none', description: 'Send envoys.' }];
	it.each([
		[.7,.85,true],[.6999,.85,false],[.9,.6999,false],[.9,.7,true],
	])('applies independent inclusive gates confidence %s / probability %s',async(confidence,p,accepted)=>{
		vi.stubGlobal('fetch',vi.fn().mockImplementation(() => Response.json({model:'kev-latest',answers:{selection:{type:'choice',choice:'hold',confidence,probabilities:{hold:p,'diplomatic:none':1-p}}}})));
		const result=await chooseJevOption({profile:input.profile,model:input.model,evidence:{},sourceIds:['known'],options});
		expect(result!==null).toBe(accepted);
	});
	it.each([
		[{id:'hold',description:'Wait.'},{id:'hold',description:'Duplicate.'}],
		[{id:'hold',description:'Wait.'},{id:'INVALID ID',description:'Bad ID.'}],
		[{id:'hold',description:'Only choice.'}],
		Array.from({length:9},(_,i)=>({id:'option_'+i,description:'Too many.'})),
	])('rejects malformed bounded sets before any request',async(...args)=>{
		const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
		await expect(chooseJevOption({profile:input.profile,model:input.model,evidence:{},sourceIds:['known'],options:args as Array<{id:string;description:string}>})).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it('accepts only a confident, supplied option with source receipts', async () => {
		vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Response.json({ model: 'typesafe/jev-1.13',
			answers: { selection: { type: 'choice', choice: 'diplomatic:none', confidence: 0.92, probabilities: { 'diplomatic:none': 0.92 } } } })));
		await expect(chooseJevOption({ profile: input.profile, model: input.model, evidence: { faction: 'Harbor' }, sourceIds: ['faction_harbor'], options }))
			.resolves.toMatchObject({ optionId: 'diplomatic:none', sourceIds: ['faction_harbor'] });
	});
	it('rejects invented options and abstains on low confidence', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ model: 'typesafe/jev-1.13',
			answers: { selection: { type: 'choice', choice: 'invented', confidence: 0.99, probabilities: { invented: 0.99 } } } }))
			.mockResolvedValueOnce(Response.json({ model: 'typesafe/jev-1.13',
				answers: { selection: { type: 'choice', choice: 'hold', confidence: 0.5, probabilities: { hold: 0.5 } } } }));
		vi.stubGlobal('fetch', fetchMock);
		const args = { profile: input.profile, model: input.model, evidence: {}, sourceIds: ['faction_harbor'], options };
		await expect(chooseJevOption(args)).rejects.toThrow('unknown option');
		await expect(chooseJevOption(args)).resolves.toBeNull();
	});
	it('bounds thousands of faction source IDs before building the Decisions API request', async () => {
		const fetchMock = vi.fn().mockImplementation(() => Response.json({ model: 'typesafe/jev-1.13',
			answers: { selection: { type: 'choice', choice: 'hold', confidence: 0.9, probabilities: { hold: 0.9 } } } }));
		vi.stubGlobal('fetch', fetchMock);
		const sourceIds = ['faction_1', 'goal_1', ...Array.from({ length: 2700 }, (_, index) => `entry_${index}`)];
		const result = await chooseJevOption({ profile: input.profile, model: input.model, evidence: { pressure: 80 }, sourceIds, options });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.state.sourceIds).toHaveLength(24);
		expect(body.state.sourceIds).toContain('faction_1');
		expect(body.state.sourceIds).toContain('entry_2699');
		expect(result?.sourceIds).toEqual(body.state.sourceIds);
	});
});

describe('Jev turn memory verification', () => {
	it('checks multiple source-quoted changes in one typed request and abstains on a proposal', async () => {
		const fetchMock = vi.fn().mockImplementation(() => Response.json({ answers: {
			change_0: { type: 'choice', choice: 'event', confidence: 0.94, probabilities: { event: 0.94 } },
			support_0: { type: 'choice', choice: 'supported', confidence: 0.94, probabilities: { supported: 0.94 } },
			change_1: { type: 'choice', choice: 'proposal', confidence: 0.97, probabilities: { proposal: 0.97 } },
			support_1: { type: 'choice', choice: 'unsupported', confidence: 0.97, probabilities: { unsupported: 0.97 } },
		} }));
		vi.stubGlobal('fetch', fetchMock);
		const envelope = { version: 1 as const, changes: [
			{ kind: 'event' as const, quote: 'Mira gave Sansa the key.', visibility: 'player_known' as const, update: { items: [{ name: 'key' }] } },
			{ kind: 'event' as const, quote: 'Mira offered to open the gate.', visibility: 'player_known' as const, update: { locations: [{ name: 'gate', current: true }] } },
		] } as any;
		expect(await verifyJevTurnMemory({ profile: input.profile, model: input.model,
			narration: 'Mira gave Sansa the key. Mira offered to open the gate.', envelope,
			sourceIds: ['player_1', 'narration_1'] })).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(Object.keys(body.questions)).toEqual(['change_0', 'support_0', 'change_1', 'support_1']);
		expect(body.state.sourceIds).toEqual(['player_1', 'narration_1']);
	});
	it('accepts only an event whose entire update is supported by its visible quote', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ answers: {
			change_0: { type: 'choice', choice: 'event', confidence: 0.94, probabilities: { event: 0.94 } },
			support_0: { type: 'choice', choice: 'supported', confidence: 0.92, probabilities: { supported: 0.92 } },
		} }));
		vi.stubGlobal('fetch', fetchMock);
		const envelope = { version: 1 as const, changes: [{ kind: 'event' as const, quote: 'Mira gave Sansa the key.',
			visibility: 'player_known' as const, update: { items: [{ name: 'key', location: 'Sansa' }] } }] } as any;
		const args = { profile: input.profile, model: input.model, narration: 'Mira gave Sansa the key.', envelope, sourceIds: ['narration_1'] };
		expect(await verifyJevTurnMemory(args)).toBe(true);
		fetchMock.mockResolvedValueOnce(Response.json({ answers: {
			change_0: { type: 'choice', choice: 'event', confidence: 0.94, probabilities: { event: 0.94 } },
			support_0: { type: 'choice', choice: 'unsupported', confidence: 0.95, probabilities: { unsupported: 0.95 } },
		} }));
		expect(await verifyJevTurnMemory(args)).toBe(false);
		expect(await verifyJevTurnMemory({ ...args, envelope: { ...envelope,
			changes: [{ ...envelope.changes[0], visibility: 'secret' }] } })).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it('accepts a witnessed NPC belief but not an absent actor or an unrelated update', async () => {
		const fetchMock = vi.fn().mockImplementation(() => Response.json({ answers: {
			change_0: { type: 'choice', choice: 'belief', confidence: 0.94, probabilities: { belief: 0.94 } },
			support_0: { type: 'choice', choice: 'supported', confidence: 0.93, probabilities: { supported: 0.93 } },
		} }));
		vi.stubGlobal('fetch', fetchMock);
		const quote = 'Mara hears Sansa say the gate is closed.';
		const change = { kind: 'belief', quote, visibility: 'player_known', update: {
			conversations: [{ npcName: 'Mara', topicSummary: 'Gate access', npcLearned: ['The gate is closed.'] }],
		} };
		const args = { profile: input.profile, model: input.model, narration: quote,
			envelope: { version: 1, changes: [change] }, sourceIds: ['narration_1'] } as any;
		expect(await verifyJevTurnMemory(args)).toBe(true);
		expect(Object.keys(JSON.parse(fetchMock.mock.calls[0][1].body).questions)).toEqual(['support_0']);
		expect(await verifyJevTurnMemory({ ...args, envelope: { version: 1, changes: [{ ...change, update: {
			conversations: [{ npcName: 'Ilan', topicSummary: 'Gate access', npcLearned: ['The gate is closed.'] }],
		} }] } })).toBe(false);
		expect(await verifyJevTurnMemory({ ...args, envelope: { version: 1, changes: [{ ...change, update: {
			...change.update, items: [{ name: 'key' }],
		} }] } })).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it('accepts a made promise as a commitment, not a fulfilled outcome or an offer', async () => {
		const fetchMock = vi.fn().mockImplementation(() => Response.json({ answers: {
			change_0: { type: 'choice', choice: 'event', confidence: 0.94, probabilities: { event: 0.94 } },
			support_0: { type: 'choice', choice: 'supported', confidence: 0.93, probabilities: { supported: 0.93 } },
		} }));
		vi.stubGlobal('fetch', fetchMock);
		const quote = 'Mara promised Sansa she would bring the bread tomorrow.';
		const change = { kind: 'event', quote, visibility: 'player_known', update: {
			agreements: [{ action: 'create', category: 'promise', parties: ['Mara', 'Sansa'], terms: 'Mara will bring Sansa bread tomorrow.' }],
		} };
		const args = { profile: input.profile, model: input.model, narration: quote,
			envelope: { version: 1, changes: [change] }, sourceIds: ['narration_1'] } as any;
		expect(await verifyJevTurnMemory(args)).toBe(true);
		expect(Object.keys(JSON.parse(fetchMock.mock.calls[0][1].body).questions)).toEqual(['support_0']);
		expect(await verifyJevTurnMemory({ ...args, envelope: { version: 1, changes: [{ ...change, update: {
			...change.update, timeline_events: [{ title: 'Bread delivered', status: 'committed' }],
		} }] } })).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		fetchMock.mockImplementationOnce(() => Response.json({ answers: {
			change_0: { type: 'choice', choice: 'proposal', confidence: 0.95, probabilities: { proposal: 0.95 } },
			support_0: { type: 'choice', choice: 'unsupported', confidence: 0.93, probabilities: { unsupported: 0.93 } },
		} }));
		expect(await verifyJevTurnMemory(args)).toBe(false);
	});
});

describe('Jev continuity candidate trial', () => {
	const args = { profile: input.profile, model: input.model,
		narration: 'Mara says the passage is arranged.',
		candidates: [{ id: 'sentence_0', span: 'Mara says the passage is arranged.' }],
		evidence: { agreements: [{ id: 'agreement_1', terms: 'Mara agreed only to discuss passage.' }] },
		sources: [{ id: 'agreement_1', description: 'Mara agreed only to discuss passage.' }] };
	it('returns one source-bound typed verdict from one request', async () => {
		const fetchMock = vi.fn().mockImplementation(() => Response.json({ model: 'typesafe/jev-1.13', answers: {
			verdict_0: { type: 'choice', choice: 'intent_as_event', confidence: 0.92, probabilities: { intent_as_event: 0.92 } },
			source_0: { type: 'choice', choice: 'agreement_1', confidence: 0.91, probabilities: { agreement_1: 0.91 } },
		} }));
		vi.stubGlobal('fetch', fetchMock);
		await expect(reviewJevContinuityCandidates(args)).resolves.toMatchObject({ verdicts: [
			{ id: 'sentence_0', span: args.narration, verdict: 'intent_as_event', sourceId: 'agreement_1' },
		] });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(Object.keys(body.questions)).toEqual(['verdict_0', 'source_0']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it('abstains when a finding cites unknown evidence or confidence is low', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ model: 'typesafe/jev-1.13', answers: {
			verdict_0: { type: 'choice', choice: 'contradiction', confidence: 0.95, probabilities: { contradiction: 0.95 } },
			source_0: { type: 'choice', choice: 'invented', confidence: 0.99, probabilities: { invented: 0.99 } },
		} })).mockResolvedValueOnce(Response.json({ model: 'typesafe/jev-1.13', answers: {
			verdict_0: { type: 'choice', choice: 'supported', confidence: 0.5, probabilities: { supported: 0.5 } },
		} })));
		await expect(reviewJevContinuityCandidates(args)).resolves.toBeNull();
		await expect(reviewJevContinuityCandidates(args)).resolves.toBeNull();
	});
	it('requires exact final-prose spans and a bounded source set', async () => {
		const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
		await expect(reviewJevContinuityCandidates({ ...args,
			candidates: [{ id: 'sentence_0', span: 'Mara books the ship.' }] })).resolves.toBeNull();
		await expect(reviewJevContinuityCandidates({ ...args,
			sources: Array.from({ length: 13 }, (_, index) => ({ id: `source_${index}`, description: 'source' })) })).resolves.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('psychology before expression', () => {
 it('conditions the reaction on psychology computed from the same NPC traits',async()=>{
  const actorView={actor:{name:'Silas',state:{traits:['proud','resents control'],goals:['avoid arrest']}},relationships:[{otherName:'Player',label:'suspicious'}],beliefs:[{id:'fact-1',belief:'The captain would punish my admitted theft.'}]};
  const fetcher=vi.fn().mockImplementation(()=>Response.json(answer()));vi.stubGlobal('fetch',fetcher);
  const result=await generateJevReaction({...input,playerText:'Help me bypass the guards or I report your admitted theft.',actorView});
  const [evaluation,reaction]=fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
  expect(Object.keys(evaluation.questions)).toEqual(['internal_judgment','emotional_intensity','relationship_delta','action_triage']);
  expect(evaluation.state.actorEvidence).toEqual(actorView);
  expect(evaluation.state).not.toHaveProperty('actorPsychology');
  expect(reaction.state.actorPsychology).toMatchObject({judgment:'threatened',emotionalIntensity:3,relationshipDelta:-1,actionTriage:'controlled',advisory:true,affinityApplied:false});
  expect(reaction.state.actorEvidence).toEqual(actorView);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(result.text).psychology).toEqual(reaction.state.actorPsychology);
  expect(result.usage.requestTokens).toBe(500);
  expect(actorView.relationships[0].label).toBe('suspicious');
 });
 it('keeps unsupported psychology unset and withholds the automatic proposal',async()=>{
  const json=answer();(json.answers as Record<string,{confidence:number}>).internal_judgment.confidence=0.3;
  vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Response.json(json)));
  const result=JSON.parse((await generateJevReaction(input)).text);
  expect(result).toMatchObject({status:'insufficient_evidence',immediateAction:null,psychology:{judgment:null,affinityApplied:false}});
 });
 it('rejects malformed psychology before asking for an action',async()=>{
  const fetcher=vi.fn().mockImplementation(()=>Response.json({answers:{}}));vi.stubGlobal('fetch',fetcher);
  await expect(generateJevReaction(input)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('also conditions a planner NPC choice while retaining bounded actions',async()=>{
  const fetcher=vi.fn().mockImplementation((_url,init)=>{
   const body=JSON.parse(init.body);
   return Response.json(body.questions.internal_judgment ? answer() : {model:input.model,answers:{selection:{type:'choice',choice:'hold',confidence:0.95,probabilities:{hold:0.95}}},usage:{input_tokens:100,output_tokens:10,cost:0.00001}});
  });vi.stubGlobal('fetch',fetcher);
  const result=await chooseJevOption({profile:input.profile,model:input.model,evidence:{question:'Does Silas push back?',actorEvidence:input.actorView},sourceIds:['fact-1'],psychology:true,
   options:[{id:'push_back',description:'Challenge the pressure verbally.'},{id:'hold',description:'Wait for more evidence.'}]});
  expect(JSON.parse(fetcher.mock.calls[1][1].body).state.actorPsychology.judgment).toBe('threatened');
  expect(result).toMatchObject({optionId:'hold',psychology:{relationshipDelta:-1,affinityApplied:false},usage:{input_tokens:350}});
 });
});
