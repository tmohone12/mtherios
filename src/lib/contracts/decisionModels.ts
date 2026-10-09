export type DecisionProvider = 'openrouter' | 'nanogpt' | 'openai-compatible';
export interface DecisionModel {
	id: string;
	name: string;
	contextWindowTokens: number;
}

// Choice + Noul models verified against the providers' public catalogs on 2026-10-08.
// Span models only support Noul and cannot choose NPC reactions or faction actions.
const catalogs: Record<DecisionProvider, readonly DecisionModel[]> = {
	openrouter: [
		{ id: 'typesafe/jev-1.13', name: 'Jev 1.13 (pinned)', contextWindowTokens: 32000 },
		{ id: '~typesafe/jev-latest', name: 'Jev Latest (automatic updates)', contextWindowTokens: 32000 },
		{ id: 'openai/gpt-6-luna-decisions', name: 'GPT-6 Luna Decisions', contextWindowTokens: 32000 },
		{ id: 'cloudflare/clef', name: 'Clef', contextWindowTokens: 32000 },
		{ id: 'cloudflare/clef-flash', name: 'Clef Flash', contextWindowTokens: 32000 },
		{ id: 'perplexity/pplx-decider-v1.1-27b', name: 'Perplexity Decider V1.1 27B', contextWindowTokens: 32000 },
		{ id: 'liquid/d1', name: 'Liquid D1', contextWindowTokens: 32000 },
		{ id: 'togethercomputer/tev1-4b-experimental', name: 'Tev1 4B (experimental)', contextWindowTokens: 32000 },
		{ id: 'inception/mercury-decide:free', name: 'Mercury Decide (free)', contextWindowTokens: 32000 },
		{ id: 'upstage/solar-decide', name: 'Solar Decide', contextWindowTokens: 32000 },
		{ id: 'upstage/solar-decide-flash', name: 'Solar Decide Flash', contextWindowTokens: 32000 },
		{ id: 'jaredpalmer/kev-4b', name: 'Kev 4B (hosted)', contextWindowTokens: 8192 },
	],
	nanogpt: [
		{ id: 'typesafe/jev-1.13', name: 'Jev 1.13 (pinned)', contextWindowTokens: 32000 },
		{ id: 'typesafe/jev-latest', name: 'Jev Latest (automatic updates)', contextWindowTokens: 32000 },
		{ id: 'llmtech/decider-0.8b-fp8', name: 'Decider 0.8B FP8', contextWindowTokens: 32000 },
		{ id: 'llmtech/decider-2b-fp8', name: 'Decider 2B FP8', contextWindowTokens: 32000 },
		{ id: 'llmtech/decider-4b-nvfp4', name: 'Decider 4B NVFP4', contextWindowTokens: 32000 },
		{ id: 'liquid/d1', name: 'Liquid D1', contextWindowTokens: 32000 },
		{ id: 'cloudflare/clef', name: 'Clef', contextWindowTokens: 1800 },
		{ id: 'cloudflare/clef-flash', name: 'Clef Flash', contextWindowTokens: 1800 },
		{ id: 'perplexity/pplx-decider-v1.1-27b', name: 'Perplexity Decider V1.1 27B', contextWindowTokens: 32000 },
	],
	'openai-compatible': [{ id: 'kev-latest', name: 'Kev-9B (local)', contextWindowTokens: 32000 }],
};

export function decisionModels(provider: DecisionProvider): readonly DecisionModel[] {
	return catalogs[provider];
}

export function decisionModel(provider: string, model?: string | null): DecisionModel | undefined {
	return catalogs[provider as DecisionProvider]?.find(candidate => candidate.id === model);
}

export function isDecisionModel(model?: string | null): boolean {
	return /^~?typesafe\/jev-(?:latest|\d[\w.-]*)$/.test(model ?? '')
		|| Object.values(catalogs).some(models => models.some(candidate => candidate.id === model));
}

export function supportsDecisionModel(provider: string, model: string): boolean {
	return Boolean(decisionModel(provider, model))
		|| (['openrouter', 'nanogpt'].includes(provider) && /^~?typesafe\/jev-(?:latest|\d[\w.-]*)$/.test(model));
}

export function modelForDecisionProvider(provider: DecisionProvider, previous: string): string {
	const normalized = previous.includes('jev-latest')
		? provider === 'nanogpt' ? 'typesafe/jev-latest' : '~typesafe/jev-latest' : previous;
	return supportsDecisionModel(provider, normalized) ? normalized : catalogs[provider][0].id;
}
