import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), log: vi.fn(), modelVersion: '', reasoning: 'low', secret: 'test',
	clearStore: () => {} }));
vi.mock('./summaryCheckpoints', async importOriginal => {
	const actual = await importOriginal<typeof import('./summaryCheckpoints')>();
	const { memorySummaryCheckpointStore } = await import('./summaryCheckpoints.testSupport');
	const memory = memorySummaryCheckpointStore(); mocks.clearStore = () => memory.rows.clear();
	return { ...actual, withSummaryCheckpoint: <T>(input: Parameters<typeof actual.withSummaryCheckpoint<T>>[0], generate: () => Promise<T>) => actual.withSummaryCheckpoint(input, generate, memory.store) };
});
// The Summaries task with two explicitly configured fallback profiles; nothing falls
// back to the Classifier or GameMaster role implicitly.
vi.mock('$lib/server/engine/llmSettings', () => ({
	resolveServiceGeneration: vi.fn(async () => {
		const service = (model: string) => ({
			profile: { providerType: 'nanogpt', baseUrl: 'https://example.invalid', apiKey: mocks.secret },
			generation: { model: model + mocks.modelVersion, reasoningEffort: mocks.reasoning, temperature: 0.3 },
		});
		return { ...service('same-model'), provenance: { limits: { maxRequests: 8 } },
			fallbacks: ['classifier', 'narrative'].map(model => ({ profileId: `${model}-fallback`, ...service(model) })) };
	}),
}));
vi.mock('$lib/server/engine/generationAccounting', () => ({ recordGenerationApiCalls: mocks.log, generationAttemptResult: (value: unknown) => value }));
vi.mock('$lib/server/turn/provider', () => ({ generateServerTextWithMetrics: mocks.generate,
	parseJsonFromGeneratedText: (text: string) => { try { return JSON.parse(text); } catch { return null; } } }));
import { generateChronologicalMemory, generateReadableNarrative } from './summaryGeneration';
beforeEach(() => { vi.clearAllMocks(); mocks.generate.mockReset(); mocks.log.mockReset(); mocks.clearStore(); mocks.modelVersion = ''; mocks.reasoning = 'low'; mocks.secret = 'test'; });

it.each(['chronological', 'readable'])('skips duplicate fallback endpoints and avoids nested retries for %s summaries', async kind => {
	mocks.generate.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ model: 'classifier', text: JSON.stringify({ title: 'Crossing', narrative: 'The party crossed the river, negotiated passage, and reached the far bank with their agreement and companions intact.', accounts: [{ sourceId: '1', summary: 'The party crossed the river.' }] }) });
	const input = { storyId: 'test', kind: 'arc' as const, sources: [{ id: 'chapter-1', text: 'The party crossed the river.' }] };
	if (kind === 'chronological') expect((await generateChronologicalMemory(input)).accounts[0].sourceId).toBe('chapter-1');
	else await generateReadableNarrative(input);
	expect(mocks.generate).toHaveBeenCalledTimes(2);
	expect(mocks.generate.mock.calls.map(([call]) => call.model)).toEqual(['same-model', 'classifier']);
	for (const [call] of mocks.generate.mock.calls) expect(call.maxRetries).toBe(0);
});

it('classifies a truncated chapter object and retries with accounts first', async () => {
	mocks.generate.mockResolvedValueOnce({ model: 'memory', text: '{"accounts":[{"sourceId":"1","summary":"The party crossed the river."}],"narrative":"unfinished', finishReason: 'length' })
		.mockResolvedValueOnce({ model: 'classifier', text: JSON.stringify({ accounts: [{ sourceId: '1', summary: 'The party crossed the river and kept the agreed passage.' }],
			title: 'Crossing', narrative: 'The party crossed the river, negotiated passage, and reached the far bank with their agreement and companions intact.' }), finishReason: 'stop' });
	const result = await generateChronologicalMemory({ storyId: 'test', kind: 'chapter', sources: [{ id: 'turn_1', text: 'The party crossed the river.' }] });
	expect(result.accounts[0].sourceId).toBe('turn_1');
	expect(mocks.generate.mock.calls[1][0].prompt).toContain('Summary response did not contain a complete JSON object (finish_reason: length)');
	expect(mocks.log.mock.calls[0][0]).toMatchObject({ status: 'error', metadata: { finishReason: 'length' } });
});

