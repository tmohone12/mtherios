/**
 * AI Services — Mtherios
 *
 * Central export for all AI services.
 * Services are instantiated as singletons on first use.
 *
 * The orchestrator pivot (see REFACTOR_PLAN.md) deleted ClassifierService,
 * MicroFactionSimService, AgenticRetrievalService, ContextAssembler, and
 * GenerationPipeline. Their work now happens via tools in
 * `src/lib/services/ai/tools/` and the background runner.
 */

export { MemoryService } from './generation/MemoryService';
export { SuggestionsService } from './generation/SuggestionsService';
export { EntryRetrievalService } from './retrieval/EntryRetrievalService';

export { LoreManagementService } from './lorebook/LoreManagementService';
export { EntryRefinementService } from './lorebook/EntryRefinementService';
export { StorySetupAssistService } from './generation/StorySetupAssistService';
export { ArcCondensationService } from './generation/ArcCondensationService';
export { SagaCondensationService } from './generation/SagaCondensationService';
export { EmbeddingService } from './embeddings/EmbeddingService';

// ── Singleton instances ──
import { MemoryService } from './generation/MemoryService';
import { SuggestionsService } from './generation/SuggestionsService';
import { EntryRetrievalService } from './retrieval/EntryRetrievalService';

import { LoreManagementService } from './lorebook/LoreManagementService';
import { EntryRefinementService } from './lorebook/EntryRefinementService';
import { StorySetupAssistService } from './generation/StorySetupAssistService';
import { ArcCondensationService } from './generation/ArcCondensationService';
import { SagaCondensationService } from './generation/SagaCondensationService';
import { EmbeddingService } from './embeddings/EmbeddingService';

let _memory: MemoryService;
let _suggestions: SuggestionsService;
let _entryRetrieval: EntryRetrievalService;

let _loreManagement: LoreManagementService;
let _entryRefinement: EntryRefinementService;
let _storySetupAssist: StorySetupAssistService;
let _arcCondensation: ArcCondensationService;
let _sagaCondensation: SagaCondensationService;
let _embeddings: EmbeddingService;

export const ai = {
	get memory() { return _memory ??= new MemoryService(); },
	get suggestions() { return _suggestions ??= new SuggestionsService(); },
	get entryRetrieval() { return _entryRetrieval ??= new EntryRetrievalService(); },

	get loreManagement() { return _loreManagement ??= new LoreManagementService(); },
	get entryRefinement() { return _entryRefinement ??= new EntryRefinementService(); },
	get storySetupAssist() { return _storySetupAssist ??= new StorySetupAssistService(); },
	get arcCondensation() { return _arcCondensation ??= new ArcCondensationService(); },
	get sagaCondensation() { return _sagaCondensation ??= new SagaCondensationService(); },
	get embeddings() { return _embeddings ??= new EmbeddingService(); },
};
