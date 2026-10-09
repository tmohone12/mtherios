import fs from 'node:fs';
import { resolveConfigPath } from './runtime-config.mjs';

const [kev, embeddings] = process.argv.slice(2);
if (![kev, embeddings].every(value => ['true', 'false'].includes(value))) {
 throw new Error('Use select-local-ai.mjs <Kev true|false> <Ollama/embeddings true|false>.');
}
const target = resolveConfigPath();
const config = JSON.parse(fs.readFileSync(target, 'utf8'));
config.localKevEnabled = kev === 'true';
config.localEmbeddingsEnabled = embeddings === 'true';
fs.writeFileSync(target + '.next', JSON.stringify(config, null, 2) + '\n');
fs.renameSync(target + '.next', target);
console.log(`Local Kev: ${config.localKevEnabled ? 'on' : 'off'}; Ollama/local embeddings: ${config.localEmbeddingsEnabled ? 'on' : 'off'}.`);