it('recovers a failed full chapter only from complete accounts and a readable rewrite', async () => {
	const sources = [{ id: 'turn_a', text: 'Mara negotiated passage.' }, { id: 'turn_b', text: 'The captain accepted the agreed fare.' }];
	mocks.generate.mockRejectedValueOnce(new Error('memory unavailable'))
		.mockRejectedValueOnce(new Error('classifier unavailable'))
		.mockResolvedValueOnce({ model: 'narrative', text: '{"accounts":[', finishReason: 'length' })
		.mockResolvedValueOnce({ model: 'narrative', text: JSON.stringify({ title: 'The Passage',
			accounts: [{ sourceId: '1', summary: 'Mara negotiated passage with the captain.' },
				{ sourceId: '2', summary: 'The captain accepted the agreed fare and arranged boarding.' }],
			openThreads: ['Boarding remains ahead.'] }), finishReason: 'stop' })
		.mockResolvedValueOnce({ model: 'same-model', text: JSON.stringify({ narrative: 'Mara negotiated passage with the captain. The captain accepted the agreed fare and arranged boarding. The party now has a crossing ahead.' }) });
	const result = await generateChronologicalMemory({ storyId: 'test', kind: 'chapter', sources });
	expect(result.accounts.map(account => account.sourceId)).toEqual(['turn_a', 'turn_b']);
	expect(result.narrative).toContain('arranged boarding');
	expect(result.openThreads).toEqual(['Boarding remains ahead.']);
	expect(mocks.generate).toHaveBeenCalledTimes(5);
	expect(mocks.generate.mock.calls[3][0].prompt).toContain('Do not write a narrative field');
	expect(mocks.generate.mock.calls[3][0].prompt).not.toContain('"narrative":"self-contained');
	expect(mocks.log.mock.calls.some(([call]) => call.operation === 'chapter.summary_accounts' && call.status === 'success')).toBe(true);
});

it('does not advance a chapter when the accounts fallback misses a source', async () => {
	mocks.generate.mockRejectedValueOnce(new Error('memory unavailable'))
		.mockRejectedValueOnce(new Error('classifier unavailable'))
		.mockResolvedValueOnce({ model: 'narrative', text: '{"accounts":[', finishReason: 'length' })
		.mockResolvedValueOnce({ model: 'narrative', text: JSON.stringify({ title: 'Incomplete',
			accounts: [{ sourceId: '1', summary: 'Mara negotiated passage with the captain.' }] }), finishReason: 'stop' });
	await expect(generateChronologicalMemory({ storyId: 'test', kind: 'chapter',
		sources: [{ id: 'turn_a', text: 'Mara negotiated passage.' }, { id: 'turn_b', text: 'The captain accepted.' }] }))
		.rejects.toThrow('accounts must cover every source');
	expect(mocks.generate).toHaveBeenCalledTimes(4);
});

it('builds a long chapter from validated smaller account windows without losing source coverage', async () => {
	const sources = Array.from({ length: 20 }, (_, index) => ({ id: `turn_${index + 1}`, text: `Turn ${index + 1}: ${'source detail '.repeat(250)}` }));
	const response = (count: number, label: string) => ({ model: 'same-model', finishReason: 'stop', text: JSON.stringify({
		title: `${label} chapter`,
		narrative: `${label} follows the party through all recorded decisions, consequences, and changes in order, ending with their established situation rather than a projected outcome.`,
		accounts: Array.from({ length: count }, (_, index) => ({ sourceId: String(index + 1), summary: `${label} preserves the distinct outcome of source ${index + 1}.` })),
	}) });
	mocks.generate.mockResolvedValueOnce(response(10, 'first')).mockResolvedValueOnce(response(10, 'second'))
		.mockResolvedValueOnce(response(2, 'combined'));
	const result = await generateChronologicalMemory({ storyId: 'test', kind: 'chapter', sources });
	expect(mocks.generate).toHaveBeenCalledTimes(3);
	expect(mocks.generate.mock.calls.map(([call]) => (call.prompt.match(/^SOURCE \d+ \| sourceId:/gm) ?? []).length)).toEqual([10, 10, 2]);
	expect(mocks.generate.mock.calls[2][0].prompt).not.toContain('source detail source detail');
	expect(mocks.generate.mock.calls[2][0].prompt).toContain('first preserves the distinct outcome of source 10.');
	expect(mocks.generate.mock.calls[2][0].prompt).toContain('second preserves the distinct outcome of source 10.');
	expect(result.accounts.map(account => account.sourceId)).toEqual(sources.map(source => source.id));
	expect(result.accounts[0].summary).toContain('first preserves');
	expect(result.accounts[19].summary).toContain('second preserves');
});

