import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('LibraryPanel archive-first deletion safety', () => {
	it('shows a failed export instead of leaving an unhandled click rejection', async () => {
		const component = readFileSync(resolve('src/lib/components/library/LibraryPanel.svelte'), 'utf8');
		const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1];
		const ast = ts.createSourceFile('LibraryPanel.ts', script, ts.ScriptTarget.Latest, true);
		const handler = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'handleExport')!;
		const code = ts.transpileModule(handler.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
		const download = vi.fn().mockRejectedValue(new Error('Unsupported export version: 99'));
		const alert = vi.fn();
		const handleExport = new Function('downloadStoryAsJson', 'alert', `${code}; return handleExport;`)(download, alert);
		const event = { stopPropagation: vi.fn() };
		await expect(handleExport(event, 'source_story')).resolves.toBeUndefined();
		expect(download).toHaveBeenCalledExactlyOnceWith('source_story');
		expect(alert).toHaveBeenCalledExactlyOnceWith('Export failed: Unsupported export version: 99');
		expect(event.stopPropagation).toHaveBeenCalledOnce();
	});

	it('archives by default and never purges from the primary delete control', () => {
		const source = readFileSync(resolve('src/lib/components/library/LibraryPanel.svelte'), 'utf8');

		expect(source).toMatch(/Move to trash/i);
		expect(source).toContain('deleteStoryEverywhere(target)');
		// The only permitted purge call is the explicit trash "Delete forever" path.
		const primaryDelete = source.slice(0, source.indexOf('handlePurgeForever'));
		expect(primaryDelete).not.toMatch(/mode:\s*'purge'/);
	});

	it('renders a Trash view backed by includeArchived listings with restore', () => {
		const source = readFileSync(resolve('src/lib/components/library/LibraryPanel.svelte'), 'utf8');

		expect(source).toContain('restoreBackendStory');
		expect(source).toContain('listBackendStories({ includeArchived: true })');
		expect(source).toContain('metadata?.archived === true');
		expect(source).toMatch(/onMount\(\(\) => \{[\s\S]*void loadTrash\(\)/);
		expect(source).toContain('Restore');
	});

	it('does not require optional Ollama for runtime health', () => {
		const source = readFileSync(resolve('src/lib/components/library/LibraryPanel.svelte'), 'utf8');

		expect(source).toContain("config.wikiEmbedProvider === 'ollama'");
		expect(source).toContain("config.memoryEmbeddingProvider === 'ollama'");
		expect(source).toContain("backendProjection.ollamaRequired ? 'down' : 'optional'");
	});

	it('requires a second confirmation before permanent purge', () => {
		const source = readFileSync(resolve('src/lib/components/library/LibraryPanel.svelte'), 'utf8');

		expect(source).toContain('confirmPurge');
		expect(source).toContain('Delete forever');
	});
});
