
import { afterEach, expect, it, vi } from 'vitest';
import { embedMemoryTexts } from './embeddings';
import { generateServerTextWithMetrics } from '../turn/provider';
vi.mock('$env/dynamic/private', () => ({ env: process.env }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('blocks explicit Ollama embedding and generation requests when startup opt-in is off', async () => {
 vi.stubEnv('MYTHENGINE_LOCAL_EMBEDDINGS', 'false');
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
 await expect(embedMemoryTexts(['query'], {provider:'ollama',model:'nomic-embed-text',baseUrl:'http://127.0.0.1:11434',apiKey:'',customUrl:'',batchSize:1,dimensions:768})).rejects.toThrow('Local embeddings are off');
 await expect(generateServerTextWithMetrics({profile:{providerType:'ollama', apiKey:'', customModels:[], fetchedModels:[], reasoningModels:[], hiddenModels:[], favoriteModels:[]},model:'local-model',system:'',prompt:'query'})).rejects.toThrow('Ollama is off');
 expect(fetcher).not.toHaveBeenCalled();
});
