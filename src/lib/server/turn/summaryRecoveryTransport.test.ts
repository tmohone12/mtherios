import {afterEach,expect,it,vi} from 'vitest';
import {generateServerTextWithMetrics} from './provider';
import {RECOVERY_PROVIDER,RECOVERY_ROUTE} from '../jobs/summaryRecovery';
afterEach(()=>vi.unstubAllGlobals());
it('sends the exact single-endpoint price-capped route and records one mocked attempt',async()=> {
	let captured:any; const before=vi.fn(),attempt=vi.fn();
	const fetch=vi.fn(async(_url:any,init:any)=> {
		expect(String(_url)).toBe('https://api.nano-gpt.com/api/v1/chat/completions');
		captured=JSON.parse(init.body);
		return new Response(JSON.stringify({model:RECOVERY_ROUTE.model,choices:[{message:{content:'{"draft":"fixture"}'},finish_reason:'stop'}],
			usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:0.0000196}}),{status:200,headers:{'Content-Type':'application/json'}});
	});vi.stubGlobal('fetch',fetch);
	await generateServerTextWithMetrics({profile:{providerType:'nanogpt',apiKey:'fixture-only',baseUrl:'https://api.nano-gpt.com/api/v1'} as any,
		model:RECOVERY_ROUTE.model,maxTokens:12000,maxRetries:0,reasoningEffort:'none',system:'Fixture',prompt:'Fixture',responseFormat:'json_object',
		nanoGptProvider:structuredClone(RECOVERY_PROVIDER),onBeforeRequest:before,onAttempt:attempt});
	expect(captured.provider).toEqual(RECOVERY_PROVIDER);expect(captured.reasoning_effort).toBe('none');expect(captured.include_usage).toBe(true);expect(captured.stream).toBeUndefined();expect(captured.max_tokens).toBe(12000);expect(captured.models).toBeUndefined();
	expect(fetch).toHaveBeenCalledTimes(1);expect(before).toHaveBeenCalledTimes(1);expect(attempt).toHaveBeenCalledTimes(1);
});
it('rejects reservation failure before HTTP dispatch',async()=> {
	const fetch=vi.fn(()=>{throw Error('HTTP must not run');});vi.stubGlobal('fetch',fetch);
	await expect(generateServerTextWithMetrics({profile:{providerType:'nanogpt',apiKey:'fixture-only'} as any,model:RECOVERY_ROUTE.model,
		maxTokens:12000,maxRetries:0,system:'Fixture',prompt:'Fixture',onBeforeRequest:()=>{throw Error('Budget denied');}})).rejects.toThrow('Budget denied');
	expect(fetch).not.toHaveBeenCalled();
});
