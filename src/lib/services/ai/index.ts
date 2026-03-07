/**
 * AI Services — Mtherios
 * 
 * Central export for all AI services.
 * Services are instantiated as singletons on first use.
 */

export { ClassifierService } from './generation/ClassifierService';
export { MemoryService, DEFAULT_MEMORY_CONFIG } from './generation/MemoryService';
export { SuggestionsService } from './generation/SuggestionsService';
export { ActionChoicesService } from './generation/ActionChoicesService';
export { StyleReviewerService } from './generation/StyleReviewerService';
export { EntryRetrievalService } from './retrieval/EntryRetrievalService';
export { TimelineFillService } from './retrieval/TimelineFillService';
export { AgenticRetrievalService } from './retrieval/AgenticRetrievalService';
export { LoreManagementService } from './lorebook/LoreManagementService';
export { InteractiveVaultService } from './vault/InteractiveVaultService';
export { ImageGenerationService } from './image/ImageGenerationService';

// ── Singleton instances ──
import { ClassifierService } from './generation/ClassifierService';
import { MemoryService } from './generation/MemoryService';
import { SuggestionsService } from './generation/SuggestionsService';
import { ActionChoicesService } from './generation/ActionChoicesService';
import { StyleReviewerService } from './generation/StyleReviewerService';
import { EntryRetrievalService } from './retrieval/EntryRetrievalService';
import { TimelineFillService } from './retrieval/TimelineFillService';
import { AgenticRetrievalService } from './retrieval/AgenticRetrievalService';
import { LoreManagementService } from './lorebook/LoreManagementService';
import { InteractiveVaultService } from './vault/InteractiveVaultService';
import { ImageGenerationService } from './image/ImageGenerationService';

let _classifier: ClassifierService;
let _memory: MemoryService;
let _suggestions: SuggestionsService;
let _actionChoices: ActionChoicesService;
let _styleReviewer: StyleReviewerService;
let _entryRetrieval: EntryRetrievalService;
let _timelineFill: TimelineFillService;
let _agenticRetrieval: AgenticRetrievalService;
let _loreManagement: LoreManagementService;
let _vault: InteractiveVaultService;
let _imageGen: ImageGenerationService;

export const ai = {
	get classifier() { return _classifier ??= new ClassifierService(); },
	get memory() { return _memory ??= new MemoryService(); },
	get suggestions() { return _suggestions ??= new SuggestionsService(); },
	get actionChoices() { return _actionChoices ??= new ActionChoicesService(); },
	get styleReviewer() { return _styleReviewer ??= new StyleReviewerService(); },
	get entryRetrieval() { return _entryRetrieval ??= new EntryRetrievalService(); },
	get timelineFill() { return _timelineFill ??= new TimelineFillService(); },
	get agenticRetrieval() { return _agenticRetrieval ??= new AgenticRetrievalService(); },
	get loreManagement() { return _loreManagement ??= new LoreManagementService(); },
	get vault() { return _vault ??= new InteractiveVaultService(); },
	get imageGen() { return _imageGen ??= new ImageGenerationService(); },
};
