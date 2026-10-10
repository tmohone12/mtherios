import { imageMediaType } from './imageAssets';
import { currentServerProviderHooks, normalizeServerProviderUsage } from '$lib/server/turn/provider';
import { countTokens } from '$lib/utils/tokens';

export type ImageProviderResult = { bytes: Uint8Array; usage: Record<string, unknown> | null };

type ImageProvider = 'openai' | 'nanogpt' | 'openrouter';

export function isImageProfile(provider: string, model: string): boolean {
  if (provider === 'openai') return /^(?:gpt-image-[a-zA-Z0-9.-]+|dall-e-[23])$/.test(model);
  if (provider === 'openrouter') return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9/._-]{0,199}$/.test(model);
  // The live NanoGPT catalog is checked again immediately before the paid call.
  return provider === 'nanogpt' && /^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,199}$/.test(model) && !model.includes(':');
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const limit = 16_000_000;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Image provider returned an empty response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Image provider response exceeded 16 MB.');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Image provider returned an invalid response.');
  return parsed as Record<string, unknown>;
}

/** OpenAI-compatible Images API transport. Provider errors exclude response bodies and credentials. */
export async function generateOpenAiImage(input: { apiKey: string; model: string; prompt: string; baseUrl?: string; provider?: ImageProvider; maxCostUsd?: number; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<ImageProviderResult> {
  if (!input.apiKey || !input.model || !input.prompt.trim() || input.prompt.length > 8000) throw new Error('Image provider settings or prompt are incomplete.');
  const provider = input.provider ?? 'openai';
  if (!isImageProfile(provider, input.model)) throw new Error('Configured model is not an image model.');
  const root = (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : input.baseUrl || (provider === 'nanogpt' ? 'https://nano-gpt.com/api/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  if (provider === 'nanogpt' && root !== 'https://nano-gpt.com/api/v1') throw new Error('NanoGPT image endpoint must use its official API base URL.');
  const endpoint = new URL(`${root.endsWith('/v1') ? root : `${root}/v1`}/${provider === 'openrouter' ? 'images' : 'images/generations'}`);
  if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Image provider endpoint must use HTTPS.');
  let estimatedCostUsd: number | null = null;
  const hooks = currentServerProviderHooks();
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(input.signal ? [input.signal] : []), ...(hooks?.signal ? [hooks.signal] : [])]);
  if (provider === 'nanogpt') {
    if (!Number.isFinite(input.maxCostUsd) || (input.maxCostUsd ?? 0) <= 0) throw new Error('Set a positive image cost limit before using NanoGPT.');
    const catalogResponse = await (input.fetchImpl ?? fetch)(new URL(`${root}/images/models`), { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (!catalogResponse.ok) throw new Error(`Image model catalog returned HTTP ${catalogResponse.status}.`);
    const catalog = await boundedJson(catalogResponse);
    const models = Array.isArray(catalog.data) ? catalog.data : [];
    const model = models.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === input.model) as Record<string, unknown> | undefined;
    const capabilities = model?.capabilities as Record<string, unknown> | undefined;
    const pricing = (model?.pricing as Record<string, unknown> | undefined)?.per_image as Record<string, unknown> | undefined;
    const prices = pricing ? Object.values(pricing).filter((price): price is number => typeof price === 'number' && Number.isFinite(price) && price >= 0) : [];
    if (capabilities?.image_generation !== true || (model?.pricing as Record<string, unknown> | undefined)?.currency !== 'USD' || !prices.length)
      throw new Error('NanoGPT model lacks verifiable image capability or USD pricing.');
    estimatedCostUsd = Math.max(...prices);
    if (estimatedCostUsd > input.maxCostUsd!) throw new Error('NanoGPT image price exceeds the configured cost limit.');
  }
  const body = {
    model: input.model, prompt: input.prompt,
    ...(provider === 'openrouter' ? {} : { n: 1 }),
    ...(provider === 'openai' ? { size: '1024x1024' } : {}),
    ...(provider === 'openrouter' ? {} : provider === 'nanogpt' || input.model.startsWith('dall-e-') ? { response_format: 'b64_json' } : { output_format: 'png' }),
  };
  const serializedBody = JSON.stringify(body), start = Date.now();
  const completeScoped = hooks ? await hooks.beforeRequest({ profile: { providerType: provider, apiKey: input.apiKey, baseUrl: root,
    customModels: [], fetchedModels: [], reasoningModels: [], hiddenModels: [], favoriteModels: [] },
    model: input.model, system: 'Explicit image generation.', prompt: input.prompt, signal, maxRetries: 0 },
    { body, serializedBody, inputTokens: countTokens(serializedBody), reservedOutputTokens: 0, contextWindowTokens: 32_000,
      ...(estimatedCostUsd == null ? {} : { reservedCostUsd: estimatedCostUsd }) }) : undefined;
  if (signal.aborted) throw signal.reason;
  const response = await (input.fetchImpl ?? fetch)(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: serializedBody, signal,
  });
  if (!response.ok) {
    const error = await boundedJson(response).catch(() => ({}));
    const detail = JSON.stringify(error);
    // Return a fixed diagnostic, never raw provider text or credentials.
    const reason = /content.management.policy|content[_ -]?filter|moderation|safety.system/i.test(detail)
      ? ' The provider content filter rejected the prompt.' : '';
    throw new Error(`Image provider returned HTTP ${response.status}.${reason}`);
  }
  const result = await boundedJson(response);
  const data = Array.isArray(result.data) ? result.data[0] : null;
  const b64 = data && typeof data === 'object' ? (data as Record<string, unknown>).b64_json : null;
  if (typeof b64 !== 'string' || b64.length > 13_400_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('Image provider did not return bounded base64 image data.');
  const bytes = Buffer.from(b64, 'base64');
  imageMediaType(bytes);
  const usage = result.usage && typeof result.usage === 'object' && !Array.isArray(result.usage) ? result.usage as Record<string, unknown> : null;
  if (signal.aborted) throw signal.reason;
  const normalizedUsage = normalizeServerProviderUsage({ usage }, false);
  normalizedUsage.estimatedCostUsd = estimatedCostUsd;
  await completeScoped?.({ text: 'Image generated.', model: input.model, endpoint: endpoint.toString(), durationMs: Date.now() - start,
    promptChars: input.prompt.length, responseChars: b64.length, finishReason: 'stop', usage: normalizedUsage });
  return { bytes, usage: estimatedCostUsd === null ? usage : { ...(usage ?? {}), estimatedCostUsd, pricingSource: 'nanogpt_catalog_max_per_image' } };
}