it('recursively splits an oversized chapter and preserves all validated turn accounts', async () => {
	const sources = Array.from({ length: 20 }, (_, index) => ({ id: `turn_${index + 1}`, text: `Turn ${index + 1}: ${'evidence '.repeat(670)}` }));
	mocks.generate.mockImplementation(async ({ prompt }: { prompt: string }) => {
		const count = (prompt.match(/^SOURCE \d+ \| sourceId:/gm) ?? []).length;
		return { model: 'same-model', finishReason: 'stop', text: JSON.stringify({
			title: `The continuing chapter ${prompt.match(/Turn (\d+):/)?.[1] ?? 'combined'}`,
			narrative: 'The first decisions led to further consequences, and the later decisions changed the situation while preserving the established sequence of events.',
			accounts: Array.from({ length: count }, (_, index) => ({ sourceId: String(index + 1), summary: `The distinct outcome of source ${index + 1} remains recorded.` })),
		}) };
	});
	const result = await generateChronologicalMemory({ storyId: 'test', kind: 'chapter', sources });
	expect(result.accounts.map(account => account.sourceId)).toEqual(sources.map(source => source.id));
	expect(mocks.generate).toHaveBeenCalledTimes(7);
	expect(mocks.generate.mock.calls.map(([call]) => (call.prompt.match(/^SOURCE \d+ \| sourceId:/gm) ?? []).length)).toEqual([5, 5, 2, 5, 5, 2, 2]);
	for (const [call] of mocks.generate.mock.calls) expect(call.prompt.length).toBeLessThanOrEqual(50_000);
});

it('fails safely before inference when one source alone exceeds the chapter prompt budget', async () => {
	await expect(generateChronologicalMemory({ storyId: 'test', kind: 'chapter',
		sources: [{ id: 'turn_1', text: 'evidence '.repeat(6000) }] }))
		.rejects.toThrow('single chapter source exceeds');
	expect(mocks.generate).not.toHaveBeenCalled();
});

it('rejects a length-limited response even when its JSON happens to parse', async () => {
	const complete = JSON.stringify({ title: 'Crossing', narrative: 'The party crossed the river, negotiated passage, and reached the far bank with their agreement and companions intact.',
		accounts: [{ sourceId: '1', summary: 'The party crossed the river.' }] });
	mocks.generate.mockResolvedValueOnce({ model: 'memory', text: complete, finishReason: 'length' })
		.mockRejectedValue(new Error('fallback unavailable'));
	await expect(generateChronologicalMemory({ storyId: 'test', kind: 'chapter',
		sources: [{ id: 'turn_1', text: 'The party crossed the river.' }] }))
		.rejects.toThrow('history was not advanced');
	expect(mocks.log.mock.calls[0][0]).toMatchObject({ status: 'error', metadata: { finishReason: 'length' } });
});

it.each(['chapter', 'arc'] as const)('repairs missing %s prose from complete accounts without regenerating facts', async kind => {
	mocks.generate.mockResolvedValueOnce({ model: 'same-model', finishReason: 'stop', text: JSON.stringify({ title: 'Conditional passage',
		accounts: [{ sourceId: '1', summary: 'The captain permits passage only after a fare of seven coins is paid.' }] }) })
		.mockResolvedValueOnce({ model: 'same-model', finishReason: 'stop', text: JSON.stringify({ narrative: 'The captain permits passage only after a fare of seven coins is paid. The party waits at the river with that condition still unmet.' }) });
	const memory = await generateChronologicalMemory({ storyId: 'test', kind, sources: [{ id: 'original_source', text: 'The captain requires seven coins.' }] });
	expect(memory.accounts).toEqual([{ sourceId: 'original_source', summary: 'The captain permits passage only after a fare of seven coins is paid.' }]);
	expect(mocks.generate).toHaveBeenCalledTimes(2);
	expect(mocks.generate.mock.calls[1][0].prompt).toContain(memory.accounts[0].summary);
	expect(mocks.generate.mock.calls[1][0].prompt).toContain('verified chronological accounts');
});

