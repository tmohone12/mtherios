import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { chooseJevOption } from '$lib/server/turn/jev';
const profile={providerType:'openrouter',apiKey:'synthetic-contract-key',baseUrl:'https://openrouter.ai/api/v1',customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]};
const options=[{id:'wait',description:'Keep current plan.'},{id:'investigate',description:'Check known uncertainty.'},{id:'offer_aid',description:'Offer relief without assuming consent.'}];
const args={profile,model:'typesafe/jev-1.13',evidence:{knownClaim:'Hillmarch sheltered our wounded.'},sourceIds:['known_event'],options};
let old:string|undefined;
beforeEach(()=>{old=process.env.MYTHENGINE_TEST_LOCAL_ONLY;process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';});
afterEach(()=>{if(old===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=old;vi.unstubAllGlobals();});
function response(confidence=.91){return {id:'synthetic-decisions-response',model:'typesafe/jev-1.13-20260917',provider:'TypeSafe',answers:{selection:{type:'choice',choice:'offer_aid',confidence,probabilities:{wait:.02,investigate:.03,offer_aid:.95}}},usage:{input_tokens:300,output_tokens:70,cost:.0000126}};}
test('current OpenRouter typed choice adapter preserves snapshot, keyed probabilities, costs and source receipts',async()=>{
 const mock=vi.fn().mockResolvedValue(Response.json(response()));vi.stubGlobal('fetch',mock);
 const result=await chooseJevOption(args);
 expect(result).toMatchObject({optionId:'offer_aid',model:'typesafe/jev-1.13-20260917',confidence:.91,sourceIds:['known_event'],usage:{cost:.0000126}});
 expect(mock.mock.calls[0][0]).toBe('https://openrouter.ai/api/alpha/decisions');
 const request=mock.mock.calls[0][1],body=JSON.parse(request.body);
 expect(request.headers.Authorization).toBe('Bearer synthetic-contract-key');
 expect(body).toMatchObject({model:'typesafe/jev-1.13',state:{evidence:args.evidence,sourceIds:['known_event']},questions:{selection:{type:'choice'}}});
 expect(Object.keys(body.questions.selection.criteria)).toEqual(options.map(o=>o.id));expect(body).not.toHaveProperty('messages');expect(mock).toHaveBeenCalledTimes(1);
});
test.each(['confidence','probabilities'])('missing optional provider %s cannot bypass acceptance',async field=>{
 const raw:any=response();delete raw.answers.selection[field];vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(raw)));
 await expect(chooseJevOption(args)).rejects.toThrow();
});
test('uncertain OpenRouter choice is held; both .7 gates remain required',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(response(.69))));expect(await chooseJevOption(args)).toBeNull();
});
test('missing current credential fails before a request, with no local fallback',async()=>{
 const mock=vi.fn();vi.stubGlobal('fetch',mock);
 await expect(chooseJevOption({...args,profile:{...profile,apiKey:''}})).rejects.toThrow('Jev requires a OpenRouter API key');expect(mock).not.toHaveBeenCalled();
});
test('paused COPY cloud guard rejects even a configured OpenRouter profile before fetch',async()=>{
 process.env.MYTHENGINE_TEST_LOCAL_ONLY='true';const mock=vi.fn();vi.stubGlobal('fetch',mock);
 await expect(chooseJevOption(args)).rejects.toThrow('local Kev decisions only');expect(mock).not.toHaveBeenCalled();
});
