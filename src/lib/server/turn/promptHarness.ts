import { countTokens } from '$lib/utils/tokens';
import type { RetrievedMemoryPacket } from '$lib/contracts/memory';
import type { TurnContext } from './context';
import { buildServerTurnPrompt, buildPromptSectionTrace, buildStateExtractionPrompt, type CompiledPrompt, type PromptSectionTrace, type ServerTurnPromptOptions } from './promptPacket';

export interface TurnPromptHarnessScenario {
	name: string;
	playerText: string;
	ctx: TurnContext;
	retrieved?: RetrievedMemoryPacket;
	currentEntryId?: string;
	options?: ServerTurnPromptOptions;
	narrationForExtraction?: string;
}

export interface PromptHarnessReport {
	name: string;
	playerText: string;
	system: string;
	prompt: string;
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
	compiledPrompt: CompiledPrompt;
	promptSectionTrace: PromptSectionTrace[];
	extractionPrompt: string;
	tokens: {
		system: number;
		prompt: number;
		messages: number;
		extraction: number;
		totalBeforeGeneration: number;
	};
	retrievedMemoryIds: string[];
	retrievalDebug: string[];
}

export interface PromptHarnessExpectations {
	systemIncludes?: string[];
	promptIncludes?: string[];
	promptExcludes?: string[];
	maxTotalBeforeGenerationTokens?: number;
	maxMessageCount?: number;
	maxOccurrences?: Record<string, number>;
}

export interface PromptHarnessFinding {
	passed: boolean;
	label: string;
	detail: string;
}

export function emptyRetrievedMemoryPacket(storyId: string, query: string): RetrievedMemoryPacket {
	return {
		storyId,
		query,
		packet: '',
		nodes: [],
		tokenEstimate: 0,
		retrievalDebug: ['harness=empty'],
		retrievalTrace: [],
	};
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = 0;
	while ((index = haystack.indexOf(needle, index)) !== -1) {
		count += 1;
		index += needle.length;
	}
	return count;
}

export function buildPromptHarnessReport(scenario: TurnPromptHarnessScenario): PromptHarnessReport {
	const currentEntryId = scenario.currentEntryId ?? 'entry_harness_current';
	const retrieved = scenario.retrieved ?? emptyRetrievedMemoryPacket(scenario.ctx.story.id, scenario.playerText);
	const promptPacket = buildServerTurnPrompt(scenario.ctx, retrieved, currentEntryId, scenario.options);
	const extractionPrompt = buildStateExtractionPrompt(
		scenario.playerText,
		scenario.narrationForExtraction ?? 'Harness placeholder narration. A few minutes pass and the scene state changes plainly.',
	);
	const messageTokens = promptPacket.messages.reduce((sum, message) => sum + countTokens(message.content), 0);

	return {
		name: scenario.name,
		playerText: scenario.playerText,
		system: promptPacket.system,
		prompt: promptPacket.prompt,
		messages: promptPacket.messages,
		compiledPrompt: promptPacket.compiledPrompt,
		promptSectionTrace: buildPromptSectionTrace(promptPacket.compiledPrompt),
		extractionPrompt,
		tokens: {
			system: countTokens(promptPacket.system),
			prompt: countTokens(promptPacket.prompt),
			messages: messageTokens,
			extraction: countTokens(extractionPrompt),
			totalBeforeGeneration: countTokens(promptPacket.system) + countTokens(promptPacket.prompt) + messageTokens,
		},
		retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
		retrievalDebug: retrieved.retrievalDebug,
	};
}

export function evaluatePromptHarness(
	report: PromptHarnessReport,
	expectations: PromptHarnessExpectations,
): PromptHarnessFinding[] {
	const findings: PromptHarnessFinding[] = [];
	const combined = `${report.system}\n\n${report.prompt}\n\n${report.messages.map((message) => message.content).join('\n\n')}`;

	for (const expected of expectations.systemIncludes ?? []) {
		const passed = report.system.includes(expected);
		findings.push({
			passed,
			label: `system includes ${expected}`,
			detail: passed ? 'found' : 'missing from system prompt',
		});
	}

	for (const expected of expectations.promptIncludes ?? []) {
		const passed = report.prompt.includes(expected);
		findings.push({
			passed,
			label: `prompt includes ${expected}`,
			detail: passed ? 'found' : 'missing from dynamic prompt',
		});
	}

	for (const forbidden of expectations.promptExcludes ?? []) {
		const passed = !report.prompt.includes(forbidden);
		findings.push({
			passed,
			label: `prompt excludes ${forbidden}`,
			detail: passed ? 'absent' : 'unexpectedly present in dynamic prompt',
		});
	}

	if (expectations.maxTotalBeforeGenerationTokens != null) {
		const passed = report.tokens.totalBeforeGeneration <= expectations.maxTotalBeforeGenerationTokens;
		findings.push({
			passed,
			label: 'total prompt token budget',
			detail: `${report.tokens.totalBeforeGeneration}/${expectations.maxTotalBeforeGenerationTokens}`,
		});
	}

	if (expectations.maxMessageCount != null) {
		const passed = report.messages.length <= expectations.maxMessageCount;
		findings.push({
			passed,
			label: 'conversation message count',
			detail: `${report.messages.length}/${expectations.maxMessageCount}`,
		});
	}

	for (const [needle, max] of Object.entries(expectations.maxOccurrences ?? {})) {
		const actual = countOccurrences(combined, needle);
		findings.push({
			passed: actual <= max,
			label: `max occurrences of ${needle}`,
			detail: `${actual}/${max}`,
		});
	}

	return findings;
}
