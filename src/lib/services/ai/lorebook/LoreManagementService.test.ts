import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('LoreManagementService prompt contract', () => {
	it('does not ask automatic lore management to create new character entries', () => {
		const source = readFileSync(resolve('src/lib/services/ai/lorebook/LoreManagementService.ts'), 'utf8');

		expect(source).toContain('Do not create new character entries during automatic lore management.');
		expect(source).toContain('For CHARACTER entries: update existing character entries only');
		expect(source).not.toContain('Named characters who spoke, acted, or were described in detail (not unnamed crowd members)');
	});
});
