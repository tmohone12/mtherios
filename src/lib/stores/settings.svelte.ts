/**
 * Settings Store — Mtherios
 * Minimal stub for Phase 1. Will be expanded with full Aventuras settings later.
 */

import type { UISettings } from '$lib/types';

interface ServiceSpecificSettings {
	contextWindow?: {
		recentEntriesForNarrative?: number;
		recentEntriesForTiered?: number;
		recentEntriesForRetrieval?: number;
		recentEntriesForChoices?: number;
		userActionsForStyle?: number;
		recentEntriesForLoreManagement?: number;
		recentEntriesForNameMatching?: number;
	};
	lorebookLimits?: {
		maxForActionChoices?: number;
		maxForSuggestions?: number;
		maxForAgenticPreview?: number;
		llmThreshold?: number;
		maxEntriesPerTier?: number;
	};
	agenticRetrieval?: {
		maxIterations?: number;
	};
}

interface SystemServicesSettings {
	classifier: {
		chatHistoryTruncation: number;
	};
	imageGeneration: {
		profileId?: string;
		styleId?: string;
		size: string;
		maxImagesPerMessage: number;
		backgroundProfileId?: string;
		referenceProfileId?: string;
		referenceSize: string;
		portraitProfileId?: string;
		portraitSize: string;
		portraitStyleId?: string;
	};
	loreManagement: {
		maxIterations: number;
	};
	agenticRetrieval: {
		maxIterations: number;
	};
	timelineFill: {
		enabled: boolean;
		mode: 'static' | 'agentic';
		maxQueries: number;
	};
}

class SettingsStore {
	uiSettings = $state<UISettings>({
		theme: 'mtherios',
		fontSize: 'medium',
		fontFamily: 'Cormorant Garamond',
		fontSource: 'google',
		showWordCount: true,
		autoSave: true,
		spellcheckEnabled: false,
		debugMode: false,
		disableSuggestions: false,
		disableActionPrefixes: false,
		showReasoning: false,
		sidebarWidth: 380,
		autoScroll: true,
		showScrollToTop: true,
		showScrollToBottom: true,
	});

	serviceSpecificSettings = $state<ServiceSpecificSettings>({});

	systemServicesSettings = $state<SystemServicesSettings>({
		classifier: { chatHistoryTruncation: 100 },
		imageGeneration: {
			size: '1024x1024',
			maxImagesPerMessage: 3,
			referenceSize: '1024x1024',
			portraitSize: '512x512',
		},
		loreManagement: { maxIterations: 5 },
		agenticRetrieval: { maxIterations: 10 },
		timelineFill: { enabled: false, mode: 'static', maxQueries: 5 },
	});

	translationSettings = $state({
		enabled: false,
		targetLanguage: 'en',
		sourceLanguage: 'en',
		translateUserInput: false,
		translateWorldState: false,
	});

	getServicePresetId(_serviceId: string): string | undefined {
		return undefined;
	}

	getImageProfile(_profileId: string): { model: string } | undefined {
		return undefined;
	}

	setTheme(theme: string) {
		this.uiSettings.theme = theme as any;
	}

	setFontSize(size: 'small' | 'medium' | 'large') {
		this.uiSettings.fontSize = size;
	}

	setSidebarWidth(width: number) {
		this.uiSettings.sidebarWidth = width;
	}
}

export const settings = new SettingsStore();
