import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadVault } from './vault.mjs';

test('parallel vault loading preserves ordering, links, and fresh file contents across batches', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'mtherios-vault-'));
	try {
		await mkdir(path.join(root, 'wiki'));
		for (let i = 0; i < 35; i++) await writeFile(path.join(root, 'wiki', `${String(i).padStart(2, '0')}.md`), `# Page ${i}\n\n[[Page ${(i + 1) % 35}]]`);
		const before = await loadVault(root);
		assert.equal(before.pages.length, 35);
		assert.deepEqual(before.pages.map(p => p.title), Array.from({ length: 35 }, (_, i) => `Page ${i}`));
		assert.deepEqual(before.byPath.get('wiki/00.md').backlinks, ['wiki/34.md']);
		await writeFile(path.join(root, 'wiki/00.md'), '# Updated page\n\nNew lore.');
		const after = await loadVault(root);
		assert.equal(after.byPath.get('wiki/00.md').title, 'Updated page');
		assert.match(after.byPath.get('wiki/00.md').body, /New lore/);
	} finally {
		assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
		assert(path.basename(root).startsWith('mtherios-vault-'));
		await rm(root, { recursive: true, force: true });
	}
});
