/**
 * Browser AI assistants — Mtherios
 *
 * Optional helpers that run in the browser with the user's saved provider
 * settings. Story turns, extraction, chapters, arcs, sagas and world processing
 * are server jobs; nothing here writes campaign state on its own.
 */

import { SuggestionsService } from './generation/SuggestionsService';
import { StorySetupAssistService } from './generation/StorySetupAssistService';

let _suggestions: SuggestionsService;
let _storySetupAssist: StorySetupAssistService;

export const ai = {
	get suggestions() { return _suggestions ??= new SuggestionsService(); },
	get storySetupAssist() { return _storySetupAssist ??= new StorySetupAssistService(); },
};