it('reuses checkpointed factual accounts after a transient prose-only failure', async () => {
	let recovering = false;
	mocks.generate.mockImplementation(async ({ prompt }: { prompt: string }) => {
		if (prompt.includes('verified chronological accounts')) {
			if (!recovering) throw new Error('provider unavailable');
			return { model: 'same-model', finishReason: 'stop', text: JSON.stringify({ narrative: 'The captain permits passage only after a fare of seven coins is paid. The party waits at the river with that condition still unmet.' }) };
		}
		return { model: 'same-model', finishReason: 'stop', text: JSON.stringify({ title: 'Conditional passage',
			accounts: [{ sourceId: '1', summary: 'The captain permits passage only after a fare of seven coins is paid.' }] }) };
	});
	const input = { storyId: 'test', kind: 'chapter' as const, sources: [{ id: 'original_source', text: 'The captain requires seven coins.' }] };
	await expect(generateChronologicalMemory(input)).rejects.toMatchObject({ retryable: true });
	recovering = true;
	const memory = await generateChronologicalMemory(input);
	expect(memory.accounts[0].summary).toContain('seven coins');
	expect(mocks.generate.mock.calls.filter(([call]) => !call.prompt.includes('verified chronological accounts'))).toHaveLength(1);
});

it('splits oversized arcs and carries complete accounts into synthesis', async () => {
	const sources = Array.from({ length: 10 }, (_, index) => ({ id: `chapter_${index + 1}`, text: `Chapter ${index + 1}: ${'chapter evidence '.repeat(400)}` }));
	mocks.generate.mockImplementation(async ({ prompt }: { prompt: string }) => {
		const count = (prompt.match(/^SOURCE \d+ \| sourceId:/gm) ?? []).length;
		return { model: 'same-model', finishReason: 'stop', text: JSON.stringify({ title: 'An arc',
			narrative: 'The party crossed the river, negotiated passage, and reached the far bank with their agreement and companions intact.',
			accounts: Array.from({ length: count }, (_, index) => ({ sourceId: String(index + 1), summary: `Retained condition ${index + 1}: passage requires seven coins after boarding.` })) }) };
	});
	const memory = await generateChronologicalMemory({ storyId: 'test', kind: 'arc', sources });
	expect(memory.accounts.map(account => account.sourceId)).toEqual(sources.map(source => source.id));
	expect(mocks.generate).toHaveBeenCalledTimes(3);
	expect(mocks.generate.mock.calls[2][0].prompt).toContain('Retained condition 5: passage requires seven coins after boarding.');
	for (const [call] of mocks.generate.mock.calls) expect(call.prompt.length).toBeLessThanOrEqual(50_000);
});

function completeResponse(prompt: string, model = 'same-model') {
	const count = (prompt.match(/^SOURCE \d+ \| sourceId:/gm) ?? []).length;
	return { model, finishReason: 'stop', text: JSON.stringify({ title: 'Verified journey',
		narrative: 'The party made the recorded decisions, preserved their agreements, and reached the established ending situation after the consequences unfolded.',
		accounts: Array.from({ length: count }, (_, index) => ({ sourceId: String(index + 1), summary: `Source ${index + 1} established a distinct consequence.` })) }) };
}

it('reuses validated subwindows after a later transient failure without repurchasing the successful half', async () => {
	const sources = Array.from({ length: 20 }, (_, index) => ({ id: `turn_${index + 1}`, text: `Turn ${index + 1}: ${'source detail '.repeat(250)}` }));
	let recovering = false;
	mocks.generate.mockImplementation(async ({ prompt }: { prompt: string }) => {
		if (prompt.includes('Turn 11:') && !recovering) throw new Error('provider unavailable');
		return completeResponse(prompt);
	});
	await expect(generateChronologicalMemory({ storyId: 'test', kind: 'chapter', sources })).rejects.toMatchObject({ retryable: true });
	expect(mocks.generate.mock.calls.filter(([call]) => call.prompt.includes('Turn 1:'))).toHaveLength(1);
	recovering = true;
	const result = await generateChronologicalMemory({ storyId: 'test', kind: 'chapter', sources });
	expect(result.accounts.map(account => account.sourceId)).toEqual(sources.map(source => source.id));
	expect(mocks.generate.mock.calls.filter(([call]) => call.prompt.includes('Turn 1:'))).toHaveLength(1);
	expect(mocks.generate).toHaveBeenCalledTimes(6);
});

