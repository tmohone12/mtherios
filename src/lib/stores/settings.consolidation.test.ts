import { describe, expect, it } from 'vitest';
import { migrateConsolidatedProfiles, SERVICE_DEFINITIONS, SERVICE_PROFILES, type ServiceConfig } from './settings.svelte';

const config = (model: string): ServiceConfig => ({
	model, temperature: 0.3, maxTokens: 900, systemPromptOverride: 'Keep evidence links.', enabled: false, profileId: 'specialist',
});

describe('service profile consolidation', () => {
	it('assigns turn memory and optional suggestions to their own subagents', () => {
		expect(SERVICE_DEFINITIONS.classifier.profile).toBe('memoryContext');
		expect(SERVICE_PROFILES.find(profile => profile.id === 'memoryContext')?.serviceIds).toContain('classifier');
		expect(SERVICE_PROFILES.find(profile => profile.id === 'guidance')?.serviceIds).toEqual(['suggestions']);
		expect(SERVICE_DEFINITIONS).not.toHaveProperty('actionChoices');
		expect(SERVICE_DEFINITIONS).not.toHaveProperty('activeRecall');
		expect(SERVICE_DEFINITIONS).not.toHaveProperty('worldSimulation');
		expect(SERVICE_PROFILES.find(profile => profile.id === 'narrative')?.serviceIds).not.toContain('activeRecall');
		expect(SERVICE_PROFILES.find(profile => profile.id === 'narrative')?.serviceIds).not.toContain('worldSimulation');
	});
	it('preserves specialist settings and moves old group models into task overrides once', () => {
		const original = { actorDecision: config('typesafe/jev-1.13'), loreManagement: config('') };
		const models = { narrative: 'narrator', worldState: 'old-world', lorebook: 'old-lore' };
		const migrated = migrateConsolidatedProfiles(original, models);
		expect(migrated.configs.actorDecision).toEqual(original.actorDecision);
		expect(migrated.configs.classifier.model).toBe('old-world');
		expect(migrated.configs.loreManagement).toEqual({ ...original.loreManagement, model: 'old-lore' });
		expect(migrated.models.memoryContext).toBe('old-lore');
		expect(migrateConsolidatedProfiles(migrated.configs, migrated.models)).toEqual(migrated);
	});
	it('keeps an old Active Recall choice in storage without creating a new service config', () => {
		const original = { activeRecall: config('legacy-model'), worldSimulation: config('legacy-world-model') };
		const migrated = migrateConsolidatedProfiles(original, { worldState: 'old-world' });
		expect(migrated.configs.activeRecall).toEqual(original.activeRecall);
		expect(migrated.configs.worldSimulation).toEqual(original.worldSimulation);
		expect(migrateConsolidatedProfiles({}, { worldState: 'old-world' }).configs).not.toHaveProperty('activeRecall');
		expect(migrateConsolidatedProfiles({}, { worldState: 'old-world' }).configs).not.toHaveProperty('worldSimulation');
	});
});
