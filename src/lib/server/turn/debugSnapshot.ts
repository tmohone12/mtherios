import type { RetrievedMemoryPacket } from '$lib/contracts/memory';

const LONG_TEXT_LIMIT = 12_000;
const SOURCE_TEXT_LIMIT = 8_000;
const OUTPUT_TEXT_LIMIT = 12_000;

type PromptMessage = { role: 'user' | 'assistant'; content: string };

type MemoryDebugNode = {
	id: string;
	title: string;
	type: string;
	score?: number | null;
	sourceEntryIds?: string[];
	sourceEventIds?: string[];
	sourcePatchIds?: string[];
};

type WikiDebugContext = {
	markdown: string;
	citations: string[];
	pageCount: number;
	seedCount: number;
	semanticError?: string | null;
};

export type TurnDebugSnapshot = {
	kind: 'narration' | 'state_extraction';
	playerText: string;
	system?: string;
	prompt?: string;
	messages?: PromptMessage[];
	retrievedMemory?: {
		packet: string;
		retrievalDebug: string[];
		nodes: MemoryDebugNode[];
	};
	wikiContext?: WikiDebugContext | null;
	contextCounts?: Record<string, number>;
	output?: string;
};

type BuildTurnDebugSnapshotInput = Omit<TurnDebugSnapshot, 'retrievedMemory' | 'wikiContext' | 'system' | 'prompt' | 'messages' | 'output'> & {
	system?: string | null;
	prompt?: string | null;
	messages?: PromptMessage[] | null;
	retrievedMemory?: Partial<RetrievedMemoryPacket> | null;
	wikiContext?: WikiDebugContext | null;
	output?: string | null;
};

function clip(value: string | null | undefined, limit: number): string {
	const text = value ?? '';
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function memoryNodes(packet: Partial<RetrievedMemoryPacket>): MemoryDebugNode[] {
	return Array.isArray(packet.nodes)
		? packet.nodes.slice(0, 24).map((node) => ({
			id: node.id,
			title: node.title,
			type: node.type,
			score: typeof node.score === 'number' ? node.score : null,
			sourceEntryIds: stringArray(node.sourceEntryIds),
			sourceEventIds: stringArray(node.sourceEventIds),
			sourcePatchIds: stringArray(node.sourcePatchIds),
		}))
		: [];
}

export function buildTurnDebugSnapshot(input: BuildTurnDebugSnapshotInput): TurnDebugSnapshot {
	return {
		kind: input.kind,
		playerText: clip(input.playerText, SOURCE_TEXT_LIMIT),
		system: input.system == null ? undefined : clip(input.system, LONG_TEXT_LIMIT),
		prompt: input.prompt == null ? undefined : clip(input.prompt, LONG_TEXT_LIMIT),
		messages: input.messages?.map((message) => ({
			role: message.role,
			content: clip(message.content, SOURCE_TEXT_LIMIT),
		})),
		retrievedMemory: input.retrievedMemory
			? {
				packet: clip(input.retrievedMemory.packet, SOURCE_TEXT_LIMIT),
				retrievalDebug: stringArray(input.retrievedMemory.retrievalDebug),
				nodes: memoryNodes(input.retrievedMemory),
			}
			: undefined,
		wikiContext: input.wikiContext
			? {
				markdown: clip(input.wikiContext.markdown, SOURCE_TEXT_LIMIT),
				citations: input.wikiContext.citations,
				pageCount: input.wikiContext.pageCount,
				seedCount: input.wikiContext.seedCount,
				semanticError: input.wikiContext.semanticError ?? null,
			}
			: input.wikiContext,
		contextCounts: input.contextCounts,
		output: input.output == null ? undefined : clip(input.output, OUTPUT_TEXT_LIMIT),
	};
}