it('suppresses the same permanently failed source window across jobs and unrelated supporting-fact changes', async () => {
	mocks.generate.mockResolvedValue({ model: 'same-model', text: '{"accounts":[', finishReason: 'length' });
	const input = { storyId: 'test', kind: 'chapter' as const, sources: [{ id: 'turn_1', text: 'The party crossed the river.' }] };
	await expect(generateChronologicalMemory(input)).rejects.toMatchObject({ retryable: false });
	expect(mocks.generate).toHaveBeenCalledTimes(4);
	await expect(generateChronologicalMemory(input)).rejects.toMatchObject({ retryable: false });
	await expect(generateChronologicalMemory({ ...input, evidence: 'A new unrelated catalog item.' })).rejects.toMatchObject({ retryable: false });
	expect(mocks.generate).toHaveBeenCalledTimes(4);
	mocks.generate.mockImplementation(async ({ prompt }) => completeResponse(prompt));
	mocks.modelVersion = '-corrected';
	await expect(generateChronologicalMemory(input)).resolves.toMatchObject({ title: 'Verified journey' });
	expect(mocks.generate).toHaveBeenCalledTimes(5);
});

it('retries a transient provider without reissuing permanently failed fallback calls despite changing timeout details', async () => {
	let attempt = 0;
	mocks.generate.mockImplementation(async ({ model }: { model: string }) => {
		if (model === 'same-model') throw new Error(`provider unavailable at request-${++attempt}`);
		return { model, text: '{"accounts":[', finishReason: 'length' };
	});
	const input = { storyId: 'test', kind: 'chapter' as const, sources: [{ id: 'turn_1', text: 'The party crossed the river.' }] };
	await expect(generateChronologicalMemory(input)).rejects.toMatchObject({ retryable: true });
	await expect(generateChronologicalMemory(input)).rejects.toMatchObject({ retryable: true });
	expect(mocks.generate.mock.calls.map(([call]) => call.model)).toEqual(['same-model', 'classifier', 'narrative', 'narrative', 'same-model']);
});

it('invalidates completions for changed sources, supporting context, and generation settings but excludes credentials', async () => {
	mocks.generate.mockImplementation(async ({ prompt }: { prompt: string }) => completeResponse(prompt));
	const input = { storyId: 'test', kind: 'chapter' as const, sources: [{ id: 'turn_1', text: 'The party crossed the river.' }] };
	await generateChronologicalMemory(input);
	await generateChronologicalMemory(input);
	mocks.secret = 'rotated-secret';
	await generateChronologicalMemory(input);
	expect(mocks.generate).toHaveBeenCalledTimes(1);
	await generateChronologicalMemory({ ...input, evidence: 'A different supporting catalog.' });
	expect(mocks.generate).toHaveBeenCalledTimes(2);
	await generateChronologicalMemory({ ...input, sources: [{ ...input.sources[0], text: 'The party returned across the river.' }] });
	mocks.reasoning = 'high';
	await generateChronologicalMemory(input);
	expect(mocks.generate).toHaveBeenCalledTimes(4);
});

it('freezes the provider settings for an invocation while a generation is in flight', async () => {
	mocks.generate.mockImplementation(async ({ model, prompt }: { model: string; prompt: string }) => {
		if (model === 'same-model') { mocks.modelVersion = '-changed-during-request'; throw new Error('provider unavailable'); }
		return completeResponse(prompt, model);
	});
	await generateChronologicalMemory({ storyId: 'test', kind: 'chapter', sources: [{ id: 'turn_1', text: 'The party crossed the river.' }] });
	expect(mocks.generate.mock.calls.map(([call]) => call.model)).toEqual(['same-model', 'classifier']);
});

it('halts provider fallbacks when accounting persistence fails', async () => {
	mocks.generate.mockImplementation(async ({ prompt }: { prompt: string }) => completeResponse(prompt));
	mocks.log.mockRejectedValue(new Error('Provider accounting receipt could not be saved; no provider retry was requested.'));
	const input = { storyId: 'test', kind: 'chapter' as const, sources: [{ id: 'turn_1', text: 'The party crossed the river.' }] };
	await expect(generateChronologicalMemory(input)).rejects.toMatchObject({ code: 'summary_checkpoint_accounting', retryable: false });
	await expect(generateChronologicalMemory(input)).rejects.toMatchObject({ retryable: false });
	expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it('halts fallbacks for a wrapped transport receipt persistence failure without relying on its inner cause', async () => {
	mocks.generate.mockRejectedValue(new Error('Provider attempt receipt could not be persisted: Unexpected receipt schema.'));
	const input = { storyId: 'test', kind: 'chapter' as const, sources: [{ id: 'turn_1', text: 'The party crossed the river.' }] };
	await expect(generateChronologicalMemory(input)).rejects.toMatchObject({ code: 'summary_checkpoint_accounting', retryable: false });
	await expect(generateChronologicalMemory(input)).rejects.toMatchObject({ retryable: false });
	expect(mocks.generate).toHaveBeenCalledTimes(1);
});
