import { expect, test, vi } from 'vitest';
import { generateOpenAiImage } from './imageProvider';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');

test('requests one image and returns validated bytes and usage without fetching a returned URL', async () => {
  const fetchImpl = vi.fn(async (_url: URL, init: RequestInit) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-image-1', n: 1, size: '1024x1024', output_format: 'png' });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    return Response.json({ data: [{ b64_json: png.toString('base64'), url: 'https://example.com/untrusted' }], usage: { total_tokens: 7 } });
  });
  const result = await generateOpenAiImage({ apiKey: 'test-key', model: 'gpt-image-1', prompt: 'A castle', fetchImpl: fetchImpl as typeof fetch });
  expect(result.bytes).toEqual(png);
  expect(result.usage).toEqual({ total_tokens: 7 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('rejects bad responses and unsupported models before persisting', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ data: [{ url: 'https://example.com/image.png' }] }));
  await expect(generateOpenAiImage({ apiKey: 'test-key', model: 'gpt-image-1', prompt: 'A castle', fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow('base64');
  await expect(generateOpenAiImage({ apiKey: 'test-key', model: 'gpt-4.1', prompt: 'A castle', fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow('not an image model');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('explains content-filter rejections without exposing provider text or retrying', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ error: {
    message: 'The response was filtered due to the prompt triggering our content management policy. secret-test-key',
  } }, { status: 400 }));
  await expect(generateOpenAiImage({ apiKey: 'secret-test-key', provider: 'openrouter', model: 'meta/muse-image',
    prompt: 'A character', fetchImpl: fetchImpl as typeof fetch }))
    .rejects.toThrow('Image provider returned HTTP 400. The provider content filter rejected the prompt.');
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test('OpenRouter uses its dedicated Images API with the configured image model', async () => {
  const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
    expect(url.href).toBe('https://openrouter.ai/api/v1/images');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'qwen/qwen-image-3-pro', prompt: 'A castle' });
    return Response.json({ data: [{ b64_json: png.toString('base64') }], usage: { cost: 0.04 } });
  });
  const result = await generateOpenAiImage({ apiKey: 'test-key', provider: 'openrouter', model: 'qwen/qwen-image-3-pro', prompt: 'A castle', fetchImpl: fetchImpl as typeof fetch });
  expect(result.bytes).toEqual(png);
  expect(result.usage).toEqual({ cost: 0.04 });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test('NanoGPT checks its live image catalog and price before the paid request', async () => {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: URL, init?: RequestInit) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith('/images/models')) return Response.json({ data: [{
      id: 'z-image-base', capabilities: { image_generation: true },
      pricing: { currency: 'USD', per_image: { auto: 0.017, '1024*1024': 0.017 } },
    }] });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'z-image-base', response_format: 'b64_json', n: 1 });
    expect(body).not.toHaveProperty('size');
    return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  });
  const input = { apiKey: 'test-key', model: 'z-image-base', prompt: 'A castle', provider: 'nanogpt' as const, fetchImpl: fetchImpl as typeof fetch };
  await expect(generateOpenAiImage({ ...input, maxCostUsd: 0.01 })).rejects.toThrow('exceeds');
  expect(calls).toEqual(['/api/v1/images/models']);
  const result = await generateOpenAiImage({ ...input, maxCostUsd: 0.02 });
  expect(result.bytes).toEqual(png);
  expect(result.usage).toMatchObject({ estimatedCostUsd: 0.017 });
  expect(calls).toEqual(['/api/v1/images/models', '/api/v1/images/models', '/api/v1/images/generations']);
  await expect(generateOpenAiImage({ ...input, model: 'zai-org/glm-5:thinking', maxCostUsd: 0.02 })).rejects.toThrow('not an image model');
  expect(calls).toHaveLength(3);
  await expect(generateOpenAiImage({ ...input, model: 'zai-org/glm-5', maxCostUsd: 0.02 })).rejects.toThrow('verifiable image capability');
  expect(calls).toEqual(['/api/v1/images/models', '/api/v1/images/models', '/api/v1/images/generations', '/api/v1/images/models']);
});
