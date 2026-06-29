import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const scenarioDir = join(process.cwd(), 'evals', 'scenarios');
const files = readdirSync(scenarioDir).filter((file) => file.endsWith('.jsonl')).sort();
let scenarios = 0;

for (const file of files) {
	const path = join(scenarioDir, file);
	const lines = readFileSync(path, 'utf8').split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line) continue;
		const record = JSON.parse(line);
		for (const key of ['id', 'storyFixture', 'playerAction']) {
			if (typeof record[key] !== 'string' || !record[key].trim()) {
				throw new Error(`${file}:${index + 1} missing ${key}`);
			}
		}
		scenarios += 1;
	}
}

console.log(`validated ${scenarios} replay scenario${scenarios === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'}`);
