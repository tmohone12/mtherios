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
export { ActionChoicesService } from './generation/ActionChoicesService';
export { StyleReviewerService } from './generation/StyleReviewerService';
export { EntryRetrievalService } from './retrieval/EntryRetrievalService';

export { LoreManagementService } from './lorebook/LoreManagementService';
export { EntryRefinementService } from './lorebook/EntryRefinementService';
export { ImageGenerationService } from './image/ImageGenerationService';
export { WorldSimulationService } from './generation/WorldSimulationService';
export { ArcCondensationService } from './generation/ArcCondensationService';
export { SagaCondensationService } from './generation/SagaCondensationService';
export { ProceduralMemoryService } from './memory/ProceduralMemoryService';
export { EmbeddingService } from './embeddings/EmbeddingService';
export { WikiLintService } from './wiki/WikiLintService';

// ── Singleton instances ──
import { MemoryService } from './generation/MemoryService';
import { SuggestionsService } from './generation/SuggestionsService';
import { ActionChoicesService } from './generation/ActionChoicesService';
import { StyleReviewerService } from './generation/StyleReviewerService';
import { EntryRetrievalService } from './retrieval/EntryRetrievalService';

import { LoreManagementService } from './lorebook/LoreManagementService';
import { EntryRefinementService } from './lorebook/EntryRefinementService';
import { ImageGenerationService } from './image/ImageGenerationService';
import { WorldSimulationService } from './generation/WorldSimulationService';
import { ArcCondensationService } from './generation/ArcCondensationService';
import { SagaCondensationService } from './generation/SagaCondensationService';
import { ProceduralMemoryService } from './memory/ProceduralMemoryService';
import { EmbeddingService } from './embeddings/EmbeddingService';
import { WikiLintService } from './wiki/WikiLintService';

let _memory: MemoryService;
let _suggestions: SuggestionsService;
let _actionChoices: ActionChoicesService;
let _styleReviewer: StyleReviewerService;
let _entryRetrieval: EntryRetrievalService;

let _loreManagement: LoreManagementService;
let _entryRefinement: EntryRefinementService;
let _imageGen: ImageGenerationService;
let _worldSim: WorldSimulationService;
let _arcCondensation: ArcCondensationService;
let _sagaCondensation: SagaCondensationService;
let _proceduralMemory: ProceduralMemoryService;
let _embeddings: EmbeddingService;
let _wikiLint: WikiLintService;

export const ai = {
	get memory() { return _memory ??= new MemoryService(); },
	get suggestions() { return _suggestions ??= new SuggestionsService(); },
	get actionChoices() { return _actionChoices ??= new ActionChoicesService(); },
	get styleReviewer() { return _styleReviewer ??= new StyleReviewerService(); },
	get entryRetrieval() { return _entryRetrieval ??= new EntryRetrievalService(); },

	get loreManagement() { return _loreManagement ??= new LoreManagementService(); },
	get entryRefinement() { return _entryRefinement ??= new EntryRefinementService(); },
	get imageGen() { return _imageGen ??= new ImageGenerationService(); },
	get worldSim() { return _worldSim ??= new WorldSimulationService(); },
	get arcCondensation() { return _arcCondensation ??= new ArcCondensationService(); },
	get sagaCondensation() { return _sagaCondensation ??= new SagaCondensationService(); },
	get proceduralMemory() { return _proceduralMemory ??= new ProceduralMemoryService(); },
	get embeddings() { return _embeddings ??= new EmbeddingService(); },
	get wikiLint() { return _wikiLint ??= new WikiLintService(); },
};
